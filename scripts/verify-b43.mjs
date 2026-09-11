/**
 * b43 verification — unattended halt recovery on an isolated daemon + dashboard.
 *
 * Isolation (non-negotiable): own temp HOME / USERPROFILE / LCA_HOME and port
 * 3768. Never calls stop-lca-daemons, never touches :3747, never sets
 * LCA_FORCE_STOP_DAEMONS. Fail-hard if daemon/dashboard dist is missing.
 */
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
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3768;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const SECRET_IDEA = "b43-verify-secret-idea-must-not-leak";

if (port === 3747) {
  console.error("verify-b43 must not use operator port 3747");
  process.exit(1);
}

const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  LCA_HOME: process.env.LCA_HOME,
};

const testHome = mkdtempSync(join(tmpdir(), "lca-b43-ui-"));
const lcaHome = join(testHome, ".cursor-local-automations");
mkdirSync(lcaHome, { recursive: true });

process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.LCA_HOME = lcaHome;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bounded poll — never a bare sleep as the only completion condition. */
async function waitUntil(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(150);
  }
}

function workspaceIdFromPath(workspacePath) {
  return Buffer.from(resolve(workspacePath)).toString("base64url");
}

function restoreEnv() {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const daemonServer = join(repoRoot, "packages/daemon/dist/http/server.js");
const dashboardIndex = join(repoRoot, "packages/dashboard/dist/index.html");
if (!existsSync(daemonServer)) {
  console.error("FAIL: daemon not built. Run `npm run build -w @lca/daemon` first.");
  restoreEnv();
  process.exit(1);
}
if (!existsSync(dashboardIndex)) {
  console.error(
    "FAIL: dashboard not built. Run `npm run build -w @lca/dashboard` first."
  );
  restoreEnv();
  process.exit(1);
}

console.log("progress: importing daemon dist under temp LCA_HOME");
const [
  { openDatabase },
  { DaemonEventBus },
  { DashboardStore },
  { startHttpServer },
  { InputHub },
  { InputStore },
  { ChatEngine },
  { RunEngine },
  { RunStore },
  { ChainRunner },
  { DEFAULT_SETTINGS },
  { TriggerManager },
] = await Promise.all([
  import("../packages/daemon/dist/db/index.js"),
  import("../packages/daemon/dist/events.js"),
  import("../packages/daemon/dist/http/dashboard-store.js"),
  import("../packages/daemon/dist/http/server.js"),
  import("../packages/daemon/dist/input/hub.js"),
  import("../packages/daemon/dist/input/store.js"),
  import("../packages/daemon/dist/chats/engine.js"),
  import("../packages/daemon/dist/runs/engine.js"),
  import("../packages/daemon/dist/runs/store.js"),
  import("../packages/daemon/dist/runs/chain-runner.js"),
  import("../packages/daemon/dist/config/settings.js"),
  import("../packages/daemon/dist/triggers/manager.js"),
]);

const hardExit = setTimeout(() => {
  console.error("Hard timeout reached.");
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardExit.unref();

async function closeWithTimeout(browser) {
  if (!browser) return;
  await Promise.race([
    browser.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("browser.close() timed out")), CLOSE_TIMEOUT_MS)
    ),
  ]).catch(() => {});
}

const WORKERS = [
  {
    key: "generated:plan-skeleton",
    name: "plan-skeleton",
    role: "planner",
    next: "generated:plan-phase",
  },
  {
    key: "generated:plan-phase",
    name: "plan-phase",
    role: "planner",
    next: "generated:implement",
  },
  {
    key: "generated:implement",
    name: "implement",
    role: "implementer",
    next: "generated:review",
  },
  {
    key: "generated:review",
    name: "review",
    role: "reviewer",
    next: "generated:docs-commit",
  },
  {
    key: "generated:docs-commit",
    name: "docs-commit",
    role: "docs",
    next: "generated:plan-phase",
  },
];

function contextFor(featureId, featureSlug) {
  return {
    variables: {
      pipelineId: "implement-fully",
      featureId,
      featureSlug,
      featureDir: `docs/roadmap/${featureSlug}`,
      featureIndex: `docs/roadmap/${featureSlug}/00-index.md`,
      idea: SECRET_IDEA,
      planningDepth: "jit",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
    },
    roleModels: {
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
      docs: { id: "docs-model" },
    },
  };
}

