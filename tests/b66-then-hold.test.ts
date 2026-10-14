import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyFeatureQueueOutcome,
  findActiveThenTailBlocker,
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
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import {
  IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY,
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
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

function stampGreenFinalGate(db: Db, runId: string): void {
  db.prepare(
    `UPDATE runs SET chain_stop_requested_at = datetime('now'),
       chain_stop_reason = ? WHERE id = ?`
  ).run("complete: green", runId);
}

async function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "lca-b66-hold-"));
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

  const shipAutomationId = automationId(workspaceId, "ship");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key
    ) VALUES (?, ?, 'ship', 1, 'enabled', ?, 'ship prompt', NULL, 'ship.yaml', 'ship')`
  ).run(shipAutomationId, workspaceId, JSON.stringify({ type: "manual" }));

  const manualAutomationId = automationId(workspaceId, "manual-run");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key
    ) VALUES (?, ?, 'manual', 1, 'enabled', ?, 'manual prompt', NULL, 'manual.yaml', 'manual-run')`
  ).run(manualAutomationId, workspaceId, JSON.stringify({ type: "manual" }));

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
  const triggerCalls: Array<{ automationId: string; triggerKind: string }> = [];
  engine.triggerRun = async (automationIdArg, triggerKind = "manual") => {
    triggerCalls.push({ automationId: automationIdArg, triggerKind });
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
    terminalAutomationId,
    shipAutomationId,
    manualAutomationId,
    events,
    store,
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

describe("b66 then-tail blocker helper", () => {
  const gateKey = TERMINAL_KEY;
  const shipAuto = "ws::ship";
  const gateAuto = "ws::generated:final-gate";
  const manualAuto = "ws::manual-run";
  const automations = [
    { id: shipAuto, configKey: "ship" },
    { id: gateAuto, configKey: gateKey },
    { id: manualAuto, configKey: "manual-run" },
  ];

  it("blocks an active ship descendant of a final-gate", () => {
    const blocker = findActiveThenTailBlocker(
      [
        {
          id: "gate",
          parentRunId: null,
          automationId: gateAuto,
          status: "completed",
        },
        {
          id: "ship-run",
          parentRunId: "gate",
          automationId: shipAuto,
          status: "running",
        },
      ],
      automations
    );
    expect(blocker?.id).toBe("ship-run");
  });

  it("does not block unrelated manual runs", () => {
    expect(
      findActiveThenTailBlocker(
        [
          {
            id: "manual",
            parentRunId: null,
            automationId: manualAuto,
            status: "running",
          },
        ],
        automations
      )
    ).toBeNull();
  });

  it("does not block when force would skip (helper returns null for terminal ship)", () => {
    expect(
      findActiveThenTailBlocker(
        [
          {
            id: "gate",
            parentRunId: null,
            automationId: gateAuto,
            status: "completed",
          },
          {
            id: "ship-done",
            parentRunId: "gate",
            automationId: shipAuto,
            status: "completed",
          },
        ],
        automations
      )
    ).toBeNull();
  });
});

describe("b66 then-tail queue settle", () => {
  it("keeps the queue row running while ship is active and blocks the next row", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b66a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b66b",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      const rootRunId = h.queueStore.getRunningEntry(h.workspaceId)!.run_id!;

      const gateId = "gate-green";
      insertRun(h.db, {
        id: gateId,
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
        parentRunId: rootRunId,
      });
      stampGreenFinalGate(h.db, gateId);

      insertRun(h.db, {
        id: "ship-active",
        automationId: h.shipAutomationId,
        workspaceId: h.workspaceId,
        status: "running",
        chainRootRunId: rootRunId,
        parentRunId: gateId,
      });

      expect(
        findActiveThenTailBlocker(
          [
            {
              id: "ship-active",
              parentRunId: gateId,
              automationId: h.shipAutomationId,
              status: "running",
            },
            {
              id: gateId,
              parentRunId: rootRunId,
              automationId: h.terminalAutomationId,
              status: "completed",
            },
          ],
          [
            { id: h.shipAutomationId, configKey: "ship" },
            { id: h.terminalAutomationId, configKey: TERMINAL_KEY },
          ]
        )?.id
      ).toBe("ship-active");

      await h.runner.startNextIfIdle(h.workspaceId);
      expect(h.triggerCalls.filter((c) => c.triggerKind === "manual")).toHaveLength(1);
      expect(h.queueStore.getEntry(a.id)?.state).toBe("running");
      expect(h.queueStore.getRunningEntry(h.workspaceId)?.feature_id).toBe("b66a");
    } finally {
      h.cleanup();
    }
  });

  it("settles done when ship completes and starts the next row", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b66a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b66b",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      const rootRunId = h.queueStore.getRunningEntry(h.workspaceId)!.run_id!;
      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(rootRunId);

      const gateId = "gate-done";
      insertRun(h.db, {
        id: gateId,
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
        parentRunId: rootRunId,
      });
      stampGreenFinalGate(h.db, gateId);

      const shipId = "ship-done";
      insertRun(h.db, {
        id: shipId,
        automationId: h.shipAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
        parentRunId: gateId,
      });

      const lineage = h.store.listChainLineageRuns(rootRunId);
      expect(classifyFeatureQueueOutcome(lineage, TERMINAL_KEY)).toBe("done");

      h.events.emitRunStatus(shipId, "completed");
      await until(() => h.queueStore.getEntry(a.id)?.state === "done");
      await until(
        () => h.triggerCalls.filter((c) => c.triggerKind === "manual").length >= 2
      );
      expect(h.queueStore.getRunningEntry(h.workspaceId)?.feature_id).toBe("b66b");
    } finally {
      h.cleanup();
    }
  });

  it("settles failed and parks dependents when ship fails", async () => {
    const h = await createHarness();
    try {
      const a = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b66a",
        after: [],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      const b = h.queueStore.enqueue({
        workspaceId: h.workspaceId,
        featureId: "b66b",
        after: ["b66a"],
        kickoff: { automationId: h.entryAutomationId, maxDepth: 13 },
      });
      await h.runner.startNextIfIdle(h.workspaceId);
      const rootRunId = h.queueStore.getRunningEntry(h.workspaceId)!.run_id!;
      h.db.prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`).run(rootRunId);

      const gateId = "gate-fail-tail";
      insertRun(h.db, {
        id: gateId,
        automationId: h.terminalAutomationId,
        workspaceId: h.workspaceId,
        status: "completed",
        chainRootRunId: rootRunId,
        parentRunId: rootRunId,
      });
      stampGreenFinalGate(h.db, gateId);

      const shipId = "ship-failed";
      insertRun(h.db, {
        id: shipId,
        automationId: h.shipAutomationId,
        workspaceId: h.workspaceId,
        status: "failed",
        chainRootRunId: rootRunId,
        parentRunId: gateId,
      });

      expect(classifyFeatureQueueOutcome(h.store.listChainLineageRuns(rootRunId), TERMINAL_KEY)).toBe(
        "failed"
      );

      h.events.emitRunStatus(shipId, "failed");
      await until(() => h.queueStore.getEntry(a.id)?.state === "failed");
      expect(h.queueStore.getEntry(b.id)?.state).toBe("blocked");
    } finally {
      h.cleanup();
    }
  });

  it("does not block kickoff for unrelated manual runs", async () => {
    const h = await createHarness();
    try {
      insertRun(h.db, {
        id: "unrelated-manual",
        automationId: h.manualAutomationId,
        workspaceId: h.workspaceId,
        status: "running",
      });
      expect(
        findActiveThenTailBlocker(
          [
            {
              id: "unrelated-manual",
              parentRunId: null,
              automationId: h.manualAutomationId,
              status: "running",
            },
          ],
          [{ id: h.manualAutomationId, configKey: "manual-run" }]
        )
      ).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
