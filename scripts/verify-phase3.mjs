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
let daemon = spawn("node", ["packages/daemon/dist/index.js"], {
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

async function getAutomationId(nameLike) {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare(
      `SELECT id FROM automations WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 1`
    )
    .get(nameLike);
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

async function submitAnswer(runId, answer) {
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  if (!res.ok) {
    throw new Error(`answer failed: ${res.status} ${await res.text()}`);
  }
}

function inputRequestLifecycle(snap) {
  const rows = snap.inputRequests ?? [];
  const pending = rows.filter((r) => r.status === "pending");
  const answered = rows.filter((r) => r.status === "answered");
  return { pending, answered, rows };
}

await sleep(500);
assert(await waitForHealth(), "daemon HTTP /health responds");

const automationId = await getAutomationId("Ask User%");
assert(Boolean(automationId), `ask-user automation found (${automationId})`);

const runId = await triggerRun(automationId);
assert(Boolean(runId), `run triggered (${runId})`);

const testAnswer = "phase3-ok";
let sawNeedsInput = false;
const askDeadline = Date.now() + 240_000;

while (Date.now() < askDeadline) {
  const snap = await getRun(runId);
  const status = snap.run?.status;
  const { pending, answered } = inputRequestLifecycle(snap);

  if (status === "needs_input" && pending.length >= 1) {
    sawNeedsInput = true;
    assert(true, `run reached needs_input with pending input_request`);
    break;
  }
  if (status === "failed") {
    console.error("Run failed before needs_input");
    process.exitCode = 1;
    break;
  }
  await sleep(1500);
}

assert(sawNeedsInput, "run blocked on ask_user (needs_input)");

// Restart durability: kill daemon while paused, answer after restart
daemon.kill("SIGTERM");
await sleep(2000);

log = "";
daemon = spawn("node", ["packages/daemon/dist/index.js"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});
daemon.stderr.on("data", (d) => {
  log += d.toString();
});

assert(await waitForHealth(15000), "daemon restarted after kill");
assert(log.includes("Re-attaching"), "daemon logged re-attach on restart");

await submitAnswer(runId, testAnswer);
assert(true, `answer submitted (${testAnswer})`);

let finalStatus = null;
let sawAnsweredRequest = false;
let sawEcho = false;
const finishDeadline = Date.now() + 240_000;

while (Date.now() < finishDeadline) {
  const snap = await getRun(runId);
  finalStatus = snap.run?.status;
  const { answered } = inputRequestLifecycle(snap);
  if (answered.some((r) => r.answer === testAnswer)) {
    sawAnsweredRequest = true;
  }
  const eventText = JSON.stringify(snap.events ?? []);
  if (eventText.includes(`LCA_ANSWER=${testAnswer}`)) {
    sawEcho = true;
  }
  if (finalStatus === "completed" || finalStatus === "failed") {
    break;
  }
  await sleep(1500);
}

assert(sawAnsweredRequest, "input_requests row marked answered");
assert(
  sawEcho || finalStatus === "completed",
  `run progressed after answer (status=${finalStatus}, echo=${sawEcho})`
);

daemon.kill("SIGTERM");
await sleep(500);

if (process.exitCode) {
  console.error("\n--- daemon log ---\n", log);
} else {
  console.log("\nPhase 3 verification passed.");
}
