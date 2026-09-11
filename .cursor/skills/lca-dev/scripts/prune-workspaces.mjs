// Prune orphan workspaces from the lca SQLite DB: any registered workspace whose
// directory no longer exists on disk (e.g. leftover verify temp dirs). The
// schema declares ON DELETE CASCADE from workspaces, so enabling foreign keys
// makes a single workspace delete also clear its automations, runs, events, and
// input requests. The real repo (and any live path) is always kept.
//
// Safe to run while the daemon is up (WAL + busy_timeout); the dashboard drops
// the pruned workspaces on its next refresh. Run from the repo root:
//   node .cursor/skills/lca-dev/scripts/prune-workspaces.mjs
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dbPath = join(homedir(), ".cursor-local-automations", "state.sqlite");

if (!existsSync(dbPath)) {
  console.log(`No DB at ${dbPath} - nothing to prune.`);
  process.exit(0);
}

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

const rows = db
  .prepare("SELECT id, path FROM workspaces WHERE path != '__global__'")
  .all();

const orphans = rows.filter((w) => !existsSync(w.path));

if (orphans.length === 0) {
  console.log(
    `No orphan workspaces (all ${rows.length} registered path(s) exist on disk).`
  );
  db.close();
  process.exit(0);
}

const del = db.prepare("DELETE FROM workspaces WHERE id = ?");
const prune = db.transaction((list) => {
  for (const w of list) {
    del.run(w.id);
    console.log(`  pruned ${w.path}`);
  }
});
prune(orphans);
db.close();

console.log(`Removed ${orphans.length} orphan workspace(s) and their cascaded rows.`);
