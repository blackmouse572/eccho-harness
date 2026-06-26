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
	/** This file's unified diff hunk (empty for binary/too-large files). */
	patch: string;
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
/** GitHub pull-request review state. */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
export type PostReviewResult = ReviewRef & {
	deduped: boolean;
	/** The event actually used (may differ from requested — see `downgraded`). */
	event: ReviewEvent;
	/** True when APPROVE/REQUEST_CHANGES was downgraded to COMMENT (e.g. reviewing your own PR). */
	downgraded?: boolean;
};
export type Reaction = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';

/** Domain-shaped GitHub PR operations. The interface is the test surface — fake it with mock.module. */
export interface PullRequestGateway {
	get(): Promise<PullRequest>;
	diff(): Promise<string>;
	rangeDiff(base: string, head: string): Promise<string>;
	/** List repo file paths at the PR head (optionally filtered by a path prefix). For the domain reviewer. */
	listTree(prefix?: string): Promise<string[]>;
	/** Read one repo file at the PR head; null if missing, a directory, binary, or too large. */
	readFile(path: string): Promise<string | null>;
	/** Existing review carrying this idempotency key, or null. Lets callers early-exit before expensive work. */
	findReview(idempotencyKey: string): Promise<ReviewRef | null>;
	postReview(args: {
		summary: string;
		idempotencyKey: string;
		comments?: InlineComment[];
		/** Review state to leave: APPROVE / REQUEST_CHANGES / COMMENT (default COMMENT). */
		event?: ReviewEvent;
	}): Promise<PostReviewResult>;
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

/** Lightweight GitHub reachability + token validity check, for health probes. */
export async function pingGitHub(): Promise<{ ok: boolean; login?: string; error?: string }> {
	try {
		const res = await client.rest.users.getAuthenticated();
		return { ok: true, login: res.data.login };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function createPullRequestGateway(ref: PullRequestRef): PullRequestGateway {
	const { owner, repo, issueNumber: pull_number } = ref;

	// Memoized PR head commit SHA — repo reads resolve against the PR head.
	let cachedHead: string | undefined;
	async function headSha(): Promise<string> {
		if (!cachedHead) {
			const pr = await client.rest.pulls.get({ owner, repo, pull_number });
			cachedHead = pr.data.head.sha;
		}
		return cachedHead;
	}

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
					patch: f.patch ?? '',
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

		async listTree(prefix) {
			const ref2 = await headSha();
			const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: ref2 });
			const tree = await client.rest.git.getTree({ owner, repo, tree_sha: commit.data.tree.sha, recursive: 'true' });
			let paths = tree.data.tree.filter((t) => t.type === 'blob' && t.path).map((t) => t.path as string);
			if (prefix) paths = paths.filter((p) => p.startsWith(prefix));
			return paths;
		},

		async readFile(path) {
			const ref2 = await headSha();
			try {
				const res = await client.rest.repos.getContent({ owner, repo, path, ref: ref2 });
				const data = res.data;
				if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return null;
				return Buffer.from(data.content, 'base64').toString('utf8');
			} catch (err) {
				if (err && typeof err === 'object' && 'status' in err && err.status === 404) return null;
				throw err;
			}
		},

		findReview: findReviewRef,

		async postReview({ summary, idempotencyKey, comments, event }) {
			const desired: ReviewEvent = event ?? 'COMMENT';
			const existing = await findReviewRef(idempotencyKey);
			if (existing) return { ...existing, deduped: true, event: desired };

			const params = {
				owner,
				repo,
				pull_number,
				body: `${summary}\n\n${reviewMarker(idempotencyKey)}`,
				comments: comments?.map((c) => ({ path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body })),
			};
			try {
				const res = await client.rest.pulls.createReview({ ...params, event: desired });
				return { reviewId: res.data.id, url: res.data.html_url ?? null, deduped: false, event: desired };
			} catch (err) {
				// You can't APPROVE / REQUEST_CHANGES your own PR (422). Downgrade to a COMMENT review.
				const status = err && typeof err === 'object' && 'status' in err ? err.status : undefined;
				if (desired !== 'COMMENT' && status === 422) {
					const res = await client.rest.pulls.createReview({ ...params, event: 'COMMENT' });
					return { reviewId: res.data.id, url: res.data.html_url ?? null, deduped: false, event: 'COMMENT', downgraded: true };
				}
				throw err;
			}
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
