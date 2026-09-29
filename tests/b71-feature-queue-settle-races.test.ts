import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type ChainRunContext,
  type RunStatus,
} from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  provisionGeneratedWorkers,
} from "../packages/daemon/src/config/generated-workers.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY,
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import {
  FeatureQueueRunner,
  type FeatureQueueSettleSource,
} from "../packages/daemon/src/runs/feature-queue-runner.ts";
import {
  dependencyBlockDetail,
  failedFeatureBlockDetail,
  FEATURE_QUEUE_RECOVERED_DETAIL,
  FeatureQueueStore,
} from "../packages/daemon/src/runs/feature-queue-store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { formatPipelineGroupStatus } from "../packages/dashboard/src/pipelineGrouping.ts";
import {
  runCardStatusLabel,
  SLOT_WAITING_LABEL,
} from "../packages/dashboard/src/runStatusLabel.ts";

type Db = ReturnType<typeof openDatabase>;

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TERMINAL_KEY = IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b71",
    featureSlug: "b71-feature-queue-settle-races",
    featureDir: "docs/roadmap/b71-feature-queue-settle-races",
    featureIndex: "docs/roadmap/b71-feature-queue-settle-races/00-index.md",
    idea: "settle ordering",
    planningDepth: "full",
    approvalPolicy: "none",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("until() timed out"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn should not be called");
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function workerAutomationId(workspaceId: string, workerKey: string): string {
  return automationId(
    workspaceId,
    `${GENERATED_CONFIG_KEY_PREFIX}${workerKey}`
  );
}

function insertRun(
  db: Db,
  args: {
    id: string;
    automationId: string;
    workspaceId: string;
    status: string;
    chainRootRunId?: string | null;
    parentRunId?: string | null;
    chainDepth?: number | null;
    chainMaxDepth?: number | null;
    chainContext?: ChainRunContext | null;
    chainStopRequested?: boolean;
    chainStopReason?: string | null;
  }
): void {
  const contextJson =
    args.chainContext == null ? null : JSON.stringify(args.chainContext);
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status,
       chain_root_run_id, parent_run_id, trigger_kind, prompt,
       chain_depth, chain_max_depth, chain_context_json,
       chain_stop_requested_at, chain_stop_reason
     ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'prompt', ?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.status,
    args.chainRootRunId ?? null,
    args.parentRunId ?? null,
    args.chainDepth ?? null,
    args.chainMaxDepth ?? null,
    contextJson,
    args.chainStopRequested ? new Date().toISOString() : null,
    args.chainStopReason ?? null
  );
}

type ChainHold = {
  promise: Promise<void>;
  release: () => void;
};

