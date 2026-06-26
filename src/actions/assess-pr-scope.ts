import { defineAction } from '@flue/runtime';
import * as v from 'valibot';
import { assessScope } from '../shared/scope.ts';

// Reusable, deterministic scope evaluation. The master agent calls this with the
// PR's changed files to decide which specialist reviewers to delegate to; the
// workflow uses the same heuristic directly.
export const assessPrScope = defineAction({
	name: 'assess_pr_scope',
	description:
		'Assess a PR\'s change set and recommend which specialist reviewers to run (architecture, testing, security, domain). Pass the changed files from get_pull_request. Returns the size, totals, recommended dimensions, and rationale.',
	input: v.object({
		files: v.array(
			v.object({
				filename: v.string(),
				additions: v.number(),
				deletions: v.number(),
				status: v.optional(v.string()),
			}),
		),
	}),
	output: v.object({
		size: v.picklist(['tiny', 'small', 'medium', 'large']),
		totalChanges: v.number(),
		fileCount: v.number(),
		dimensions: v.array(v.picklist(['architecture', 'testing', 'security', 'domain'])),
		rationale: v.string(),
	}),
	async run({ input }) {
		return assessScope(input.files);
	},
});