function eventsOfType(db, runId, eventType) {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = ?
         ORDER BY seq ASC`
      )
      .all(runId, eventType)
  ).map((r) => JSON.parse(r.payload));
}

function listChildren(db, parentId) {
  return db
    .prepare(
      `SELECT id, automation_id, trigger_kind, chain_depth
       FROM runs WHERE parent_run_id = ? ORDER BY rowid ASC`
    )
    .all(parentId);
}

function readRun(db, id) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id);
}

function seedFailedHalt(store, db, opts) {
  const rootId = opts.rootId;
  const context = opts.context;
  store.insertRun({
    id: opts.id,
    automationId: opts.automationId,
    workspaceId: opts.wsId,
    triggerKind: "chain",
    prompt: `Review prompt for ${opts.id}`,
    chainContext: context,
    chainRootRunId: rootId,
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: opts.maxDepth ?? 9,
    parentRunId: opts.parentId ?? null,
  });
  store.setStatus(opts.id, "failed");
  if (opts.withSafeEvidence !== false) {
    store.appendEvent(opts.id, "assistant", {
      message: { content: [{ type: "text", text: "working" }] },
    });
    store.appendEvent(opts.id, "tool_call", { name: "Shell" });
    store.appendEvent(opts.id, "run.error", {
      reason: opts.failureReason ?? "sdk_error",
      sdkStatus: "error",
    });
  }
  if (opts.withChainSkipped) {
    store.appendEvent(opts.id, "run.chain-skipped", {
      reason: "status-mismatch",
      next: "generated:docs-commit",
      status: "failed",
      when: "completed",
      depth: opts.depth ?? 2,
      maxDepth: opts.maxDepth ?? 9,
    });
  }
}

function seedHarness() {
  console.log("progress: seeding isolated workspace + halt fixtures");
  const workspace = mkdtempSync(join(tmpdir(), "lca-b43-ws-"));
  writeFileSync(join(workspace, "README.md"), "# b43 verify\n");
  writeFileSync(
    join(lcaHome, "automations.yaml"),
    [`workspaces:`, `  - ${JSON.stringify(workspace)}`, ``, `automations: []`, ``].join(
      "\n"
    )
  );

  const db = openDatabase(join(lcaHome, "state.sqlite"));
  const wsId = workspaceIdFromPath(workspace);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(wsId, resolve(workspace), "b43-ws");

  const autoIds = {};
  for (const w of WORKERS) {
    const id = `${wsId}::${w.key}`;
    autoIds[w.key] = id;
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, origin, trigger_json, prompt,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, ?, ?, 1, 'enabled', 'generated', '{"type":"manual"}', ?,
        'generated.yaml', ?, ?, ?)`
    ).run(
      id,
      wsId,
      w.name,
      `Prompt ${w.name} {{featureId}}`,
      w.key,
      JSON.stringify({ next: w.next, when: "completed", passResult: true }),
      w.role
    );
  }

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);

  // Separate roots so lineage budget cannot couple the three scenarios.
  const safeRootId = randomUUID();
  const unsafeRootId = randomUUID();
  const startupRootId = randomUUID();
  const safeId = randomUUID();
  const unsafeId = randomUUID();
  const startupId = randomUUID();

  const safeCtx = contextFor("b43r", "b43-recover-safe");
  const unsafeCtx = contextFor("b43d", "b43-decline-unsafe");
  const startupCtx = contextFor("b43p", "b43-startup-persist");

  seedFailedHalt(store, db, {
    id: safeId,
    rootId: safeRootId,
    wsId,
    automationId: autoIds["generated:review"],
    context: safeCtx,
    withChainSkipped: false,
    failureReason: "sdk_error",
  });
  seedFailedHalt(store, db, {
    id: unsafeId,
    rootId: unsafeRootId,
    wsId,
    automationId: autoIds["generated:review"],
    context: unsafeCtx,
    withChainSkipped: false,
    failureReason: "spawn_error",
  });
  seedFailedHalt(store, db, {
    id: startupId,
    rootId: startupRootId,
    wsId,
    automationId: autoIds["generated:review"],
    context: startupCtx,
    withChainSkipped: true,
    failureReason: "sdk_error",
  });

  const recoveryDecisions = [];
  const fakeExecutor = {
    kind: "sdk-local",
    async spawn(params) {
      return {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        async wait() {
          return { status: "finished", result: "ok" };
        },
        async cancel() {},
        async dispose() {},
      };
    },
    async resume() {
      throw new Error("resume not used in b43 verify");
    },
  };

  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
    inputHub: new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    }),
    maxConcurrentRuns: 4,
  });
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: 86_400_000,
    onHaltRecoveryDecision: (runId, result) => {
      recoveryDecisions.push({ runId, kind: result.kind, result });
    },
  });
  chainRunner.start();
  const chatEngine = new ChatEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
  });

  return {
    testHome,
    lcaHome,
    workspace,
    wsId,
    db,
    events,
    engine,
    chatEngine,
    store,
    chainRunner,
    autoIds,
    recoveryDecisions,
    safeId,
    unsafeId,
    startupId,
    safeRootId,
    unsafeRootId,
    startupRootId,
  };
}

