import { test, expect, mock, beforeEach } from 'bun:test';

// Seal-the-Octokit seam in action: replace @octokit/rest with a fake, then drive
// the gateway. `reviews` is what listReviews returns; `created` records posts.
let reviews: Array<{ id: number; html_url: string; body: string }> = [];
let created: Array<{ body: string; event?: string }> = [];
let failOwnPr = false; // simulate "can't review your own PR" (422)

mock.module('@octokit/rest', () => ({
	Octokit: class {
		paginate = async () => reviews;
		rest = {
			pulls: {
				listReviews: 'listReviews',
				createReview: async (p: { body: string; event?: string }) => {
					if (failOwnPr && p.event && p.event !== 'COMMENT') {
						const e = new Error('Can not approve your own pull request') as Error & { status: number };
						e.status = 422;
						throw e;
					}
					created.push(p);
					return { data: { id: 99, html_url: 'http://x/99' } };
				},
				get: async () => ({ data: { head: { sha: 'HEADSHA' } } }),
			},
			repos: {
				getContent: async ({ path }: { path: string }) => {
					if (path === 'CONTEXT.md') {
						return { data: { type: 'file', content: Buffer.from('hello domain', 'utf8').toString('base64') } };
					}
					const e = new Error('Not Found') as Error & { status: number };
					e.status = 404;
					throw e;
				},
			},
		};
		graphql = async () => ({});
	},
}));

const { createPullRequestGateway } = await import('./pull-requests.ts');
const gw = () => createPullRequestGateway({ owner: 'o', repo: 'r', issueNumber: 1 });

beforeEach(() => {
	reviews = [];
	created = [];
	failOwnPr = false;
});

test('postReview embeds the idempotency marker and posts when none exists', async () => {
	const res = await gw().postReview({ summary: 'hello', idempotencyKey: 'k1' });
	expect(res.deduped).toBe(false);
	expect(created).toHaveLength(1);
	expect(created[0]!.body).toContain('<!-- eccho-pr-review key=k1 -->');
});

test('postReview dedups when a review already carries the key (no second post)', async () => {
	reviews = [{ id: 5, html_url: 'http://x/5', body: 'old\n\n<!-- eccho-pr-review key=k2 -->' }];
	const res = await gw().postReview({ summary: 'again', idempotencyKey: 'k2' });
	expect(res.deduped).toBe(true);
	expect(res.reviewId).toBe(5);
	expect(created).toHaveLength(0);
});

test('findReview returns the matching review or null', async () => {
	reviews = [{ id: 5, html_url: 'http://x/5', body: '<!-- eccho-pr-review key=k2 -->' }];
	expect(await gw().findReview('k2')).toEqual({ reviewId: 5, url: 'http://x/5' });
	expect(await gw().findReview('nope')).toBeNull();
});

test('readFile decodes a repo file at the PR head, null when missing', async () => {
	expect(await gw().readFile('CONTEXT.md')).toBe('hello domain');
	expect(await gw().readFile('nope.md')).toBeNull();
});

test('postReview leaves the requested review state', async () => {
	const res = await gw().postReview({ summary: 's', idempotencyKey: 'k', event: 'APPROVE' });
	expect(res.event).toBe('APPROVE');
	expect(created[0]!.event).toBe('APPROVE');
});

test('postReview downgrades to COMMENT when you cannot review your own PR (422)', async () => {
	failOwnPr = true;
	const res = await gw().postReview({ summary: 's', idempotencyKey: 'k', event: 'REQUEST_CHANGES' });
	expect(res.event).toBe('COMMENT');
	expect(res.downgraded).toBe(true);
	expect(created.map((c) => c.event)).toEqual(['COMMENT']);
});
