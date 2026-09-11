import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../packages/daemon/dist/db/index.js";
import { DaemonEventBus } from "../packages/daemon/dist/events.js";
import { DashboardStore } from "../packages/daemon/dist/http/dashboard-store.js";
import { startHttpServer } from "../packages/daemon/dist/http/server.js";
import { InputHub } from "../packages/daemon/dist/input/hub.js";
import { InputStore } from "../packages/daemon/dist/input/store.js";
import { RunEngine } from "../packages/daemon/dist/runs/engine.js";
import { chromium } from "playwright";
import { stopLcaDaemons } from "./stop-lca-daemons.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3757;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
  console.log("OK:", msg);
}

if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error("SKIP: dashboard not built. Run `npm run build` first.");
  process.exit(0);
}

const hardExit = setTimeout(() => {
  console.error("Hard timeout reached.");
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardExit.unref();

async function rmWithRetries(path, options = {}) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      rmSync(path, options);
      return;
    } catch (err) {
      if (err?.code !== "EBUSY" || attempt === 59) {
        throw err;
      }
      await sleep(500);
    }
  }
}

function prepareTempState() {
  const root = mkdtempSync(join(tmpdir(), "lca-b6-state-"));
  const lcaHome = join(root, ".cursor-local-automations");
  mkdirSync(lcaHome, { recursive: true });
  writeFileSync(
    join(lcaHome, "automations.yaml"),
    ["workspaces: []", "", "automations: []", ""].join("\n")
  );
  return { root, dbPath: join(lcaHome, "state.sqlite") };
}

async function closeWithTimeout(browser) {
  if (!browser) return;
  await Promise.race([
    browser.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("browser.close() timed out")), CLOSE_TIMEOUT_MS)
    ),
  ]).catch(() => {});
}

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  return false;
}

async function json(path, options) {
  const res = await fetch(`${base}${path}`, options);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail}`);
  }
  return res.json();
}

function seedAutomation(db, workspacePath) {
  const suffix = Date.now();
  const workspaceId = `b6-ui-ws-${suffix}`;
  const automationId = `b6-ui-auto-${suffix}`;
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    workspaceId,
    workspacePath,
    "b6 verify temp"
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt,
      config_path, config_key, origin
    ) VALUES (?, ?, ?, 1, 'enabled', '{"type":"manual"}', ?, '__dashboard__', ?, 'dashboard')`
  ).run(
    automationId,
    workspaceId,
    `b6 verify ${suffix}`,
    "Synthetic completed runs for delete UI verification.",
    `dashboard:${randomUUID()}`
  );
  return { id: automationId, workspaceId };
}

function seedCompletedRun(db, automationId, workspaceId, label) {
  const runId = `b6-${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, started_at, ended_at
    ) VALUES (?, ?, ?, 'completed', 'manual', ?, datetime('now'), datetime('now'))`
  ).run(runId, automationId, workspaceId, `Synthetic ${label}`);
  db.prepare(
    "INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, 1, 'run.finished', ?)"
  ).run(runId, JSON.stringify({ sdkStatus: "finished", result: label }));
  return runId;
}

function createFakeExecutor() {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("b6 verify should not spawn runs");
    },
  };
}

function createInputHub(db, events) {
  return new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
    events,
  });
}

async function startHarness(dbPath) {
  const db = openDatabase(dbPath);
  const events = new DaemonEventBus();
  const engine = new RunEngine(db, {
    apiKey: "b6-verify",
    executor: createFakeExecutor(),
    inputHub: createInputHub(db, events),
    events,
  });
  const http = await startHttpServer({
    engine,
    chatEngine: {},
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "b6-verify",
    port,
  });
  return { db, engine, http };
}

function completedColumn(page) {
  return page.locator("section.column").filter({
    has: page.locator(".column-head span", { hasText: "Completed" }),
  });
}

async function main() {
  await stopLcaDaemons([3747, 3752, 3753, 3754, 3755, 3756, port]);
  const { root: stateRoot, dbPath } = prepareTempState();
  const tempWorkspacePath = mkdtempSync(join(tmpdir(), "lca-b6-workspace-"));
  let browser = null;
  let harness = null;

  try {
    harness = await startHarness(dbPath);
    assert(await waitForHealth(), "daemon HTTP /health responds");

    const automation = seedAutomation(harness.db, tempWorkspacePath);
    const runA = seedCompletedRun(harness.db, automation.id, automation.workspaceId, "a");
    const runB = seedCompletedRun(harness.db, automation.id, automation.workspaceId, "b");
    const runC = seedCompletedRun(harness.db, automation.id, automation.workspaceId, "c");
    const seededIds = new Set([runA, runB, runC]);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base, { waitUntil: "networkidle" });

    const col = completedColumn(page);
    await col.waitFor({ timeout: 15000 });
    const cards = col.locator(".run-card");
    await cards.first().waitFor({ timeout: 15000 });
    assert((await cards.count()) === 3, "completed column shows three seeded runs");

    // Per-card delete: arm the inline confirm, then click Confirm.
    const firstCard = cards.first();
    await firstCard.hover();
    await firstCard.locator(".card-actions button.danger").click();
    await firstCard.locator(".card-actions .confirm-yes").click();
    await sleep(800);
    assert((await cards.count()) === 2, "per-card Delete removes one run");
    const afterSingle = (await json("/api/runs")).runs.map((run) => run.id);
    assert(
      afterSingle.filter((id) => seededIds.has(id)).length === 2,
      "one seeded run removed from GET /api/runs"
    );

    // Cancel path: arming then dismissing must not delete anything.
    const keepCard = cards.first();
    await keepCard.hover();
    await keepCard.locator(".card-actions button.danger").click();
    await keepCard.locator(".card-actions .confirm-no").click();
    await sleep(400);
    assert((await cards.count()) === 2, "Cancel keeps the run");

    // Multi-select delete via the column-header Delete (N) inline confirm.
    const cardToSelect = cards.first();
    await cardToSelect.hover();
    await cardToSelect.locator(".select-box input").check();
    await col.locator(".col-actions button.danger", { hasText: "Delete (1)" }).click();
    await col.locator(".col-actions .confirm-yes").click();
    await sleep(800);
    assert((await cards.count()) === 1, "Delete (N) removes selected run");

    // Clear the rest via the column-header Clear inline confirm.
    await col.locator(".col-actions button.danger", { hasText: "Clear" }).click();
    await col.locator(".col-actions .confirm-yes").click();
    await sleep(800);
    assert((await cards.count()) === 0, "Clear removes remaining completed runs");
    assert(
      (await json("/api/runs")).runs.every((run) => !seededIds.has(run.id)),
      "all seeded runs removed from API list"
    );
  } finally {
    await closeWithTimeout(browser);
    if (harness) {
      await harness.engine.shutdown();
      await harness.http.close();
      harness.db.close();
    }
    await rmWithRetries(stateRoot, { recursive: true, force: true });
    await rmWithRetries(tempWorkspacePath, { recursive: true, force: true });
  }

  console.log("b6 UI verification passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
