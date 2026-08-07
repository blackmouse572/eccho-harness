// Retention helpers for Cloudflare Durable Object storage.
//
// Flue persists agent sessions, submissions, turn journals, and stream chunks
// in the owning Durable Object's SQLite, and prunes none of it automatically.
// Long-lived per-conversation agent instances therefore accumulate records
// until the account's storage ceiling. These helpers mirror the runtime's own
// `deleteSession`/`runSessionDeletion` SQL (sql-run-store) to reclaim old
// records from inside the owning object. They are deliberately defensive:
// they no-op on missing tables and never touch sessions with active work.
import { extend, type CloudflareAgentLike } from '@flue/runtime/cloudflare';

const SESSION_KEY_PREFIX = 'agent-session:';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Structural subset of Cloudflare's DO SQLite surface used here.
export interface Sql {
	exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

interface SessionKey {
	instanceId: string;
	harness: string;
	session: string;
}

function sessionStorageKey(instanceId: string, harness: string, session: string): string {
	return `${SESSION_KEY_PREFIX}${JSON.stringify([instanceId, harness, session])}`;
}

function parseSessionKey(id: string): SessionKey | null {
	if (!id.startsWith(SESSION_KEY_PREFIX)) return null;
	try {
		const value = JSON.parse(id.slice(SESSION_KEY_PREFIX.length)) as unknown;
		if (Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'string')) {
			const parts = value as [string, string, string];
			return { instanceId: parts[0], harness: parts[1], session: parts[2] };
		}
	} catch {}
	return null;
}

// Mirrors @flue/runtime childSessionStorageKey: task children keep the parent
// harness and get a task-scoped session; action children get a scoped harness.
function childSessionStorageKey(parent: SessionKey, child: unknown): string | null {
	if (!child || typeof child !== 'object') return null;
	const { type, session } = child as Record<string, unknown>;
	if (typeof session !== 'string') return null;
	if (type === 'task') {
		const { taskId } = child as Record<string, unknown>;
		if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) return null;
		if (session !== `task:${parent.session}:${taskId}`) return null;
		return sessionStorageKey(parent.instanceId, parent.harness, session);
	}
	if (type === 'action') {
		const { invocationId } = child as Record<string, unknown>;
		if (typeof invocationId !== 'string' || !UUID_PATTERN.test(invocationId)) return null;
		return sessionStorageKey(parent.instanceId, `${parent.harness}:action:${invocationId}`, session);
	}
	return null;
}

// Collect a session and its (recursive) child task/action sessions.
function collectSessionTree(sql: Sql, rootKey: string): string[] {
	const keys: string[] = [];
	const seen = new Set<string>();
	const visit = (key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		keys.push(key);
		const row = sql.exec('SELECT data FROM flue_sessions WHERE id = ?', key).toArray()[0];
		if (!row || typeof row.data !== 'string') return;
		const parent = parseSessionKey(key);
		if (!parent) return;
		try {
			const data = JSON.parse(row.data) as { childSessions?: unknown[] };
			for (const child of data.childSessions ?? []) {
				const childKey = childSessionStorageKey(parent, child);
				if (childKey) visit(childKey);
			}
		} catch {}
	};
	visit(rootKey);
	return keys;
}

function hasUnsettledSubmissions(sql: Sql, sessionKey: string): boolean {
	return (
		sql
			.exec(
				"SELECT 1 FROM flue_agent_submissions WHERE session_key = ? AND status IN ('queued','running','terminalizing') LIMIT 1",
				sessionKey,
			)
			.toArray().length > 0
	);
}

function sessionLastActivity(sql: Sql, sessionKey: string): number {
	const row = sql
		.exec('SELECT COALESCE(MAX(accepted_at), 0) AS last FROM flue_agent_submissions WHERE session_key = ?', sessionKey)
		.toArray()[0];
	return row && typeof row.last === 'number' ? row.last : 0;
}

