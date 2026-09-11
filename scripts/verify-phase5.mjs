import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(lcaHome, ".env");
const globalConfig = join(lcaHome, "automations.yaml");
const dbPath = join(lcaHome, "state.sqlite");
const port = 3749;
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
  return line.slice("CURSOR_API_KEY=".length).trim().length > 10;
}

if (!envHasApiKey()) {
  console.error(
    "SKIP: CURSOR_API_KEY not set in ~/.cursor-local-automations/.env — the daemon cannot boot without it. Add your key and re-run."
  );
  process.exit(0);
}

if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error(
    "SKIP: dashboard not built. Run `npm run build -w @lca/dashboard` first."
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
  env: { ...process.env, LCA_PORT: String(port) },
});
daemon.stdout.on("data", (d) => (log += d.toString()));
daemon.stderr.on("data", (d) => (log += d.toString()));

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

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  assert(await waitForHealth(), "daemon HTTP /health responds");

  // --- Layer A: read-only board data over REST ---
  const autos = await getJson("/api/automations");
  assert(Array.isArray(autos.automations), "GET /api/automations returns a list");
  const sample = autos.automations.find((a) => a.name === "Sample Hello");
  assert(Boolean(sample), `sample automation present (${sample?.id})`);
  assert(
    typeof sample?.enabled === "boolean" && typeof sample?.trigger === "object",
    "automation entity is camelCase-mapped (enabled, trigger)"
  );

  const ws = await getJson("/api/workspaces");
  assert(
    Array.isArray(ws.workspaces) &&
      ws.workspaces.some((w) => resolve(w.path) === repoRoot),
    "GET /api/workspaces includes repo workspace"
  );

  const runsList = await getJson("/api/runs");
  assert(Array.isArray(runsList.runs), "GET /api/runs returns a list");

  // --- Static SPA serving ---
  const indexRes = await fetch(`${base}/`);
  const indexHtml = await indexRes.text();
  assert(
    indexRes.ok && indexHtml.includes('<div id="root">'),
    "daemon serves built dashboard index.html at /"
  );
  const spaFallback = await fetch(`${base}/some/client/route`);
  assert(spaFallback.ok, "unknown non-API route falls back to SPA (history mode)");
  const apiMiss = await fetch(`${base}/api/does-not-exist`);
  assert(apiMiss.status === 404, "unknown /api/* route returns 404 (no SPA fallback)");

  // --- Layer C: arm/disarm transitions ---
  let r = await postJson(`/api/automations/${encodeURIComponent(sample.id)}/enabled`, {
    enabled: false,
  });
  assert(
    r.status === 200 && r.body.automation.enabled === false &&
      r.body.automation.status === "backlog",
    "disarm: POST enabled=false → backlog"
  );
  r = await postJson(`/api/automations/${encodeURIComponent(sample.id)}/enabled`, {
    enabled: true,
  });
  assert(
    r.status === 200 && r.body.automation.enabled === true &&
      r.body.automation.status === "enabled",
    "arm: POST enabled=true → enabled"
  );
  const missing = await postJson(
    `/api/automations/nope/enabled`,
    { enabled: true }
  );
  assert(missing.status === 404, "enable on unknown automation → 404");

  // --- Layer B: live events over WebSocket ---
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen = { status: new Set(), events: new Set(), runIds: new Set() };
  await new Promise((res, rej) => {
    socket.on("open", res);
    socket.on("error", rej);
  });
  assert(socket.readyState === WebSocket.OPEN, "WebSocket /ws connected");

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "run_status") {
      seen.status.add(msg.status);
      seen.runIds.add(msg.runId);
    } else if (msg.type === "run_event") {
      seen.events.add(msg.runId);
    }
  });

  const triggered = await postJson("/api/runs", { automationId: sample.id });
  assert(triggered.status === 201 && triggered.body.runId, "manual trigger via POST /api/runs");
  const runId = triggered.body.runId;

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (seen.runIds.has(runId) && seen.events.has(runId)) break;
    await sleep(500);
  }
  assert(seen.runIds.has(runId), "WS delivered run_status for triggered run");
  assert(seen.events.has(runId), "WS delivered run_event(s) for triggered run");
  assert(
    seen.status.has("running") ||
      seen.status.has("completed") ||
      seen.status.has("failed"),
    `WS observed a live status transition (${[...seen.status].join(", ") || "none"})`
  );

  socket.close();
}

try {
  await main();
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  daemon.kill("SIGTERM");
  await sleep(500);
  if (process.exitCode) {
    console.error("\n--- daemon log ---\n", log);
  } else {
    console.log("\nPhase 5 verification passed.");
  }
}
