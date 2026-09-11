import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { RunStore } from "../packages/daemon/dist/runs/store.js";
import { assertTransition } from "../packages/daemon/dist/runs/state-machine.js";
import { chromium } from "playwright";
import { stopLcaDaemons } from "./stop-lca-daemons.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3756;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const RUN_TIMEOUT_MS = 30_000;

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
  const root = mkdtempSync(join(tmpdir(), "lca-b4-state-"));
  const lcaHome = join(root, ".cursor-local-automations");
  mkdirSync(lcaHome, { recursive: true });
  writeFileSync(
    join(lcaHome, "automations.yaml"),
    ["workspaces: []", "", "automations: []", ""].join("\n")
  );
  return { root, dbPath: join(lcaHome, "state.sqlite") };
}

function seedTempWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "lca-b4-workspace-"));
  writeFileSync(join(workspace, "README.md"), "# B4 verify workspace\n");
  return workspace;
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

async function waitForCondition(fn, msg, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) {
      console.log("OK:", msg);
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out: ${msg}`);
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
  const workspaceId = `b4-ui-ws-${suffix}`;
  const automationId = `b4-ui-auto-${suffix}`;
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    workspaceId,
    workspacePath,
    "b4 verify temp"
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt,
      config_path, config_key, origin
    ) VALUES (?, ?, ?, 1, 'enabled', '{"type":"manual"}', ?, '__dashboard__', ?, 'dashboard')`
  ).run(
    automationId,
    workspaceId,
    `b4 verify ${suffix}`,
    [
      "This is an automated verification run.",
      "Reply exactly: B4_INITIAL_DONE",
      "Do not edit files. Do not call tools.",
    ].join("\n"),
    `dashboard:${randomUUID()}`
  );
  return { id: automationId, workspaceId };
}

async function getRun(runId) {
  return json(`/api/runs/${encodeURIComponent(runId)}`);
}

function isTerminal(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

async function waitForRun(runId, predicate, msg, timeoutMs = RUN_TIMEOUT_MS) {
  let latest;
  await waitForCondition(async () => {
    latest = await getRun(runId);
    return predicate(latest.run.status, latest);
  }, msg, timeoutMs);
  return latest;
}

let log = "";

function assistantMessage(text) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
}

function createFakeActiveRun(agentId, sdkRunId, messages, leadMs = 0) {
  return {
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {
      // A lead delay keeps the run in `running` long enough for the dashboard
      // poll to observe the round-trip before the sentinel pauses it.
      if (leadMs > 0) await sleep(leadMs);
      for (const message of messages) {
        yield message;
        await sleep(50);
      }
    },
    wait: async () => ({ status: "finished", result: "ok" }),
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async (message) => {
      const text = message.includes("NEEDS_INPUT: B4 verify question?")
        ? "NEEDS_INPUT: B4 verify question?"
        : "B4_FOLLOWUP_DONE";
      return createFakeActiveRun(
        `agent-followup-${randomUUID()}`,
        `sdk-followup-${randomUUID()}`,
        [assistantMessage(text)],
        800
      );
    },
  };
}

function createFakeExecutor() {
  return {
    kind: "sdk-local",
    spawn: async () =>
      createFakeActiveRun(`agent-${randomUUID()}`, `sdk-${randomUUID()}`, [
        assistantMessage("B4_INITIAL_DONE"),
      ]),
    resume: async () => {
      throw new Error("fake verifier should use retained local run handles");
    },
  };
}

function createInputHub(db, events) {
  const runStore = new RunStore(db, events);
  return new InputHub(new InputStore(db), {
    onNeedsInput: (runId, request) => {
      const row = runStore.getRun(runId);
      if (row?.status === "running") {
        assertTransition(row.status, "needs_input");
        runStore.setStatus(runId, "needs_input");
      }
      events.emitInputRequest(runId, {
        id: request.id,
        runId: request.run_id,
        question: request.question,
        answer: request.answer,
        status: request.status,
        createdAt: request.created_at,
        answeredAt: request.answered_at,
      });
    },
    onAnswered: (runId, request) => {
      const row = runStore.getRun(runId);
      if (row?.status === "needs_input") {
        assertTransition(row.status, "running");
        runStore.setStatus(runId, "running");
      }
      events.emitInputRequest(runId, {
        id: request.id,
        runId: request.run_id,
        question: request.question,
        answer: request.answer,
        status: request.status,
        createdAt: request.created_at,
        answeredAt: request.answered_at,
      });
    },
  });
}

async function startHarness(dbPath) {
  const db = openDatabase(dbPath);
  const events = new DaemonEventBus();
  const engine = new RunEngine(db, {
    apiKey: "b4-verify",
    executor: createFakeExecutor(),
    inputHub: createInputHub(db, events),
    events,
    onLog: (message) => {
      log += `[harness] ${message}\n`;
    },
  });
  const http = await startHttpServer({
    engine,
    chatEngine: {},
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "b4-verify",
    port,
  });
  return { db, engine, http };
}

