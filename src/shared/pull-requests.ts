import { Octokit } from '@octokit/rest';

// The one seam for GitHub pull-request access. Octokit, pagination, the GraphQL
// review-thread queries, and the idempotency marker all live behind this
// interface — no call site reaches Octokit directly. Build one per PR with
// createPullRequestGateway(ref); tools and the workflow are its only callers.
//
// `GITHUB_TOKEN` authenticates outbound calls; inbound webhook verification uses
// `GITHUB_WEBHOOK_SECRET` (in the channel). The client is private to this module.
const client = new Octokit({ auth: process.env.GITHUB_TOKEN });

/** A pull request the application trusts — never chosen by the model. issueNumber is the PR number. */
export type PullRequestRef = {
	owner: string;
	repo: string;
	issueNumber: number;
};

export type ChangedFile = {
	filename: string;
	status: string;
	additions: number;
	deletions: number;
};

export type PullRequest = {
	number: number;
	title: string;
	body: string;
	state: string;
	draft: boolean;
	baseSha: string;
	headSha: string;
	changedFiles: ChangedFile[];
};

export type InlineComment = {
	path: string;
	line: number;
	side?: 'LEFT' | 'RIGHT';
	body: string;
};

export type ReviewThread = {
	threadId: string;
	isResolved: boolean;
	path: string;
	firstComment: { commentId: number | null; author: string | null; body: string } | null;
};

export type CommentRef = { commentId: number; url: string };
export type ReviewRef = { reviewId: number; url: string | null };
export type PostReviewResult = ReviewRef & { deduped: boolean };
export type Reaction = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';

/** Domain-shaped GitHub PR operations. The interface is the test surface — fake it with mock.module. */
export interface PullRequestGateway {
	get(): Promise<PullRequest>;
	diff(): Promise<string>;
	rangeDiff(base: string, head: string): Promise<string>;
	/** Existing review carrying this idempotency key, or null. Lets callers early-exit before expensive work. */
	findReview(idempotencyKey: string): Promise<ReviewRef | null>;
	postReview(args: { summary: string; idempotencyKey: string; comments?: InlineComment[] }): Promise<PostReviewResult>;
	postComment(body: string): Promise<CommentRef>;
	replyToThread(commentId: number, body: string): Promise<CommentRef>;
	listThreads(): Promise<ReviewThread[]>;
	resolveThread(threadId: string): Promise<{ threadId: string; isResolved: boolean }>;
	react(args: { commentId: number; commentType: 'issue' | 'review'; content: Reaction }): Promise<void>;
}

/** Hidden marker that makes posting idempotent under a caller-chosen key (a delivery id, a head sha, …). */
function reviewMarker(idempotencyKey: string): string {
	return `<!-- eccho-pr-review key=${idempotencyKey} -->`;
}

export function createPullRequestGateway(ref: PullRequestRef): PullRequestGateway {
	const { owner, repo, issueNumber: pull_number } = ref;

	async function findReviewRef(idempotencyKey: string): Promise<ReviewRef | null> {
		const marker = reviewMarker(idempotencyKey);
		const reviews = await client.paginate(client.rest.pulls.listReviews, { owner, repo, pull_number, per_page: 100 });
		const hit = reviews.find((r) => r.body?.includes(marker));
		return hit ? { reviewId: hit.id, url: hit.html_url ?? null } : null;
	}

	return {
		async get() {
			const pr = await client.rest.pulls.get({ owner, repo, pull_number });
			const files = await client.paginate(client.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });
			return {
				number: pr.data.number,
				title: pr.data.title,
				body: pr.data.body ?? '',
				state: pr.data.state,
				draft: pr.data.draft ?? false,
				baseSha: pr.data.base.sha,
				headSha: pr.data.head.sha,
				changedFiles: files.map((f) => ({
					filename: f.filename,
					status: f.status,
					additions: f.additions,
					deletions: f.deletions,
				})),
			};
		},

		async diff() {
			const res = await client.rest.pulls.get({ owner, repo, pull_number, mediaType: { format: 'diff' } });
			return res.data as unknown as string;
		},

		async rangeDiff(base, head) {
			const res = await client.rest.repos.compareCommitsWithBasehead({
				owner,
				repo,
				basehead: `${base}...${head}`,
				mediaType: { format: 'diff' },
			});
			return res.data as unknown as string;
		},

		findReview: findReviewRef,

		async postReview({ summary, idempotencyKey, comments }) {
			const existing = await findReviewRef(idempotencyKey);
			if (existing) return { ...existing, deduped: true };

			const res = await client.rest.pulls.createReview({
				owner,
				repo,
				pull_number,
				event: 'COMMENT',
				body: `${summary}\n\n${reviewMarker(idempotencyKey)}`,
				comments: comments?.map((c) => ({ path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body })),
			});
			return { reviewId: res.data.id, url: res.data.html_url ?? null, deduped: false };
		},

		async postComment(body) {
			const res = await client.rest.issues.createComment({ owner, repo, issue_number: pull_number, body });
			return { commentId: res.data.id, url: res.data.html_url };
		},

		async replyToThread(commentId, body) {
			const res = await client.rest.pulls.createReplyForReviewComment({ owner, repo, pull_number, comment_id: commentId, body });
			return { commentId: res.data.id, url: res.data.html_url };
		},

		async listThreads() {
			const data = await client.graphql<{
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: Array<{
								id: string;
								isResolved: boolean;
								path: string;
								comments: { nodes: Array<{ databaseId: number | null; author: { login: string } | null; body: string }> };
							}>;
						};
					};
				};
			}>(
				`query($owner:String!,$repo:String!,$number:Int!){
					repository(owner:$owner,name:$repo){
						pullRequest(number:$number){
							reviewThreads(first:100){ nodes{ id isResolved path comments(first:1){ nodes{ databaseId author{ login } body } } } }
						}
					}
				}`,
				{ owner, repo, number: pull_number },
			);
			return data.repository.pullRequest.reviewThreads.nodes.map((t) => ({
				threadId: t.id,
				isResolved: t.isResolved,
				path: t.path,
				firstComment: t.comments.nodes[0]
					? { commentId: t.comments.nodes[0].databaseId, author: t.comments.nodes[0].author?.login ?? null, body: t.comments.nodes[0].body }
					: null,
			}));
		},

		async resolveThread(threadId) {
			const data = await client.graphql<{ resolveReviewThread: { thread: { id: string; isResolved: boolean } } }>(
				`mutation($threadId:ID!){ resolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } } }`,
				{ threadId },
			);
			return { threadId: data.resolveReviewThread.thread.id, isResolved: data.resolveReviewThread.thread.isResolved };
		},

		async react({ commentId, commentType, content }) {
			if (commentType === 'review') {
				await client.rest.reactions.createForPullRequestReviewComment({ owner, repo, comment_id: commentId, content });
			} else {
				await client.rest.reactions.createForIssueComment({ owner, repo, comment_id: commentId, content });
			}
		},
	};
}
