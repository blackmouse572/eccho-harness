import { test, expect } from 'bun:test';
import { createReviewTools } from './review-tools.ts';
import type { PullRequestGateway } from './pull-requests.ts';

// A fake gateway records the calls the tools delegate to it — the seam in action.
function fakeGateway() {
	const calls: Record<string, unknown> = {};
	const gw: PullRequestGateway = {
		get: async () => {
			calls.get = true;
			return { number: 1, title: 't', body: 'b', state: 'open', draft: false, baseSha: 'base', headSha: 'head', changedFiles: [] };
		},
		diff: async () => 'DIFF',
		rangeDiff: async (base, head) => {
			calls.rangeDiff = { base, head };
			return 'RANGE';
		},
		listTree: async () => [],
		readFile: async () => null,
		findReview: async () => null,
		postReview: async (a) => {
			calls.postReview = a;
			return { reviewId: 7, url: 'http://x/7', deduped: false, event: a.event ?? 'COMMENT' };
		},
		postComment: async (body) => {
			calls.postComment = body;
			return { commentId: 1, url: 'u' };
		},
		replyToThread: async (commentId, body) => {
			calls.replyToThread = { commentId, body };
			return { commentId, url: 'u' };
		},
		listThreads: async () => [],
		resolveThread: async (threadId) => {
			calls.resolveThread = threadId;
			return { threadId, isResolved: true };
		},
		react: async (a) => {
			calls.react = a;
		},
	};
	return { gw, calls };
}

function tool(gw: PullRequestGateway, name: string) {
	const t = (createReviewTools(gw) as Array<{ name: string; run: (ctx: { input?: unknown }) => Promise<unknown> }>).find((x) => x.name === name);
	if (!t) throw new Error(`no tool named ${name}`);
	return t;
}

test('post_review maps the dispatched deliveryId to the gateway idempotency key', async () => {
	const { gw, calls } = fakeGateway();
	const res = (await tool(gw, 'post_review').run({
		input: { summary: 'S', deliveryId: 'D1', comments: [{ path: 'a.ts', line: 3, body: 'x' }] },
	})) as { reviewId: number };
	expect(calls.postReview).toMatchObject({ summary: 'S', idempotencyKey: 'D1' });
	expect((calls.postReview as { comments: unknown[] }).comments).toHaveLength(1);
	expect(res.reviewId).toBe(7);
});

test('get_commit_range_diff forwards base/head and wraps the diff', async () => {
	const { gw, calls } = fakeGateway();
	const res = await tool(gw, 'get_commit_range_diff').run({ input: { base: 'aaaaaaa', head: 'bbbbbbb' } });
	expect(calls.rangeDiff).toEqual({ base: 'aaaaaaa', head: 'bbbbbbb' });
	expect(res).toEqual({ diff: 'RANGE' });
});

test('resolve_review_thread delegates the threadId', async () => {
	const { gw, calls } = fakeGateway();
	await tool(gw, 'resolve_review_thread').run({ input: { threadId: 'T1' } });
	expect(calls.resolveThread).toBe('T1');
});
