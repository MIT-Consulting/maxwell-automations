import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { stopLcaDaemons } from "./stop-lca-daemons.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(lcaHome, ".env");
const globalConfig = join(lcaHome, "automations.yaml");
const dbPath = join(lcaHome, "state.sqlite");
const port = 3752;
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
  if (process.env.CURSOR_API_KEY?.trim().length > 10) return true;
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

const configBackup = existsSync(globalConfig)
  ? readFileSync(globalConfig, "utf8")
  : null;
const repoPath = repoRoot.replace(/\\/g, "/");
const testConfig = `# b2-verify comment — preserve on workspace append\nworkspaces:\n  - ${repoPath}\n\nautomations: []\n`;

mkdirSync(lcaHome, { recursive: true });
writeFileSync(globalConfig, testConfig, "utf8");

let log = "";
let daemon = null;

function spawnDaemon() {
  daemon = spawn("node", ["packages/daemon/dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LCA_PORT: String(port) },
  });
  daemon.stdout.on("data", (d) => {
    log += d.toString();
  });
  daemon.stderr.on("data", (d) => {
    log += d.toString();
  });
}

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

async function requestJson(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
  };
}

function getSampleAutomationId() {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare(
      `SELECT id FROM automations
       WHERE name LIKE 'Sample%' AND origin = 'config' AND archived_at IS NULL
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get();
  db.close();
  return row?.id;
}

function insertTestRun(automationId, workspaceId) {
  const runId = `verify-b2-${randomUUID()}`;
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind)
     VALUES (@id, @automationId, @workspaceId, 'completed', 'manual')`
  ).run({ id: runId, automationId, workspaceId });
  db.close();
  return runId;
}

function countRunsForAutomation(automationId) {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE automation_id = ?")
    .get(automationId);
  db.close();
  return row?.n ?? 0;
}

function automationArchivedAt(automationId) {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT archived_at FROM automations WHERE id = ?")
    .get(automationId);
  db.close();
  return row?.archived_at ?? null;
}

async function listAutomations() {
  const res = await requestJson("GET", "/api/automations");
  if (res.status !== 200) {
    throw new Error(`GET /api/automations → ${res.status}`);
  }
  return res.body.automations;
}

async function findAutomation(id) {
  const automations = await listAutomations();
  return automations.find((a) => a.id === id);
}

