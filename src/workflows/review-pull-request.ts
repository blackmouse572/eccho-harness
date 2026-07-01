import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import reviewPr from '../skills/review-pr/SKILL.md' with { type: 'skill' };
import { createPullRequestGateway } from '../shared/pull-requests.ts';
import { domainRepoTools } from '../shared/repo-tools.ts';
import { VERDICT_EVENT } from '../shared/review-tools.ts';
import { assessScope } from '../shared/scope.ts';
import {
	FindingsSchema,
	buildSpecialistPrompt,
	dimensionAgent,
	reviewerProfiles,
	scopedDiff,
	type Findings,
} from '../shared/reviewers.ts';

// Finite, invocable version of the PR review pipeline (for manual `flue run` and
// CI). Same building blocks as the master agent — scope heuristic, specialist
// subagents, the review-pr skill — but deterministic app-orchestrated and
// without cross-event memory. Invoke:
//   flue run review-pull-request --input '{"owner":"blackmouse572","repo":"eccho","pr":123}'

const coordinator = defineAgent(() => ({
	model: 'deepseek/deepseek-v4-flash',
	thinkingLevel: 'medium',
	skills: [reviewPr],
	subagents: reviewerProfiles,
}));

const SynthSchema = v.object({
	summary: v.string(),
	verdict: v.picklist(['approve', 'request_changes', 'comment']),
	comments: v.array(
		v.object({
			path: v.string(),
			line: v.number(),
			side: v.optional(v.picklist(['LEFT', 'RIGHT'])),
			body: v.string(),
		}),
	),
});

export default defineWorkflow({
	agent: coordinator,
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		pr: v.number(),
	}),
	output: v.object({
		reviewUrl: v.nullable(v.string()),
		dimensions: v.array(v.string()),
		deduped: v.boolean(),
		event: v.optional(v.string()),
	}),

	async run({ harness, input }) {
		const { owner, repo, pr } = input;
		const gw = createPullRequestGateway({ owner, repo, issueNumber: pr });

		// 1. PR context + changed files.
		const prInfo = await gw.get();

		// 2. Scope → which specialists to run.
		const dimensions = assessScope(prInfo.changedFiles).dimensions;

		// Idempotency on re-run: skip before expensive work if a review covers this head.
		const idempotencyKey = `head:${prInfo.headSha}`;
		const existing = await gw.findReview(idempotencyKey);
		if (existing) {
			return { reviewUrl: existing.url, dimensions, deduped: true };
		}

		// 3. Fan out to the recommended specialists IN PARALLEL — each gets only
		//    its scoped slice of the diff. Separate sessions avoid contention.
		//    The domain reviewer gets repo-read tools (GitHub API) for this PR.
		const findings: Array<{ dimension: string } & Findings> = await Promise.all(
			dimensions.map(async (dimension) => {
				const session = await harness.session(dimension);
				const res = await session.task(
					buildSpecialistPrompt({
						dimension,
						prTitle: prInfo.title,
						prBody: prInfo.body,
						diff: scopedDiff(dimension, prInfo.changedFiles),
					}),
					{
						agent: dimensionAgent[dimension],
						result: FindingsSchema,
						...(dimension === 'domain' ? { tools: domainRepoTools(gw) } : {}),
					},
				);
				return { dimension, ...res.data };
			}),
		);

		// 5. Synthesize one review (or review the diff directly if nothing fanned out).
		const synthSession = await harness.session('synthesis');
		const synthInput =
			dimensions.length > 0
				? `Synthesize these specialist findings into one pull-request review for #${pr} ("${prInfo.title}").\n\n${JSON.stringify(findings, null, 2)}`
				: `Review this trivial change to PR #${pr} ("${prInfo.title}") directly.\n\n\`\`\`diff\n${await gw.diff()}\n\`\`\``;
		const synth = await synthSession.skill(reviewPr, {
			args: { request: synthInput },
			result: SynthSchema,
		});

		// 6. Post one review and mark the PR review state via the API
		//    (deterministic step — approve / request_changes / comment).
		const result = await gw.postReview({
			summary: synth.data.summary,
			idempotencyKey,
			comments: synth.data.comments,
			event: VERDICT_EVENT[synth.data.verdict],
		});

		return { reviewUrl: result.url, dimensions, deduped: result.deduped, event: result.event };
	},
});
