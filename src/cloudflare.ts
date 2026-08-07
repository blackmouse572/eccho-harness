// Worker-level Cloudflare code: an application-owned Durable Object that tracks
// GitHub conversation state (admission dedup, push-burst coalescing, lifecycle),
// plus the scheduled handler that prunes stale records and triggers retention
// cleanup.
//
// Named exports become Worker exports; Flue keeps HTTP composition in app.ts.
import { DurableObject } from 'cloudflare:workers';
import { dispatch } from '@flue/runtime';

const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ConversationRecord {
	key: string;
	owner: string;
	repo: string;
	number: number;
	kind: 'pr' | 'issue';
	agents: string[];
}

interface StateEnv {
	FLUE_SYNCHRONIZE_COOLDOWN_SECONDS?: string;
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
// dedup), pending push-burst heads awaiting a coalesced review, whether the
// conversation is open/closed, and the agent instances involved (so the
// scheduled handler can address exactly the objects that exist). Singleton
// instance addressed by name 'default'.
export class FlueGithubState extends DurableObject<StateEnv> {
	constructor(ctx: DurableObjectState, env: StateEnv) {
		super(ctx, env);
		this.ensureSchema();
	}

	private ensureSchema(): void {
		const sql = this.ctx.storage.sql;
		sql.exec('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL)');
		sql.exec(`CREATE TABLE IF NOT EXISTS conversations (
			key TEXT PRIMARY KEY,
			owner TEXT NOT NULL,
			repo TEXT NOT NULL,
			number INTEGER NOT NULL,
			kind TEXT NOT NULL,
			agents TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'open',
			last_head_sha TEXT,
			last_dispatch_at INTEGER,
			last_activity_at INTEGER NOT NULL,
			closed_at INTEGER,
			pending_head TEXT,
			pending_since INTEGER
		)`);
		// Add columns to tables deployed before they existed (idempotent).
		const columns = new Set(sql.exec('PRAGMA table_info(conversations)').toArray().map((row) => String(row.name)));
		if (!columns.has('pending_head')) sql.exec('ALTER TABLE conversations ADD COLUMN pending_head TEXT');
		if (!columns.has('pending_since')) sql.exec('ALTER TABLE conversations ADD COLUMN pending_since INTEGER');
	}

	private cooldownMs(): number {
		const seconds = Number(this.env.FLUE_SYNCHRONIZE_COOLDOWN_SECONDS ?? 300);
		return (Number.isFinite(seconds) && seconds > 0 ? seconds : 300) * 1000;
	}

	// Union the existing per-conversation agents with the ones handling this
	// event, so the cleanup cron can address every instance holding data for a
	// conversation (an issue is handled by classifier AND triager, for example).
	private mergeAgents(key: string, incoming: string[]): string {
		const row = this.ctx.storage.sql.exec('SELECT agents FROM conversations WHERE key = ?', key).toArray()[0];
		const existing = parseAgents(row?.agents);
		return JSON.stringify([...new Set([...existing, ...incoming])]);
	}

	async recordDelivery(id: string): Promise<boolean> {
		const inserted = this.ctx.storage.sql
			.exec('INSERT OR IGNORE INTO deliveries (id, seen_at) VALUES (?, ?) RETURNING id', id, Date.now())
			.toArray();
		return inserted.length > 0;
	}

	// Un-mark a delivery so a failed webhook can be reprocessed on redelivery
	// (GitHub reuses the same deliveryId when redelivering a failed delivery).
	async forgetDelivery(id: string): Promise<void> {
		this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE id = ?', id);
	}

	// Commit the reviewed head only AFTER a dispatch succeeded. Kept separate so
	// a failed dispatch never locks a head as already-reviewed.
	async markHeadDispatched(key: string, headSha: string): Promise<void> {
		this.ctx.storage.sql.exec(
			'UPDATE conversations SET last_head_sha = ?, last_activity_at = ?, pending_head = NULL, pending_since = NULL WHERE key = ?',
			headSha,
			Date.now(),
			key,
		);
	}