async function startServer(harness) {
  console.log("progress: starting HTTP server on", port);
  const triggers = new TriggerManager(harness.db, harness.engine, { port });
  return startHttpServer({
    engine: harness.engine,
    chatEngine: harness.chatEngine,
    store: new DashboardStore(harness.db),
    db: harness.db,
    events: harness.events,
    apiKey: "test-key",
    port,
    host: "127.0.0.1",
    settings: DEFAULT_SETTINGS,
    triggers,
  });
}

function countKinds(decisions) {
  let acted = 0;
  let declined = 0;
  for (const d of decisions) {
    if (d.kind === "acted") acted += 1;
    else if (d.kind === "declined") declined += 1;
  }
  return { acted, declined };
}

async function runRecoveryScenarios(harness) {
  console.log("progress: safe live recovery");
  await harness.chainRunner.handleTerminal(harness.safeId, "failed");

  const safeSkipped = eventsOfType(
    harness.db,
    harness.safeId,
    "run.chain-skipped"
  );
  assert(safeSkipped.length === 1, "safe: one durable status-mismatch chain-skip");
  assert(
    safeSkipped[0].reason === "status-mismatch",
    "safe: chain-skip reason is status-mismatch"
  );

  const safeEscalated = eventsOfType(
    harness.db,
    harness.safeId,
    "run.pipeline-escalated"
  );
  assert(safeEscalated.length === 1, "safe: one daemon pipeline-escalated");
  assert(
    safeEscalated[0].actor === "daemon" &&
      safeEscalated[0].recoveryCode === "safe-class" &&
      safeEscalated[0].action === "retry",
    "safe: daemon safe-class retry evidence"
  );

  const safeChildren = listChildren(harness.db, harness.safeId);
  assert(safeChildren.length === 1, "safe: exactly one escalation successor");
  assert(
    safeChildren[0].trigger_kind === "escalation" &&
      safeChildren[0].chain_depth === 2 &&
      safeChildren[0].automation_id === harness.autoIds["generated:review"],
    "safe: successor is same-depth review escalation"
  );
  assert(
    readRun(harness.db, harness.safeId).chain_handled_at != null,
    "safe: source chain claim is set"
  );

  console.log("progress: unsafe live decline");
  await harness.chainRunner.handleTerminal(harness.unsafeId, "failed");

  const unrecovered = eventsOfType(
    harness.db,
    harness.unsafeId,
    "run.pipeline-halt-unrecovered"
  );
  assert(unrecovered.length === 1, "unsafe: one pipeline-halt-unrecovered");
  assert(
    unrecovered[0].code === "not-safe-class",
    "unsafe: decline code is not-safe-class"
  );
  assert(
    listChildren(harness.db, harness.unsafeId).length === 0,
    "unsafe: no escalation child"
  );
  assert(
    readRun(harness.db, harness.unsafeId).chain_handled_at == null,
    "unsafe: chain claim remains null"
  );

  const afterLive = countKinds(harness.recoveryDecisions);
  assert(afterLive.acted === 1, "callback: one acted after safe live recovery");
  assert(
    afterLive.declined === 1,
    "callback: one declined after unsafe live decline"
  );

  console.log("progress: startup recovery sweep");
  const beforeSkipped = eventsOfType(
    harness.db,
    harness.startupId,
    "run.chain-skipped"
  ).length;

  const first = await harness.chainRunner.resumeFailedHaltRecovery();
  assert(first === 1, "startup: first sweep recovers once");
  assert(
    listChildren(harness.db, harness.startupId).length === 1,
    "startup: one escalation child after first sweep"
  );
  assert(
    eventsOfType(harness.db, harness.startupId, "run.pipeline-escalated")
      .length === 1,
    "startup: one daemon escalation after first sweep"
  );
  assert(
    eventsOfType(harness.db, harness.startupId, "run.chain-skipped").length ===
      beforeSkipped,
    "startup: no extra chain-skipped on first sweep"
  );

  const afterFirstStartup = countKinds(harness.recoveryDecisions);
  assert(
    afterFirstStartup.acted === 2 && afterFirstStartup.declined === 1,
    "callback: startup first sweep adds one acted (2 acted / 1 declined total)"
  );

  const second = await harness.chainRunner.resumeFailedHaltRecovery();
  assert(second === 0, "startup: second sweep recovers zero");
  assert(
    listChildren(harness.db, harness.startupId).length === 1,
    "startup: still exactly one child after replay"
  );
  assert(
    eventsOfType(harness.db, harness.startupId, "run.pipeline-escalated")
      .length === 1,
    "startup: no duplicate daemon escalation on replay"
  );
  assert(
    eventsOfType(harness.db, harness.startupId, "run.chain-skipped").length ===
      beforeSkipped,
    "startup: replay does not append chain-skipped"
  );

  const afterReplay = countKinds(harness.recoveryDecisions);
  assert(
    afterReplay.acted === 2 && afterReplay.declined === 1,
    "callback: replay/no-op does not add acted or declined callbacks"
  );
}

