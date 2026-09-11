/**
 * b44 verification — halt-discovery lifecycle on an isolated daemon + dashboard.
 *
 * Isolation (non-negotiable): own temp HOME / USERPROFILE / LCA_HOME and port
 * 3770. Never calls stop-lca-daemons, never touches :3747, never sets
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
const port = 3770;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 12 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const SECRET_IDEA = "b44-verify-secret-idea-must-not-leak";
const LOOKBACK_MS = 86_400_000;
const HALT_DISCOVERY_INPUT_KIND = "halt-discovery-briefing";
const HALT_DISCOVERY_TRIGGER_KIND = "halt-discovery";
const HALT_DISCOVERY_CONFIG_KEY = "generated:halt-discovery";

if (port === 3747) {
  console.error("verify-b44 must not use operator port 3747");
  process.exit(1);
}

const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  LCA_HOME: process.env.LCA_HOME,
};

const testHome = mkdtempSync(join(tmpdir(), "lca-b44-ui-"));
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
async function waitUntil(label, predicate, timeoutMs = 20_000) {
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
  { InputStore, parseInputMetadataJson },
  { ChatEngine },
  { RunEngine },
  { RunStore },
  { ChainRunner },
  { DEFAULT_SETTINGS },
  { TriggerManager },
  { provisionGeneratedWorkers },
  { automationId },
  { HALT_DISCOVERY_WORKERS },
  {
    orchestrateHaltDiscoveryAdvisory,
    reconcileHaltDiscoveryAdvisoryTerminal,
  },
  { presentCompletedHaltDiscoveryAdvisory },
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
  import("../packages/daemon/dist/config/generated-workers.js"),
  import("../packages/daemon/dist/config/parse.js"),
  import("../packages/daemon/dist/pipelines/halt-discovery.js"),
  import("../packages/daemon/dist/runs/halt-discovery-orchestrator.js"),
  import("../packages/daemon/dist/runs/halt-discovery-presentation.js"),
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
      `SELECT r.id, r.status, r.trigger_kind, r.chain_depth, a.config_key
       FROM runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.parent_run_id = ?
       ORDER BY r.rowid ASC`
    )
    .all(parentId);
}

function readRun(db, id) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id);
}

function sourceAuthoritySnapshot(db, id) {
  return db
    .prepare(
      `SELECT status, chain_handled_at, chain_stop_requested_at,
              chain_max_depth, chain_max_depth_override, chain_depth,
              chain_root_run_id, parent_run_id
       FROM runs WHERE id = ?`
    )
    .get(id);
}

function fence(body) {
  return `\`\`\`text\n${body.trimEnd()}\n\`\`\``;
}

function validPacket(recommendation = "retry") {
  const lines = [
    "lca-halt-discovery",
    "version: 1",
    "summary: Diagnosis summary",
    "likely-cause: Likely cause one-liner",
    "partial-work: partial",
    "evidence:",
    "- run abc failed with sdk_error",
    `recommendation: ${recommendation}`,
    "alternatives:",
    "- none",
    "confidence: medium",
    "operator-notes: Uncertainty noted",
  ];
  return fence(lines.join("\n"));
}

function appendFinishedResult(store, advisoryId, result) {
  store.appendEvent(advisoryId, "run.started", {});
  store.appendEvent(advisoryId, "assistant", { text: "diagnosis notes" });
  store.appendEvent(advisoryId, "run.finished", { result });
}

function appendRequested(store, runId) {
  store.appendEvent(runId, "run.pipeline-halt-unrecovered", {
    action: "none",
    code: "not-safe-class",
    detail: "Classifier declined auto-escalation",
    observedReason: "auth_failed",
  });
  store.appendEvent(runId, "run.pipeline-halt-discovery-requested", {
    code: "unrecovered-halt",
    recoveryCode: "not-safe-class",
    recoveryDetail: "Classifier declined auto-escalation",
    observedReason: "auth_failed",
  });
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
    pipelineWaveId: opts.pipelineWaveId,
    pipelineTrackId: opts.pipelineTrackId,
  });
  store.setStatus(opts.id, "failed");
  const endedAt = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  db.prepare(`UPDATE runs SET ended_at = ? WHERE id = ?`).run(endedAt, opts.id);
  store.appendEvent(opts.id, "assistant", {
    message: { content: [{ type: "text", text: "working" }] },
  });
  store.appendEvent(opts.id, "tool_call", { name: "Shell" });
  store.appendEvent(opts.id, "run.error", {
    reason: opts.failureReason ?? "auth_failed",
    sdkStatus: "error",
  });
}

function ensureHaltDiscoveryAutomation(harness) {
  const plan = provisionGeneratedWorkers(
    harness.db,
    harness.wsId,
    [...HALT_DISCOVERY_WORKERS],
    { prune: false }
  );
  assert(plan.applied === true, "halt-discovery worker provision applied");
  return automationId(harness.wsId, HALT_DISCOVERY_CONFIG_KEY);
}

function seedAdvisoryChild(harness, opts) {
  const autoId = ensureHaltDiscoveryAutomation(harness);
  harness.store.insertRun({
    id: opts.childId,
    automationId: autoId,
    workspaceId: harness.wsId,
    triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
    prompt: "seeded advisory",
    parentRunId: opts.sourceId,
    chainContext: opts.context,
    chainRootRunId: opts.rootId,
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: opts.maxDepth ?? 9,
  });
  harness.store.setStatus(opts.childId, opts.status ?? "completed");
  if (opts.agentId && opts.sdkRunId) {
    harness.store.setAgentIds(opts.childId, opts.agentId, opts.sdkRunId);
  }
}

async function presentBriefing(harness, opts) {
  seedFailedHalt(harness.store, harness.db, {
    id: opts.sourceId,
    rootId: opts.rootId,
    wsId: harness.wsId,
    automationId: harness.autoIds["generated:review"],
    context: opts.context,
    failureReason: "auth_failed",
  });
  appendRequested(harness.store, opts.sourceId);
  seedAdvisoryChild(harness, {
    sourceId: opts.sourceId,
    childId: opts.advisoryId,
    context: opts.context,
    rootId: opts.rootId,
    agentId: opts.agentId ?? `agent-${opts.advisoryId}`,
    sdkRunId: opts.sdkRunId ?? `sdk-${opts.advisoryId}`,
    status: "completed",
  });
  appendFinishedResult(
    harness.store,
    opts.advisoryId,
    validPacket(opts.recommendation ?? "skip")
  );
  await harness.chainRunner.handleTerminal(opts.advisoryId, "completed");
  assert(
    harness.store.getRun(opts.advisoryId)?.status === "needs_input",
    `advisory ${opts.advisoryId} parked as needs_input`
  );
}

function seedRetained(harness, runId) {
  const activeRun = {
    kind: "sdk-local",
    agentId: `agent-${runId}`,
    sdkRunId: `sdk-${runId}`,
    async *stream() {},
    wait: async () => ({ status: "finished", result: "ok" }),
    cancel: async () => {},
    dispose: async () => {},
  };
  harness.engine.retainedRuns.set(runId, {
    activeRun,
    runToken: "tok",
    retainedAt: Date.now(),
  });
}

function seedHarness() {
  console.log("progress: seeding isolated workspace + discovery fixtures");
  const workspace = mkdtempSync(join(tmpdir(), "lca-b44-ws-"));
  writeFileSync(join(workspace, "README.md"), "# b44 verify\n");
  writeFileSync(join(workspace, "package.json"), '{"name":"b44-ws"}\n');
  mkdirSync(join(workspace, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(workspace, "docs", "roadmap", "00-index.md"), "# idx\n");
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
  ).run(wsId, resolve(workspace), "b44-ws");

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
  const inputStore = new InputStore(db);

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
      throw new Error("resume not used in b44 verify");
    },
  };

  const inputHub = new InputHub(inputStore, {
    onNeedsInput: (runId) => {
      const row = store.getRun(runId);
      if (row?.status === "running") {
        store.setStatus(runId, "needs_input");
      }
    },
    onAnswered: (runId, request) => {
      const meta = parseInputMetadataJson(request.metadata_json);
      if (meta?.kind === HALT_DISCOVERY_INPUT_KIND) {
        return;
      }
      const row = store.getRun(runId);
      if (row?.status === "needs_input") {
        store.setStatus(runId, "running");
      }
    },
  });

  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
    inputHub,
    maxConcurrentRuns: 8,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
  });

  const waveCoordinator = {
    handleTerminalHook: async () => ({ handled: false }),
  };

  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: LOOKBACK_MS,
    pipelineAutoEscalate: true,
    pipelineHaltDiscovery: true,
    waveCoordinator,
    orchestrateHaltDiscoveryAdvisory: (sourceRunId) =>
      orchestrateHaltDiscoveryAdvisory({
        store,
        engine,
        provisionWorkers: (workspaceId, workers) =>
          provisionGeneratedWorkers(db, workspaceId, [...workers], {
            prune: false,
          }),
        onLog: () => {},
        sourceRunId,
      }),
    reconcileHaltDiscoveryAdvisoryTerminal: (advisoryRunId, status) =>
      reconcileHaltDiscoveryAdvisoryTerminal({
        store,
        onLog: () => {},
        advisoryRunId,
        status,
      }),
    presentCompletedHaltDiscoveryAdvisory: (advisoryRunId) =>
      presentCompletedHaltDiscoveryAdvisory({
        store,
        inputHub,
        onLog: () => {},
        advisoryRunId,
      }),
  });

  // Separate ChainRunner for disabled-policy skip (same stores).
  const disabledRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: LOOKBACK_MS,
    pipelineAutoEscalate: true,
    pipelineHaltDiscovery: false,
    waveCoordinator,
  });

  // Disjoint roots / feature ids so lineage and board labels cannot couple.
  const ids = {
    live: {
      id: randomUUID(),
      rootId: randomUUID(),
      ctx: contextFor("b44e", "b44-eligible-live"),
    },
    disabled: {
      id: randomUUID(),
      rootId: randomUUID(),
      ctx: contextFor("b44d", "b44-disabled-skip"),
    },
    wave: {
      id: randomUUID(),
      rootId: randomUUID(),
      ctx: contextFor("b44w", "b44-wave-scoped"),
    },
    replay: {
      id: randomUUID(),
      rootId: randomUUID(),
      ctx: contextFor("b44r", "b44-replay-enqueue"),
    },
    fail: {
      id: randomUUID(),
      rootId: randomUUID(),
      advisoryId: randomUUID(),
      ctx: contextFor("b44f", "b44-diagnosis-fail"),
    },
    operator: {
      id: randomUUID(),
      rootId: randomUUID(),
      advisoryId: randomUUID(),
      ctx: contextFor("b44o", "b44-operator-skip"),
    },
    promote: {
      id: randomUUID(),
      rootId: randomUUID(),
      advisoryId: randomUUID(),
      ctx: contextFor("b44p", "b44-promote-chat"),
    },
  };

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
    inputHub,
    inputStore,
    chainRunner,
    disabledRunner,
    autoIds,
    ids,
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

async function runDiscoveryScenarios(harness) {
  console.log("progress: eligible live unrecovered → advisory child");
  seedFailedHalt(harness.store, harness.db, {
    id: harness.ids.live.id,
    rootId: harness.ids.live.rootId,
    wsId: harness.wsId,
    automationId: harness.autoIds["generated:review"],
    context: harness.ids.live.ctx,
    failureReason: "auth_failed",
  });
  const liveBefore = sourceAuthoritySnapshot(harness.db, harness.ids.live.id);
  await harness.chainRunner.handleTerminal(harness.ids.live.id, "failed");

  assert(
    eventsOfType(
      harness.db,
      harness.ids.live.id,
      "run.pipeline-halt-unrecovered"
    ).length === 1,
    "live: one unrecovered event"
  );
  assert(
    eventsOfType(
      harness.db,
      harness.ids.live.id,
      "run.pipeline-halt-discovery-requested"
    ).length === 1,
    "live: one discovery request"
  );
  const liveChildren = listChildren(harness.db, harness.ids.live.id);
  assert(liveChildren.length === 1, "live: exactly one advisory child");
  assert(
    liveChildren[0].trigger_kind === HALT_DISCOVERY_TRIGGER_KIND &&
      liveChildren[0].config_key === HALT_DISCOVERY_CONFIG_KEY &&
      liveChildren[0].chain_depth === 2,
    "live: child is same-depth halt-discovery worker"
  );
  const liveAfter = sourceAuthoritySnapshot(harness.db, harness.ids.live.id);
  assert(
    liveAfter.status === "failed" &&
      liveAfter.chain_handled_at == null &&
      liveAfter.chain_stop_requested_at == null &&
      liveAfter.chain_depth === liveBefore.chain_depth &&
      liveAfter.chain_max_depth === liveBefore.chain_max_depth,
    "live: source remains failed / unclaimed / un-stopped"
  );
  assert(
    eventsOfType(harness.db, harness.ids.live.id, "run.pipeline-escalated")
      .length === 0,
    "live: source not escalated"
  );

  console.log("progress: disabled-policy skip");
  seedFailedHalt(harness.store, harness.db, {
    id: harness.ids.disabled.id,
    rootId: harness.ids.disabled.rootId,
    wsId: harness.wsId,
    automationId: harness.autoIds["generated:review"],
    context: harness.ids.disabled.ctx,
    failureReason: "auth_failed",
  });
  await harness.disabledRunner.handleTerminal(harness.ids.disabled.id, "failed");
  const disabledSkipped = eventsOfType(
    harness.db,
    harness.ids.disabled.id,
    "run.pipeline-halt-discovery-skipped"
  );
  assert(disabledSkipped.length === 1, "disabled: one discovery skip");
  assert(disabledSkipped[0].code === "disabled", "disabled: skip code disabled");
  assert(
    eventsOfType(
      harness.db,
      harness.ids.disabled.id,
      "run.pipeline-halt-discovery-requested"
    ).length === 0,
    "disabled: no discovery request"
  );
  assert(
    listChildren(harness.db, harness.ids.disabled.id).length === 0,
    "disabled: no advisory child"
  );
  assert(
    readRun(harness.db, harness.ids.disabled.id).chain_handled_at == null,
    "disabled: source claim unchanged"
  );

  console.log("progress: wave-scoped skip");
  seedFailedHalt(harness.store, harness.db, {
    id: harness.ids.wave.id,
    rootId: harness.ids.wave.rootId,
    wsId: harness.wsId,
    automationId: harness.autoIds["generated:review"],
    context: harness.ids.wave.ctx,
    failureReason: "auth_failed",
    pipelineWaveId: "wave-1",
    pipelineTrackId: "track-1",
  });
  await harness.chainRunner.handleTerminal(harness.ids.wave.id, "failed");
  const waveSkipped = eventsOfType(
    harness.db,
    harness.ids.wave.id,
    "run.pipeline-halt-discovery-skipped"
  );
  assert(waveSkipped.length === 1, "wave: one discovery skip");
  assert(waveSkipped[0].code === "wave-scoped", "wave: skip code wave-scoped");
  assert(
    listChildren(harness.db, harness.ids.wave.id).length === 0,
    "wave: no advisory child"
  );
  assert(
    readRun(harness.db, harness.ids.wave.id).chain_handled_at == null,
    "wave: source claim unchanged"
  );

  console.log("progress: startup advisory replay idempotency");
  seedFailedHalt(harness.store, harness.db, {
    id: harness.ids.replay.id,
    rootId: harness.ids.replay.rootId,
    wsId: harness.wsId,
    automationId: harness.autoIds["generated:review"],
    context: harness.ids.replay.ctx,
    failureReason: "auth_failed",
  });
  appendRequested(harness.store, harness.ids.replay.id);
  const first = await harness.chainRunner.resumeHaltDiscoveryAdvisories();
  assert(first === 1, "replay: first sweep enqueues one");
  assert(
    listChildren(harness.db, harness.ids.replay.id).length === 1,
    "replay: one child after first sweep"
  );
  const second = await harness.chainRunner.resumeHaltDiscoveryAdvisories();
  assert(second === 0, "replay: second sweep enqueues zero");
  assert(
    listChildren(harness.db, harness.ids.replay.id).length === 1,
    "replay: still exactly one child"
  );

  console.log("progress: diagnosis-stage failure reconcile");
  seedFailedHalt(harness.store, harness.db, {
    id: harness.ids.fail.id,
    rootId: harness.ids.fail.rootId,
    wsId: harness.wsId,
    automationId: harness.autoIds["generated:review"],
    context: harness.ids.fail.ctx,
    failureReason: "auth_failed",
  });
  appendRequested(harness.store, harness.ids.fail.id);
  seedAdvisoryChild(harness, {
    sourceId: harness.ids.fail.id,
    childId: harness.ids.fail.advisoryId,
    context: harness.ids.fail.ctx,
    rootId: harness.ids.fail.rootId,
    status: "failed",
  });
  harness.store.appendEvent(harness.ids.fail.advisoryId, "run.started", {});
  harness.store.appendEvent(harness.ids.fail.advisoryId, "run.error", {
    message: "diagnosis crashed",
  });
  const failBefore = sourceAuthoritySnapshot(harness.db, harness.ids.fail.id);
  await harness.chainRunner.handleTerminal(
    harness.ids.fail.advisoryId,
    "failed"
  );
  const failed = eventsOfType(
    harness.db,
    harness.ids.fail.id,
    "run.pipeline-halt-discovery-failed"
  );
  assert(failed.length === 1, "fail: one discovery-failed on source");
  assert(
    failed[0].stage === "diagnosis" &&
      failed[0].code === "advisory-failed" &&
      failed[0].advisoryRunId === harness.ids.fail.advisoryId,
    "fail: diagnosis-stage advisory-failed evidence"
  );
  assert(
    listChildren(harness.db, harness.ids.fail.id).length === 1,
    "fail: no respawn (still one child)"
  );
  const failAfter = sourceAuthoritySnapshot(harness.db, harness.ids.fail.id);
  assert(
    failAfter.status === failBefore.status &&
      failAfter.chain_handled_at === failBefore.chain_handled_at &&
      failAfter.chain_stop_requested_at === failBefore.chain_stop_requested_at,
    "fail: source authority unchanged"
  );
  assert(
    eventsOfType(harness.db, harness.ids.fail.id, "run.pipeline-escalated")
      .length === 0,
    "fail: source not escalated"
  );

  console.log("progress: operator no-timeout briefing presentation");
  await presentBriefing(harness, {
    sourceId: harness.ids.operator.id,
    advisoryId: harness.ids.operator.advisoryId,
    rootId: harness.ids.operator.rootId,
    context: harness.ids.operator.ctx,
    recommendation: "skip",
  });
  const opPending = harness.inputHub.getPendingQuestion(
    harness.ids.operator.advisoryId
  );
  assert(opPending?.status === "pending", "operator: one pending card");
  const opMeta = parseInputMetadataJson(opPending.metadata_json);
  assert(
    opMeta?.kind === HALT_DISCOVERY_INPUT_KIND,
    "operator: exact halt-discovery briefing kind"
  );
  assert(
    harness.inputHub.hasActiveWaiter(harness.ids.operator.advisoryId) === false,
    "operator: no active agent waiter"
  );
  assert(
    !("timeoutMs" in (opMeta ?? {})) && !("deadline" in (opMeta ?? {})),
    "operator: no timeout/deadline requirement on metadata"
  );
  const opSourceBefore = sourceAuthoritySnapshot(
    harness.db,
    harness.ids.operator.id
  );
  assert(
    opSourceBefore.status === "failed" &&
      opSourceBefore.chain_handled_at == null,
    "operator: source still failed / unclaimed before answer"
  );

  console.log("progress: promotion pending briefing");
  await presentBriefing(harness, {
    sourceId: harness.ids.promote.id,
    advisoryId: harness.ids.promote.advisoryId,
    rootId: harness.ids.promote.rootId,
    context: harness.ids.promote.ctx,
    recommendation: "chat",
  });
  seedRetained(harness, harness.ids.promote.advisoryId);
  assert(
    harness.inputHub.getPendingQuestion(harness.ids.promote.advisoryId)
      ?.status === "pending",
    "promote: pending briefing ready"
  );
}

async function runOperatorAnswer(harness) {
  console.log("progress: HTTP skip answer on operator briefing");
  const res = await fetch(
    `${base}/api/runs/${encodeURIComponent(harness.ids.operator.advisoryId)}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "skip" }),
    }
  );
  assert(res.status === 200, "operator HTTP answer returns 200");
  assert(
    harness.store.getRun(harness.ids.operator.advisoryId)?.status ===
      "completed",
    "operator: advisory completed after answer"
  );
  const cards = harness.inputHub.listForRun(harness.ids.operator.advisoryId);
  assert(
    cards.length === 1 &&
      cards[0].status === "answered" &&
      cards[0].answer === "skip",
    "operator: card answered skip"
  );
  const actionResults = eventsOfType(
    harness.db,
    harness.ids.operator.advisoryId,
    "run.pipeline-halt-discovery-action-result"
  );
  assert(actionResults.length === 1, "operator: one action-result on advisory");
  assert(
    actionResults[0].outcome === "acted" &&
      actionResults[0].action === "skip" &&
      actionResults[0].sourceRunId === harness.ids.operator.id &&
      actionResults[0].advisoryRunId === harness.ids.operator.advisoryId,
    "operator: action-result records acted skip linked to source/advisory"
  );
  const escalated = eventsOfType(
    harness.db,
    harness.ids.operator.id,
    "run.pipeline-escalated"
  );
  assert(escalated.length === 1, "operator: exactly one source escalation");
  assert(
    escalated[0].actor === "operator" && escalated[0].action === "skip",
    "operator: escalation is operator-attributed skip"
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

  const liveSource = payload.runs.find((r) => r.id === harness.ids.live.id);
  const opAdvisory = payload.runs.find(
    (r) => r.id === harness.ids.operator.advisoryId
  );
  const promoAdvisory = payload.runs.find(
    (r) => r.id === harness.ids.promote.advisoryId
  );
  assert(liveSource != null, "API lists live source");
  assert(
    liveSource.parentRunId == null &&
      liveSource.chainRootRunId === harness.ids.live.rootId &&
      liveSource.pipeline?.featureId === "b44e" &&
      liveSource.chainHandledAt == null,
    "API: live source root/feature/unclaimed"
  );

  const liveChild = payload.runs.find(
    (r) =>
      r.parentRunId === harness.ids.live.id &&
      r.triggerKind === HALT_DISCOVERY_TRIGGER_KIND
  );
  assert(liveChild != null, "API lists live advisory child");
  assert(
    liveChild.chainRootRunId === harness.ids.live.rootId &&
      liveChild.chainDepth === 2,
    "API: live advisory preserves root/depth"
  );

  assert(opAdvisory != null, "API lists operator advisory");
  assert(
    opAdvisory.parentRunId === harness.ids.operator.id &&
      opAdvisory.triggerKind === HALT_DISCOVERY_TRIGGER_KIND &&
      opAdvisory.status === "completed",
    "API: operator advisory linked and completed"
  );

  assert(promoAdvisory != null, "API lists promote advisory");
  assert(
    promoAdvisory.parentRunId === harness.ids.promote.id &&
      promoAdvisory.status === "needs_input" &&
      promoAdvisory.triggerKind === HALT_DISCOVERY_TRIGGER_KIND,
    "API: promote advisory linked and needs_input"
  );

  const promoSnapshot = await waitUntil("API promote run snapshot", async () => {
    const res = await fetch(
      `${base}/api/runs/${encodeURIComponent(harness.ids.promote.advisoryId)}`
    );
    if (!res.ok) return null;
    return res.json();
  });
  const pending = (promoSnapshot.inputRequests ?? []).find(
    (r) => r.status === "pending"
  );
  assert(pending != null, "API: promote advisory has pending input request");
  assert(
    pending.metadata?.kind === HALT_DISCOVERY_INPUT_KIND ||
      JSON.stringify(pending).includes(HALT_DISCOVERY_INPUT_KIND),
    "API: pending card exposes halt-discovery kind"
  );
  const pendingJson = JSON.stringify(pending);
  assert(
    !pendingJson.includes(SECRET_IDEA),
    "API: pending card omits pipeline idea"
  );
  assert(
    !pendingJson.includes("Review prompt for"),
    "API: pending card omits stored source prompt"
  );
}

/**
 * Opens one board card's Logs modal, waits for expected lifecycle copy, and
 * returns the transcript text with the modal closed again.
 */