function seedNonResumableRun(db, automationId, workspaceId) {
  const runId = `b4-nonresumable-${Date.now()}`;
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, started_at, ended_at
    ) VALUES (?, ?, ?, 'completed', 'manual', 'synthetic non-resumable', datetime('now'), datetime('now'))`
  ).run(runId, automationId, workspaceId);
  db.prepare(
    "INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, 1, 'run.finished', ?)"
  ).run(runId, JSON.stringify({ sdkStatus: "finished", result: "synthetic" }));
  return runId;
}

async function waitForModalStatus(page, status, timeoutMs = 30000) {
  await waitForCondition(
    async () => ((await page.locator(".modal-status strong").textContent()) ?? "") === status,
    `modal status becomes ${status}`,
    timeoutMs
  );
}

async function waitForEnabled(locator, msg, timeoutMs = 15000) {
  await waitForCondition(
    async () => locator.evaluate((el) => !el.disabled).catch(() => false),
    msg,
    timeoutMs
  );
}

async function runUiChecks(page, runId, nonResumableRunId) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/?run=${encodeURIComponent(runId)}`, {
    waitUntil: "networkidle",
  });

  const modal = page.locator(".modal");
  await modal.waitFor({ timeout: 15000 });
  assert(true, "logs modal opens from ?run= deep link");

  const textarea = page.locator(".compose textarea");
  const submit = page.locator(".compose button[type='submit']");
  await waitForModalStatus(page, "completed");
  await waitForEnabled(textarea, "compose textarea enables for completed resumable run");

  const assistantBefore = await page.locator(".bubble.assistant").count();
  const followUp = [
    "Output exactly this single line and nothing else:",
    "NEEDS_INPUT: B4 verify question?",
    "Do not edit files.",
  ].join("\n");

  await textarea.fill(followUp);
  await submit.click();
  await page.locator(".bubble.user", { hasText: "NEEDS_INPUT: B4 verify question?" }).waitFor({
    timeout: 15000,
  });
  assert(true, "operator run.message bubble appears after Send");
  await waitForModalStatus(page, "running");

  await waitForModalStatus(page, "needs_input", RUN_TIMEOUT_MS);
  await page.locator(".compose-question", { hasText: "B4 verify question?" }).waitFor({
    timeout: 15000,
  });
  assert(true, "resumed turn surfaces ask_user question");

  await waitForEnabled(textarea, "compose textarea enables for ask_user answer");
  await textarea.fill("yes from b4 verifier");
  await submit.click();
  await waitForModalStatus(page, "completed", RUN_TIMEOUT_MS);

  await waitForCondition(
    async () => (await page.locator(".bubble.assistant").count()) > assistantBefore,
    "resumed turn adds at least one assistant bubble",
    15000
  );
  await page.locator(".bubble.assistant", { hasText: "NEEDS_INPUT: B4 verify question?" }).first().waitFor({
    timeout: 15000,
  });
  assert(true, "resumed turn streams assistant response into same transcript");

  const duplicateOperatorBubbles = await page
    .locator(".bubble.user", { hasText: "NEEDS_INPUT: B4 verify question?" })
    .count();
  assert(
    duplicateOperatorBubbles === 1,
    `SDK user echo is not duplicated (found ${duplicateOperatorBubbles} operator bubbles)`
  );

  await page.goto(`${base}/?run=${encodeURIComponent(nonResumableRunId)}`, {
    waitUntil: "networkidle",
  });
  await modal.waitFor({ timeout: 15000 });
  await waitForModalStatus(page, "completed");
  assert(
    await textarea.evaluate((el) => el.disabled),
    "non-resumable completed run disables compose textarea"
  );
  assert(
    ((await textarea.getAttribute("placeholder")) ?? "").includes("can't be continued"),
    "non-resumable completed run explains why compose is disabled"
  );
}

async function main() {
  await stopLcaDaemons([3747, 3752, 3753, 3754, 3755, port]);
  const { root: stateRoot, dbPath } = prepareTempState();
  const tempWorkspacePath = seedTempWorkspace();
  let browser = null;
  let harness = null;

  try {
    harness = await startHarness(dbPath);
    assert(await waitForHealth(), "daemon HTTP /health responds");

    const automation = seedAutomation(harness.db, tempWorkspacePath);
    const runId = await harness.engine.triggerRun(automation.id);
    console.log("triggered b4 verify run:", runId);

    const initial = await waitForRun(
      runId,
      (status) => isTerminal(status),
      "initial automation reaches terminal state"
    );
    assert(initial.run.status === "completed", "initial automation completed successfully");
    assert(
      initial.run.agent_id && initial.run.sdk_run_id && !initial.run.agent_id.startsWith("bc-"),
      "initial completed run is resumable"
    );

    const nonResumableRunId = seedNonResumableRun(
      harness.db,
      automation.id,
      automation.workspaceId
    );

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await runUiChecks(page, runId, nonResumableRunId);

    const final = await getRun(runId);
    assert(final.run.status === "completed", "continued run finishes completed");
    assert(
      final.events.filter((event) => event.event_type === "run.message").length === 1,
      "continued run stores exactly one operator run.message event"
    );
    assert(
      final.events.some((event) => event.event_type === "input.asked"),
      "continued run records resumed-turn input request"
    );
    assert(
      final.inputRequests.some(
        (request) =>
          request.question === "B4 verify question?" &&
          request.answer === "yes from b4 verifier" &&
          request.status === "answered"
      ),
      "continued run records answered resumed-turn input request"
    );
  } finally {
    await closeWithTimeout(browser);
    if (harness) {
      await harness.engine.shutdown().catch(() => {});
      await harness.http.close().catch(() => {});
      harness.db.close();
    }
    rmSync(tempWorkspacePath, { recursive: true, force: true });
    await rmWithRetries(stateRoot, { recursive: true, force: true }).catch((err) => {
      console.error("WARN: temporary LCA state cleanup failed:", err.message);
    });
  }
}

try {
  await main();
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  clearTimeout(hardExit);
  if (process.exitCode) {
    console.error("\n--- daemon log ---\n", log);
  } else {
    console.log("\nb4 UI verification passed.");
  }
}
