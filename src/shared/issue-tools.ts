import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { IssueGateway } from './issues.ts';
import { MISSING_LABELS } from './issues.ts';

export function createClassifierTools(gw: IssueGateway) {
	return [
		defineTool({
			name: 'ensure_triage_labels',
			description:
				'Create missing triage labels in this repo (needs-triage, needs-info, ready-for-agent, ready-for-human, difficulty:hard). Call once before adding any labels.',
			run: async () => {
				await gw.ensureLabels(MISSING_LABELS);
				return undefined;
			},
		}),

		defineTool({
			name: 'add_labels',
			description: 'Apply one or more labels to this issue.',
			input: v.object({
				names: v.array(v.pipe(v.string(), v.minLength(1)), 'Label names to apply.'),
			}),
			run: async ({ input }) => {
				await gw.addLabels(input.names);
				return undefined;
			},
		}),

		defineTool({
			name: 'post_comment',
			description: 'Post a comment on this issue.',
			input: v.object({
				body: v.pipe(v.string(), v.minLength(1), v.description('Comment body in Markdown.')),
			}),
			run: async ({ input }) => {
				await gw.postComment(input.body);
				return undefined;
			},
		}),
	];
}

export function createTriagerTools(gw: IssueGateway) {
	return [
		defineTool({
			name: 'get_issue',
			description:
				'Get the issue title, body, current labels, all comments (id, author, body, createdAt), and the issue author.',
			run: () => gw.get(),
		}),

		defineTool({
			name: 'ensure_triage_labels',
			description:
				'Create missing triage labels (needs-triage, needs-info, ready-for-agent, ready-for-human, difficulty:hard). Call once at the start of triage.',
			run: async () => {
				await gw.ensureLabels(MISSING_LABELS);
				return undefined;
			},
		}),

		defineTool({
			name: 'add_labels',
			description: 'Apply one or more labels to this issue.',
			input: v.object({
				names: v.array(v.pipe(v.string(), v.minLength(1)), 'Label names to apply.'),
			}),
			run: async ({ input }) => {
				await gw.addLabels(input.names);
				return undefined;
			},
		}),

		defineTool({
			name: 'remove_label',
			description: 'Remove a label from this issue. Safe to call even if the label is not present.',
			input: v.object({
				name: v.pipe(v.string(), v.minLength(1), v.description('Label name to remove.')),
			}),
			run: async ({ input }) => {
				await gw.removeLabel(input.name);
				return undefined;
			},
		}),

		defineTool({
			name: 'post_comment',
			description: 'Post a comment on this issue.',
			input: v.object({
				body: v.pipe(v.string(), v.minLength(1), v.description('Comment body in Markdown.')),
			}),
			run: async ({ input }) => {
				await gw.postComment(input.body);
				return undefined;
			},
		}),

		defineTool({
			name: 'close_issue',
			description: 'Close this issue. Use only for wontfix outcomes.',
			run: async () => {
				await gw.close();
				return undefined;
			},
		}),

		defineTool({
			name: 'read_repo_file',
			description:
				'Read a file from the default branch of the repository by its path. Returns text content or null if missing or binary. Use to read CONTEXT.md, docs/adr/**, or any file needed to check for existing implementations.',
			input: v.object({
				path: v.pipe(v.string(), v.minLength(1), v.description('Repo-relative file path.')),
			}),
			run: ({ input }) => gw.readRepoFile(input.path),
		}),

		defineTool({
			name: 'list_repo_tree',
			description:
				'List file paths in the repository (default branch). Pass an optional prefix to filter (e.g. "docs/adr/"). Use to discover ADR files before reading them.',
			input: v.object({
				prefix: v.optional(v.pipe(v.string(), v.description('Path prefix filter, e.g. docs/adr/'))),
			}),
			run: ({ input }) => gw.listRepoTree(input?.prefix),
		}),
	];
}
