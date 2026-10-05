import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type ChainRunContext,
  type FeatureQueueEntry,
} from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  provisionGeneratedWorkers,
} from "../packages/daemon/src/config/generated-workers.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY,
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { FeatureQueueRunner } from "../packages/daemon/src/runs/feature-queue-runner.ts";
import {
  FeatureQueueError,
  FeatureQueueStore,
  toFeatureQueueEntry,
} from "../packages/daemon/src/runs/feature-queue-store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { freeListenPort } from "./helpers/free-port.ts";

type Db = ReturnType<typeof openDatabase>;

const FEATURE_CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b85",
    featureSlug: "b85-after-on-direct-kickoffs-queue-add",
    featureDir: "docs/roadmap/b85-after-on-direct-kickoffs-queue-add",
    featureIndex: "docs/roadmap/b85-after-on-direct-kickoffs-queue-add/00-index.md",
    idea: "direct kickoff queue rows",
    planningDepth: "full",
    approvalPolicy: "none",
  },
  roleModels: {},
};

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

function seedWorkspace(db: Db, workspacePath: string): string {
  mkdirSync(workspacePath, { recursive: true });
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    workspaceId,
    workspacePath,
    "Workspace"
  );
  provisionGeneratedWorkers(db, workspaceId, IMPLEMENT_FULLY_WORKERS);
  return workspaceId;
}

