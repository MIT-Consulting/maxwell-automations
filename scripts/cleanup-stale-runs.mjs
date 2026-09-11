/**
 * Mark runs stuck in running/needs_input as failed (local agent session is gone).
 * The daemon now reconciles orphaned active runs on boot (b16) and requeues or
 * fails them via the shared retry policy. Keep this script as a manual backstop
 * for unusual situations (e.g. daemon won't start, need to clear slots by hand).
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";

const dbPath = join(homedir(), ".cursor-local-automations", "state.sqlite");
const db = new Database(dbPath);
const rows = db
  .prepare(
    `SELECT id, status FROM runs WHERE status IN ('running', 'needs_input')`
  )
  .all();

if (rows.length === 0) {
  console.log("No stuck runs.");
  db.close();
  process.exit(0);
}

const stmt = db.prepare(
  `UPDATE runs SET status = 'failed', ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
);
const cancelInput = db.prepare(
  `UPDATE input_requests SET status = 'cancelled' WHERE run_id = ? AND status = 'pending'`
);

for (const row of rows) {
  stmt.run(row.id);
  cancelInput.run(row.id);
  console.log(`Marked failed: ${row.id} (was ${row.status})`);
}

db.close();
console.log(`Cleaned ${rows.length} run(s).`);
