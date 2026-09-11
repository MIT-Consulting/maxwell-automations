import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALERT_NOTIFY_EVENTS,
  DEFAULT_NOTIFY_EVENT_PREFS,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  notifySettingsSchema,
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
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { FeatureQueueRunner } from "../packages/daemon/src/runs/feature-queue-runner.ts";
import { FeatureQueueStore } from "../packages/daemon/src/runs/feature-queue-store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

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

type DigestSpy = {
  calls: Array<{
    workspaceLabel: string;
    doneCount: number;
    failedCount: number;
    blockedCount: number;
    failedFeatureIds: string[];
    blockedFeatureIds: string[];
  }>;
  notifier: { queueBatchComplete: (facts: DigestSpy["calls"][number]) => void };
};

function createDigestSpy(): DigestSpy {
  const calls: DigestSpy["calls"] = [];
  return {
    calls,
    notifier: {
      queueBatchComplete(facts) {
        calls.push({ ...facts });
      },
    },
  };
}

async function createHarness(options?: { withNotifier?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "lca-b58-4-"));
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
  const terminalAutomationId = automationId(
    workspaceId,
    GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
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
  const digestSpy = createDigestSpy();
  engine.triggerRun = async (automationIdArg) => {
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
    notifier: options?.withNotifier === false ? undefined : digestSpy.notifier,
    getWorkspaceLabel: () => "workspace",
  });
  runner.start();
  return {
    root,
    db,
    workspaceId,
    entryAutomationId,
    terminalAutomationId,
    events,
    store,
    queueStore,
    runner,
    digestSpy,
    completeRunningAsDone: async () => {
      const running = queueStore.getRunningEntry(workspaceId);
      if (!running?.run_id) {
        throw new Error("no running entry");
      }
      const rootRunId = running.run_id;
      insertRun(db, {
        id: randomUUID(),
        automationId: terminalAutomationId,
        workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
      });
      db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(rootRunId);
      events.emitRunStatus(rootRunId, "completed");
      await until(
        () => queueStore.getEntry(running.id)?.state !== "running",
        8_000
      );
    },
    cleanup: () => {
      runner.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("b58.4 queue batch digest notify", () => {
  it("registers queue_batch_complete in the alert catalog and schema", () => {
    expect(ALERT_NOTIFY_EVENTS).toContain("queue_batch_complete");
    expect(ALERT_NOTIFY_EVENTS).toHaveLength(13);
    expect(DEFAULT_NOTIFY_EVENT_PREFS.queue_batch_complete).toEqual({
      toast: true,
      ntfy: true,
    });
    const parsed = notifySettingsSchema.parse({
      events: { queue_batch_complete: { toast: true, ntfy: true } },
    });
    expect(parsed.events?.queue_batch_complete).toEqual({
      toast: true,
      ntfy: true,
    });
    expect(
      notifySettingsSchema.safeParse({
        events: { not_a_real_event: { toast: true, ntfy: true } },
      }).success
    ).toBe(false);
  });

  it("emits exactly one digest after the second entry settles", async () => {
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
      await h.completeRunningAsDone();
      expect(h.digestSpy.calls).toHaveLength(0);
      await until(() => h.queueStore.getRunningEntry(h.workspaceId) != null);
      await h.completeRunningAsDone();
      await until(() => h.digestSpy.calls.length === 1);
      expect(h.digestSpy.calls[0]?.doneCount).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it("emits a digest when the batch ends with done and blocked entries", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58b",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.queueStore.blockEntry(b.id, "operator hold")).toBe(true);
      await h.completeRunningAsDone();
      await until(() => h.digestSpy.calls.length === 1);
      expect(h.digestSpy.calls[0]?.doneCount).toBe(1);
      expect(h.digestSpy.calls[0]?.blockedCount).toBe(1);
      expect(h.queueStore.getEntry(a.id)?.state).toBe("done");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("blocked");
    } finally {
      h.cleanup();
    }
  });

  it("does not emit when the queue only had cancelled entries", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58b",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      expect(h.queueStore.cancelEntry(a.id)).toBe("cancelled");
      expect(h.queueStore.cancelEntry(b.id)).toBe("cancelled");
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.digestSpy.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("does not re-emit after a fresh runner replays settle on the same database", async () => {
    const h = await createHarness();
    try {
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      await h.completeRunningAsDone();
      await until(() => h.digestSpy.calls.length === 1);
      h.runner.stop();
      const replaySpy = createDigestSpy();
      const replayRunner = new FeatureQueueRunner({
        store: h.store,
        queueStore: h.queueStore,
        engine: h.engine as RunEngine,
        events: h.events,
        onLog: () => {},
        notifier: replaySpy.notifier,
        getWorkspaceLabel: () => "workspace",
      });
      replayRunner.start();
      const settled = h.queueStore.listEntries(h.workspaceId)[0];
      if (settled?.run_id) {
        h.events.emitRunStatus(settled.run_id, "completed");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(replaySpy.calls).toHaveLength(0);
      replayRunner.stop();
    } finally {
      h.cleanup();
    }
  });

  it("keeps Phase 2 runner behavior when notifier is omitted", async () => {
    const h = await createHarness({ withNotifier: false });
    try {
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b58a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 1 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.queueStore.getRunningEntry(h.workspaceId)?.feature_id).toBe("b58a");
    } finally {
      h.cleanup();
    }
  });
});
