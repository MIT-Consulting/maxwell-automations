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
  type FeatureQueueLineageRun,
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

function lineageRun(
  partial: Partial<FeatureQueueLineageRun> &
    Pick<FeatureQueueLineageRun, "configKey" | "status">
): FeatureQueueLineageRun {
  return {
    chainStopRequestedAt: null,
    chainStopReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
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
  it("classifies lineage outcomes with green-aware final-gate semantics", () => {
    const implementKey = `${GENERATED_CONFIG_KEY_PREFIX}implement`;

    expect(classifyFeatureQueueOutcome([], TERMINAL_KEY)).toBe("running");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: implementKey,
            status: "running",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("running");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: TERMINAL_KEY,
            status: "completed",
            chainStopReason: "complete: all phases done",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("done");

    expect(
      classifyFeatureQueueOutcome(
        [lineageRun({ configKey: TERMINAL_KEY, status: "completed" })],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [lineageRun({ configKey: TERMINAL_KEY, status: "completed" })],
        TERMINAL_KEY
      )
    ).toContain("missing explicit complete");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: TERMINAL_KEY,
            status: "completed",
            chainStopReason: "blocked: tracker incomplete",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [
          lineageRun({
            configKey: TERMINAL_KEY,
            status: "completed",
            chainStopReason: "blocked: tracker incomplete",
          }),
        ],
        TERMINAL_KEY
      )
    ).toContain("final-gate blocked:");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: TERMINAL_KEY,
            status: "completed",
            chainStopReason: "deadlock: circular dependency",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [
          lineageRun({
            configKey: TERMINAL_KEY,
            status: "completed",
            chainStopReason: "deadlock: circular dependency",
          }),
        ],
        TERMINAL_KEY
      )
    ).toContain("deadlock:");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: TERMINAL_KEY,
            status: "completed",
            chainStopReason: "mystery: unrecognised stop",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [
          lineageRun({
            configKey: TERMINAL_KEY,
            status: "completed",
            chainStopReason: "mystery: unrecognised stop",
          }),
        ],
        TERMINAL_KEY
      )
    ).toContain("missing explicit complete");

    expect(
      classifyFeatureQueueOutcome(
        [lineageRun({ configKey: TERMINAL_KEY, status: "failed" })],
        TERMINAL_KEY
      )
    ).toBe("failed");

    expect(
      classifyFeatureQueueOutcome(
        [lineageRun({ configKey: implementKey, status: "failed" })],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [lineageRun({ configKey: implementKey, status: "failed" })],
        TERMINAL_KEY
      )
    ).toContain("failed");

    expect(
      classifyFeatureQueueOutcome(
        [lineageRun({ configKey: implementKey, status: "cancelled" })],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [lineageRun({ configKey: implementKey, status: "cancelled" })],
        TERMINAL_KEY
      )
    ).toContain("cancelled");

    expect(
      classifyFeatureQueueOutcome(
        [lineageRun({ configKey: implementKey, status: "completed" })],
        TERMINAL_KEY
      )
    ).toBe("running");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: implementKey,
            status: "completed",
            chainStopRequestedAt: "2026-01-01T00:00:01.000Z",
            chainStopReason: "complete: handoff ready",
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("running");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: implementKey,
            status: "completed",
            chainStopRequestedAt: "2026-01-01T00:00:01.000Z",
            chainStopReason: "blocked: halted mid-pipeline",
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [
          lineageRun({
            configKey: implementKey,
            status: "completed",
            chainStopRequestedAt: "2026-01-01T00:00:01.000Z",
            chainStopReason: "blocked: halted mid-pipeline",
          }),
        ],
        TERMINAL_KEY
      )
    ).toContain("halted:");

    expect(
      classifyFeatureQueueOutcome(
        [
          lineageRun({
            configKey: implementKey,
            status: "completed",
            chainStopRequestedAt: "2026-01-01T00:00:01.000Z",
            chainStopReason: "aborted: operator abort",
            createdAt: "2026-01-01T00:00:01.000Z",
          }),
        ],
        TERMINAL_KEY
      )
    ).toBe("failed");
    expect(
      featureQueueFailureDetail(
        [
          lineageRun({
            configKey: implementKey,
            status: "completed",
            chainStopRequestedAt: "2026-01-01T00:00:01.000Z",
            chainStopReason: "aborted: operator abort",
          }),
        ],
        TERMINAL_KEY
      )
    ).toContain("halted:");
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
      h.db
        .prepare(
          `UPDATE runs SET chain_stop_requested_at = datetime('now'),
             chain_stop_reason = ? WHERE id = ?`
        )
        .run("complete: stale resume", "terminal-done");
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

  it("keeps a queue entry running across a successful non-terminal settle", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b67a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b67b",
        after: ["b67a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b67c",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls).toHaveLength(1);
      const rootRunId = h.queueStore.getRunningEntry(h.workspaceId)!.run_id!;
      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(rootRunId);
      h.events.emitRunStatus(rootRunId, "completed");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(h.queueStore.getEntry(a.id)?.state).toBe("running");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("queued");
      expect(h.triggerCalls).toHaveLength(1);
      expect(h.queueStore.getNewestEntryByFeatureId(h.workspaceId, "b67c")?.state).toBe(
        "queued"
      );

      const terminalId = "terminal-green";
      insertRun(h.db, {
        id: terminalId,
        automationId: automationId(
          h.workspaceId,
          GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
        ),
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
      });
      h.db
        .prepare(
          `UPDATE runs SET chain_stop_requested_at = datetime('now'),
             chain_stop_reason = ? WHERE id = ?`
        )
        .run("complete: green final gate", terminalId);
      h.events.emitRunStatus(terminalId, "completed");
      await until(() => h.queueStore.getEntry(a.id)?.state === "done");
      await until(() => h.queueStore.getEntry(b.id)?.state === "running");
      expect(h.triggerCalls).toHaveLength(2);
      expect(h.queueStore.getNewestEntryByFeatureId(h.workspaceId, "b67c")?.state).toBe(
        "queued"
      );
    } finally {
      h.cleanup();
    }
  });

  it("resumeQueue leaves incomplete successful lineage running", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b67a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b67b",
        after: ["b67a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      const rootRunId = "stale-incomplete";
      insertRun(h.db, {
        id: rootRunId,
        automationId: h.entryAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: null,
      });
      h.db.prepare(
        `UPDATE feature_queue_entries SET state = 'running', run_id = ? WHERE id = ?`
      ).run(rootRunId, a.id);
      await h.runner.resumeQueue();
      expect(h.queueStore.getEntry(a.id)?.state).toBe("running");
      expect(h.triggerCalls).toHaveLength(0);
      expect(
        h.queueStore.getNewestEntryByFeatureId(h.workspaceId, "b67b")?.state
      ).toBe("queued");
    } finally {
      h.cleanup();
    }
  });
});
