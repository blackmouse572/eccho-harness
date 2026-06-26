import { defineAgent, defineWorkflow } from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';
import * as v from 'valibot';
import reviewPr from '../skills/review-pr/SKILL.md' with { type: 'skill' };
import { checkoutPrHead } from '../shared/checkout.ts';
import { createPullRequestGateway } from '../shared/pull-requests.ts';
import { assessScope } from '../shared/scope.ts';
import {
	FindingsSchema,
	buildSpecialistPrompt,
	dimensionAgent,
	reviewerProfiles,
	type Findings,
} from '../shared/reviewers.ts';

// Finite, invocable version of the PR review pipeline (for manual `flue run` and
// CI). Same building blocks as the master agent — scope heuristic, specialist
// subagents, the review-pr skill — but deterministic app-orchestrated and
// without cross-event memory. Invoke:
//   flue run review-pull-request --input '{"owner":"blackmouse572","repo":"eccho","pr":123}'

type Env = { Sandbox: Parameters<typeof getSandbox>[0] };

const coordinator = defineAgent<Env>(({ id, env }) => ({
	model: 'deepseek/deepseek-v4-pro',
	thinkingLevel: 'high',
	sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
	cwd: '/workspace',
	skills: [reviewPr],
	subagents: reviewerProfiles,
}));

const SynthSchema = v.object({
	summary: v.string(),
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

		// 3. Whole-PR diff.
		const diff = await gw.diff();

		// 4. Checkout for the domain reviewer (container sandbox), if needed.
		if (dimensions.includes('domain')) {
			await checkoutPrHead(harness, { owner, repo, pr });
		}

		// 5. Fan out to the recommended specialists (separate sessions, sequential
		//    to avoid per-session operation contention).
		const findings: Array<{ dimension: string } & Findings> = [];
		for (const dimension of dimensions) {
			const session = await harness.session(dimension);
			const res = await session.task(
				buildSpecialistPrompt({
					dimension,
					prTitle: prInfo.title,
					prBody: prInfo.body,
					diff,
				}),
				{ agent: dimensionAgent[dimension], result: FindingsSchema },
			);
			findings.push({ dimension, ...res.data });
		}

		// 6. Synthesize one review (or review directly if nothing fanned out).
		const synthSession = await harness.session('synthesis');
		const synthInput =
			dimensions.length > 0
				? `Synthesize these specialist findings into one pull-request review for #${pr} ("${prInfo.title}").\n\n${JSON.stringify(findings, null, 2)}`
				: `Review this trivial change to PR #${pr} ("${prInfo.title}") directly.\n\n\`\`\`diff\n${diff}\n\`\`\``;
		const synth = await synthSession.skill(reviewPr, {
			args: { request: synthInput },
			result: SynthSchema,
		});

		// 7. Post one review (summary + inline resolvable threads).
		const result = await gw.postReview({
			summary: synth.data.summary,
			idempotencyKey,
			comments: synth.data.comments,
		});

		return { reviewUrl: result.url, dimensions, deduped: result.deduped };
	},
});
