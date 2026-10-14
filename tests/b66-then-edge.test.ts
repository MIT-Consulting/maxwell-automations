import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type ChainRunContext,
} from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
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
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

function baseContext(then: string, loopMode: "normal" | "execute" = "normal"): ChainRunContext {
  return {
    variables: {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b66",
      featureSlug: "b66-pipeline-then-chaining",
      featureDir: "docs/roadmap/b66-pipeline-then-chaining",
      featureIndex: "docs/roadmap/b66-pipeline-then-chaining/00-index.md",
      idea: "then edge",
      planningDepth: "full",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode,
      then,
    },
    roleModels: {
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
      docs: { id: "docs-model" },
    },
  };
}

function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
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
    spawn: async (_params: SpawnParams) => {
      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: "agent-stub",
        sdkRunId: "sdk-stub",
        async *stream() {},
        wait: async () =>
          ({ status: "finished", result: "ok" }) as never,
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

type Env = {
  root: string;
  workspaceId: string;
  db: Db;
  store: RunStore;
  engine: RunEngine;
  chainRunner: ChainRunner;
  shipAutomationId: string;
};

async function createEnv(): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b66-then-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    workspaceId,
    workspacePath,
    "Workspace"
  );
  const plan = provisionGeneratedWorkers(
    db,
    workspaceId,
    IMPLEMENT_FULLY_WORKERS
  );
  expect(plan.applied).toBe(true);

  const shipAutomationId = automationId(workspaceId, "ship");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key
    ) VALUES (?, ?, 'ship', 1, 'enabled', ?, 'ship prompt', NULL, 'ship.yaml', 'ship')`
  ).run(shipAutomationId, workspaceId, JSON.stringify({ type: "manual" }));

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
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
  });
  return { root, workspaceId, db, store, engine, chainRunner, shipAutomationId };
}

async function destroyEnv(env: Env): Promise<void> {
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function finalGateAutomationId(workspaceId: string): string {
  return automationId(
    workspaceId,
    `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY}`
  );
}

function seedFinalGateRun(
  env: Env,
  opts: {
    id: string;
    stopReason: string | null;
    status?: string;
    depth?: number;
    maxDepth?: number;
    chainContext?: ChainRunContext;
    chainHandledAt?: string | null;
  }
): void {
  env.store.insertRun({
    id: opts.id,
    automationId: finalGateAutomationId(env.workspaceId),
    workspaceId: env.workspaceId,
    triggerKind: "manual",
    prompt: "seed",
    chainRootRunId: opts.id,
    chainDepth: opts.depth ?? 13,
    chainMaxDepth: opts.maxDepth ?? 13,
    chainContext: opts.chainContext ?? baseContext("ship"),
    pipelineTrackId: null,
  });
  env.db
    .prepare(
      `UPDATE runs SET status = ?,
         chain_stop_requested_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
         chain_stop_reason = ?,
         chain_handled_at = ?
       WHERE id = ?`
    )
    .run(
      opts.status ?? "completed",
      opts.stopReason,
      opts.stopReason,
      opts.chainHandledAt ?? null,
      opts.id
    );
}

function childRuns(
  db: Db,
  parentId: string
): Array<{ id: string; config_key: string; chain_max_depth: number | null }> {
  return db
    .prepare(
      `SELECT r.id, a.config_key, r.chain_max_depth
       FROM runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.parent_run_id = ?
       ORDER BY r.created_at ASC`
    )
    .all(parentId) as Array<{
    id: string;
    config_key: string;
    chain_max_depth: number | null;
  }>;
}

function eventPayload(
  db: Db,
  runId: string,
  eventType: string
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND event_type = ?
       ORDER BY seq DESC LIMIT 1`
    )
    .get(runId, eventType) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("b66 then synthetic edge on green final-gate", () => {
  it("enqueues ship once with source then and a fresh depth budget", async () => {
    const env = await createEnv();
    try {
      seedFinalGateRun(env, {
        id: "gate-ship",
        stopReason: "complete: feature green",
        depth: 13,
        maxDepth: 13,
        chainContext: baseContext("ship"),
      });
      await env.chainRunner.handleTerminal("gate-ship", "completed");

      const children = childRuns(env.db, "gate-ship");
      expect(children).toHaveLength(1);
      expect(children[0]!.config_key).toBe("ship");
      expect(children[0]!.id).toBeTruthy();
      expect(children[0]!.chain_max_depth).toBe(14 + 20);

      const chained = eventPayload(env.db, "gate-ship", "run.chained");
      expect(chained?.source).toBe("then");
      expect(chained?.childRunId).toBe(children[0]!.id);
      expect(chained?.next).toBe("ship");
      expect(
        eventPayload(env.db, "gate-ship", "run.pipeline-final-gate-enqueued")
      ).toBeUndefined();

      await until(
        () => env.store.getRun(children[0]!.id)!.status === "completed"
      );
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not enqueue when then is none", async () => {
    const env = await createEnv();
    try {
      seedFinalGateRun(env, {
        id: "gate-none",
        stopReason: "complete: feature green",
        chainContext: baseContext("none"),
      });
      await env.chainRunner.handleTerminal("gate-none", "completed");
      expect(childRuns(env.db, "gate-none")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not enqueue on blocked stop reason", async () => {
    const env = await createEnv();
    try {
      seedFinalGateRun(env, {
        id: "gate-blocked",
        stopReason: "blocked: gate failed",
        chainContext: baseContext("ship"),
      });
      await env.chainRunner.handleTerminal("gate-blocked", "completed");
      expect(childRuns(env.db, "gate-blocked")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not enqueue twice when chain already handled", async () => {
    const env = await createEnv();
    try {
      seedFinalGateRun(env, {
        id: "gate-once",
        stopReason: "complete: feature green",
        chainContext: baseContext("ship"),
        chainHandledAt: "2026-01-01T00:00:00.000Z",
      });
      await env.chainRunner.handleTerminal("gate-once", "completed");
      expect(childRuns(env.db, "gate-once")).toHaveLength(0);
      expect(
        eventPayload(env.db, "gate-once", "run.chain-skipped")?.reason
      ).toBe("already-chained");
    } finally {
      await destroyEnv(env);
    }
  });

  it("applies the same then rule in execute mode", async () => {
    const env = await createEnv();
    try {
      seedFinalGateRun(env, {
        id: "gate-exec",
        stopReason: "complete: execute feature green",
        depth: 9,
        maxDepth: 9,
        chainContext: baseContext("ship", "execute"),
      });
      await env.chainRunner.handleTerminal("gate-exec", "completed");

      const children = childRuns(env.db, "gate-exec");
      expect(children).toHaveLength(1);
      expect(children[0]!.config_key).toBe("ship");
      expect(eventPayload(env.db, "gate-exec", "run.chained")?.source).toBe(
        "then"
      );
    } finally {
      await destroyEnv(env);
    }
  });
});
