import { test, expect, describe, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cleanupRetainedData, type Sql } from './retention.ts';

const INSTANCE = 'github:v1:owner:o:repo:r:issue:1';
const OTHER_INSTANCE = 'github:v1:owner:o:repo:r:issue:2';
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function sessionKey(instanceId: string, session = 'default'): string {
	return `agent-session:${JSON.stringify([instanceId, 'default', session])}`;
}

function adapt(db: Database): Sql {
	return {
		exec(query, ...bindings) {
			const stmt = db.prepare(query);
			const rows = stmt.all(...(bindings as never[])) as Array<Record<string, unknown>>;
			return { toArray: () => rows };
		},
	};
}

function schema(db: Database): void {
	db.exec(`CREATE TABLE flue_sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
	db.exec(`CREATE TABLE flue_session_entries (
		session_id TEXT NOT NULL, entry_id TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL,
		PRIMARY KEY (session_id, entry_id))`);
	db.exec(`CREATE TABLE flue_agent_submissions (
		sequence INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL UNIQUE, session_key TEXT NOT NULL,
		kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, accepted_at INTEGER NOT NULL)`);
	db.exec(`CREATE TABLE flue_agent_turn_journals (
		submission_id TEXT PRIMARY KEY, stream_key TEXT)`);
	db.exec(`CREATE TABLE flue_agent_stream_chunks (
		stream_key TEXT NOT NULL, segment_index INTEGER NOT NULL, body TEXT NOT NULL,
		PRIMARY KEY (stream_key, segment_index))`);
	db.exec(`CREATE TABLE flue_image_chunks (
		owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, owner_part TEXT NOT NULL, image_id TEXT NOT NULL,
		chunk_index INTEGER NOT NULL, chunk_count INTEGER NOT NULL, data TEXT NOT NULL,
		PRIMARY KEY (owner_kind, owner_id, owner_part, image_id, chunk_index))`);
	db.exec(`CREATE TABLE flue_agent_attempt_markers (
		submission_id TEXT NOT NULL, attempt_id TEXT NOT NULL, created_at INTEGER NOT NULL,
		PRIMARY KEY (submission_id, attempt_id))`);
}

function addSession(db: Database, key: string, data = '{}'): void {
	db.prepare('INSERT INTO flue_sessions (id, data) VALUES (?, ?)').run(key, data);
}

function addSubmission(db: Database, key: string, submissionId: string, status: string, acceptedAt: number): void {
	db.prepare(
		'INSERT INTO flue_agent_submissions (submission_id, session_key, kind, payload, status, accepted_at) VALUES (?, ?, ?, ?, ?, ?)',
	).run(submissionId, key, 'direct', '{}', status, acceptedAt);
}

let db: Database;
let sql: Sql;

beforeEach(() => {
	db = new Database(':memory:');
	schema(db);
	sql = adapt(db);
});

describe('cleanupRetainedData', () => {
	test('prunes stale sessions and their submissions, entries, journals, chunks', () => {
		const key = sessionKey(INSTANCE);
		addSession(db, key);
		addSubmission(db, key, 'sub-1', 'settled', NOW - 40 * DAY);
		addSubmission(db, key, 'sub-2', 'settled', NOW - 40 * DAY);
		db.prepare('INSERT INTO flue_session_entries (session_id, entry_id, position, data) VALUES (?, ?, 0, ?)').run(key, 'e1', '{}');
		db.prepare('INSERT INTO flue_agent_turn_journals (submission_id, stream_key) VALUES (?, ?)').run('sub-1', 'stream-1');
		db.prepare('INSERT INTO flue_agent_stream_chunks (stream_key, segment_index, body) VALUES (?, 0, ?)').run('stream-1', '{}');
		db.prepare('INSERT INTO flue_image_chunks (owner_kind, owner_id, owner_part, image_id, chunk_index, chunk_count, data) VALUES (?, ?, ?, ?, 0, 1, ?)').run('submission', 'sub-1', '', 'img', '{}');
		db.prepare('INSERT INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at) VALUES (?, ?, ?)').run('sub-2', 'a', NOW - 40 * DAY);

		const result = cleanupRetainedData(sql, INSTANCE, NOW - 30 * DAY);

		expect(result).toEqual({ sessions: 1, submissions: 2 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_sessions').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_session_entries').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_agent_submissions').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_agent_turn_journals').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_agent_stream_chunks').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_image_chunks').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_agent_attempt_markers').get()).toEqual({ n: 0 });
	});

	test('keeps sessions with recent activity', () => {
		const key = sessionKey(INSTANCE);
		addSession(db, key);
		addSubmission(db, key, 'sub-1', 'settled', NOW - 1 * DAY);

		const result = cleanupRetainedData(sql, INSTANCE, NOW - 30 * DAY);

		expect(result).toEqual({ sessions: 0, submissions: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_sessions').get()).toEqual({ n: 1 });
	});

	test('keeps sessions with unsettled (queued/running/terminalizing) submissions', () => {
		for (const status of ['queued', 'running', 'terminalizing']) {
			const key = sessionKey(INSTANCE, status);
			addSession(db, key);
			addSubmission(db, key, `sub-${status}`, status, NOW - 40 * DAY);
		}

		const result = cleanupRetainedData(sql, INSTANCE, NOW - 30 * DAY);

		expect(result).toEqual({ sessions: 0, submissions: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_sessions').get()).toEqual({ n: 3 });
	});

	test('ignores sessions owned by other instances', () => {
		const key = sessionKey(OTHER_INSTANCE);
		addSession(db, key);
		addSubmission(db, key, 'sub-1', 'settled', NOW - 40 * DAY);

		const result = cleanupRetainedData(sql, INSTANCE, NOW - 30 * DAY);

		expect(result).toEqual({ sessions: 0, submissions: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_sessions').get()).toEqual({ n: 1 });
	});

	test('prunes child task sessions via the session tree', () => {
		const key = sessionKey(INSTANCE);
		const childKey = sessionKey(INSTANCE, `task:default:9e1e7c2e-9a3b-4c5d-8e6f-7a8b9c0d1e2f`);
		addSession(db, key, JSON.stringify({ childSessions: [{ type: 'task', session: 'task:default:9e1e7c2e-9a3b-4c5d-8e6f-7a8b9c0d1e2f', taskId: '9e1e7c2e-9a3b-4c5d-8e6f-7a8b9c0d1e2f' }] }));
		addSubmission(db, key, 'sub-1', 'settled', NOW - 40 * DAY);
		addSession(db, childKey);
		db.prepare('INSERT INTO flue_session_entries (session_id, entry_id, position, data) VALUES (?, ?, 0, ?)').run(childKey, 'e1', '{}');

		const result = cleanupRetainedData(sql, INSTANCE, NOW - 30 * DAY);

		expect(result).toEqual({ sessions: 2, submissions: 1 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_sessions').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM flue_session_entries').get()).toEqual({ n: 0 });
	});

	test('is idempotent across runs', () => {
		const key = sessionKey(INSTANCE);
		addSession(db, key);
		addSubmission(db, key, 'sub-1', 'settled', NOW - 40 * DAY);

		cleanupRetainedData(sql, INSTANCE, NOW - 30 * DAY);
		const second = cleanupRetainedData(sql, INSTANCE, NOW - 30 * DAY);

		expect(second).toEqual({ sessions: 0, submissions: 0 });
	});
});