async function runApiChecks(harness) {
  console.log("progress: API lineage checks");
  const payload = await waitUntil("API runs list", async () => {
    const res = await fetch(`${base}/api/runs?limit=200`);
    if (!res.ok) return null;
    return res.json();
  });

  const json = JSON.stringify(payload);
  assert(!json.includes(SECRET_IDEA), "API list omits pipeline idea");
  assert(
    !json.includes("Review prompt for"),
    "API list omits stored prompt text"
  );

  const safeSource = payload.runs.find((r) => r.id === harness.safeId);
  const unsafeSource = payload.runs.find((r) => r.id === harness.unsafeId);
  const startupSource = payload.runs.find((r) => r.id === harness.startupId);
  assert(safeSource != null, "API lists safe source run");
  assert(unsafeSource != null, "API lists unsafe source run");
  assert(startupSource != null, "API lists startup source run");

  assert(
    safeSource.chainHandledAt != null &&
      safeSource.pipeline?.featureId === "b43r",
    "API: safe source claimed with b43r lineage"
  );
  assert(
    unsafeSource.chainHandledAt == null &&
      unsafeSource.pipeline?.featureId === "b43d",
    "API: unsafe source unclaimed with b43d lineage"
  );
  assert(
    startupSource.chainHandledAt != null &&
      startupSource.pipeline?.featureId === "b43p",
    "API: startup source claimed with b43p lineage"
  );

  const safeChild = payload.runs.find(
    (r) =>
      r.parentRunId === harness.safeId &&
      r.triggerKind === "escalation" &&
      r.chainDepth === 2
  );
  assert(safeChild != null, "API lists safe escalation successor");
  assert(
    safeChild.chainRootRunId === harness.safeRootId &&
      safeChild.pipeline?.featureId === "b43r",
    "API successor preserves safe root/lineage"
  );
}

/**
 * The board expands only the active pipeline group; every other group renders
 * its header without run cards. Expand them all so per-run chips are assertable.
 */
async function expandAllPipelineGroups(page) {
  const toggles = page.getByRole("button", { name: /^Expand .+ pipeline$/ });
  for (let guard = 0; guard < 20; guard++) {
    if ((await toggles.count()) === 0) return;
    await toggles.first().click();
  }
  throw new Error("pipeline groups never finished expanding");
}

