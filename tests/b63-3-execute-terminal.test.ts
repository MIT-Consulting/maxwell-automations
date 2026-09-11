import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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

const EXECUTE_CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b63",
    featureSlug: "b63-implement-fully-execute-mode",
    featureDir: "docs/roadmap/done/b63-implement-fully-execute-mode",
    featureIndex: "docs/roadmap/done/b63-implement-fully-execute-mode/00-index.md",
    idea: "execute terminal path",
    planningDepth: "full",
    approvalPolicy: "none",
    researchApprovalPolicy: "none",
    loopMode: "execute",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

const NORMAL_CONTEXT: ChainRunContext = {
  variables: {
    ...EXECUTE_CONTEXT.variables,
    loopMode: "normal",
    planningDepth: "jit",
  },
  roleModels: EXECUTE_CONTEXT.roleModels,
};

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
};

async function createEnv(): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b63-3-"));
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
  return { root, workspaceId, db, store, engine, chainRunner };
}

async function destroyEnv(env: Env): Promise<void> {
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function planPhaseAutomationId(workspaceId: string): string {
  return automationId(
    workspaceId,
    `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`
  );
}

function seedPlanPhaseRun(
  env: Env,
  opts: {
    id: string;
    stopReason: string | null;
    status?: string;
    depth?: number;
    maxDepth?: number;
    chainContext?: ChainRunContext;
  }
): void {
  env.store.insertRun({
    id: opts.id,
    automationId: planPhaseAutomationId(env.workspaceId),
    workspaceId: env.workspaceId,
    triggerKind: "manual",
    prompt: "seed",
    chainRootRunId: opts.id,
    chainDepth: opts.depth ?? 5,
    chainMaxDepth: opts.maxDepth ?? 13,
    chainContext: opts.chainContext ?? EXECUTE_CONTEXT,
    pipelineTrackId: null,
  });
  env.db
    .prepare(
      `UPDATE runs SET status = ?,
         chain_stop_requested_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
         chain_stop_reason = ?
       WHERE id = ?`
    )
    .run(opts.status ?? "completed", opts.stopReason, opts.stopReason, opts.id);
}

function childRuns(db: Db, parentId: string): Array<{ id: string; config_key: string }> {
  return db
    .prepare(
      `SELECT r.id, a.config_key
       FROM runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.parent_run_id = ?
       ORDER BY r.created_at ASC`
    )
    .all(parentId) as Array<{ id: string; config_key: string }>;
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

describe("b63.3 execute terminal routing", () => {
  it("execute complete: enqueues feature-level review, then final-gate with depth exemption", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-complete",
        stopReason: "complete: no runnable Pending phase left",
        depth: 7,
        maxDepth: 8,
        chainContext: EXECUTE_CONTEXT,
      });
      await env.chainRunner.handleTerminal("pp-complete", "completed");

      const reviewChildren = childRuns(env.db, "pp-complete");
      expect(reviewChildren).toHaveLength(1);
      expect(reviewChildren[0]!.config_key).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}review`
      );
      expect(
        eventPayload(env.db, "pp-complete", "run.pipeline-feature-review-enqueued")
      ).toBeTruthy();
      expect(
        eventPayload(env.db, "pp-complete", "run.pipeline-final-gate-enqueued")
      ).toBeUndefined();

      const reviewId = reviewChildren[0]!.id;
      const reviewRow = env.store.getRun(reviewId)!;
      expect(reviewRow.chain_depth).toBe(8);
      expect(reviewRow.chain_max_depth).toBe(8);

      await until(() => env.store.getRun(reviewId)!.status === "completed");
      await env.chainRunner.handleTerminal(reviewId, "completed");

      const gateChildren = childRuns(env.db, reviewId);
      expect(gateChildren).toHaveLength(1);
      expect(gateChildren[0]!.config_key).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}final-gate`
      );
      const gate = env.store.getRun(gateChildren[0]!.id)!;
      expect(gate.chain_depth).toBe(9);
      expect(gate.chain_max_depth).toBe(9);
    } finally {
      await destroyEnv(env);
    }
  });

  it("normal complete: enqueues final-gate directly with no feature review", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-normal",
        stopReason: "complete: tracker dry",
        chainContext: NORMAL_CONTEXT,
      });
      await env.chainRunner.handleTerminal("pp-normal", "completed");

      const children = childRuns(env.db, "pp-normal");
      expect(children).toHaveLength(1);
      expect(children[0]!.config_key).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}final-gate`
      );
      expect(
        eventPayload(env.db, "pp-normal", "run.pipeline-feature-review-enqueued")
      ).toBeUndefined();
    } finally {
      await destroyEnv(env);
    }
  });

  it("blocked feature review halts without final-gate or plan-phase successor", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-parent",
        stopReason: "complete: done",
        chainContext: EXECUTE_CONTEXT,
      });
      await env.chainRunner.handleTerminal("pp-parent", "completed");
      const reviewId = childRuns(env.db, "pp-parent")[0]!.id;

      env.db
        .prepare(
          `UPDATE runs SET chain_stop_requested_at = datetime('now'),
             chain_stop_reason = ?
           WHERE id = ?`
        )
        .run("blocked: acceptance failed", reviewId);

      await env.chainRunner.handleTerminal(reviewId, "completed");

      expect(childRuns(env.db, reviewId)).toHaveLength(0);
      expect(
        eventPayload(env.db, reviewId, "run.pipeline-final-gate-enqueued")
      ).toBeUndefined();
    } finally {
      await destroyEnv(env);
    }
  });

  it("restart-safe: fresh ChainRunner over same DB routes feature review to final-gate", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-restart",
        stopReason: "complete: restart test",
        depth: 7,
        maxDepth: 8,
        chainContext: EXECUTE_CONTEXT,
      });
      await env.chainRunner.handleTerminal("pp-restart", "completed");
      const reviewId = childRuns(env.db, "pp-restart")[0]!.id;

      await until(() => env.store.getRun(reviewId)!.status === "completed");

      const freshRunner = new ChainRunner({
        store: env.store,
        engine: env.engine,
        events: new DaemonEventBus(),
        onLog: () => {},
      });

      await freshRunner.handleTerminal(reviewId, "completed");

      const gateChildren = childRuns(env.db, reviewId);
      expect(gateChildren).toHaveLength(1);
      expect(gateChildren[0]!.config_key).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}final-gate`
      );
    } finally {
      await destroyEnv(env);
    }
  });
});