	// Record a dispatch. Returns false when the PR head was already dispatched,
	// so the webhook can skip the redundant review run. Clears any coalesced
	// pending head — a full review covers the whole PR.
	async noteDispatch(record: ConversationRecord & { headSha?: string }): Promise<boolean> {
		const now = Date.now();
		if (record.headSha) {
			const existing = this.ctx.storage.sql.exec('SELECT last_head_sha FROM conversations WHERE key = ?', record.key).toArray()[0];
			if (existing && existing.last_head_sha === record.headSha) {
				this.ctx.storage.sql.exec(
					'UPDATE conversations SET last_activity_at = ?, last_dispatch_at = ?, pending_head = NULL, pending_since = NULL WHERE key = ?',
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
			   last_activity_at = excluded.last_activity_at,
			   pending_head = NULL, pending_since = NULL`,
			record.key,
			record.owner,
			record.repo,
			record.number,
			record.kind,
			this.mergeAgents(record.key, record.agents),
			record.headSha ?? null,
			now,
			now,
		);
		return true;
	}

	// Synchronize handling with trailing-edge debounce: a push within the
	// cooldown window after the last dispatch is remembered as `pending_head`
	// and reviewed by the alarm once the burst goes quiet. Returns whether the
	// webhook should dispatch a review now. The reviewed head is NOT committed
	// here — the webhook calls `markHeadDispatched` only after the dispatch
	// succeeds, so a failed dispatch stays retryable.
	async maybeDispatchSynchronize(record: ConversationRecord & { headSha: string }): Promise<boolean> {
		const now = Date.now();
		const cooldown = this.cooldownMs();
		const existing = this.ctx.storage.sql
			.exec('SELECT last_head_sha, last_dispatch_at FROM conversations WHERE key = ?', record.key)
			.toArray()[0];
		const lastHead = typeof existing?.last_head_sha === 'string' ? existing.last_head_sha : null;
		const lastDispatchAt = typeof existing?.last_dispatch_at === 'number' ? existing.last_dispatch_at : 0;

		if (lastHead === record.headSha) return false;

		if (now - lastDispatchAt < cooldown) {
			this.ctx.storage.sql.exec(
				`INSERT INTO conversations (key, owner, repo, number, kind, agents, state, pending_head, pending_since, last_activity_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET
				   owner = excluded.owner, repo = excluded.repo, number = excluded.number, kind = excluded.kind,
				   agents = excluded.agents,
				   state = CASE WHEN conversations.state = 'closed' THEN 'open' ELSE conversations.state END,
				   pending_head = excluded.pending_head, pending_since = excluded.pending_since,
				   last_activity_at = excluded.last_activity_at`,
				record.key,
				record.owner,
				record.repo,
				record.number,
				record.kind,
				this.mergeAgents(record.key, record.agents),
				record.headSha,
				now,
				now,
			);
			await this.ctx.storage.setAlarm(now + cooldown);
			return false;
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO conversations (key, owner, repo, number, kind, agents, state, last_dispatch_at, last_activity_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
			 ON CONFLICT(key) DO UPDATE SET
			   owner = excluded.owner, repo = excluded.repo, number = excluded.number, kind = excluded.kind,
			   agents = excluded.agents,
			   state = CASE WHEN conversations.state = 'closed' THEN 'open' ELSE conversations.state END,
			   last_dispatch_at = excluded.last_dispatch_at,
			   last_activity_at = excluded.last_activity_at,
			   pending_head = NULL, pending_since = NULL`,
			record.key,
			record.owner,
			record.repo,
			record.number,
			record.kind,
			this.mergeAgents(record.key, record.agents),
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
			   state = 'closed', closed_at = ?, last_activity_at = ?, pending_head = NULL, pending_since = NULL`,
			record.key,
			record.owner,
			record.repo,
			record.number,
			record.kind,
			this.mergeAgents(record.key, record.agents),
			now,
			now,
			now,
			now,
		);
	}

	// Alarm: dispatch the coalesced review for push bursts that have gone quiet,
	// then re-arm while any pending head remains.
	async alarm(): Promise<void> {
		const now = Date.now();
		const cooldown = this.cooldownMs();
		const due = this.ctx.storage.sql
			.exec(
				`SELECT key, owner, repo, number, agents, pending_head
				 FROM conversations
				 WHERE pending_head IS NOT NULL AND pending_since + ? <= ?`,
				cooldown,
				now,
			)
			.toArray();

		for (const row of due) {
			const key = String(row.key);
			const head = typeof row.pending_head === 'string' ? row.pending_head : null;
			if (!key || !head) continue;
			try {
				await dispatch({
					agent: 'pr-reviewer',
					id: key,
					input: {
						type: 'github.pull_request.review',
						command: 'incremental',
						deliveryId: `coalesced:${head.slice(0, 12)}`,
						owner: String(row.owner),
						repo: String(row.repo),
						pr: Number(row.number),
						after: head,
						reason: 'Coalesced push burst — reviewing the latest head.',
					},
				});
			} catch (error) {
				console.warn('[github] coalesced review dispatch failed', key, error);
				continue;
			}
			this.ctx.storage.sql.exec(
				'UPDATE conversations SET last_head_sha = ?, last_dispatch_at = ?, last_activity_at = ?, pending_head = NULL, pending_since = NULL WHERE key = ?',
				head,
				now,
				now,
				key,
			);
		}

		const remaining = this.ctx.storage.sql
			.exec('SELECT MIN(pending_since) AS earliest FROM conversations WHERE pending_head IS NOT NULL')
			.toArray()[0];
		if (remaining && typeof remaining.earliest === 'number') {
			// Never re-arm in the past: a failed dispatch (or a late alarm) leaves
			// pending_since behind, so clamp to at least a full cooldown from now
			// to avoid a tight retry loop.
			const next = Math.max(now + cooldown, remaining.earliest + cooldown);
			await this.ctx.storage.setAlarm(next);
		}
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
