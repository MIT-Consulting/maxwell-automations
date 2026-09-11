import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyFeatureQueueOutcome,
  featureQueueFailureDetail,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
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
import { FeatureQueueRunner } from "../packages/daemon/src/runs/feature-queue-runner.ts";
import { FeatureQueueStore } from "../packages/daemon/src/runs/feature-queue-store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

const TERMINAL_KEY = IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY;

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

function insertRun(
  db: Db,
  args: {
    id: string;
    automationId: string;
    workspaceId: string;
    status: string;
    chainRootRunId?: string | null;
    parentRunId?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status,
       chain_root_run_id, parent_run_id, trigger_kind, prompt
     ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'prompt')`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.status,
    args.chainRootRunId ?? null,
    args.parentRunId ?? null
  );
}

async function createHarness(options?: { failFirstTrigger?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "lca-b58-2-"));
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
  const entryAutomationId = automationId(
    workspaceId,
    GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_ENTRY_WORKER_KEY
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
  const triggerCalls: Array<{
    automationId: string;
    triggerKind: string;
    options: unknown;
  }> = [];
  let failNextTrigger = options?.failFirstTrigger === true;
  engine.triggerRun = async (automationIdArg, triggerKind = "manual", opts) => {
    triggerCalls.push({
      automationId: automationIdArg,
      triggerKind,
      options: opts,
    });
    if (failNextTrigger) {
      failNextTrigger = false;
      throw new Error("triggerRun failed");
    }
    const runId = randomUUID();
    insertRun(db, {
      id: runId,
      automationId: automationIdArg,
      workspaceId,
      status: "running",
      chainRootRunId: runId,
    });
    return runId;
  };
  const runner = new FeatureQueueRunner({
    store,
    queueStore,
    engine,
    events,
    onLog: () => {},
  });
  runner.start();
  return {
    root,
    db,
    workspaceId,
    entryAutomationId,
    events,
    store,
    engine,
    queueStore,
    runner,
    triggerCalls,
    cleanup: () => {
      runner.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("b58.2 feature queue runner", () => {
  it("classifies done only when the terminal worker completed", () => {
    expect(
      classifyFeatureQueueOutcome(
        [{ configKey: TERMINAL_KEY, status: "completed" }],
        TERMINAL_KEY
      )
    ).toBe("done");
    expect(classifyFeatureQueueOutcome([], TERMINAL_KEY)).toBe("failed");
    expect(
      classifyFeatureQueueOutcome(
        [{ configKey: TERMINAL_KEY, status: "failed" }],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      classifyFeatureQueueOutcome(
        [
          {
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
            status: "completed",
          },
        ],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [
          {
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
            status: "failed",
          },
        ],
        TERMINAL_KEY
      )
    ).toContain("failed");
  });

  it("blocks tryStartNext while a pipeline worker run is active", async () => {
    const h = await createHarness();
    try {
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58b",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      insertRun(h.db, {
        id: "blocker-run",
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "running",
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls).toHaveLength(0);
      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = 'blocker-run'`).run();
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("starts at most one queued entry per workspace", async () => {
    const h = await createHarness();
    try {
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58b",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls).toHaveLength(1);
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("respects after[] dependencies and parks on failure", async () => {
    const h = await createHarness();
    try {
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58b",
        after: ["b58a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58c",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls).toHaveLength(1);
      const running = h.queueStore.getRunningEntry(h.workspaceId);
      expect(running?.feature_id).toBe("b58a");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("queued");
      const rootRunId = running!.run_id!;
      insertRun(h.db, {
        id: "failed-step",
        automationId: automationId(
          h.workspaceId,
          GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
        ),
        workspaceId: h.workspaceId,
        status: "failed",
        chainRootRunId: rootRunId,
      });
      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(rootRunId);
      h.events.emitRunStatus(rootRunId, "completed");
      await until(() => h.queueStore.getEntry(b.id)?.state === "blocked");
      await until(() => h.triggerCalls.length >= 2);
      expect(h.queueStore.getRunningEntry(h.workspaceId)?.feature_id).toBe("b58c");
    } finally {
      h.cleanup();
    }
  });

  it("marks start failures failed, parks dependents, and continues", async () => {
    const h = await createHarness({ failFirstTrigger: true });
    try {
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58b",
        after: ["b58a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58c",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      const failed = h.queueStore.getNewestEntryByFeatureId(h.workspaceId, "b58a");
      expect(failed?.state).toBe("failed");
      expect(h.queueStore.getNewestEntryByFeatureId(h.workspaceId, "b58b")?.state).toBe(
        "blocked"
      );
      expect(h.queueStore.getRunningEntry(h.workspaceId)?.feature_id).toBe("b58c");
      expect(h.triggerCalls[0]?.triggerKind).toBe("manual");
      expect(h.triggerCalls[0]?.options).toMatchObject({
        chainMaxDepth: 1,
        chainContext: expect.any(Object),
      });
    } finally {
      h.cleanup();
    }
  });

  it("resumeQueue classifies stale running entries and starts the next", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58b",
        after: ["b58a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      const rootRunId = "stale-root";
      insertRun(h.db, {
        id: rootRunId,
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: null,
      });
      insertRun(h.db, {
        id: "terminal-done",
        automationId: automationId(
          h.workspaceId,
          GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
        ),
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
      });
      h.db.prepare(
        `UPDATE feature_queue_entries SET state = 'running', run_id = ? WHERE id = ?`
      ).run(rootRunId, a.id);
      await h.runner.resumeQueue();
      expect(h.queueStore.getEntry(a.id)?.state).toBe("done");
      await until(() => h.triggerCalls.length >= 1);
      expect(h.queueStore.getRunningEntry(h.workspaceId)?.feature_id).toBe("b58b");
    } finally {
      h.cleanup();
    }
  });
});
