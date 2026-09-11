import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_PIPELINE_ID,
  type ModelSelection,
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
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_WORKERS,
  computeImplementFullyBudget,
  resolveExecuteModeNext,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

const REVIEW_KEY = `${GENERATED_CONFIG_KEY_PREFIX}review`;
const DOCS_COMMIT_KEY = `${GENERATED_CONFIG_KEY_PREFIX}docs-commit`;

const ROLE_MODELS = {
  planner: { id: "planner-model-a" } satisfies ModelSelection,
  implementer: { id: "implementer-model-b" } satisfies ModelSelection,
  reviewer: { id: "reviewer-model-c" } satisfies ModelSelection,
  docs: { id: "docs-model-d" } satisfies ModelSelection,
};

const EXECUTE_VARS = {
  pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
  featureId: "b99",
  featureSlug: "b99-execute-loop",
  featureDir: "docs/roadmap/b99-execute-loop",
  featureIndex: "docs/roadmap/b99-execute-loop/00-index.md",
  idea: "execute loop simulation",
  planningDepth: "full",
  approvalPolicy: "none",
  researchApprovalPolicy: "none",
  loopMode: "execute",
};

const NORMAL_VARS = {
  ...EXECUTE_VARS,
  loopMode: "normal",
  planningDepth: "jit",
};

const EXECUTE_WORKER_ORDER = [
  "plan-skeleton",
  "plan-phase",
  "implement",
  "docs-commit",
  "plan-phase",
  "implement",
  "docs-commit",
  "plan-phase",
] as const;

const NORMAL_WORKER_ORDER = [
  "plan-skeleton",
  "plan-phase",
  "implement",
  "review",
  "plan-phase",
  "implement",
  "review",
  "plan-phase",
] as const;

function handoffPacketFor(workerKey: string): string {
  return [
    "```text",
    "lca-handoff",
    "version: 1",
    `pipeline: ${IMPLEMENT_FULLY_PIPELINE_ID}`,
    `worker: ${workerKey}`,
    "feature: b99",
    "phase: -",
    "outcome: planned",
    "summary: loop sim",
    "artifacts:",
    "- none",
    "decisions:",
    "- none",
    "deviations:",
    "- none",
    "verification:",
    "- none",
    "risks:",
    "- none",
    "downstream-effects:",
    "- none",
    "next: continue",
    "```",
  ].join("\n");
}

function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
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

function workerKeyFromConfigKey(configKey: string): string {
  return configKey.startsWith(GENERATED_CONFIG_KEY_PREFIX)
    ? configKey.slice(GENERATED_CONFIG_KEY_PREFIX.length)
    : configKey;
}

type SpawnRecord = { workerKey: string };

function scriptedExecutor(
  db: Db,
  engineRef: { current: RunEngine | null },
  spawns: SpawnRecord[],
  budget: number
): Executor {
  const planPhaseByRoot = new Map<string, number>();

  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      const run = db
        .prepare(
          `SELECT id, automation_id, chain_root_run_id FROM runs WHERE id = ?`
        )
        .get(params.runId) as
        | { id: string; automation_id: string; chain_root_run_id: string | null }
        | undefined;
      if (!run) {
        throw new Error(`spawn for unknown run ${params.runId}`);
      }
      const automation = db
        .prepare(`SELECT config_key FROM automations WHERE id = ?`)
        .get(run.automation_id) as { config_key: string } | undefined;
      if (!automation) {
        throw new Error(`spawn missing automation ${run.automation_id}`);
      }

      const workerKey = workerKeyFromConfigKey(automation.config_key);
      spawns.push({ workerKey });

      const engine = engineRef.current;
      if (!engine) {
        throw new Error("engine ref not set before spawn");
      }

      const rootId = run.chain_root_run_id ?? run.id;

      if (workerKey === "plan-skeleton") {
        const applied = engine.applyChainControl(
          params.runId,
          { rebudget: { maxDepth: budget } },
          params.runToken
        );
        if (!applied.ok) {
          throw new Error(`rebudget failed: ${applied.reason}`);
        }
      }

      if (workerKey === "plan-phase") {
        const count = (planPhaseByRoot.get(rootId) ?? 0) + 1;
        planPhaseByRoot.set(rootId, count);
        if (count === 3) {
          const applied = engine.applyChainControl(
            params.runId,
            { stop: { reason: "complete: no runnable Pending phase left" } },
            params.runToken
          );
          if (!applied.ok) {
            throw new Error(`stop failed: ${applied.reason}`);
          }
        }
      }

      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        wait: async () =>
          ({ status: "finished", result: handoffPacketFor(workerKey) }) as never,
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
  db: Db;
  engine: RunEngine;
  chainRunner: ChainRunner;
  spawns: SpawnRecord[];
  entryAutomationId: string;
};

