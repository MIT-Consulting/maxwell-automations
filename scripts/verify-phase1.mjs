import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const globalConfig = join(lcaHome, "automations.yaml");
const dbPath = join(lcaHome, "state.sqlite");

mkdirSync(lcaHome, { recursive: true });
writeFileSync(
  globalConfig,
  `workspaces:\n  - ${repoRoot.replace(/\\/g, "/")}\n\nautomations: []\n`,
  "utf8"
);

const daemon = spawn("node", ["packages/daemon/dist/index.js"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});

let log = "";
daemon.stdout.on("data", (d) => {
  log += d.toString();
});
daemon.stderr.on("data", (d) => {
  log += d.toString();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(200);
  }
  return false;
}

function queryAutomations() {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      "SELECT id, name, enabled FROM automations ORDER BY name"
    )
    .all();
  db.close();
  return rows;
}

let failed = false;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = true;
  } else {
    console.log("OK:", msg);
  }
}

const dbReady = await waitFor(() => existsSync(dbPath), 10000);
assert(dbReady, "SQLite database file exists");
await sleep(300);

const initial = queryAutomations();
assert(
  initial.some((r) => r.name === "Sample Hello"),
  `sample automation loaded (${initial.length} row(s))`
);

const samplePath = join(repoRoot, ".cursor", "automations", "sample.yaml");
const original = readFileSync(samplePath, "utf8");
writeFileSync(
  samplePath,
  original.replace("Sample Hello", "Sample Hello Updated"),
  "utf8"
);

const sawUpdate = await waitFor(() => {
  try {
    return queryAutomations().some((r) => r.name === "Sample Hello Updated");
  } catch {
    return false;
  }
}, 10000);
assert(sawUpdate, "YAML edit reconciled into automations table (watch works)");

writeFileSync(samplePath, original, "utf8");

daemon.kill("SIGTERM");
await sleep(500);

if (failed) {
  console.error("\n--- daemon log ---\n", log);
  process.exit(1);
}
console.log("\nPhase 1 verification passed.");