// Remove settled submissions older than the cutoff for one session key, along
// with their turn journals, stream chunks, image chunks, and attempt markers.
function deleteSettledSubmissions(sql: Sql, sessionKey: string, cutoffMs: number): number {
	const rows = sql
		.exec(
			"DELETE FROM flue_agent_submissions WHERE session_key = ? AND status = 'settled' AND accepted_at <= ? RETURNING submission_id",
			sessionKey,
			cutoffMs,
		)
		.toArray();
	const ids = rows.map((row) => (typeof row.submission_id === 'string' ? row.submission_id : null)).filter(Boolean);
	if (ids.length === 0) return 0;
	const placeholders = ids.map(() => '?').join(', ');
	sql.exec(
		`DELETE FROM flue_agent_stream_chunks WHERE stream_key IN (SELECT stream_key FROM flue_agent_turn_journals WHERE submission_id IN (${placeholders}) AND stream_key IS NOT NULL)`,
		...ids,
	);
	sql.exec(`DELETE FROM flue_agent_turn_journals WHERE submission_id IN (${placeholders})`, ...ids);
	sql.exec(`DELETE FROM flue_image_chunks WHERE owner_kind = 'submission' AND owner_id IN (${placeholders})`, ...ids);
	sql.exec(`DELETE FROM flue_agent_attempt_markers WHERE submission_id IN (${placeholders})`, ...ids);
	return ids.length;
}

function deleteSessionData(sql: Sql, key: string): void {
	sql.exec("DELETE FROM flue_image_chunks WHERE owner_kind = 'session_entry' AND owner_id = ?", key);
	sql.exec('DELETE FROM flue_session_entries WHERE session_id = ?', key);
	sql.exec('DELETE FROM flue_sessions WHERE id = ?', key);
}

export interface RetentionResult {
	sessions: number;
	submissions: number;
}

// Reclaim every session owned by `instanceId` whose last submission was
// accepted before `cutoffMs`. Returns how many sessions/submissions were
// removed. Failures are logged and never thrown, so a schema drift in the
// Flue runtime can only degrade cleanup, not break agent execution.
export function cleanupRetainedData(sql: Sql, instanceId: string, cutoffMs: number): RetentionResult {
	const result: RetentionResult = { sessions: 0, submissions: 0 };
	const seen = new Set<string>();
	try {
		const rows = sql.exec('SELECT id FROM flue_sessions').toArray();
		for (const row of rows) {
			if (typeof row.id !== 'string') continue;
			const parsed = parseSessionKey(row.id);
			if (!parsed || parsed.instanceId !== instanceId) continue;
			// A child session may also be listed as a row of its own after its
			// parent was already processed — only touch keys not yet reclaimed.
			const tree = collectSessionTree(sql, row.id).filter((key) => !seen.has(key));
			if (tree.length === 0) continue;
			for (const key of tree) seen.add(key);
			const active = tree.some((key) => hasUnsettledSubmissions(sql, key));
			if (active) continue;
			// Guard the whole tree: skip unless every session in it (including
			// child task/action sessions) is older than the cutoff.
			const recent = tree.some((key) => sessionLastActivity(sql, key) >= cutoffMs);
			if (recent) continue;
			for (const key of tree) result.submissions += deleteSettledSubmissions(sql, key, cutoffMs);
			for (const key of tree) deleteSessionData(sql, key);
			result.sessions += tree.length;
		}
	} catch (error) {
		console.warn('[retention] cleanup failed:', error);
	}
	return result;
}

interface CleanupAgent extends CloudflareAgentLike {
	name: string;
	ctx: { storage: { sql: Sql } };
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function retentionCutoff(overrideMs?: number): number {
	if (overrideMs !== undefined) return overrideMs;
	const days = Number(process.env.FLUE_RETENTION_DAYS ?? 30);
	const ms = Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : DEFAULT_RETENTION_MS;
	return Date.now() - ms;
}

// Cloudflare module extension that makes each generated agent DO self-maintain
// its own storage: a daily `cleanupRetention` sweep prunes sessions whose last
// activity predates the retention window. The method is also RPC-callable from
// the outer worker (`env.FLUE_*_AGENT.get(id).cleanupRetention(cutoffMs)`).
export function createRetentionExtension(intervalSeconds = 24 * 60 * 60) {
	return extend<CleanupAgent>({
		base: (Base) =>
			class extends Base {
				override async onStart(props?: Record<string, unknown>): Promise<void> {
					await super.onStart?.(props);
					await this.scheduleEvery(intervalSeconds, 'cleanupRetention');
				}

				async cleanupRetention(cutoffMs?: number): Promise<RetentionResult> {
					const result = cleanupRetainedData(this.ctx.storage.sql, this.name, retentionCutoff(cutoffMs));
					if (result.sessions > 0 || result.submissions > 0) {
						console.log(
							`[retention] ${this.name}: pruned ${result.sessions} session(s), ${result.submissions} submission(s)`,
						);
					}
					return result;
				}
			},
	});
}
