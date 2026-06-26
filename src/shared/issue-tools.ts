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
			run: () => gw.ensureLabels(MISSING_LABELS),
		}),

		defineTool({
			name: 'add_labels',
			description: 'Apply one or more labels to this issue.',
			input: v.object({
				names: v.array(v.pipe(v.string(), v.minLength(1)), 'Label names to apply.'),
			}),
			run: ({ input }) => gw.addLabels(input.names),
		}),

		defineTool({
			name: 'post_comment',
			description: 'Post a comment on this issue.',
			input: v.object({
				body: v.pipe(v.string(), v.minLength(1), v.description('Comment body in Markdown.')),
			}),
			run: ({ input }) => gw.postComment(input.body),
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
			run: () => gw.ensureLabels(MISSING_LABELS),
		}),

		defineTool({
			name: 'add_labels',
			description: 'Apply one or more labels to this issue.',
			input: v.object({
				names: v.array(v.pipe(v.string(), v.minLength(1)), 'Label names to apply.'),
			}),
			run: ({ input }) => gw.addLabels(input.names),
		}),

		defineTool({
			name: 'remove_label',
			description: 'Remove a label from this issue. Safe to call even if the label is not present.',
			input: v.object({
				name: v.pipe(v.string(), v.minLength(1), v.description('Label name to remove.')),
			}),
			run: ({ input }) => gw.removeLabel(input.name),
		}),

		defineTool({
			name: 'post_comment',
			description: 'Post a comment on this issue.',
			input: v.object({
				body: v.pipe(v.string(), v.minLength(1), v.description('Comment body in Markdown.')),
			}),
			run: ({ input }) => gw.postComment(input.body),
		}),

		defineTool({
			name: 'close_issue',
			description: 'Close this issue. Use only for wontfix outcomes.',
			run: () => gw.close(),
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
	];
}