async function runBoardChecks(page, harness) {
  console.log("progress: browser board checks");
  await page.addInitScript(() => {
    window.confirm = () => true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base, { waitUntil: "networkidle" });
  await sleep(800);
  await expandAllPipelineGroups(page);

  const safeChip = page.getByText(/b43r · review/i).first();
  await safeChip.waitFor({ state: "visible", timeout: 15000 });
  const unsafeChip = page.getByText(/b43d · review/i).first();
  await unsafeChip.waitFor({ state: "visible", timeout: 15000 });
  const startupChip = page.getByText(/b43p · review/i).first();
  await startupChip.waitFor({ state: "visible", timeout: 15000 });
  assert(true, "board shows b43r / b43d / b43p review lineage chips");

  const bodyText = await page.locator("body").innerText();
  assert(
    !bodyText.includes(SECRET_IDEA),
    "board text does not leak pipeline idea"
  );

  // Prefer the failed source over its completed escalation sibling (same chip).
  const safeCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/b43r · review/i) })
    .filter({ has: page.locator('[title="failed"]') })
    .first();
  await safeCard.waitFor({ state: "visible", timeout: 10000 });
  await safeCard.hover();
  assert(
    (await safeCard.getByRole("button", { name: "Retry", exact: true }).count()) ===
      0,
    "safe recovered card has no Retry halt control"
  );
  assert(
    (await safeCard.getByRole("button", { name: "Skip", exact: true }).count()) ===
      0,
    "safe recovered card has no Skip halt control"
  );
  assert(
    (await safeCard.getByRole("button", { name: "Abort", exact: true }).count()) ===
      0,
    "safe recovered card has no Abort halt control"
  );

  // Recovery summary is on the transcript (historical events), not lastEvent-from-WS.
  await safeCard.getByRole("button", { name: "View logs" }).click();
  const safeDialog = page.getByRole("dialog");
  await safeDialog.waitFor({ state: "visible", timeout: 10000 });
  await waitUntil("safe logs modal to show automatic recovery", async () => {
    const text = await safeDialog.innerText();
    return /automatic recovery|Automatic retry/i.test(text) ? true : null;
  });
  assert(true, "safe card shows automatic-recovery summary text");
  await page.keyboard.press("Escape");
  await waitUntil("safe logs modal to close", async () =>
    (await safeDialog.count()) === 0 ? true : null
  );

  const unsafeCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/b43d · review/i) })
    .filter({ has: page.locator('[title="failed"]') })
    .first();
  await unsafeCard.waitFor({ state: "visible", timeout: 10000 });
  await unsafeCard.hover();
  assert(
    await unsafeCard.getByRole("button", { name: "Retry", exact: true }).isVisible(),
    "unsafe halted card retains Retry"
  );
  assert(
    await unsafeCard.getByRole("button", { name: "Skip", exact: true }).isVisible(),
    "unsafe halted card retains Skip"
  );
  assert(
    await unsafeCard.getByRole("button", { name: "Abort", exact: true }).isVisible(),
    "unsafe halted card retains Abort"
  );

  await unsafeCard.getByRole("button", { name: "View logs" }).click();
  const unsafeDialog = page.getByRole("dialog");
  await unsafeDialog.waitFor({ state: "visible", timeout: 10000 });
  await waitUntil(
    "unsafe logs modal to show declined recovery",
    async () => {
      const text = await unsafeDialog.innerText();
      return /Automatic recovery declined|pipeline remains halted|not-safe-class/i.test(
        text
      )
        ? true
        : null;
    }
  );
  assert(
    true,
    "unsafe card says automatic recovery declined / remains halted"
  );
  await page.keyboard.press("Escape");
}

async function main() {
  let browser;
  let http;
  let harness;

  try {
    harness = seedHarness();
    await runRecoveryScenarios(harness);
    http = await startServer(harness);
    await sleep(400);
    await runApiChecks(harness);

    console.log("progress: launching browser");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await runBoardChecks(page, harness);
  } finally {
    console.log("progress: cleanup");
    await closeWithTimeout(browser);
    try {
      harness?.chainRunner?.stop();
    } catch {
      /* ignore */
    }
    try {
      await http?.close();
    } catch {
      /* ignore */
    }
    try {
      await harness?.engine?.shutdown();
      await harness?.chatEngine?.shutdown();
      harness?.db?.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(testHome, { recursive: true, force: true });
      if (harness?.workspace) {
        rmSync(harness.workspace, { recursive: true, force: true });
      }
    } catch {
      /* tolerate Windows WAL locks */
    }
    restoreEnv();
    clearTimeout(hardExit);
  }
}

const result = await main()
  .then(() => {
    console.log("\nb43 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
