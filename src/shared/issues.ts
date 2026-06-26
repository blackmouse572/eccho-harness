import { Octokit } from '@octokit/rest';

const client = new Octokit({ auth: process.env.GITHUB_TOKEN });

export type IssueRef = { owner: string; repo: string; issueNumber: number };
export type LabelDef = { name: string; color: string; description?: string };

export type IssueComment = {
	id: number;
	author: string;
	body: string;
	createdAt: string;
};

export type Issue = {
	number: number;
	title: string;
	body: string;
	state: 'open' | 'closed';
	labels: string[];
	comments: IssueComment[];
	author: string;
};

export interface IssueGateway {
	get(): Promise<Issue>;
	addLabels(names: string[]): Promise<void>;
	removeLabel(name: string): Promise<void>;
	postComment(body: string): Promise<void>;
	close(): Promise<void>;
	ensureLabels(defs: LabelDef[]): Promise<void>;
	readRepoFile(path: string): Promise<string | null>;
}

export const MISSING_LABELS: LabelDef[] = [
	{ name: 'needs-triage',    color: 'e4e669', description: 'Awaiting triage' },
	{ name: 'needs-info',      color: 'd876e3', description: 'Waiting on reporter' },
	{ name: 'ready-for-agent', color: '0075ca', description: 'Fully specified, agent-ready' },
	{ name: 'ready-for-human', color: '008672', description: 'Requires human implementation' },
	{ name: 'difficulty:hard', color: 'EF4444', description: 'Significant effort required' },
];

export function createIssueGateway(ref: IssueRef): IssueGateway {
	const { owner, repo, issueNumber: issue_number } = ref;

	return {
		async get() {
			const [issue, comments] = await Promise.all([
				client.rest.issues.get({ owner, repo, issue_number }),
				client.paginate(client.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 }),
			]);
			return {
				number: issue.data.number,
				title: issue.data.title,
				body: issue.data.body ?? '',
				state: issue.data.state as 'open' | 'closed',
				labels: issue.data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
				comments: comments.map((c) => ({
					id: c.id,
					author: c.user?.login ?? '',
					body: c.body ?? '',
					createdAt: c.created_at,
				})),
				author: issue.data.user?.login ?? '',
			};
		},

		async addLabels(names) {
			await client.rest.issues.addLabels({ owner, repo, issue_number, labels: names });
		},

		async removeLabel(name) {
			try {
				await client.rest.issues.removeLabel({ owner, repo, issue_number, name });
			} catch (err) {
				if (err && typeof err === 'object' && 'status' in err && err.status === 404) return;
				throw err;
			}
		},

		async postComment(body) {
			await client.rest.issues.createComment({ owner, repo, issue_number, body });
		},

		async close() {
			await client.rest.issues.update({ owner, repo, issue_number, state: 'closed' });
		},

		async ensureLabels(defs) {
			const existing = await client.paginate(client.rest.issues.listLabelsForRepo, { owner, repo, per_page: 100 });
			const existingNames = new Set(existing.map((l) => l.name));
			await Promise.all(
				defs
					.filter((d) => !existingNames.has(d.name))
					.map((d) =>
						client.rest.issues.createLabel({
							owner,
							repo,
							name: d.name,
							color: d.color,
							description: d.description ?? '',
						}),
					),
			);
		},

		async readRepoFile(path) {
			try {
				const res = await client.rest.repos.getContent({ owner, repo, path });
				const data = res.data;
				if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return null;
				return Buffer.from(data.content, 'base64').toString('utf8');
			} catch (err) {
				if (err && typeof err === 'object' && 'status' in err && err.status === 404) return null;
				throw err;
			}
		},
	};
}
