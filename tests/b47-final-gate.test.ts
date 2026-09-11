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
import {
  IMPLEMENT_FULLY_REQUIRED_SKILLS,
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import {
  describePipelineWaveStep,
  formatPipelineWaveChipLabel,
} from "../packages/shared/src/pipeline-wave.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b47",
    featureSlug: "b47-focused-phase-review",
    featureDir: "docs/roadmap/b47-focused-phase-review",
    featureIndex: "docs/roadmap/b47-focused-phase-review/00-index.md",
    idea: "final gate routing",
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
  const root = mkdtempSync(join(tmpdir(), "lca-b47-gate-"));
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
  // Do not start() — tests call handleTerminal directly.
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
    trackId?: string | null;
    workerKey?: string;
    chainContext?: ChainRunContext;
  }
): void {
  const workerKey = opts.workerKey ?? "plan-phase";
  const automationIdFor =
    workerKey === "plan-phase"
      ? planPhaseAutomationId(env.workspaceId)
      : automationId(
          env.workspaceId,
          `${GENERATED_CONFIG_KEY_PREFIX}${workerKey}`
        );
  env.store.insertRun({
    id: opts.id,
    automationId: automationIdFor,
    workspaceId: env.workspaceId,
    triggerKind: "manual",
    prompt: "seed",
    chainRootRunId: opts.id,
    chainDepth: opts.depth ?? 5,
    chainMaxDepth: opts.maxDepth ?? 13,
    chainContext: opts.chainContext ?? CONTEXT,
    pipelineTrackId: opts.trackId ?? null,
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

describe("b47 final-gate catalog", () => {
  it("registers eight workers with a terminal final-gate gatekeeper", () => {
    expect(IMPLEMENT_FULLY_WORKERS).toHaveLength(8);
    const gate = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
    )!;
    expect(gate).toBeDefined();
    expect(gate.chain).toBeNull();
    expect(gate.modelRole).toBe("gatekeeper");
    expect([
      ...IMPLEMENT_FULLY_REQUIRED_SKILLS[IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY],
    ]).toEqual(["review-speed-implementation", "gc"]);
  });

  it("prompt names root commands, Final Gate record, stops, and gate-fix commits", () => {
    const prompt = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
    )!.prompt;
    expect(prompt).toContain("npm run typecheck");
    expect(prompt).toContain("npm run build");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("## Final Gate");
    expect(prompt).toContain("complete:");
    expect(prompt).toContain("blocked:");
    expect(prompt).toContain("fix({{featureSlug}}): final gate");
  });
});

describe("b47 final-gate labels", () => {
  it("does not fabricate a cycle for final-gate", () => {
    const step = describePipelineWaveStep({
      configKey: `${GENERATED_CONFIG_KEY_PREFIX}final-gate`,
      chainDepth: 10,
    });
    expect(step.workerKey).toBe("final-gate");
    expect(step.stepInCycle).toBeNull();
    expect(step.cycle).toBeNull();
    expect(
      formatPipelineWaveChipLabel({
        featureId: "b47",
        configKey: `${GENERATED_CONFIG_KEY_PREFIX}final-gate`,
        chainDepth: 10,
      })
    ).toBe("b47 · final-gate");
  });
});

describe("b47 final-gate routing", () => {
  it("enqueues final-gate once for a completed non-track plan-phase complete: stop", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-complete",
        stopReason: "complete: no runnable Pending phase left",
      });
      await env.chainRunner.handleTerminal("pp-complete", "completed");

      const children = childRuns(env.db, "pp-complete");
      expect(children).toHaveLength(1);
      expect(children[0]!.config_key).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}final-gate`
      );
      const enqueued = eventPayload(
        env.db,
        "pp-complete",
        "run.pipeline-final-gate-enqueued"
      );
      expect(enqueued?.childRunId).toBe(children[0]!.id);
      expect(enqueued?.stopReason).toBe(
        "complete: no runnable Pending phase left"
      );
      expect(env.store.getRun("pp-complete")!.chain_handled_at).toBeTruthy();

      await until(() => env.store.getRun(children[0]!.id)!.status === "completed");
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not enqueue for non-completion or non-implement-fully runs", async () => {
    const env = await createEnv();
    try {
      const cases: Array<{
        id: string;
        stopReason: string | null;
        status?: string;
        trackId?: string | null;
        workerKey?: string;
        chainContext?: ChainRunContext;
      }> = [
        { id: "pp-deadlock", stopReason: "deadlock: mutual deps" },
        { id: "pp-blocked", stopReason: "blocked: waiting on secret" },
        { id: "pp-abort", stopReason: "operator aborted" },
        {
          id: "pp-track",
          stopReason: "complete: no runnable Pending phase left",
          trackId: "track-1",
        },
        {
          id: "impl-complete",
          stopReason: "complete: should not matter",
          workerKey: "implement",
        },
        {
          id: "pp-failed",
          stopReason: "complete: no runnable Pending phase left",
          status: "failed",
        },
        {
          id: "pp-other-pipeline",
          stopReason: "complete: no runnable Pending phase left",
          chainContext: {
            ...CONTEXT,
            variables: {
              ...CONTEXT.variables,
              pipelineId: "other-pipeline",
            },
          },
        },
      ];

      for (const c of cases) {
        seedPlanPhaseRun(env, c);
        await env.chainRunner.handleTerminal(
          c.id,
          (c.status as "completed" | "failed") ?? "completed"
        );
        expect(childRuns(env.db, c.id)).toHaveLength(0);
        expect(
          eventPayload(env.db, c.id, "run.pipeline-final-gate-enqueued")
        ).toBeUndefined();
      }
    } finally {
      await destroyEnv(env);
    }
  });

  it("still enqueues when chainDepth >= chainMaxDepth (depth exemption)", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-budget",
        stopReason: "complete: tracker dry",
        depth: 13,
        maxDepth: 13,
      });
      await env.chainRunner.handleTerminal("pp-budget", "completed");

      const children = childRuns(env.db, "pp-budget");
      expect(children).toHaveLength(1);
      expect(children[0]!.config_key).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}final-gate`
      );
      const gate = env.store.getRun(children[0]!.id)!;
      expect(gate.chain_depth).toBe(14);
      expect(gate.chain_max_depth).toBe(14);
      expect(
        eventPayload(env.db, "pp-budget", "run.pipeline-final-gate-enqueued")
      ).toBeTruthy();
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not enqueue twice on a second terminal delivery", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-once",
        stopReason: "complete: done",
      });
      await env.chainRunner.handleTerminal("pp-once", "completed");
      await env.chainRunner.handleTerminal("pp-once", "completed");

      expect(childRuns(env.db, "pp-once")).toHaveLength(1);
      const events = env.db
        .prepare(
          `SELECT COUNT(*) AS n FROM run_events
           WHERE run_id = ? AND event_type = 'run.pipeline-final-gate-enqueued'`
        )
        .get("pp-once") as { n: number };
      expect(events.n).toBe(1);
    } finally {
      await destroyEnv(env);
    }
  });
});
