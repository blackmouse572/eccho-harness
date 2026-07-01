import { test, expect, mock, beforeEach } from 'bun:test';

// Capture the webhook handler that github.ts registers with createGitHubChannel.
let capturedWebhook: ((args: { delivery: unknown }) => Promise<unknown>) | null = null;
const dispatched: Array<{ agent: unknown; payload: unknown }> = [];

mock.module('@flue/github', () => ({
	createGitHubChannel: (opts: { webhook: (args: { delivery: unknown }) => Promise<unknown> }) => {
		capturedWebhook = opts.webhook;
		return { conversationKey: (ref: { owner: string; repo: string; issueNumber: number }) => `${ref.owner}/${ref.repo}#${ref.issueNumber}` };
	},
}));

mock.module('@flue/runtime', () => ({
	dispatch: async (agent: unknown, payload: unknown) => {
		dispatched.push({ agent, payload });
	},
}));

mock.module('../agents/pr-reviewer.ts', () => ({ default: 'pr-reviewer' }));
mock.module('../agents/issue-classifier.ts', () => ({ default: 'issue-classifier' }));
mock.module('../agents/issue-triager.ts', () => ({ default: 'issue-triager' }));
const hintComments: Array<{ owner: string; repo: string; pr: number; body: string }> = [];

mock.module('./pull-requests.ts', () => ({
	createPullRequestGateway: ({ owner, repo, issueNumber: pr }: { owner: string; repo: string; issueNumber: number }) => ({
		postComment: async (body: string) => { hintComments.push({ owner, repo, pr, body }); },
		react: async () => {},
	}),
}));

await import('../channels/github.ts');

function makePRDelivery(action: string, draft: boolean) {
	return {
		name: 'pull_request',
		deliveryId: 'del-1',
		payload: {
			action,
			repository: { owner: { login: 'owner' }, name: 'repo' },
			pull_request: {
				number: 42,
				draft,
				user: { type: 'User', login: 'alice' },
				base: { sha: 'base-sha' },
				head: { sha: 'head-sha' },
			},
		},
	};
}

beforeEach(() => {
	dispatched.length = 0;
	hintComments.length = 0;
});

test('auto-reviews a non-draft PR when opened', async () => {
	await capturedWebhook!({ delivery: makePRDelivery('opened', false) });
	expect(dispatched).toHaveLength(1);
	expect((dispatched[0].payload as { input: { command: string } }).input.command).toBe('full');
});

test('skips auto-review for draft PRs opened as draft', async () => {
	await capturedWebhook!({ delivery: makePRDelivery('opened', true) });
	expect(dispatched).toHaveLength(0);
});

test('auto-reviews when draft is converted to ready_for_review', async () => {
	await capturedWebhook!({ delivery: makePRDelivery('ready_for_review', false) });
	expect(dispatched).toHaveLength(1);
	expect((dispatched[0].payload as { input: { command: string } }).input.command).toBe('full');
});

test('auto-reviews a non-draft PR when reopened', async () => {
	await capturedWebhook!({ delivery: makePRDelivery('reopened', false) });
	expect(dispatched).toHaveLength(1);
});

test('posts hint comment when non-draft PR is opened', async () => {
	await capturedWebhook!({ delivery: makePRDelivery('opened', false) });
	expect(hintComments).toHaveLength(1);
	expect(hintComments[0].body).toContain('/review');
});