async function readCardLogs(page, opts) {
  const card = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(opts.label) })
    .filter({ has: page.locator(`[title="${opts.status}"]`) })
    .first();
  await card.waitFor({ state: "visible", timeout: 15000 });
  await card.getByRole("button", { name: "View logs" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  await waitUntil(`${opts.what} logs copy`, async () => {
    const text = await dialog.innerText();
    return opts.until.test(text) ? true : null;
  });
  const text = await dialog.innerText();
  await page.keyboard.press("Escape");
  await waitUntil(`${opts.what} logs modal to close`, async () =>
    (await dialog.count()) === 0 ? true : null
  );
  return text;
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

  const liveChip = page.getByText(/b44e · review/i).first();
  await liveChip.waitFor({ state: "visible", timeout: 15000 });
  assert(true, "board shows b44e review lineage chip");

  const bodyText = await page.locator("body").innerText();
  assert(
    !bodyText.includes(SECRET_IDEA),
    "board text does not leak pipeline idea"
  );

  const liveCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/b44e · review/i) })
    .filter({ has: page.locator('[title="failed"]') })
    .first();
  await liveCard.waitFor({ state: "visible", timeout: 10000 });
  await liveCard.hover();
  assert(
    await liveCard.getByRole("button", { name: "Retry", exact: true }).isVisible(),
    "live source retains Retry"
  );
  assert(
    await liveCard.getByRole("button", { name: "Skip", exact: true }).isVisible(),
    "live source retains Skip"
  );
  assert(
    await liveCard.getByRole("button", { name: "Abort", exact: true }).isVisible(),
    "live source retains Abort"
  );

  await liveCard.getByRole("button", { name: "View logs" }).click();
  const liveDialog = page.getByRole("dialog");
  await liveDialog.waitFor({ state: "visible", timeout: 10000 });
  await waitUntil("live logs show discovery requested", async () => {
    const text = await liveDialog.innerText();
    return /Halt discovery requested|halt discovery requested/i.test(text)
      ? true
      : null;
  });
  const liveLogText = await liveDialog.innerText();
  assert(
    !/source recovered|automatic recovery succeeded|pipeline recovered/i.test(
      liveLogText
    ),
    "live logs do not claim source recovery"
  );
  await page.keyboard.press("Escape");
  await waitUntil("live logs modal to close", async () =>
    (await liveDialog.count()) === 0 ? true : null
  );

  const failCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/b44f/i) })
    .filter({ has: page.locator('[title="failed"]') })
    .first();
  await failCard.waitFor({ state: "visible", timeout: 10000 });
  await failCard.getByRole("button", { name: "View logs" }).click();
  const failDialog = page.getByRole("dialog");
  await failDialog.waitFor({ state: "visible", timeout: 10000 });
  await waitUntil("fail logs show diagnosis failure", async () => {
    const text = await failDialog.innerText();
    return /Halt discovery failed|halt discovery failed/i.test(text)
      ? true
      : null;
  });
  const failLogText = await failDialog.innerText();
  assert(
    !/source recovered|automatic recovery succeeded/i.test(failLogText),
    "fail logs do not claim source recovery"
  );
  await page.keyboard.press("Escape");
  await waitUntil("fail logs modal to close", async () =>
    (await failDialog.count()) === 0 ? true : null
  );

  console.log("progress: promote via rendered control");
  const promoCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/b44p/i) })
    .filter({ has: page.locator('[title="needs_input"]') })
    .first();
  await promoCard.waitFor({ state: "visible", timeout: 15000 });
  const promoBody = await promoCard.innerText();
  assert(
    /Diagnosis summary|Likely cause|recommendation/i.test(promoBody),
    "promote card shows briefing copy"
  );
  const promoteBtn = promoCard.locator('[data-promote-to-chat="halt-discovery"]');
  await promoteBtn.waitFor({ state: "visible", timeout: 10000 });
  assert(
    await promoteBtn.isVisible(),
    "promote card exposes Continue diagnosis in chat"
  );
  await promoteBtn.click();

  await waitUntil("promotion completes in DB", async () => {
    const status = harness.store.getRun(harness.ids.promote.advisoryId)?.status;
    return status === "completed" ? true : null;
  });

  const cards = harness.inputHub.listForRun(harness.ids.promote.advisoryId);
  assert(
    cards.length === 1 &&
      cards[0].status === "cancelled" &&
      cards[0].answer == null,
    "promote: card cancelled not answered"
  );
  const promoted = eventsOfType(
    harness.db,
    harness.ids.promote.advisoryId,
    "run.pipeline-halt-discovery-promoted"
  );
  assert(promoted.length === 1, "promote: one promotion event");
  assert(
    promoted[0].sourceRunId === harness.ids.promote.id &&
      promoted[0].advisoryRunId === harness.ids.promote.advisoryId &&
      typeof promoted[0].chatId === "string",
    "promote: event links source/advisory/chat"
  );

  const chat = harness.db
    .prepare(`SELECT * FROM chat_sessions WHERE id = ?`)
    .get(promoted[0].chatId);
  assert(chat != null, "promote: origin-linked chat exists");
  assert(
    chat.origin_run_id === harness.ids.promote.advisoryId,
    "promote: chat origin is advisory"
  );
  const chatSeed = harness.db
    .prepare(
      `SELECT payload FROM chat_events
       WHERE chat_id = ? AND event_type = 'chat.message'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(promoted[0].chatId);
  assert(chatSeed != null, "promote: chat has seeded message");
  const seedPayload = JSON.parse(chatSeed.payload);
  assert(
    typeof seedPayload.text === "string" &&
      seedPayload.text.includes("Diagnosis summary"),
    "promote: seed includes briefing summary"
  );

  assert(
    eventsOfType(
      harness.db,
      harness.ids.promote.id,
      "run.pipeline-escalated"
    ).length === 0,
    "promote: source remains un-escalated"
  );
  assert(
    readRun(harness.db, harness.ids.promote.id).chain_handled_at == null,
    "promote: source claim unchanged"
  );

  // Re-open source/advisory logs for the remaining lifecycle copy. These are
  // required evidence, not opportunistic: locate by label + status and fail if
  // the card or its copy never appears.
  await page.goto(base, { waitUntil: "networkidle" });
  await sleep(600);
  await expandAllPipelineGroups(page);

  const promoSourceLog = await readCardLogs(page, {
    label: /b44p · review/i,
    status: "failed",
    what: "promo source",
    until: /Halt discovery requested|halt discovery requested/i,
  });
  assert(
    !/source recovered|automatic recovery succeeded/i.test(promoSourceLog),
    "promo source logs do not claim recovery"
  );

  const promoAdvisoryLog = await readCardLogs(page, {
    label: /b44p/i,
    status: "completed",
    what: "promo advisory",
    until: /promoted to chat/i,
  });
  assert(
    /not escalated/i.test(promoAdvisoryLog),
    "promo advisory logs state the source was not escalated"
  );
  assert(
    !/source recovered|source escalated via promotion/i.test(promoAdvisoryLog),
    "promo advisory logs do not claim source recovery/escalation"
  );

  const operatorAdvisoryLog = await readCardLogs(page, {
    label: /b44o/i,
    status: "completed",
    what: "operator advisory",
    until: /halt discovery action applied|Operator approved/i,
  });
  assert(
    /Operator approved skip/i.test(operatorAdvisoryLog),
    "operator advisory logs show the operator-approved skip"
  );
  assert(
    !/source recovered|automatic recovery succeeded/i.test(operatorAdvisoryLog),
    "operator advisory logs do not claim automatic source recovery"
  );
}

async function main() {
  let browser;
  let http;
  let harness;

  try {
    harness = seedHarness();
    await runDiscoveryScenarios(harness);
    harness.chainRunner.start();
    http = await startServer(harness);
    await sleep(400);
    await runOperatorAnswer(harness);
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
      harness?.disabledRunner?.stop();
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
    console.log("\nb44 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
