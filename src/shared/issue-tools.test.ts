import { test, expect } from 'bun:test';
import type { IssueGateway, Issue } from './issues.ts';
import { createClassifierTools, createTriagerTools } from './issue-tools.ts';

const fakeIssue: Issue = {
	number: 1,
	title: 'Bug report',
	body: 'It crashes',
	state: 'open',
	labels: ['bug', 'needs-triage'],
	comments: [],
	author: 'alice',
};

function fakeGw(overrides: Partial<IssueGateway> = {}): IssueGateway {
	return {
		get: async () => fakeIssue,
		addLabels: async () => {},
		removeLabel: async () => {},
		postComment: async () => {},
		close: async () => {},
		ensureLabels: async () => {},
		readRepoFile: async () => null,
		...overrides,
	};
}

type Tool = { name: string; run: (ctx: { input?: unknown }) => Promise<unknown> };

test('createClassifierTools returns ensure_triage_labels, add_labels, post_comment', () => {
	const tools = createClassifierTools(fakeGw()) as Tool[];
	const names = tools.map((t) => t.name);
	expect(names).toContain('ensure_triage_labels');
	expect(names).toContain('add_labels');
	expect(names).toContain('post_comment');
});

test('classifier add_labels delegates to gw.addLabels', async () => {
	const called: string[][] = [];
	const gw = fakeGw({ addLabels: async (names) => { called.push(names); } });
	const tools = createClassifierTools(gw) as Tool[];
	const tool = tools.find((t) => t.name === 'add_labels')!;
	await tool.run({ input: { names: ['bug', 'priority:high', 'needs-triage'] } });
	expect(called).toEqual([['bug', 'priority:high', 'needs-triage']]);
});

test('classifier post_comment delegates to gw.postComment', async () => {
	let posted = '';
	const gw = fakeGw({ postComment: async (body) => { posted = body; } });
	const tools = createClassifierTools(gw) as Tool[];
	const tool = tools.find((t) => t.name === 'post_comment')!;
	await tool.run({ input: { body: 'hello' } });
	expect(posted).toBe('hello');
});

test('createTriagerTools returns get_issue, add_labels, remove_label, post_comment, close_issue, read_repo_file, ensure_triage_labels', () => {
	const tools = createTriagerTools(fakeGw()) as Tool[];
	const names = tools.map((t) => t.name);
	expect(names).toContain('get_issue');
	expect(names).toContain('add_labels');
	expect(names).toContain('remove_label');
	expect(names).toContain('post_comment');
	expect(names).toContain('close_issue');
	expect(names).toContain('read_repo_file');
	expect(names).toContain('ensure_triage_labels');
});

test('triager get_issue returns the issue', async () => {
	const tools = createTriagerTools(fakeGw()) as Tool[];
	const tool = tools.find((t) => t.name === 'get_issue')!;
	const result = await tool.run({});
	expect(result).toEqual(fakeIssue);
});

test('triager remove_label delegates to gw.removeLabel', async () => {
	let removed = '';
	const gw = fakeGw({ removeLabel: async (name) => { removed = name; } });
	const tools = createTriagerTools(gw) as Tool[];
	const tool = tools.find((t) => t.name === 'remove_label')!;
	await tool.run({ input: { name: 'needs-triage' } });
	expect(removed).toBe('needs-triage');
});

test('triager close_issue delegates to gw.close', async () => {
	let closed = false;
	const gw = fakeGw({ close: async () => { closed = true; } });
	const tools = createTriagerTools(gw) as Tool[];
	const tool = tools.find((t) => t.name === 'close_issue')!;
	await tool.run({});
	expect(closed).toBe(true);
});

test('triager read_repo_file delegates to gw.readRepoFile', async () => {
	const gw = fakeGw({ readRepoFile: async (path) => `content of ${path}` });
	const tools = createTriagerTools(gw) as Tool[];
	const tool = tools.find((t) => t.name === 'read_repo_file')!;
	const result = await tool.run({ input: { path: 'CONTEXT.md' } });
	expect(result).toBe('content of CONTEXT.md');
});