function createChainHold(): ChainHold {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type Harness = {
  root: string;
  db: Db;
  workspaceId: string;
  entryAutomationId: string;
  planSkeletonAutomationId: string;
  planPhaseAutomationId: string;
  terminalAutomationId: string;
  events: DaemonEventBus;
  store: RunStore;
  engine: RunEngine;
  queueStore: FeatureQueueStore;
  chainRunner: ChainRunner;
  runner: FeatureQueueRunner;
  triggerCalls: Array<{ automationId: string; triggerKind: string }>;
  logs: string[];
  setChainHold: (hold: ChainHold | null) => void;
  cleanup: () => void;
};

async function createHarness(options?: {
  settleSource?: FeatureQueueSettleSource | "chainRunner";
  withNotifier?: boolean;
}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "lca-b71-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    workspaceId,
    workspacePath,
    "Workspace"
  );
  const plan = provisionGeneratedWorkers(db, workspaceId, IMPLEMENT_FULLY_WORKERS);
  expect(plan.applied).toBe(true);
  const entryAutomationId = workerAutomationId(
    workspaceId,
    IMPLEMENT_FULLY_ENTRY_WORKER_KEY
  );
  const planSkeletonAutomationId = workerAutomationId(
    workspaceId,
    IMPLEMENT_FULLY_ENTRY_WORKER_KEY
  );
  const planPhaseAutomationId = workerAutomationId(workspaceId, "plan-phase");
  const terminalAutomationId = workerAutomationId(
    workspaceId,
    IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
  );
  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    inputHub,
    maxConcurrentRuns: 4,
    events,
  });
  const queueStore = new FeatureQueueStore(db);
  const logs: string[] = [];
  const triggerCalls: Harness["triggerCalls"] = [];
  const holdState = { current: null as ChainHold | null };

  engine.triggerRun = async (automationIdArg, triggerKind = "manual", opts) => {
    triggerCalls.push({ automationId: automationIdArg, triggerKind });
    if (triggerKind === "chain" && holdState.current) {
      await holdState.current.promise;
    }
    const runId = randomUUID();
    const chainRootRunId =
      opts?.chainRootRunId ??
      (opts?.chainContext ? runId : opts?.parentRunId ?? runId);
    const chainDepth =
      opts?.chainDepth ??
      (opts?.chainContext && opts?.chainRootRunId == null ? 0 : null);
    store.insertRun({
      id: runId,
      automationId: automationIdArg,
      workspaceId,
      triggerKind,
      prompt: "prompt",
      parentRunId: opts?.parentRunId ?? null,
      chainRootRunId,
      chainDepth,
      chainMaxDepth: opts?.chainMaxDepth ?? null,
      chainContext: opts?.chainContext ?? null,
    });
    return runId;
  };

  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: (msg) => logs.push(msg),
    pipelineAutoEscalate: false,
    pipelineHaltDiscovery: false,
  });

  const settleSource =
    options?.settleSource === "chainRunner"
      ? chainRunner
      : options?.settleSource;

  const digestCalls: Array<Record<string, unknown>> = [];
  const runner = new FeatureQueueRunner({
    store,
    queueStore,
    engine,
    events,
    onLog: (msg) => logs.push(msg),
    settleSource,
    notifier:
      options?.withNotifier === false
        ? undefined
        : {
            queueBatchComplete(facts) {
              digestCalls.push({ ...facts });
            },
          },
  });

  return {
    root,
    db,
    workspaceId,
    entryAutomationId,
    planSkeletonAutomationId,
    planPhaseAutomationId,
    terminalAutomationId,
    events,
    store,
    engine,
    queueStore,
    chainRunner,
    runner,
    triggerCalls,
    logs,
    setChainHold(hold) {
      holdState.current = hold;
    },
    cleanup: () => {
      runner.stop();
      chainRunner.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createFakeSettleSource(): FeatureQueueSettleSource & {
  inFlight: Set<string>;
  emit(runId: string, status: RunStatus): void;
} {
  const listeners = new Set<(runId: string, status: RunStatus) => void>();
  const inFlight = new Set<string>();
  return {
    inFlight,
    onTransitionSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasTransitionInFlight(workspaceId) {
      return inFlight.has(workspaceId);
    },
    emit(runId, status) {
      for (const listener of [...listeners]) {
        listener(runId, status);
      }
    },
  };
}

describe("b71 feature queue settle races", () => {
  it("notifies once per handleTerminal with in-flight tracking and listener isolation", async () => {
    const h = await createHarness();
    try {
      const settleEvents: Array<{ runId: string; status: RunStatus }> = [];
      const secondEvents: string[] = [];
      h.chainRunner.onTransitionSettled((runId, status) => {
        settleEvents.push({ runId, status });
      });
      h.chainRunner.onTransitionSettled((runId) => {
        secondEvents.push(runId);
        throw new Error("listener boom");
      });
      const unsub = h.chainRunner.onTransitionSettled(() => {
        secondEvents.push("removed");
      });
      unsub();

      const rootId = "contract-root";
      h.store.insertRun({
        id: rootId,
        automationId: h.planSkeletonAutomationId,
        workspaceId: h.workspaceId,
        triggerKind: "manual",
        prompt: "seed",
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 13,
        chainContext: CONTEXT,
      });
      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(rootId);

      const hold = createChainHold();
      h.setChainHold(hold);
      const inFlightDuringSpawn = new Promise<void>((resolve) => {
        h.chainRunner.onTransitionSettled(() => resolve());
      });
      void h.chainRunner.handleTerminal(rootId, "completed");
      await until(() => h.chainRunner.hasTransitionInFlight(h.workspaceId));
      expect(h.chainRunner.hasTransitionInFlight(h.workspaceId)).toBe(true);
      hold.release();
      await inFlightDuringSpawn;
      expect(h.chainRunner.hasTransitionInFlight(h.workspaceId)).toBe(false);
      expect(settleEvents).toEqual([{ runId: rootId, status: "completed" }]);
      expect(
        h.db.prepare(`SELECT id FROM runs WHERE parent_run_id = ?`).all(rootId)
      ).toHaveLength(1);
      expect(h.logs.some((line) => line.includes("listener boom"))).toBe(true);
      expect(secondEvents).toEqual([rootId]);
    } finally {
      h.cleanup();
    }
  });

  it("does not start a queued entry during a direct kickoff gap", async () => {
    const h = await createHarness({ settleSource: "chainRunner" });
    try {
      h.chainRunner.start();
      h.runner.start();
      const entry = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71q",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });

      const rootId = "direct-plan-skeleton";
      h.store.insertRun({
        id: rootId,
        automationId: h.planSkeletonAutomationId,
        workspaceId: h.workspaceId,
        triggerKind: "manual",
        prompt: "direct",
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 13,
        chainContext: CONTEXT,
      });
      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(rootId);

      const hold = createChainHold();
      h.setChainHold(hold);
      h.events.emitRunStatus(rootId, "completed");
      await sleep(80);
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(0);
      expect(h.queueStore.getEntry(entry.id)?.state).toBe("queued");

      hold.release();
      await until(
        () =>
          (
            h.db
              .prepare(`SELECT id FROM runs WHERE parent_run_id = ?`)
              .all(rootId) as Array<{ id: string }>
          ).length === 1
      );
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(0);
      expect(h.queueStore.getEntry(entry.id)?.state).toBe("queued");

      const planPhaseId = (
        h.db
          .prepare(`SELECT id FROM runs WHERE parent_run_id = ?`)
          .get(rootId) as { id: string }
      ).id;
      h.db
        .prepare(
          `UPDATE runs SET status = 'completed', chain_stop_requested_at = datetime('now'), chain_stop_reason = ? WHERE id = ?`
        )
        .run("complete: done", planPhaseId);

      const finalGateId = randomUUID();
      insertRun(h.db, {
        id: finalGateId,
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootId,
        parentRunId: planPhaseId,
      });
      h.events.emitRunStatus(finalGateId, "completed");
      await until(() => h.queueStore.getEntry(entry.id)?.state === "running");
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("starts the queued entry when a stopped chain produces no successor", async () => {
    const h = await createHarness({ settleSource: "chainRunner" });
    try {
      h.chainRunner.start();
      h.runner.start();
      const entry = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71s",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });

      const rootId = "stopped-root";
      insertRun(h.db, {
        id: rootId,
        automationId: h.planSkeletonAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 13,
        chainContext: CONTEXT,
        chainStopRequested: true,
        chainStopReason: "blocked: halted",
      });
      h.events.emitRunStatus(rootId, "completed");
      await until(() => h.queueStore.getEntry(entry.id)?.state === "running");
      expect(
        h.db.prepare(`SELECT id FROM runs WHERE parent_run_id = ?`).all(rootId)
      ).toHaveLength(0);
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("keeps a queue entry running when a failed step has a retry child", async () => {
    const h = await createHarness();
    try {
      const fake = createFakeSettleSource();
      const runner = new FeatureQueueRunner({
        store: h.store,
        queueStore: h.queueStore,
        engine: h.engine,
        events: h.events,
        onLog: () => {},
        settleSource: fake,
      });
      runner.start();

      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71b",
        after: ["b71a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      await runner.startNextIfIdle(h.workspaceId);
      const rootRunId = h.queueStore.getRunningEntry(h.workspaceId)!.run_id!;
      h.db.prepare(`UPDATE runs SET status = 'failed' WHERE id = ?`).run(rootRunId);
      h.events.emitRunStatus(rootRunId, "failed");
      await sleep(80);
      expect(h.queueStore.getEntry(a.id)?.state).toBe("running");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("queued");

      const retryId = randomUUID();
      insertRun(h.db, {
        id: retryId,
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "queued",
        chainRootRunId: rootRunId,
        parentRunId: rootRunId,
      });
      fake.emit(rootRunId, "failed");
      await sleep(80);
      expect(h.queueStore.getEntry(a.id)?.state).toBe("running");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("queued");
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(1);

      runner.stop();
      const h2 = await createHarness();
      try {
        const fake2 = createFakeSettleSource();
        const runner2 = new FeatureQueueRunner({
          store: h2.store,
          queueStore: h2.queueStore,
          engine: h2.engine,
          events: h2.events,
          onLog: () => {},
          settleSource: fake2,
        });
        runner2.start();
        const z = h2.queueStore.enqueue({
          workspaceId: h2.workspaceId,
          featureId: "b71z",
          after: [],
          kickoff: { automationId: h2.entryAutomationId, maxDepth: 13 },
        });
        const zDep = h2.queueStore.enqueue({
          workspaceId: h2.workspaceId,
          featureId: "b71y",
          after: ["b71z"],
          kickoff: { automationId: h2.entryAutomationId, maxDepth: 13 },
        });
        await runner2.startNextIfIdle(h2.workspaceId);
        const controlRoot = h2.queueStore.getRunningEntry(h2.workspaceId)!.run_id!;
        insertRun(h2.db, {
          id: randomUUID(),
          automationId: h2.terminalAutomationId,
          workspaceId: h2.workspaceId,
          status: "failed",
          chainRootRunId: controlRoot,
        });
        h2.db
          .prepare(`UPDATE runs SET status = 'failed' WHERE id = ?`)
          .run(controlRoot);
        fake2.emit(controlRoot, "failed");
        await until(() => h2.queueStore.getEntry(z.id)?.state === "failed");
        expect(h2.queueStore.getEntry(zDep.id)?.detail).toBe(
          failedFeatureBlockDetail("b71z")
        );
        runner2.stop();
      } finally {
        h2.cleanup();
      }
    } finally {
      h.cleanup();
    }
  });

  it("blocks startNextIfIdle while a transition is in flight", async () => {
    const h = await createHarness();
    try {
      const fake = createFakeSettleSource();
      const runner = new FeatureQueueRunner({
        store: h.store,
        queueStore: h.queueStore,
        engine: h.engine,
        events: h.events,
        onLog: () => {},
        settleSource: fake,
      });
      runner.start();
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71g",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      fake.inFlight.add(h.workspaceId);
      await runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls).toHaveLength(0);

      const cancelId = randomUUID();
      insertRun(h.db, {
        id: cancelId,
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "running",
      });
      h.db.prepare(`UPDATE runs SET status = 'cancelled' WHERE id = ?`).run(cancelId);
      h.events.emitRunStatus(cancelId, "cancelled");
      await sleep(80);
      expect(h.triggerCalls).toHaveLength(0);

      fake.inFlight.delete(h.workspaceId);
      fake.emit(cancelId, "completed");
      await until(() => h.triggerCalls.length === 1);
      runner.stop();
    } finally {
      h.cleanup();
    }
  });

  it("starts the queued entry on raw cancel when a settle source is wired", async () => {
    const h = await createHarness({ settleSource: "chainRunner" });
    try {
      h.runner.start();
      const entry = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71x",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const cancelId = randomUUID();
      insertRun(h.db, {
        id: cancelId,
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "running",
      });
      h.db.prepare(`UPDATE runs SET status = 'cancelled' WHERE id = ?`).run(cancelId);
      h.events.emitRunStatus(cancelId, "cancelled");
      await until(() => h.queueStore.getEntry(entry.id)?.state === "running");
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it(
    "recovers a failed entry and re-queues transitive dependents end-to-end",
    async () => {
    const h = await createHarness({ settleSource: "chainRunner" });
    try {
      h.chainRunner.start();
      const digestCalls: Array<Record<string, number>> = [];
      const runner = new FeatureQueueRunner({
        store: h.store,
        queueStore: h.queueStore,
        engine: h.engine,
        events: h.events,
        onLog: () => {},
        settleSource: h.chainRunner,
        notifier: {
          queueBatchComplete(facts) {
            digestCalls.push({
              doneCount: facts.doneCount,
              failedCount: facts.failedCount,
              blockedCount: facts.blockedCount,
            });
          },
        },
      });
      runner.start();

      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71b",
        after: ["b71a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const c = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71c",
        after: ["b71b"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const x = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71x",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const d = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71d",
        after: ["b71x"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      h.queueStore.cancelEntry(x.id);

      await runner.startNextIfIdle(h.workspaceId);
      const rootRunId = h.queueStore.getRunningEntry(h.workspaceId)!.run_id!;
      insertRun(h.db, {
        id: randomUUID(),
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "failed",
        chainRootRunId: rootRunId,
      });
      h.db.prepare(`UPDATE runs SET status = 'failed' WHERE id = ?`).run(rootRunId);
      h.events.emitRunStatus(rootRunId, "failed");
      await until(() => h.queueStore.getEntry(a.id)?.state === "failed");
      expect(h.queueStore.getEntry(b.id)?.detail).toBe(
        failedFeatureBlockDetail("b71a")
      );
      expect(h.queueStore.getEntry(c.id)?.detail).toBe(
        dependencyBlockDetail("blocked", "b71b")
      );
      expect(h.queueStore.getEntry(d.id)?.detail).toBe(
        dependencyBlockDetail("cancelled", "b71x")
      );
      await until(() => digestCalls.length === 1, 10_000);
      expect(digestCalls[0]).toEqual({
        doneCount: 0,
        failedCount: 1,
        blockedCount: 3,
      });

      const finalGateId = randomUUID();
      insertRun(h.db, {
        id: finalGateId,
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
      });
      h.events.emitRunStatus(finalGateId, "completed");
      await until(() => h.queueStore.getEntry(a.id)?.state === "done");
      expect(h.queueStore.getEntry(a.id)?.detail).toBe(FEATURE_QUEUE_RECOVERED_DETAIL);
      await until(() => h.queueStore.getEntry(b.id)?.state === "running");
      expect(h.queueStore.getEntry(c.id)?.state).toBe("queued");
      expect(h.queueStore.getEntry(d.id)?.state).toBe("blocked");
      expect(h.queueStore.getEntry(x.id)?.state).toBe("cancelled");

      const finishQueued = async (featureId: string) => {
        await until(
          () => h.queueStore.getNewestEntryByFeatureId(h.workspaceId, featureId)?.state === "running"
        );
        const running = h.queueStore.getRunningEntry(h.workspaceId)!;
        const lineageRoot = running.run_id!;
        const gateId = randomUUID();
        insertRun(h.db, {
          id: gateId,
          automationId: h.terminalAutomationId,
          workspaceId: h.workspaceId,
          status: "completed",
          chainRootRunId: lineageRoot,
        });
        h.db
          .prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`)
          .run(lineageRoot);
        h.events.emitRunStatus(gateId, "completed");
        await until(() => h.queueStore.getEntry(running.id)?.state === "done");
      };

      await finishQueued("b71b");
      await finishQueued("b71c");
      await until(() => digestCalls.length === 2);
      expect(digestCalls[1]).toEqual({
        doneCount: 3,
        failedCount: 0,
        blockedCount: 0,
      });
      runner.stop();
    } finally {
      h.cleanup();
    }
  },
    15_000
  );

  it("does not recover when lineage is incomplete or another pipeline is active", async () => {
    const h = await createHarness();
    try {
      const fake = createFakeSettleSource();
      const runner = new FeatureQueueRunner({
        store: h.store,
        queueStore: h.queueStore,
        engine: h.engine,
        events: h.events,
        onLog: () => {},
        settleSource: fake,
      });
      runner.start();

      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b71b",
        after: ["b71a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      await runner.startNextIfIdle(h.workspaceId);
      const rootRunId = h.queueStore.getRunningEntry(h.workspaceId)!.run_id!;
      insertRun(h.db, {
        id: randomUUID(),
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "failed",
        chainRootRunId: rootRunId,
      });
      h.db.prepare(`UPDATE runs SET status = 'failed' WHERE id = ?`).run(rootRunId);
      fake.emit(rootRunId, "failed");
      await until(() => h.queueStore.getEntry(a.id)?.state === "failed");

      const retryId = randomUUID();
      insertRun(h.db, {
        id: retryId,
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
        parentRunId: rootRunId,
      });
      fake.emit(retryId, "completed");
      await sleep(80);
      expect(h.queueStore.getEntry(a.id)?.state).toBe("failed");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("blocked");

      const finalGateId = randomUUID();
      insertRun(h.db, {
        id: finalGateId,
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
      });
      const blockerId = randomUUID();
      insertRun(h.db, {
        id: blockerId,
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "running",
      });
      fake.emit(finalGateId, "completed");
      await until(() => h.queueStore.getEntry(a.id)?.state === "done");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("queued");
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(1);

      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(blockerId);
      fake.emit(blockerId, "completed");
      await until(() => h.queueStore.getEntry(b.id)?.state === "running");
      runner.stop();
    } finally {
      h.cleanup();
    }
  });

  it("wires settleSource and start order in index.ts", () => {
    const src = readSrc("packages/daemon/src/index.ts");
    const runnerBlock = src.match(
      /new FeatureQueueRunner\(\{[\s\S]*?\}\);/
    )?.[0];
    expect(runnerBlock).toContain("settleSource: chainRunner");
    expect(src.indexOf("chainRunner.start();")).toBeLessThan(
      src.indexOf("featureQueueRunner.start();")
    );
  });

  it("labels queued runs as waiting for slot", () => {
    expect(runCardStatusLabel("queued")).toBe(SLOT_WAITING_LABEL);
    expect(runCardStatusLabel("paused")).toBe("Paused");
    expect(runCardStatusLabel("running")).toBe("running");
    expect(formatPipelineGroupStatus("queued")).toBe("waiting for slot");
    const cardsSrc = readSrc("packages/dashboard/src/cards.tsx");
    expect(cardsSrc).toContain("runCardStatusLabel");
    expect(cardsSrc).toContain("SLOT_WAITING_LABEL");
    expect(failedFeatureBlockDetail("b1")).toBe("blocked by failed feature b1");
    expect(dependencyBlockDetail("blocked", "b2")).toBe(
      "blocked by blocked dependency b2"
    );
  });
});
