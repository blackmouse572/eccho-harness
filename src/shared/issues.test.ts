import { test, expect, mock, beforeEach } from 'bun:test';

let issueData = { number: 1, title: 'Test', body: 'body', state: 'open', user: { login: 'alice' }, labels: [{ name: 'bug' }] };
let comments: Array<{ id: number; user: { login: string }; body: string; created_at: string }> = [];
let repoLabels: Array<{ name: string }> = [{ name: 'bug' }];
let addedLabels: string[] = [];
let removedLabel = '';
let postedComment = '';
let closed = false;
let createdLabels: Array<{ name: string; color: string; description: string }> = [];

mock.module('@octokit/rest', () => ({
	Octokit: class {
		paginate = async (method: string) => {
			if (method === 'listComments') return comments;
			if (method === 'listLabelsForRepo') return repoLabels;
			return [];
		};
		rest = {
			issues: {
				get: async () => ({ data: issueData }),
				listComments: 'listComments',
				listLabelsForRepo: 'listLabelsForRepo',
				addLabels: async (p: { labels: string[] }) => { addedLabels.push(...p.labels); },
				removeLabel: async (p: { name: string }) => {
					if (p.name === 'missing') {
						const e = new Error('Not Found') as Error & { status: number };
						e.status = 404;
						throw e;
					}
					removedLabel = p.name;
				},
				createComment: async (p: { body: string }) => { postedComment = p.body; },
				update: async (p: { state: string }) => { if (p.state === 'closed') closed = true; },
				createLabel: async (p: { name: string; color: string; description: string }) => { createdLabels.push(p); },
			},
			repos: {
				getContent: async (p: { path: string }) => {
					if (p.path === 'CONTEXT.md') {
						return { data: { type: 'file', content: Buffer.from('hello', 'utf8').toString('base64') } };
					}
					const e = new Error('Not Found') as Error & { status: number };
					e.status = 404;
					throw e;
				},
			},
		};
	},
}));

const { createIssueGateway, MISSING_LABELS } = await import('./issues.ts');
const gw = () => createIssueGateway({ owner: 'o', repo: 'r', issueNumber: 1 });

beforeEach(() => {
	addedLabels = [];
	removedLabel = '';
	postedComment = '';
	closed = false;
	createdLabels = [];
	repoLabels = [{ name: 'bug' }];
	comments = [];
});

test('get returns mapped issue with labels and comments', async () => {
	comments = [{ id: 1, user: { login: 'bob' }, body: 'hi', created_at: '2024-01-01T00:00:00Z' }];
	const issue = await gw().get();
	expect(issue.title).toBe('Test');
	expect(issue.labels).toEqual(['bug']);
	expect(issue.comments).toHaveLength(1);
	expect(issue.comments[0]!.author).toBe('bob');
	expect(issue.author).toBe('alice');
});

test('addLabels calls GitHub API with the provided names', async () => {
	await gw().addLabels(['needs-triage', 'bug']);
	expect(addedLabels).toEqual(['needs-triage', 'bug']);
});

test('removeLabel calls GitHub API', async () => {
	await gw().removeLabel('bug');
	expect(removedLabel).toBe('bug');
});

test('removeLabel ignores 404 (label not present)', async () => {
	await expect(gw().removeLabel('missing')).resolves.toBeUndefined();
});

test('postComment posts to the issue', async () => {
	await gw().postComment('hello world');
	expect(postedComment).toBe('hello world');
});

test('close sets state to closed', async () => {
	await gw().close();
	expect(closed).toBe(true);
});

test('ensureLabels creates only labels not already in the repo', async () => {
	repoLabels = [{ name: 'needs-triage' }];
	await gw().ensureLabels(MISSING_LABELS);
	const created = createdLabels.map((l) => l.name);
	expect(created).not.toContain('needs-triage');
	expect(created).toContain('needs-info');
	expect(created).toContain('ready-for-agent');
	expect(created).toContain('ready-for-human');
	expect(created).toContain('difficulty:hard');
});

test('readRepoFile decodes file content, null when missing', async () => {
	expect(await gw().readRepoFile('CONTEXT.md')).toBe('hello');
	expect(await gw().readRepoFile('missing.md')).toBeNull();
});

test('MISSING_LABELS contains all five required labels', () => {
	const names = MISSING_LABELS.map((l) => l.name);
	expect(names).toContain('needs-triage');
	expect(names).toContain('needs-info');
	expect(names).toContain('ready-for-agent');
	expect(names).toContain('ready-for-human');
	expect(names).toContain('difficulty:hard');
});
