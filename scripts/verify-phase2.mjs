import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(lcaHome, ".env");
const globalConfig = join(lcaHome, "automations.yaml");
const dbPath = join(lcaHome, "state.sqlite");
const port = 3747;
const base = `http://127.0.0.1:${port}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    return false;
  }
  console.log("OK:", msg);
  return true;
}

function envHasApiKey() {
  if (!existsSync(envPath)) return false;
  const raw = readFileSync(envPath, "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("CURSOR_API_KEY="));
  if (!line) return false;
  const value = line.slice("CURSOR_API_KEY=".length).trim();
  return value.length > 10;
}

if (!envHasApiKey()) {
  console.error(
    "SKIP: CURSOR_API_KEY not set in ~/.cursor-local-automations/.env — add your key and re-run."
  );
  process.exit(0);
}

mkdirSync(lcaHome, { recursive: true });
writeFileSync(
  globalConfig,
  `workspaces:\n  - ${repoRoot.replace(/\\/g, "/")}\n\nautomations: []\n`,
  "utf8"
);

let log = "";
const daemon = spawn("node", ["packages/daemon/dist/index.js"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
daemon.stdout.on("data", (d) => {
  log += d.toString();
});
daemon.stderr.on("data", (d) => {
  log += d.toString();
});

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  return false;
}

async function getSampleAutomationId() {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare(
      `SELECT id FROM automations WHERE name LIKE 'Sample%' ORDER BY updated_at DESC LIMIT 1`
    )
    .get();
  db.close();
  return row?.id;
}

async function triggerRun(automationId) {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ automationId }),
  });
  if (!res.ok) {
    throw new Error(`trigger failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.runId;
}

async function getRun(runId) {
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) {
    throw new Error(`get run failed: ${res.status}`);
  }
  return res.json();
}

await sleep(500);
assert(await waitForHealth(), "daemon HTTP /health responds");

const automationId = await getSampleAutomationId();
assert(Boolean(automationId), `sample automation found (${automationId})`);

const runId = await triggerRun(automationId);
assert(Boolean(runId), `run triggered (${runId})`);

let terminal = null;
let eventCount = 0;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const snap = await getRun(runId);
  eventCount = snap.events?.length ?? 0;
  const status = snap.run?.status;
  if (status === "completed" || status === "failed" || status === "cancelled") {
    terminal = status;
    break;
  }
  if (status === "running" && eventCount >= 1) {
    // enough to attempt resume test
    break;
  }
  await sleep(1000);
}

assert(eventCount >= 1, `run_events streamed (${eventCount} event(s))`);

if (terminal === "completed") {
  assert(true, "run reached completed");
} else if (terminal === "failed") {
  console.error("Run failed — check daemon log and CURSOR_API_KEY");
  process.exitCode = 1;
} else {
  // Resume test: kill daemon mid-run, restart, re-attach
  const eventsBefore = eventCount;
  daemon.kill("SIGTERM");
  await sleep(2000);

  log = "";
  const daemon2 = spawn("node", ["packages/daemon/dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon2.stderr.on("data", (d) => {
    log += d.toString();
  });

  assert(await waitForHealth(15000), "daemon restarted after kill");

  const resumeDeadline = Date.now() + 180_000;
  let finalStatus = null;
  while (Date.now() < resumeDeadline) {
    const snap = await getRun(runId);
    finalStatus = snap.run?.status;
    if (finalStatus === "completed" || finalStatus === "failed") {
      break;
    }
    await sleep(1000);
  }

  assert(
    log.includes("Re-attaching"),
    "daemon logged re-attach on restart"
  );
  const snap = await getRun(runId);
  const eventsAfter = snap.events?.length ?? 0;
  assert(
    finalStatus === "completed" || eventsAfter > eventsBefore,
    `run progressed after resume (status=${finalStatus}, events=${eventsAfter})`
  );

  daemon2.kill("SIGTERM");
  await sleep(500);
}

daemon.kill("SIGTERM");
await sleep(500);

if (process.exitCode) {
  console.error("\n--- daemon log ---\n", log);
} else {
  console.log("\nPhase 2 verification passed.");
}
