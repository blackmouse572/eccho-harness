// Worker-level Cloudflare code: an application-owned Durable Object that tracks
// GitHub conversation state (admission dedup + lifecycle), plus the scheduled
// handler that prunes stale records and triggers retention cleanup.
//
// Named exports become Worker exports; Flue keeps HTTP composition in app.ts.
import { DurableObject } from 'cloudflare:workers';

const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ConversationRecord {
	key: string;
	owner: string;
	repo: string;
	number: number;
	kind: 'pr' | 'issue';
	agents: string[];
}

function toRecord(row: Record<string, unknown>): ConversationRecord {
	return {
		key: String(row.key),
		owner: String(row.owner),
		repo: String(row.repo),
		number: Number(row.number),
		kind: row.kind === 'issue' ? 'issue' : 'pr',
		agents: parseAgents(row.agents),
	};
}

function parseAgents(value: unknown): string[] {
	if (typeof value !== 'string') return [];
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

// Per-conversation GitHub state: which head SHA was last dispatched (PR review
// dedup), whether the conversation is open/closed, and the agent instances
// involved (so the scheduled handler can address exactly the objects that
// exist). Singleton instance addressed by name 'default'.
export class FlueGithubState extends DurableObject {
	async recordDelivery(id: string): Promise<boolean> {
		const inserted = this.ctx.storage.sql
			.exec('INSERT OR IGNORE INTO deliveries (id, seen_at) VALUES (?, ?) RETURNING id', id, Date.now())
			.toArray();
		return inserted.length > 0;
	}

	// Record a dispatch. Returns false when the PR head was already dispatched,
	// so the webhook can skip the redundant review run.
	async noteDispatch(record: ConversationRecord & { headSha?: string }): Promise<boolean> {
		const now = Date.now();
		if (record.headSha) {
			const existing = this.ctx.storage.sql.exec('SELECT last_head_sha FROM conversations WHERE key = ?', record.key).toArray()[0];
			if (existing && existing.last_head_sha === record.headSha) {
				this.ctx.storage.sql.exec(
					'UPDATE conversations SET last_activity_at = ?, last_dispatch_at = ? WHERE key = ?',
					now,
					now,
					record.key,
				);
				return false;
			}
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO conversations (key, owner, repo, number, kind, agents, state, last_head_sha, last_dispatch_at, last_activity_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   owner = excluded.owner, repo = excluded.repo, number = excluded.number, kind = excluded.kind,
			   agents = excluded.agents,
			   state = CASE WHEN conversations.state = 'closed' THEN 'open' ELSE conversations.state END,
			   last_head_sha = excluded.last_head_sha,
			   last_dispatch_at = excluded.last_dispatch_at,
			   last_activity_at = excluded.last_activity_at`,
			record.key,
			record.owner,
			record.repo,
			record.number,
			record.kind,
			JSON.stringify(record.agents),
			record.headSha ?? null,
			now,
			now,
		);
		return true;
	}

	async markClosed(record: ConversationRecord): Promise<void> {
		const now = Date.now();
		this.ctx.storage.sql.exec(
			`INSERT INTO conversations (key, owner, repo, number, kind, agents, state, last_activity_at, closed_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'closed', ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   state = 'closed', closed_at = ?, last_activity_at = ?`,
			record.key,
			record.owner,
			record.repo,
			record.number,
			record.kind,
			JSON.stringify(record.agents),
			now,
			now,
			now,
			now,
		);
	}

	// Conversations past their retention window (closed or idle), with the
	// agent instances that hold data for each.
	async listCleanupCandidates(cutoffMs: number): Promise<Array<ConversationRecord>> {
		const rows = this.ctx.storage.sql
			.exec(
				`SELECT key, owner, repo, number, kind, agents
				 FROM conversations
				 WHERE (state = 'closed' AND closed_at < ?) OR last_activity_at < ?`,
				cutoffMs,
				cutoffMs,
			)
			.toArray();
		return rows.map(toRecord);
	}

	async prune(cutoffMs: number, deliveryRetentionMs: number = DELIVERY_RETENTION_MS): Promise<{
		conversations: number;
		deliveries: number;
	}> {
		const conversations = this.ctx.storage.sql
			.exec(
				`DELETE FROM conversations WHERE (state = 'closed' AND closed_at < ?) OR last_activity_at < ? RETURNING key`,
				cutoffMs,
				cutoffMs,
			)
			.toArray().length;
		const deliveries = this.ctx.storage.sql
			.exec('DELETE FROM deliveries WHERE seen_at < ? RETURNING id', Date.now() - deliveryRetentionMs)
			.toArray().length;
		return { conversations, deliveries };
	}
}

interface Env {
	FLUE_GITHUB_STATE: DurableObjectNamespace<FlueGithubState>;
	FLUE_PR_REVIEWER_AGENT: DurableObjectNamespace<unknown>;
	FLUE_ISSUE_CLASSIFIER_AGENT: DurableObjectNamespace<unknown>;
	FLUE_ISSUE_TRIAGER_AGENT: DurableObjectNamespace<unknown>;
	FLUE_RETENTION_DAYS?: string;
}

function agentNamespace(env: Env, agent: string): DurableObjectNamespace<unknown> | undefined {
	switch (agent) {
		case 'pr-reviewer':
			return env.FLUE_PR_REVIEWER_AGENT;
		case 'issue-classifier':
			return env.FLUE_ISSUE_CLASSIFIER_AGENT;
		case 'issue-triager':
			return env.FLUE_ISSUE_TRIAGER_AGENT;
		default:
			return undefined;
	}
}

interface CleanupRpc {
	cleanupRetention(cutoffMs?: number): Promise<unknown>;
}

export default {
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const days = Number(env.FLUE_RETENTION_DAYS ?? 30);
		const cutoffMs = Date.now() - (Number.isFinite(days) && days > 0 ? days : 30) * 24 * 60 * 60 * 1000;

		const state = env.FLUE_GITHUB_STATE.get(env.FLUE_GITHUB_STATE.idFromName('default'));
		const candidates = await state.listCleanupCandidates(cutoffMs);
		console.log(`[retention] scheduled cleanup: ${candidates.length} stale conversation(s)`);

		for (const candidate of candidates) {
			for (const agent of candidate.agents) {
				const ns = agentNamespace(env, agent);
				if (!ns) continue;
				const stub = ns.get(ns.idFromName(candidate.key)) as unknown as CleanupRpc;
				ctx.waitUntil(stub.cleanupRetention(cutoffMs).catch((error) => console.warn('[retention] cleanup failed', candidate.key, error)));
			}
		}

		const pruned = await state.prune(cutoffMs);
		console.log(`[retention] pruned ${pruned.conversations} conversation(s), ${pruned.deliveries} delivery(s)`);
	},
};