function insertRootRun(
  db: Db,
  args: {
    id: string;
    automationId: string;
    workspaceId: string;
    status: string;
    featureId: string;
    chainStopReason?: string | null;
    chainStopRequested?: boolean;
  }
): void {
  const context: ChainRunContext = {
    ...FEATURE_CONTEXT,
    variables: {
      ...FEATURE_CONTEXT.variables,
      featureId: args.featureId,
    },
  };
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status,
       chain_root_run_id, parent_run_id, trigger_kind, prompt,
       chain_depth, chain_max_depth, chain_context_json,
       chain_stop_requested_at, chain_stop_reason
     ) VALUES (?, ?, ?, ?, ?, NULL, 'manual', 'prompt', 0, 1, ?, ?, ?)`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.status,
    args.id,
    JSON.stringify(context),
    args.chainStopRequested ? "2026-01-01T00:00:00.000Z" : null,
    args.chainStopReason ?? null
  );
}

function schemaVersion(db: Db): number {
  return (
    db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
      v: number | null;
    }
  ).v ?? 0;
}

describe("b85 direct kickoff queue rows", () => {
  it("migrates origin with queue default on existing rows", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b85-migrate-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(22);
      const workspaceId = seedWorkspace(db, workspacePath);
      const entryAutomationId = automationId(
        workspaceId,
        GENERATED_CONFIG_KEY_PREFIX + "implement"
      );
      db.exec("ALTER TABLE feature_queue_entries DROP COLUMN origin");
      db.prepare("DELETE FROM schema_migrations WHERE version >= 22").run();
      expect(schemaVersion(db)).toBe(21);
      expect(
        (
          db.prepare("PRAGMA table_info(feature_queue_entries)").all() as Array<{
            name: string;
          }>
        ).some((c) => c.name === "origin")
      ).toBe(false);

      db.prepare(
        `INSERT INTO feature_queue_entries (
           id, workspace_id, feature_id, position,
           after_json, kickoff_json, state
         ) VALUES (?, ?, 'legacy', 1, '[]', ?, 'done')`
      ).run(randomUUID(), workspaceId, JSON.stringify({ automationId: entryAutomationId }));

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      const legacy = db
        .prepare(
          `SELECT origin FROM feature_queue_entries WHERE feature_id = 'legacy'`
        )
        .get() as { origin: string };
      expect(legacy.origin).toBe("queue");

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(
        (
          db.prepare("PRAGMA table_info(feature_queue_entries)").all() as Array<{
            name: string;
          }>
        ).filter((c) => c.name === "origin")
      ).toHaveLength(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records direct kickoffs over HTTP and accepts --after the running feature", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b85-http-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const entryAutomationId = automationId(
      workspaceId,
      GENERATED_CONFIG_KEY_PREFIX + "implement"
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
    engine.triggerRun = async (automationIdArg) => {
      const runId = randomUUID();
      insertRootRun(db, {
        id: runId,
        automationId: automationIdArg,
        workspaceId,
        status: "running",
        featureId: "b85",
      });
      return runId;
    };
    const featureQueue = new FeatureQueueStore(db, store);
    const port = await freeListenPort();
    const http = await startHttpServer({
      engine,
      chatEngine: new ChatEngine(db, {
        apiKey: "test",
        executor: stubExecutor(),
        events,
      }),
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      triggers: new TriggerManager(db, engine, { port }),
      featureQueue,
    });
    try {
      const kickoffRes = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId: entryAutomationId,
          variables: FEATURE_CONTEXT.variables,
          roleModels: FEATURE_CONTEXT.roleModels,
          maxDepth: 1,
        }),
      });
      expect(kickoffRes.status).toBe(201);
      const kickoffBody = (await kickoffRes.json()) as { runId: string };
      const directRows = featureQueue.listEntries(workspaceId);
      expect(directRows).toHaveLength(1);
      expect(directRows[0]?.origin).toBe("direct");
      expect(directRows[0]?.state).toBe("running");
      expect(directRows[0]?.run_id).toBe(kickoffBody.runId);

      const afterRes = await fetch(`http://127.0.0.1:${port}/api/feature-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          featureId: "b86",
          after: ["b85"],
          kickoff: { automationId: entryAutomationId },
        }),
      });
      expect(afterRes.status).toBe(201);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lazy-adopts a green historical root and preserves unknown dependency text", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b85-adopt-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const entryAutomationId = automationId(
      workspaceId,
      GENERATED_CONFIG_KEY_PREFIX + "implement"
    );
    const terminalAutomationId = automationId(
      workspaceId,
      IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY
    );
    const events = new DaemonEventBus();
    const runStore = new RunStore(db, events);
    const queue = new FeatureQueueStore(db, runStore);
    const rootRunId = randomUUID();
    const gateRunId = randomUUID();
    insertRootRun(db, {
      id: rootRunId,
      automationId: entryAutomationId,
      workspaceId,
      status: "completed",
      featureId: "hist",
    });
    db.prepare(
      `INSERT INTO runs (
         id, automation_id, workspace_id, status,
         chain_root_run_id, parent_run_id, trigger_kind, prompt,
         chain_context_json, chain_stop_requested_at, chain_stop_reason
       ) VALUES (?, ?, ?, 'completed', ?, ?, 'manual', 'prompt', ?, datetime('now'), 'complete: green')`
    ).run(
      gateRunId,
      terminalAutomationId,
      workspaceId,
      rootRunId,
      rootRunId,
      JSON.stringify({
        ...FEATURE_CONTEXT,
        variables: { ...FEATURE_CONTEXT.variables, featureId: "hist" },
      })
    );

    const adopted = queue.enqueue({
      workspaceId,
      featureId: "next",
      after: ["hist"],
      kickoff: { automationId: entryAutomationId },
    });
    expect(adopted.feature_id).toBe("next");
    const histRow = queue.getNewestEntryByFeatureId(workspaceId, "hist");
    expect(histRow?.origin).toBe("direct");
    expect(histRow?.state).toBe("done");

    expect(() =>
      queue.enqueue({
        workspaceId,
        featureId: "bad",
        after: ["missing"],
        kickoff: { automationId: entryAutomationId },
      })
    ).toThrow(FeatureQueueError);
    try {
      queue.enqueue({
        workspaceId,
        featureId: "bad",
        after: ["missing"],
        kickoff: { automationId: entryAutomationId },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(FeatureQueueError);
      expect((err as FeatureQueueError).message).toBe(
        "unknown dependency feature id: missing"
      );
    }
  });

  it("excludes direct rows from batch digests and settles multiple running rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b85-settle-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const entryAutomationId = automationId(
      workspaceId,
      GENERATED_CONFIG_KEY_PREFIX + "implement"
    );
    const terminalAutomationId = automationId(
      workspaceId,
      IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY
    );
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const queueStore = new FeatureQueueStore(db, store);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      }),
      maxConcurrentRuns: 4,
      events,
    });
    const runner = new FeatureQueueRunner({
      store,
      queueStore,
      engine,
      events,
      onLog: () => {},
    });
    runner.start();

    for (const featureId of ["d1", "d2"] as const) {
      const directRunId = randomUUID();
      insertRootRun(db, {
        id: directRunId,
        automationId: entryAutomationId,
        workspaceId,
        status: "completed",
        featureId,
      });
      db.prepare(
        `INSERT INTO runs (
           id, automation_id, workspace_id, status,
           chain_root_run_id, parent_run_id, trigger_kind, prompt,
           chain_context_json, chain_stop_requested_at, chain_stop_reason
         ) VALUES (?, ?, ?, 'completed', ?, ?, 'manual', 'prompt', ?, datetime('now'), 'complete: green')`
      ).run(
        randomUUID(),
        terminalAutomationId,
        workspaceId,
        directRunId,
        directRunId,
        JSON.stringify({
          ...FEATURE_CONTEXT,
          variables: { ...FEATURE_CONTEXT.variables, featureId },
        })
      );
      queueStore.recordDirectKickoff({
        workspaceId,
        featureId,
        runId: directRunId,
        kickoff: { automationId: entryAutomationId },
      });
    }

    expect(queueStore.listRunningEntries(workspaceId)).toHaveLength(2);
    await runner.resumeQueue();
    expect(queueStore.listRunningEntries(workspaceId)).toHaveLength(0);

    const batchEntry = queueStore.enqueue({
      workspaceId,
      featureId: "batch",
      after: [],
      kickoff: { automationId: entryAutomationId },
    });
    queueStore.claimEntry(batchEntry.id);
    queueStore.recordStart(batchEntry.id, randomUUID());
    queueStore.settleEntry(batchEntry.id, "done", null);

    const facts = queueStore.collectUndigestedBatchDigest(workspaceId);
    expect(facts?.doneCount).toBe(1);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM feature_queue_entries
             WHERE workspace_id = ? AND origin = 'direct'`
          )
          .get(workspaceId) as { n: number }
      ).n
    ).toBe(2);

    runner.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("maps direct rows to API entries with origin", () => {
    const row = {
      id: "e1",
      workspace_id: "ws",
      feature_id: "b85",
      position: 1,
      after_json: "[]",
      kickoff_json: JSON.stringify({ automationId: "a" }),
      state: "running",
      run_id: "run-1",
      detail: null,
      created_at: "2026-01-01T00:00:00.000Z",
      started_at: "2026-01-01T00:00:00.000Z",
      settled_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
      batch_digest_at: "2026-01-01T00:00:00.000Z",
      origin: "direct",
    };
    const entry: FeatureQueueEntry = toFeatureQueueEntry(row);
    expect(entry.origin).toBe("direct");
  });

  it("refuses duplicate active feature and is record/adopt idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b85-idempotent-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const entryAutomationId = automationId(
      workspaceId,
      GENERATED_CONFIG_KEY_PREFIX + "implement"
    );
    const events = new DaemonEventBus();
    const runStore = new RunStore(db, events);
    const queue = new FeatureQueueStore(db, runStore);
    const runId = randomUUID();
    insertRootRun(db, {
      id: runId,
      automationId: entryAutomationId,
      workspaceId,
      status: "running",
      featureId: "b85",
    });

    expect(
      queue.recordDirectKickoff({
        workspaceId,
        featureId: "b85",
        runId,
        kickoff: { automationId: entryAutomationId },
      })
    ).toBe("recorded");
    expect(
      queue.recordDirectKickoff({
        workspaceId,
        featureId: "b85",
        runId,
        kickoff: { automationId: entryAutomationId },
      })
    ).toBe("skipped-active");
    expect(
      queue.recordDirectKickoff({
        workspaceId,
        featureId: "other",
        runId,
        kickoff: { automationId: entryAutomationId },
      })
    ).toBe("skipped-duplicate-run");
    expect(queue.listEntries(workspaceId)).toHaveLength(1);

    expect(() =>
      queue.enqueue({
        workspaceId,
        featureId: "b85",
        after: [],
        kickoff: { automationId: entryAutomationId },
      })
    ).toThrow(/already active/);

    const histId = randomUUID();
    insertRootRun(db, {
      id: histId,
      automationId: entryAutomationId,
      workspaceId,
      status: "completed",
      featureId: "hist2",
      chainStopRequested: true,
      chainStopReason: "complete: green",
    });
    const terminalAutomationId = automationId(
      workspaceId,
      IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY
    );
    db.prepare(
      `INSERT INTO runs (
         id, automation_id, workspace_id, status,
         chain_root_run_id, parent_run_id, trigger_kind, prompt,
         chain_context_json, chain_stop_requested_at, chain_stop_reason
       ) VALUES (?, ?, ?, 'completed', ?, ?, 'manual', 'prompt', ?, datetime('now'), 'complete: green')`
    ).run(
      randomUUID(),
      terminalAutomationId,
      workspaceId,
      histId,
      histId,
      JSON.stringify({
        ...FEATURE_CONTEXT,
        variables: { ...FEATURE_CONTEXT.variables, featureId: "hist2" },
      })
    );

    queue.enqueue({
      workspaceId,
      featureId: "dep1",
      after: ["hist2"],
      kickoff: { automationId: entryAutomationId },
    });
    const before = queue.listEntries(workspaceId).filter((e) => e.feature_id === "hist2");
    expect(before).toHaveLength(1);
    queue.enqueue({
      workspaceId,
      featureId: "dep2",
      after: ["hist2"],
      kickoff: { automationId: entryAutomationId },
    });
    const after = queue.listEntries(workspaceId).filter((e) => e.feature_id === "hist2");
    expect(after).toHaveLength(1);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("settles blocked final-gate and non-final halt as failed for direct rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b85-fail-settle-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const entryAutomationId = automationId(
      workspaceId,
      GENERATED_CONFIG_KEY_PREFIX + "implement"
    );
    const terminalAutomationId = automationId(
      workspaceId,
      IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY
    );
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const queueStore = new FeatureQueueStore(db, store);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      }),
      maxConcurrentRuns: 4,
      events,
    });
    const runner = new FeatureQueueRunner({
      store,
      queueStore,
      engine,
      events,
      onLog: () => {},
    });
    runner.start();

    const blockedRoot = randomUUID();
    insertRootRun(db, {
      id: blockedRoot,
      automationId: entryAutomationId,
      workspaceId,
      status: "completed",
      featureId: "blocked-fg",
    });
    db.prepare(
      `INSERT INTO runs (
         id, automation_id, workspace_id, status,
         chain_root_run_id, parent_run_id, trigger_kind, prompt,
         chain_context_json, chain_stop_requested_at, chain_stop_reason
       ) VALUES (?, ?, ?, 'completed', ?, ?, 'manual', 'prompt', ?, datetime('now'), 'blocked: acceptance failed')`
    ).run(
      randomUUID(),
      terminalAutomationId,
      workspaceId,
      blockedRoot,
      blockedRoot,
      JSON.stringify({
        ...FEATURE_CONTEXT,
        variables: { ...FEATURE_CONTEXT.variables, featureId: "blocked-fg" },
      })
    );
    queueStore.recordDirectKickoff({
      workspaceId,
      featureId: "blocked-fg",
      runId: blockedRoot,
      kickoff: { automationId: entryAutomationId },
    });

    const haltRoot = randomUUID();
    insertRootRun(db, {
      id: haltRoot,
      automationId: entryAutomationId,
      workspaceId,
      status: "completed",
      featureId: "halted",
      chainStopRequested: true,
      chainStopReason: "blocked: operator stop",
    });
    queueStore.recordDirectKickoff({
      workspaceId,
      featureId: "halted",
      runId: haltRoot,
      kickoff: { automationId: entryAutomationId },
    });

    await runner.resumeQueue();
    expect(queueStore.getNewestEntryByFeatureId(workspaceId, "blocked-fg")?.state).toBe(
      "failed"
    );
    expect(queueStore.getNewestEntryByFeatureId(workspaceId, "halted")?.state).toBe(
      "failed"
    );

    runner.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
