import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext, RunStatus } from "@lca/shared";
import { GENERATED_CONFIG_KEY_PREFIX } from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { provisionGeneratedWorkers } from "../packages/daemon/src/config/generated-workers.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
  HALT_DISCOVERY_WORKERS,
} from "../packages/daemon/src/pipelines/halt-discovery.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import {
  orchestrateHaltDiscoveryAdvisory,
  reconcileHaltDiscoveryAdvisoryTerminal,
} from "../packages/daemon/src/runs/halt-discovery-orchestrator.ts";
import type { PipelineWaveCoordinator } from "../packages/daemon/src/runs/pipeline-wave-coordinator.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b44",
    featureSlug: "b44-halt-discovery-agent",
    featureDir: "docs/roadmap/done/b44-halt-discovery-agent",
    featureIndex: "docs/roadmap/done/b44-halt-discovery-agent/00-index.md",
    idea: "halt discovery lifecycle",
    planningDepth: "jit",
    approvalPolicy: "none",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

const HALT_DISCOVERY_CONFIG_KEY =
  GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;

const LOOKBACK_MS = 86_400_000;

vi.unmock("node:os");

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:os");
});

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        wait: async () => ({ status: "finished", result: "ok" }) as never,
        cancel: async () => {},
        dispose: async () => {},
      };
      return activeRun;
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function insertAutomation(
  db: Db,
  input: {
    id: string;
    configKey: string;
    name: string;
    prompt?: string;
    chainJson?: string | null;
    modelRole?: string | null;
    origin?: string;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role, origin
    ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name}`,
    input.configKey,
    input.chainJson ?? null,
    input.modelRole ?? null,
    input.origin ?? "generated"
  );
}

function seedPipelineWorkers(db: Db): void {
  insertAutomation(db, {
    id: "ws::implement",
    configKey: "generated:implement",
    name: "Implement",
    prompt: "Implement {{featureId}}",
    chainJson: JSON.stringify({
      next: "generated:review",
      when: "completed",
    }),
    modelRole: "implementer",
  });
  insertAutomation(db, {
    id: "ws::review",
    configKey: "generated:review",
    name: "Review",
    prompt: "Review {{featureId}}",
    chainJson: JSON.stringify({
      next: "generated:docs-commit",
      when: "completed",
    }),
    modelRole: "reviewer",
  });
  insertAutomation(db, {
    id: "ws::docs",
    configKey: "generated:docs-commit",
    name: "Docs",
    prompt: "Docs {{featureId}}",
    modelRole: "docs",
  });
}

type Env = {
  root: string;
  workspace: string;
  db: Db;
  store: RunStore;
  engine: RunEngine;
  events: DaemonEventBus;
  chainRunner: ChainRunner;
  provisionCalls: number;
  waveHookCalls: Array<{ runId: string; status: RunStatus }>;
  recoveryDecisions: Array<{ runId: string; kind: string }>;
};

function createEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "lca-b44-lifecycle-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  mkdirSync(join(workspace, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), '{"name":"ws"}\n');
  writeFileSync(join(workspace, "docs", "roadmap", "00-index.md"), "# idx\n");

  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
  ).run("ws", workspace, "Workspace");
  seedPipelineWorkers(db);

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: stubExecutor(),
    events,
    inputHub,
    maxConcurrentRuns: 4,
  });

  const env: Env = {
    root,
    workspace,
    db,
    store,
    engine,
    events,
    chainRunner: null as unknown as ChainRunner,
    provisionCalls: 0,
    waveHookCalls: [],
    recoveryDecisions: [],
  };

  const waveCoordinator = {
    handleTerminalHook: async (runId: string, status: RunStatus) => {
      env.waveHookCalls.push({ runId, status });
      return { handled: false };
    },
  } as unknown as PipelineWaveCoordinator;

  env.chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: LOOKBACK_MS,
    pipelineAutoEscalate: true,
    pipelineHaltDiscovery: true,
    waveCoordinator,
    onHaltRecoveryDecision: (runId, result) => {
      env.recoveryDecisions.push({ runId, kind: result.kind });
    },
    orchestrateHaltDiscoveryAdvisory: (sourceRunId) =>
      orchestrateHaltDiscoveryAdvisory({
        store,
        engine,
        provisionWorkers: (workspaceId, workers) => {
          env.provisionCalls += 1;
          return provisionGeneratedWorkers(db, workspaceId, [...workers], {
            prune: false,
          });
        },
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
  });

  return env;
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function seedFailedHalt(
  store: RunStore,
  db: Db,
  opts: {
    id: string;
    depth?: number;
    maxDepth?: number;
    rootId?: string;
    failureReason?: string;
    endedAt?: string;
  }
): void {
  const id = opts.id;
  const rootId = opts.rootId ?? "root-1";
  store.insertRun({
    id,
    automationId: "ws::review",
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: "Review prompt stored",
    chainContext: CONTEXT,
    chainRootRunId: rootId,
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: opts.maxDepth ?? 9,
  });
  store.setStatus(id, "failed");
  const endedAt =
    opts.endedAt ??
    new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  db.prepare(`UPDATE runs SET ended_at = ? WHERE id = ?`).run(endedAt, id);
  store.appendEvent(id, "assistant", {
    message: { content: [{ type: "text", text: "working" }] },
  });
  store.appendEvent(id, "tool_call", { name: "Shell" });
  store.appendEvent(id, "run.error", {
    reason: opts.failureReason ?? "auth_failed",
    sdkStatus: "error",
  });
}

function appendRequested(store: RunStore, runId: string): void {
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

function ensureHaltDiscoveryAutomation(env: Env): string {
  const plan = provisionGeneratedWorkers(env.db, "ws", [
    ...HALT_DISCOVERY_WORKERS,
  ], { prune: false });
  expect(plan.applied).toBe(true);
  return automationId("ws", HALT_DISCOVERY_CONFIG_KEY);
}

function seedAdvisoryChild(
  env: Env,
  opts: {
    sourceId: string;
    childId: string;
    status: RunStatus;
    createdAt?: string;
  }
): void {
  const autoId = ensureHaltDiscoveryAutomation(env);
  env.store.insertRun({
    id: opts.childId,
    automationId: autoId,
    workspaceId: "ws",
    triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
    prompt: "seeded advisory",
    parentRunId: opts.sourceId,
    chainContext: CONTEXT,
    chainRootRunId: "root-1",
    chainDepth: 2,
    chainMaxDepth: 9,
  });
  env.store.setStatus(opts.childId, opts.status);
  if (opts.createdAt) {
    env.db
      .prepare(`UPDATE runs SET created_at = ? WHERE id = ?`)
      .run(opts.createdAt, opts.childId);
  }
}

function eventsOfType(db: Db, runId: string, eventType: string) {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = ?
         ORDER BY seq ASC`
      )
      .all(runId, eventType) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function eventTypes(db: Db, runId: string): string[] {
  return (
    db
      .prepare(
        `SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq ASC`
      )
      .all(runId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

function readRun(db: Db, id: string) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | {
        id: string;
        status: string;
        parent_run_id: string | null;
        trigger_kind: string | null;
        chain_root_run_id: string | null;
        chain_depth: number | null;
        chain_max_depth: number | null;
        chain_handled_at: string | null;
        chain_stop_requested_at: string | null;
        chain_max_depth_override: number | null;
        pipeline_wave_id: string | null;
        pipeline_track_id: string | null;
        execution_cwd: string | null;
        model: string | null;
        automation_id: string;
      }
    | undefined;
}

function listChildren(db: Db, parentId: string) {
  return db
    .prepare(
      `SELECT r.id, r.status, r.trigger_kind, r.chain_depth, r.model, a.config_key
       FROM runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.parent_run_id = ?
       ORDER BY r.rowid ASC`
    )
    .all(parentId) as Array<{
    id: string;
    status: string;
    trigger_kind: string | null;
    chain_depth: number | null;
    model: string | null;
    config_key: string;
  }>;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("b44 halt discovery lifecycle composition", () => {
  it("live decline requests discovery and enqueues one restricted advisory child", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-live",
        depth: 2,
        maxDepth: 9,
        failureReason: "auth_failed",
      });
      const before = readRun(env.db, "halt-live")!;

      await env.chainRunner.handleTerminal("halt-live", "failed");

      expect(
        eventsOfType(env.db, "halt-live", "run.pipeline-halt-unrecovered")
      ).toHaveLength(1);
      expect(
        eventsOfType(
          env.db,
          "halt-live",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(1);
      expect(env.recoveryDecisions).toEqual([
        { runId: "halt-live", kind: "declined" },
      ]);
      expect(env.provisionCalls).toBe(1);

      const children = listChildren(env.db, "halt-live");
      expect(children).toHaveLength(1);
      expect(children[0]!.trigger_kind).toBe(HALT_DISCOVERY_TRIGGER_KIND);
      expect(children[0]!.config_key).toBe(HALT_DISCOVERY_CONFIG_KEY);
      expect(children[0]!.chain_depth).toBe(2);
      expect(children[0]!.model).toBe("reviewer-model");

      const child = readRun(env.db, children[0]!.id)!;
      expect(child.parent_run_id).toBe("halt-live");
      expect(child.chain_root_run_id).toBe("root-1");
      expect(child.chain_max_depth).toBe(9);
      expect(child.pipeline_wave_id).toBeNull();
      expect(child.pipeline_track_id).toBeNull();
      expect(child.execution_cwd).toBeNull();

      const after = readRun(env.db, "halt-live")!;
      expect(after.status).toBe("failed");
      expect(after.chain_handled_at).toBeNull();
      expect(after.chain_stop_requested_at).toBeNull();
      expect(after.chain_depth).toBe(before.chain_depth);
      expect(after.chain_max_depth).toBe(before.chain_max_depth);
      expect(after.chain_max_depth_override).toBe(
        before.chain_max_depth_override
      );
      expect(eventTypes(env.db, "halt-live")).not.toContain("run.chained");
      expect(eventTypes(env.db, "halt-live")).not.toContain(
        "run.pipeline-escalated"
      );
      expect(
        eventsOfType(env.db, "halt-live", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("startup recovers missed enqueue and is idempotent on second replay", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-startup" });
      appendRequested(env.store, "halt-startup");

      const first = await env.chainRunner.resumeHaltDiscoveryAdvisories();
      expect(first).toBe(1);
      expect(listChildren(env.db, "halt-startup")).toHaveLength(1);
      expect(env.provisionCalls).toBe(1);

      const second = await env.chainRunner.resumeHaltDiscoveryAdvisories();
      expect(second).toBe(0);
      expect(listChildren(env.db, "halt-startup")).toHaveLength(1);
      expect(env.provisionCalls).toBe(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("concurrent live and startup entry does not duplicate the advisory child", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-race" });
      appendRequested(env.store, "halt-race");

      const [a, b] = await Promise.all([
        orchestrateHaltDiscoveryAdvisory({
          store: env.store,
          engine: env.engine,
          provisionWorkers: (workspaceId, workers) => {
            env.provisionCalls += 1;
            return provisionGeneratedWorkers(env.db, workspaceId, [
              ...workers,
            ], { prune: false });
          },
          onLog: () => {},
          sourceRunId: "halt-race",
        }),
        env.chainRunner.resumeHaltDiscoveryAdvisories(),
      ]);

      expect(
        a.kind === "enqueued" || a.kind === "existing"
      ).toBe(true);
      expect(listChildren(env.db, "halt-race")).toHaveLength(1);
      expect(b === 0 || b === 1).toBe(true);
    } finally {
      await destroyEnv(env);
    }
  });

  it("existing non-terminal children never duplicate on startup replay", async () => {
    const statuses: RunStatus[] = [
      "queued",
      "running",
      "needs_input",
      "completed",
    ];
    for (const status of statuses) {
      const env = createEnv();
      try {
        seedFailedHalt(env.store, env.db, { id: `halt-${status}` });
        appendRequested(env.store, `halt-${status}`);
        seedAdvisoryChild(env, {
          sourceId: `halt-${status}`,
          childId: `child-${status}`,
          status,
        });
        env.provisionCalls = 0;

        const enqueued =
          await env.chainRunner.resumeHaltDiscoveryAdvisories();
        expect(enqueued).toBe(0);
        expect(listChildren(env.db, `halt-${status}`)).toHaveLength(1);
        expect(env.provisionCalls).toBe(0);
        expect(
          eventsOfType(
            env.db,
            `halt-${status}`,
            "run.pipeline-halt-discovery-failed"
          )
        ).toHaveLength(0);
      } finally {
        await destroyEnv(env);
      }
    }
  });

  it("failed and cancelled children reconcile on startup and never respawn", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const env = createEnv();
      try {
        seedFailedHalt(env.store, env.db, { id: `halt-${status}` });
        appendRequested(env.store, `halt-${status}`);
        seedAdvisoryChild(env, {
          sourceId: `halt-${status}`,
          childId: `child-${status}`,
          status,
        });
        env.store.appendEvent(`child-${status}`, "run.started", {});
        env.store.appendEvent(`child-${status}`, "run.error", {
          message: `${status} mid-diagnosis`,
        });
        env.provisionCalls = 0;

        const enqueued =
          await env.chainRunner.resumeHaltDiscoveryAdvisories();
        expect(enqueued).toBe(0);
        expect(listChildren(env.db, `halt-${status}`)).toHaveLength(1);
        expect(env.provisionCalls).toBe(0);

        const failed = eventsOfType(
          env.db,
          `halt-${status}`,
          "run.pipeline-halt-discovery-failed"
        );
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({
          stage: "diagnosis",
          code:
            status === "cancelled"
              ? "advisory-cancelled"
              : "advisory-failed",
          advisoryRunId: `child-${status}`,
        });

        const again = await env.chainRunner.resumeHaltDiscoveryAdvisories();
        expect(again).toBe(0);
        expect(
          eventsOfType(
            env.db,
            `halt-${status}`,
            "run.pipeline-halt-discovery-failed"
          )
        ).toHaveLength(1);
      } finally {
        await destroyEnv(env);
      }
    }
  });

  it("cancellation subscription reconciles authoritative advisory once", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-cancel" });
      appendRequested(env.store, "halt-cancel");
      seedAdvisoryChild(env, {
        sourceId: "halt-cancel",
        childId: "adv-cancel",
        status: "running",
      });
      env.store.appendEvent("adv-cancel", "run.started", {});
      env.store.appendEvent("adv-cancel", "run.error", {
        message: "operator cancelled",
      });

      env.chainRunner.start();
      env.store.setStatus("adv-cancel", "cancelled");
      await flushMicrotasks();
      await flushMicrotasks();

      const failed = eventsOfType(
        env.db,
        "halt-cancel",
        "run.pipeline-halt-discovery-failed"
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        code: "advisory-cancelled",
        advisoryRunId: "adv-cancel",
      });
      expect(env.waveHookCalls).toEqual([]);
      expect(env.recoveryDecisions).toEqual([]);

      await env.chainRunner.handleTerminal("adv-cancel", "cancelled");
      expect(
        eventsOfType(
          env.db,
          "halt-cancel",
          "run.pipeline-halt-discovery-failed"
        )
      ).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("superseded duplicate child never reconciles the source", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-dup" });
      appendRequested(env.store, "halt-dup");
      seedAdvisoryChild(env, {
        sourceId: "halt-dup",
        childId: "adv-old",
        status: "running",
        createdAt: "2020-01-01 00:00:00",
      });
      seedAdvisoryChild(env, {
        sourceId: "halt-dup",
        childId: "adv-new",
        status: "failed",
        createdAt: "2020-01-02 00:00:00",
      });
      env.store.appendEvent("adv-new", "run.started", {});
      env.store.appendEvent("adv-new", "run.error", {
        message: "duplicate terminal",
      });

      env.waveHookCalls.length = 0;
      await env.chainRunner.handleTerminal("adv-new", "failed");

      expect(
        eventsOfType(
          env.db,
          "halt-dup",
          "run.pipeline-halt-discovery-failed"
        )
      ).toHaveLength(0);
      expect(env.waveHookCalls).toEqual([]);
      expect(env.recoveryDecisions).toEqual([]);

      env.store.setStatus("adv-old", "failed");
      env.store.appendEvent("adv-old", "run.started", {});
      env.store.appendEvent("adv-old", "run.error", {
        message: "authoritative failure",
      });
      await env.chainRunner.handleTerminal("adv-old", "failed");
      await env.chainRunner.handleTerminal("adv-old", "failed");

      const failed = eventsOfType(
        env.db,
        "halt-dup",
        "run.pipeline-halt-discovery-failed"
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        advisoryRunId: "adv-old",
        code: "advisory-failed",
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("startup after missed terminal reconciles without respawn", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-missed" });
      appendRequested(env.store, "halt-missed");
      seedAdvisoryChild(env, {
        sourceId: "halt-missed",
        childId: "adv-missed",
        status: "failed",
      });
      env.store.appendEvent("adv-missed", "run.error", {
        message: "missed terminal",
      });
      env.provisionCalls = 0;

      const enqueued = await env.chainRunner.resumeHaltDiscoveryAdvisories();
      expect(enqueued).toBe(0);
      expect(env.provisionCalls).toBe(0);
      expect(listChildren(env.db, "halt-missed")).toHaveLength(1);
      expect(
        eventsOfType(
          env.db,
          "halt-missed",
          "run.pipeline-halt-discovery-failed"
        )
      ).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("cancelled non-discovery runs retain existing subscription behavior", async () => {
    const env = createEnv();
    try {
      env.store.insertRun({
        id: "review-cancel",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "review",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("review-cancel", "running");
      env.chainRunner.start();
      env.waveHookCalls.length = 0;
      env.store.setStatus("review-cancel", "cancelled");
      await flushMicrotasks();
      await flushMicrotasks();

      expect(env.waveHookCalls).toEqual([]);
      expect(env.recoveryDecisions).toEqual([]);
      expect(
        eventsOfType(
          env.db,
          "review-cancel",
          "run.pipeline-halt-discovery-failed"
        )
      ).toHaveLength(0);
      expect(listChildren(env.db, "review-cancel")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("every advisory status bypasses wave hooks, chaining, and b43 recovery", async () => {
    const cases: Array<{ persisted: RunStatus; declared: RunStatus }> = [
      { persisted: "queued", declared: "completed" },
      { persisted: "running", declared: "completed" },
      { persisted: "needs_input", declared: "completed" },
      { persisted: "completed", declared: "completed" },
      { persisted: "failed", declared: "failed" },
      { persisted: "cancelled", declared: "cancelled" },
    ];
    for (const { persisted, declared } of cases) {
      const env = createEnv();
      try {
        seedFailedHalt(env.store, env.db, {
          id: `halt-bypass-${persisted}`,
        });
        appendRequested(env.store, `halt-bypass-${persisted}`);
        seedAdvisoryChild(env, {
          sourceId: `halt-bypass-${persisted}`,
          childId: `adv-bypass-${persisted}`,
          status: persisted,
        });
        env.waveHookCalls.length = 0;
        env.recoveryDecisions.length = 0;

        await env.chainRunner.handleTerminal(
          `adv-bypass-${persisted}`,
          declared
        );

        expect(env.waveHookCalls).toEqual([]);
        expect(env.recoveryDecisions).toEqual([]);
        expect(eventTypes(env.db, `adv-bypass-${persisted}`)).not.toContain(
          "run.chained"
        );
        expect(eventTypes(env.db, `halt-bypass-${persisted}`)).not.toContain(
          "run.pipeline-escalated"
        );
        expect(eventTypes(env.db, `adv-bypass-${persisted}`)).not.toContain(
          "run.chain-skipped"
        );
      } finally {
        await destroyEnv(env);
      }
    }
  });

  it("provisioning callback uses prune:false and only halt-discovery workers", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-prune" });
      appendRequested(env.store, "halt-prune");

      let seenWorkers: string[] | null = null;
      let seenPrune: boolean | undefined;
      const result = await orchestrateHaltDiscoveryAdvisory({
        store: env.store,
        engine: env.engine,
        provisionWorkers: (workspaceId, workers) => {
          seenWorkers = workers.map((w) => w.key);
          const plan = provisionGeneratedWorkers(
            env.db,
            workspaceId,
            [...workers],
            { prune: false }
          );
          seenPrune = false;
          return plan;
        },
        onLog: () => {},
        sourceRunId: "halt-prune",
      });
      expect(result.kind).toBe("enqueued");
      expect(seenWorkers).toEqual([HALT_DISCOVERY_WORKER_KEY]);
      expect(seenPrune).toBe(false);

      const archived = env.db
        .prepare(
          `SELECT COUNT(*) AS n FROM automations
           WHERE workspace_id = 'ws' AND archived_at IS NOT NULL`
        )
        .get() as { n: number };
      expect(archived.n).toBe(0);
    } finally {
      await destroyEnv(env);
    }
  });
});
