import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import type { PullRequestGateway } from './pull-requests.ts';

// Model-facing tools. Each is a thin adapter over the PullRequestGateway — the
// model contract (names, descriptions, schemas) lives here; all GitHub behavior
// lives behind the gateway. Build the gateway once and pass it in.
export function createReviewTools(gw: PullRequestGateway) {
	return [
		defineTool({
			name: 'get_pull_request',
			description:
				'Get this pull request\'s title, description, state, base/head commit SHAs, and the list of changed files with additions/deletions.',
			run: () => gw.get(),
		}),

		defineTool({
			name: 'get_pull_request_diff',
			description:
				'Get the full unified diff for the entire pull request (base...head). Use for a full review of a newly opened/reopened PR or a "full review" command.',
			run: async () => ({ diff: await gw.diff() }),
		}),

		defineTool({
			name: 'get_commit_range_diff',
			description:
				'Get the unified diff between two commit SHAs in this repository (base...head). Use for an incremental review of only the new commits added since the last review. Pass the SHAs from your dispatched input.',
			input: v.object({
				base: v.pipe(v.string(), v.minLength(7), v.description('Starting commit SHA (exclusive lower bound).')),
				head: v.pipe(v.string(), v.minLength(7), v.description('Ending commit SHA (the latest commit to review).')),
			}),
			run: async ({ input }) => ({ diff: await gw.rangeDiff(input.base, input.head) }),
		}),

		defineTool({
			name: 'post_review',
			description:
				'Post the finished review as a pull-request review: a Markdown `summary` plus optional `comments` anchored to file lines (each opens a resolvable thread). Call once per review. Pass `deliveryId` from your input as the idempotency key; a retried or redelivered webhook will not post twice. Only attach inline comments on lines that appear in the diff you reviewed.',
			input: v.object({
				summary: v.pipe(v.string(), v.minLength(1), v.description('The review summary in Markdown.')),
				deliveryId: v.pipe(v.string(), v.minLength(1), v.description('The `deliveryId` from your dispatched input. Used as the idempotency key.')),
				comments: v.optional(
					v.array(
						v.object({
							path: v.pipe(v.string(), v.description('Repo-relative file path from the diff.')),
							line: v.pipe(v.number(), v.description('Line number in the file at the PR head.')),
							side: v.optional(v.picklist(['LEFT', 'RIGHT'])),
							body: v.pipe(v.string(), v.minLength(1), v.description('Inline finding in Markdown.')),
						}),
					),
				),
			}),
			run: ({ input }) => gw.postReview({ summary: input.summary, idempotencyKey: input.deliveryId, comments: input.comments }),
		}),

		defineTool({
			name: 'post_issue_comment',
			description:
				'Post a top-level comment on this pull request conversation. Use to reply to a comment on the review summary (not an inline thread).',
			input: v.object({ body: v.pipe(v.string(), v.minLength(1), v.description('Comment body in Markdown.')) }),
			run: ({ input }) => gw.postComment(input.body),
		}),

		defineTool({
			name: 'reply_to_review_comment',
			description:
				'Reply inside an inline review-comment thread, in reply to a specific review comment id. Use to counter a user reply on a line-level finding.',
			input: v.object({
				commentId: v.pipe(v.number(), v.description('The review comment id to reply to.')),
				body: v.pipe(v.string(), v.minLength(1), v.description('Reply body in Markdown.')),
			}),
			run: ({ input }) => gw.replyToThread(input.commentId, input.body),
		}),

		defineTool({
			name: 'get_review_threads',
			description:
				'List this PR\'s inline review threads: each thread\'s id, whether it is resolved, the file path, and the first comment (author + body + comment id). Use to find which thread a user reply belongs to before countering or resolving it.',
			run: async () => ({ threads: await gw.listThreads() }),
		}),

		defineTool({
			name: 'resolve_review_thread',
			description:
				'Mark an inline review thread as resolved. Use when you accept the user\'s reply or the point is settled. Get the threadId from get_review_threads.',
			input: v.object({ threadId: v.pipe(v.string(), v.minLength(1), v.description('GraphQL thread node id from get_review_threads.')) }),
			run: ({ input }) => gw.resolveThread(input.threadId),
		}),

		defineTool({
			name: 'react_to_comment',
			description: 'Add an emoji reaction to a PR comment. Use 👍 (+1) to acknowledge a resolved point.',
			input: v.object({
				commentId: v.pipe(v.number(), v.description('The comment id to react to.')),
				commentType: v.picklist(['issue', 'review'], 'Whether the comment is a conversation comment or an inline review comment.'),
				content: v.picklist(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']),
			}),
			run: async ({ input }) => {
				await gw.react({ commentId: input.commentId, commentType: input.commentType, content: input.content });
				return { ok: true };
			},
		}),
	];
}
