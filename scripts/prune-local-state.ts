// Local maintenance: run Flue's retention prune against the local
// `.wrangler` Durable Object state (created by `flue dev` / `flue run`).
// Reclaims disk and validates the same retention logic the deployed cron uses.
//   bun scripts/prune-local-state.ts
import { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { cleanupRetainedData, type Sql } from '../src/shared/retention.ts';

const ROOT = '.wrangler/state/v3/do';
const days = Number(process.env.FLUE_RETENTION_DAYS ?? 30);
const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
const cutoffIso = new Date(cutoffMs).toISOString();

function adapt(db: Database): Sql {
	return {
		exec(query, ...bindings) {
			const stmt = db.prepare(query);
			const rows = stmt.all(...(bindings as never[])) as Array<Record<string, unknown>>;
			return { toArray: () => rows };
		},
	};
}

function hasTable(db: Database, table: string): boolean {
	return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) !== null;
}

function instanceName(db: Database): string {
	const row = db.prepare('SELECT * FROM __miniflare_do_name').get() as { name?: string } | undefined;
	return row?.name ?? '';
}

interface Summary {
	className: string;
	files: number;
	pruned: number;
	reclaimedBytes: number;
}

let totals = { files: 0, pruned: 0, reclaimed: 0 };
const byClass = new Map<string, Summary>();

for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
	if (!dir.isDirectory()) continue;
	const classDir = path.join(ROOT, dir.name);
	const summary: Summary = { className: dir.name, files: 0, pruned: 0, reclaimedBytes: 0 };
	byClass.set(dir.name, summary);

	for (const file of readdirSync(classDir)) {
		if (!file.endsWith('.sqlite') || file === 'metadata.sqlite') continue;
		const filePath = path.join(classDir, file);
		const before = (await Bun.file(filePath).size) as number;
		const db = new Database(filePath);
		const sql = adapt(db);
		const name = instanceName(db);
		let pruned = 0;

		try {
			if (hasTable(db, 'flue_runs')) {
				// Workflow-run Durable Object: each instance owns one run. A
				// terminal run older than the retention window is fully
				// disposable — drop its event stream, sessions, and run record.
				const runs = db
					.prepare("SELECT run_id, status, started_at FROM flue_runs WHERE status IN ('completed','errored') AND started_at < ?")
					.all(cutoffIso) as Array<{ run_id: string }>;
				for (const run of runs) {
					const streamPath = `runs/${run.run_id}`;
					db.prepare('DELETE FROM flue_event_stream_entries WHERE path = ?').run(streamPath);
					db.prepare('DELETE FROM flue_event_streams WHERE path = ?').run(streamPath);
					db.prepare('DELETE FROM flue_image_chunks').run();
					db.prepare('DELETE FROM flue_session_entries').run();
					db.prepare('DELETE FROM flue_sessions').run();
					db.prepare('DELETE FROM flue_runs WHERE run_id = ?').run(run.run_id);
					pruned++;
				}
			} else if (hasTable(db, 'flue_sessions')) {
				// Agent Durable Object: prune stale sessions/submissions.
				pruned += cleanupRetainedData(sql, name, cutoffMs).sessions;
			}
		} catch (error) {
			console.warn(`[prune] ${filePath}: ${error instanceof Error ? error.message : error}`);
		}

		// Reclaim free pages from deletes, even when nothing matched this run.
		if (hasTable(db, 'flue_runs') || hasTable(db, 'flue_sessions')) {
			db.exec('VACUUM');
			db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		}
		db.close();

		const after = (await Bun.file(filePath).size) as number;
		const reclaimed = Math.max(0, before - after);
		summary.files++;
		summary.pruned += pruned;
		summary.reclaimedBytes += reclaimed;
		totals.files++;
		totals.pruned += pruned;
		totals.reclaimed += reclaimed;
		console.log(`[prune] ${dir.name}/${file}: pruned=${pruned} reclaimed=${(reclaimed / 1e6).toFixed(1)}MB`);
	}
}

console.log('\n=== summary ===');
for (const s of byClass.values()) {
	if (s.files > 0) console.log(`${s.className}: ${s.files} file(s), ${s.pruned} pruned, ${(s.reclaimedBytes / 1e6).toFixed(1)}MB reclaimed`);
}
console.log(`total: ${totals.files} file(s), ${totals.pruned} pruned, ${(totals.reclaimed / 1e6).toFixed(1)}MB reclaimed`);
