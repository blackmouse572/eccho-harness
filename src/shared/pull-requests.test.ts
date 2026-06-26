import { test, expect, mock, beforeEach } from 'bun:test';

// Seal-the-Octokit seam in action: replace @octokit/rest with a fake, then drive
// the gateway. `reviews` is what listReviews returns; `created` records posts.
let reviews: Array<{ id: number; html_url: string; body: string }> = [];
let created: Array<{ body: string }> = [];

mock.module('@octokit/rest', () => ({
	Octokit: class {
		paginate = async () => reviews;
		rest = {
			pulls: {
				listReviews: 'listReviews',
				createReview: async (p: { body: string }) => {
					created.push(p);
					return { data: { id: 99, html_url: 'http://x/99' } };
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