async function main() {
  await stopLcaDaemons();
  spawnDaemon();
  await sleep(1000);
  if (!(await waitForHealth())) {
    assert(false, "daemon HTTP /health responds");
    return;
  }
  assert(true, "daemon HTTP /health responds");

  const workspacesRes = await requestJson("GET", "/api/workspaces");
  assert(workspacesRes.status === 200, "GET /api/workspaces");
  const workspaceId = workspacesRes.body.workspaces?.[0]?.id;
  assert(Boolean(workspaceId), `workspace available (${workspaceId})`);

  const sampleId = getSampleAutomationId();
  assert(Boolean(sampleId), `config-origin sample automation found (${sampleId})`);

  const createBody = {
    workspaceId,
    name: "b2-verify-main",
    trigger: { type: "manual" },
    prompt: "verify b2 create",
    enabled: true,
  };

  // 1–2. Create dashboard automation and list it
  const created = await requestJson("POST", "/api/automations", createBody);
  assert(
    created.status === 201 && created.body.automation?.origin === "dashboard",
    "POST /api/automations → 201 with origin=dashboard"
  );
  const mainId = created.body.automation.id;
  const listed = await findAutomation(mainId);
  assert(Boolean(listed), "created automation appears in GET /api/automations");

  // 3. Validation errors
  const unknownWs = await requestJson("POST", "/api/automations", {
    ...createBody,
    workspaceId: "unknown-workspace-id",
    name: "b2-verify-bad-ws",
  });
  assert(unknownWs.status === 404, "POST with unknown workspaceId → 404");

  const badTrigger = await requestJson("POST", "/api/automations", {
    ...createBody,
    name: "b2-verify-bad-trigger",
    trigger: { type: "cron" },
  });
  assert(badTrigger.status === 400, "POST with invalid trigger → 400");

  // 4. PATCH name/prompt
  const patched = await requestJson("PATCH", `/api/automations/${encodeURIComponent(mainId)}`, {
    name: "b2-verify-main-renamed",
    prompt: "verify b2 patch",
  });
  assert(patched.status === 200, "PATCH name/prompt → 200");
  const afterPatch = await findAutomation(mainId);
  assert(
    afterPatch?.name === "b2-verify-main-renamed" &&
      afterPatch?.prompt === "verify b2 patch",
    "PATCH changes reflected on re-fetch (list)"
  );

  // 8. WS automation_event on create
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((res, rej) => {
    socket.on("open", res);
    socket.on("error", rej);
  });
  assert(socket.readyState === WebSocket.OPEN, "WebSocket /ws connected");

  let wsCreated = null;
  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "automation_event" && msg.action === "created") {
      wsCreated = msg;
    }
  });

  const wsCreate = await requestJson("POST", "/api/automations", {
    workspaceId,
    name: "b2-verify-ws",
    trigger: { type: "manual" },
    prompt: "verify ws broadcast",
  });
  assert(wsCreate.status === 201, "POST automation for WS broadcast → 201");
  const wsAutomationId = wsCreate.body.automation.id;

  const wsDeadline = Date.now() + 10_000;
  while (Date.now() < wsDeadline && !wsCreated) {
    await sleep(200);
  }
  assert(
    wsCreated?.type === "automation_event" &&
      wsCreated.action === "created" &&
      wsCreated.id === wsAutomationId,
    "WS delivered automation_event action=created"
  );
  socket.close();

  // 6. Config-origin read-only
  const configPatch = await requestJson(
    "PATCH",
    `/api/automations/${encodeURIComponent(sampleId)}`,
    { name: "should-not-work" }
  );
  assert(configPatch.status === 403, "PATCH config-origin automation → 403");

  const configDelete = await requestJson(
    "DELETE",
    `/api/automations/${encodeURIComponent(sampleId)}`
  );
  assert(configDelete.status === 403, "DELETE config-origin automation → 403");

  // 9. Model clear-to-null
  const withModel = await requestJson("POST", "/api/automations", {
    workspaceId,
    name: "b2-verify-model",
    trigger: { type: "manual" },
    prompt: "verify model clear",
    model: "gpt-verify-model",
  });
  assert(withModel.status === 201, "POST automation with model → 201");
  const modelId = withModel.body.automation.id;

  const clearModel = await requestJson(
    "PATCH",
    `/api/automations/${encodeURIComponent(modelId)}`,
    { model: null }
  );
  assert(clearModel.status === 200, "PATCH { model: null } → 200");
  const afterClear = await findAutomation(modelId);
  assert(afterClear?.model === null, "re-fetch shows model === null");

  const emptyModel = await requestJson(
    "PATCH",
    `/api/automations/${encodeURIComponent(modelId)}`,
    { model: "" }
  );
  assert(emptyModel.status === 400, "PATCH { model: \"\" } → 400");

  // 5. Reconcile survival via daemon restart
  daemon.kill("SIGTERM");
  await sleep(2000);
  log = "";
  spawnDaemon();
  assert(await waitForHealth(15000), "daemon restarted for reconcile survival check");

  const survivedMain = await findAutomation(mainId);
  const survivedModel = await findAutomation(modelId);
  assert(Boolean(survivedMain), "dashboard automation survives restart/reconcile");
  assert(Boolean(survivedModel), "model automation survives restart/reconcile");
  assert(
    automationArchivedAt(mainId) === null && automationArchivedAt(modelId) === null,
    "dashboard automations not archived after restart"
  );

  // 7. Soft delete preserves run history
  const runId = insertTestRun(mainId, workspaceId);
  assert(countRunsForAutomation(mainId) >= 1, `seeded run history (${runId})`);

  const deleted = await requestJson(
    "DELETE",
    `/api/automations/${encodeURIComponent(mainId)}`
  );
  assert(deleted.status === 200 && deleted.body.ok === true, "DELETE dashboard automation → { ok: true }");
  assert(!(await findAutomation(mainId)), "deleted automation absent from GET /api/automations");
  assert(
    countRunsForAutomation(mainId) >= 1,
    "run history rows still exist in SQLite after soft delete"
  );

  // 10. Inline workspace registration
  const missingPath = join(tmpdir(), "lca-b2-missing", String(Date.now()));
  const missingRes = await requestJson("POST", "/api/workspaces", {
    path: missingPath,
  });
  assert(missingRes.status === 400, "POST /api/workspaces missing path → 400");

  const dupRes = await requestJson("POST", "/api/workspaces", { path: repoRoot });
  assert(dupRes.status === 409, "POST /api/workspaces duplicate path → 409");

  const tmpWorkspace = join(tmpdir(), `lca-b2-workspace-${Date.now()}`);
  mkdirSync(tmpWorkspace, { recursive: true });
  const addRes = await requestJson("POST", "/api/workspaces", {
    path: tmpWorkspace,
  });
  assert(addRes.status === 201, "POST /api/workspaces new path → 201");

  const yamlAfter = readFileSync(globalConfig, "utf8");
  assert(
    yamlAfter.includes("# b2-verify comment"),
    "automations.yaml preserves pre-existing comments"
  );
  const tmpResolved = resolve(tmpWorkspace);
  assert(
    yamlAfter.includes(tmpResolved) ||
      yamlAfter.includes(tmpResolved.replace(/\\/g, "/")),
    "automations.yaml appends new workspace path"
  );

  const wsList = await requestJson("GET", "/api/workspaces");
  assert(
    wsList.body.workspaces?.some(
      (w) => resolve(w.path) === resolve(tmpWorkspace)
    ),
    "GET /api/workspaces includes newly registered workspace"
  );

  rmSync(tmpWorkspace, { recursive: true, force: true });

  // Clean up other dashboard-origin test automations
  for (const id of [wsAutomationId, modelId]) {
    await requestJson("DELETE", `/api/automations/${encodeURIComponent(id)}`);
  }
}

try {
  await main();
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await sleep(500);
  }
  if (configBackup !== null) {
    writeFileSync(globalConfig, configBackup, "utf8");
  }
  if (process.exitCode) {
    console.error("\n--- daemon log ---\n", log);
  } else {
    console.log("\nb2 verification passed.");
  }
}