async function createEnv(
  variables: Record<string, string>,
  phaseCount: number,
  loopMode: "execute" | "normal"
): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b63-2-"));
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

  const spawns: SpawnRecord[] = [];
  const engineRef: { current: RunEngine | null } = { current: null };
  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const budget = computeImplementFullyBudget(phaseCount, loopMode);
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: scriptedExecutor(db, engineRef, spawns, budget),
    events,
    inputHub,
    maxConcurrentRuns: 4,
  });
  engineRef.current = engine;
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
  });
  chainRunner.start();

  return {
    root,
    db,
    engine,
    chainRunner,
    spawns,
    entryAutomationId: automationId(
      workspaceId,
      `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
    ),
  };
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function listPipelineRuns(db: Db, rootId: string) {
  return (
    db
      .prepare(
        `SELECT r.id, r.status, r.chain_stop_reason, a.config_key
         FROM runs r
         JOIN automations a ON a.id = r.automation_id
         WHERE r.chain_root_run_id = ?
         ORDER BY r.created_at ASC, r.rowid ASC`
      )
      .all(rootId) as Array<{
      id: string;
      status: string;
      chain_stop_reason: string | null;
      config_key: string;
    }>
  );
}

async function kickoff(env: Env, variables: Record<string, string>): Promise<string> {
  return env.engine.triggerRun(env.entryAutomationId, "manual", {
    chainContext: { variables, roleModels: ROLE_MODELS },
    chainMaxDepth: 1,
    modelSelectionOverride: ROLE_MODELS.planner,
  });
}

describe("b63.2 resolveExecuteModeNext", () => {
  const executeVars = {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    loopMode: "execute",
  };

  it("remaps only on the exact four-condition match", () => {
    expect(
      resolveExecuteModeNext({
        sourceWorkerKey: "implement",
        chainNext: REVIEW_KEY,
        variables: executeVars,
      })
    ).toBe(DOCS_COMMIT_KEY);
  });

  it("returns chainNext unchanged for non-matching inputs", () => {
    const cases = [
      { sourceWorkerKey: null, chainNext: REVIEW_KEY },
      {
        sourceWorkerKey: "implement",
        chainNext: REVIEW_KEY,
        variables: { pipelineId: IMPLEMENT_FULLY_PIPELINE_ID },
      },
      {
        sourceWorkerKey: "implement",
        chainNext: REVIEW_KEY,
        variables: { pipelineId: IMPLEMENT_FULLY_PIPELINE_ID, loopMode: "normal" },
      },
      { sourceWorkerKey: "plan-phase", chainNext: REVIEW_KEY, variables: executeVars },
      {
        sourceWorkerKey: "implement",
        chainNext: `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`,
        variables: executeVars,
      },
      {
        sourceWorkerKey: "implement",
        chainNext: REVIEW_KEY,
        variables: { pipelineId: "other", loopMode: "execute" },
      },
    ] as const;

    for (const c of cases) {
      expect(
        resolveExecuteModeNext({
          sourceWorkerKey: c.sourceWorkerKey,
          chainNext: c.chainNext,
          variables: c.variables ?? executeVars,
        })
      ).toBe(c.chainNext);
    }
  });
});

describe("b63.2 computeImplementFullyBudget", () => {
  it("uses 3P+2 under execute and 6P+1 under normal or when omitted", () => {
    expect(computeImplementFullyBudget(2, "execute")).toBe(8);
    expect(computeImplementFullyBudget(2, "normal")).toBe(13);
    expect(computeImplementFullyBudget(2)).toBe(13);
  });

  it("clamps both formulas at 500 and rejects invalid phaseCount", () => {
    expect(computeImplementFullyBudget(200, "execute")).toBe(500);
    expect(computeImplementFullyBudget(200, "normal")).toBe(500);
    expect(() => computeImplementFullyBudget(0)).toThrow();
    expect(() => computeImplementFullyBudget(-1)).toThrow();
    expect(() => computeImplementFullyBudget(1.5)).toThrow();
  });
});

describe("b63.2 static graph unchanged", () => {
  it("reachable chain from plan-skeleton never includes docs-commit", () => {
    const workerByKey = new Map(
      IMPLEMENT_FULLY_WORKERS.map((w) => [w.key, w])
    );
    function nextWorkerKey(
      spec: (typeof IMPLEMENT_FULLY_WORKERS)[number]
    ): string | null {
      const next = spec.chain?.next;
      if (next == null) return null;
      return next.replace(/^generated:/, "");
    }

    const reachable: string[] = [];
    let cursor: string | null = IMPLEMENT_FULLY_ENTRY_WORKER_KEY;
    const seen = new Set<string>();
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      reachable.push(cursor);
      const spec = workerByKey.get(cursor);
      cursor = spec ? nextWorkerKey(spec) : null;
    }

    expect(reachable).toEqual([
      "plan-skeleton",
      "plan-phase",
      "implement",
      "review",
    ]);
    expect(reachable.includes("docs-commit")).toBe(false);
  });
});

describe("b63.2 loop simulation", () => {
  it("execute: two-phase chain runs plan-phase→implement→docs-commit and completes", async () => {
    const env = await createEnv(EXECUTE_VARS, 2, "execute");
    try {
      const rootId = await kickoff(env, EXECUTE_VARS);

      await until(() => {
        const pipe = listPipelineRuns(env.db, rootId);
        if (pipe.length < 8) return false;
        const leaf = pipe[7]!;
        return (
          leaf.status === "completed" &&
          workerKeyFromConfigKey(leaf.config_key) === "plan-phase" &&
          leaf.chain_stop_reason?.startsWith("complete:")
        );
      });

      const pipe = listPipelineRuns(env.db, rootId);
      expect(pipe.length).toBeGreaterThanOrEqual(8);
      for (let i = 0; i < 8; i++) {
        expect(workerKeyFromConfigKey(pipe[i]!.config_key)).toBe(
          EXECUTE_WORKER_ORDER[i]
        );
      }
      expect(env.spawns.map((s) => s.workerKey).slice(0, 8)).toEqual([
        ...EXECUTE_WORKER_ORDER,
      ]);
      expect(pipe[7]!.chain_stop_reason).toBe(
        "complete: no runnable Pending phase left"
      );
      expect(
        env.spawns.slice(0, 8).filter((s) => s.workerKey === "review")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("normal: two-phase chain still routes implement→review", async () => {
    const env = await createEnv(NORMAL_VARS, 2, "normal");
    try {
      const rootId = await kickoff(env, NORMAL_VARS);

      await until(() => listPipelineRuns(env.db, rootId).length >= 8);

      const loopSpawns = env.spawns.map((s) => s.workerKey).slice(0, 8);
      expect(loopSpawns).toEqual([...NORMAL_WORKER_ORDER]);
      const reviewIndices = loopSpawns
        .map((key, i) => (key === "review" ? i : -1))
        .filter((i) => i >= 0);
      expect(reviewIndices).toEqual([3, 6]);
      expect(loopSpawns.filter((key) => key === "docs-commit")).toHaveLength(0);
      expect(env.spawns[8]?.workerKey).toBe("final-gate");
    } finally {
      await destroyEnv(env);
    }
  });
});
