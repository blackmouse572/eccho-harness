import { defineAgent, defineWorkflow, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import issueTriager from '../agents/issue-triager.ts';
import { channel } from '../channels/github.ts';
import { listOpenIssues } from '../shared/issues.ts';

// Backfill triage over EXISTING open issues (they don't fire `issues.opened`).
// Lists open issues and dispatches the issue-triager for each — the same path a
// `/triage` comment takes, in bulk. Each issue is triaged asynchronously in its
// own durable agent instance; this workflow just kicks them off.
//
//   flue run triage-backlog --input '{"owner":"blackmouse572","repo":"eccho"}'
//   (optional "limit" caps how many issues to dispatch)
const coordinator = defineAgent(() => ({ model: 'deepseek/deepseek-v4-flash' }));

export default defineWorkflow({
	agent: coordinator,
	input: v.object({
		owner: v.string(),
		repo: v.string(),
		limit: v.optional(v.number()),
	}),
	output: v.object({
		count: v.number(),
		dispatched: v.array(v.number()),
	}),

	async run({ input }) {
		const { owner, repo, limit } = input;
		const open = await listOpenIssues(owner, repo);
		const targets = limit ? open.slice(0, limit) : open;

		for (const issue of targets) {
			await dispatch(issueTriager, {
				id: channel.conversationKey({ owner, repo, issueNumber: issue.number }),
				input: {
					command: 'triage',
					owner,
					repo,
					issue: issue.number,
					requester: 'triage-backlog',
				},
			});
		}

		const dispatched = targets.map((i) => i.number);
		return { count: dispatched.length, dispatched };
	},
});
