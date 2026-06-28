import { defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';
import triageSkill from '../skills/triage/SKILL.md' with { type: 'skill' };
import { MISSING_LABELS, createIssueGateway, listOpenIssues } from '../shared/issues.ts';
import { createTriagerTools } from '../shared/issue-tools.ts';

// Backfill triage over EXISTING open issues (they don't fire `issues.opened`).
// Runs the triage INLINE per issue so it completes within this invocation —
// `flue run` tears down its local runtime on return, so a fire-and-forget
// dispatch() would never execute. Reuses the same triage skill + triager tools
// the webhook-driven issue-triager agent uses.
//
//   flue run triage-backlog --input '{"owner":"blackmouse572","repo":"eccho"}'
//   optional: "limit" caps how many, "concurrency" tunes parallelism (default 4)
const coordinator = defineAgent(() => ({
	model: 'deepseek/deepseek-v4-flash',
	thinkingLevel: 'medium',
	skills: [triageSkill],
}));

export default defineWorkflow({
	agent: coordinator,
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		limit: v.optional(v.number()),
		concurrency: v.optional(v.number()),
	}),
	output: v.object({
		count: v.number(),
		triaged: v.array(v.number()),
	}),

	async run({ harness, input }) {
		const { owner, repo, limit } = input;
		const concurrency = Math.max(1, input.concurrency ?? 4);

		const open = await listOpenIssues(owner, repo);
		const targets = limit ? open.slice(0, limit) : open;
		if (targets.length === 0) return { count: 0, triaged: [] };

		// Ensure the triage labels exist once (idempotent, repo-level).
		await createIssueGateway({ owner, repo, issueNumber: targets[0]!.number }).ensureLabels(MISSING_LABELS);

		const triaged: number[] = [];
		for (let i = 0; i < targets.length; i += concurrency) {
			const batch = targets.slice(i, i + concurrency);
			await Promise.all(
				batch.map(async (issue) => {
					const gw = createIssueGateway({ owner, repo, issueNumber: issue.number });
					const session = await harness.session(`issue-${issue.number}`);
					await session.skill(triageSkill, {
						args: { command: 'triage', owner, repo, issue: issue.number, title: issue.title },
						tools: createTriagerTools(gw),
					});
					triaged.push(issue.number);
				}),
			);
		}

		return { count: triaged.length, triaged };
	},
});
