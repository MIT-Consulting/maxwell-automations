import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_PIPELINE_ID,
  modelSelectionKey,
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
  IMPLEMENT_FULLY_WORKERS,
  computeImplementFullyBudget,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

type SpawnRecord = {
  runId: string;
  automationId: string;
  configKey: string;
  workerKey: string;
  prompt: string;
  model: SpawnParams["model"];
};

type ScriptMode = "full" | "no-rebudget" | "fail-implement" | "deadlock-stop";

const WORKER_ORDER = [
  "plan-skeleton",
  "plan-phase",
  "implement",
  "review",
  "plan-phase",
  "implement",
  "review",
  "plan-phase",
] as const;

const ROLE_MODELS = {
  planner: { id: "planner-model-a" } satisfies ModelSelection,
  implementer: {
    id: "implementer-model-b",
    params: [{ id: "fast", value: "true" }],
  } satisfies ModelSelection,
  reviewer: { id: "reviewer-model-c" } satisfies ModelSelection,
  docs: {
    id: "docs-model-d",
    params: [{ id: "reasoning", value: "high" }],
  } satisfies ModelSelection,
};

const WORKER_ROLE: Record<string, keyof typeof ROLE_MODELS> = {
  "plan-skeleton": "planner",
  "plan-phase": "planner",
  implement: "implementer",
  review: "reviewer",
  "docs-commit": "docs",
  "final-gate": "reviewer",
};

const ALT_ROLE_MODELS = {
  planner: { id: "alt-planner" } satisfies ModelSelection,
  implementer: { id: "alt-implementer" } satisfies ModelSelection,
  reviewer: { id: "alt-reviewer" } satisfies ModelSelection,
  docs: { id: "alt-docs" } satisfies ModelSelection,
};

const FEATURE_A = {
  pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
  featureId: "b99",
  featureSlug: "b99-loop-sim",
  featureDir: "docs/roadmap/b99-loop-sim",
  featureIndex: "docs/roadmap/b99-loop-sim/00-index.md",
  idea: "prove the loop with a stub executor",
};

const FEATURE_B = {
  pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
  featureId: "b100",
  featureSlug: "b100-isolation",
  featureDir: "docs/roadmap/b100-isolation",
  featureIndex: "docs/roadmap/b100-isolation/00-index.md",
  idea: "second concurrent pipeline",
};

/** Valid v1 handoff; keeps `{{featureDir}}` literal so chain must not re-template it. */
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
    "summary: parent noted {{featureDir}} literally",
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
    "next: continue loop",
    "```",
  ].join("\n");
}

const PARENT_HANDOFF_SUMMARY = "parent noted {{featureDir}} literally";

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

function scriptedExecutor(
  db: Db,
  engineRef: { current: RunEngine | null },
  spawns: SpawnRecord[],
  options: {
    mode: ScriptMode;
    /** Per-root budget for plan-skeleton rebudget (default: two-phase = 13). */
    budget?: number;
    budgetByFeatureSlug?: Readonly<Record<string, number>>;
    result?: string;
  }
): Executor {
  const planPhaseByRoot = new Map<string, number>();
  const defaultBudget = options.budget ?? computeImplementFullyBudget(2);

  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      const run = db
        .prepare(
          `SELECT id, automation_id, chain_root_run_id, chain_context_json
           FROM runs WHERE id = ?`
        )
        .get(params.runId) as
        | {
            id: string;
            automation_id: string;
            chain_root_run_id: string | null;
            chain_context_json: string | null;
          }
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

      const configKey = automation.config_key;
      const workerKey = workerKeyFromConfigKey(configKey);
      const prompt =
        typeof params.prompt === "string" ? params.prompt : params.prompt.text;

      spawns.push({
        runId: params.runId,
        automationId: run.automation_id,
        configKey,
        workerKey,
        prompt,
        model: params.model,
      });

      const engine = engineRef.current;
      if (!engine) {
        throw new Error("engine ref not set before spawn");
      }

      const rootId = run.chain_root_run_id ?? run.id;
      const context = run.chain_context_json
        ? (JSON.parse(run.chain_context_json) as {
            variables?: Record<string, string>;
          })
        : undefined;
      const featureSlug = context?.variables?.featureSlug;
      const budget =
        (featureSlug == null
          ? undefined
          : options.budgetByFeatureSlug?.[featureSlug]) ?? defaultBudget;

      if (
        (options.mode === "full" ||
          options.mode === "deadlock-stop" ||
          options.mode === "fail-implement") &&
        workerKey === "plan-skeleton"
      ) {
        const applied = engine.applyChainControl(
          params.runId,
          { rebudget: { maxDepth: budget } },
          params.runToken
        );
        if (!applied.ok) {
          throw new Error(`rebudget failed: ${applied.reason}`);
        }
      }

      if (
        (options.mode === "full" || options.mode === "deadlock-stop") &&
        workerKey === "plan-phase"
      ) {
        const count = (planPhaseByRoot.get(rootId) ?? 0) + 1;
        planPhaseByRoot.set(rootId, count);
        if (count === 3) {
          const reason =
            options.mode === "deadlock-stop"
              ? "deadlock: two phases blocked on mutual deps"
              : "complete: no runnable Pending phase left";
          const applied = engine.applyChainControl(
            params.runId,
            { stop: { reason } },
            params.runToken
          );
          if (!applied.ok) {
            throw new Error(`stop failed: ${applied.reason}`);
          }
        }
      }

      const failThis =
        options.mode === "fail-implement" && workerKey === "implement";
      const result =
        options.result ?? handoffPacketFor(workerKey);

      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        wait: async () =>
          (failThis
            ? { status: "error", result: null }
            : { status: "finished", result }) as never,
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
  workspacePath: string;
  workspaceId: string;
  db: Db;
  events: DaemonEventBus;
  store: RunStore;
  engine: RunEngine;
  chainRunner: ChainRunner;
  spawns: SpawnRecord[];
  entryAutomationId: string;
};

async function createEnv(options: {
  mode: ScriptMode;
  budget?: number;
  budgetByFeatureSlug?: Readonly<Record<string, number>>;
  result?: string;
}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-3d-"));
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
  expect(plan.items.every((i) => i.action === "create")).toBe(true);

  const spawns: SpawnRecord[] = [];
  const engineRef: { current: RunEngine | null } = { current: null };
  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: scriptedExecutor(db, engineRef, spawns, options),
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
    workspacePath,
    workspaceId,
    db,
    events,
    store,
    engine,
    chainRunner,
    spawns,
    entryAutomationId: automationId(
      workspaceId,
      `${GENERATED_CONFIG_KEY_PREFIX}plan-skeleton`
    ),
  };
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function listPipelineRuns(db: Db, rootId?: string) {
  const rows = db
    .prepare(
      `SELECT r.id, r.automation_id, r.parent_run_id, r.status, r.prompt,
              r.chain_root_run_id, r.chain_depth, r.chain_max_depth,
              r.chain_max_depth_override, r.chain_context_json, r.chain_stop_reason,
              r.chain_handled_at,
              a.config_key
       FROM runs r
       JOIN automations a ON a.id = r.automation_id
       ORDER BY r.created_at ASC, r.rowid ASC`
    )
    .all() as Array<{
    id: string;
    automation_id: string;
    parent_run_id: string | null;
    status: string;
    prompt: string | null;
    chain_root_run_id: string | null;
    chain_depth: number | null;
    chain_max_depth: number | null;
    chain_max_depth_override: number | null;
    chain_context_json: string | null;
    chain_stop_reason: string | null;
    chain_handled_at: string | null;
    config_key: string;
  }>;
  if (rootId == null) {
    return rows;
  }
  return rows.filter((r) => r.chain_root_run_id === rootId);
}

function chainSkipped(
  db: Db,
  runId: string
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND event_type = 'run.chain-skipped'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(runId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

function chainEvents(db: Db, runId: string): Array<Record<string, unknown>> {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = 'run.chained'
         ORDER BY seq ASC`
      )
      .all(runId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

async function kickoff(
  env: Env,
  variables: Record<string, string>,
  roleModels: typeof ROLE_MODELS,
  maxDepth = 1
): Promise<string> {
  return env.engine.triggerRun(env.entryAutomationId, "manual", {
    chainContext: { variables, roleModels },
    chainMaxDepth: maxDepth,
    modelSelectionOverride: roleModels.planner,
  });
}

function finalGateEnqueued(
  db: Db,
  runId: string
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND event_type = 'run.pipeline-final-gate-enqueued'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(runId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("b36.03d implement-fully loop simulation", () => {
  it("runs a two-phase feature through nine runs ending in final-gate", async () => {
    const env = await createEnv({ mode: "full" });
    try {
      const budget = computeImplementFullyBudget(2);
      expect(budget).toBe(13);

      const rootId = await kickoff(env, FEATURE_A, ROLE_MODELS);

      await until(() => {
        const pipe = listPipelineRuns(env.db, rootId);
        if (pipe.length < 9) return false;
        const leaf = pipe[8]!;
        return (
          leaf.status === "completed" &&
          workerKeyFromConfigKey(leaf.config_key) === "final-gate"
        );
      });

      const pipe = listPipelineRuns(env.db, rootId);
      expect(pipe).toHaveLength(9);
      expect(listPipelineRuns(env.db)).toHaveLength(9);

      for (let i = 0; i < 8; i++) {
        const run = pipe[i]!;
        expect(workerKeyFromConfigKey(run.config_key)).toBe(WORKER_ORDER[i]);
        expect(run.chain_depth).toBe(i);
        expect(run.status).toBe("completed");
      }
      expect(workerKeyFromConfigKey(pipe[8]!.config_key)).toBe("final-gate");
      expect(pipe[8]!.chain_depth).toBe(8);
      expect(pipe[8]!.status).toBe("completed");

      expect(pipe[0]!.chain_max_depth).toBe(1);
      expect(pipe[0]!.chain_max_depth_override).toBe(13);
      for (let i = 1; i < 9; i++) {
        expect(pipe[i]!.chain_max_depth).toBe(13);
        expect(pipe[i]!.chain_max_depth_override).toBeNull();
      }

      const contextJson = pipe[0]!.chain_context_json!;
      expect(contextJson).toBeTruthy();
      for (const run of pipe) {
        expect(run.chain_context_json).toBe(contextJson);
      }

      expect(pipe[7]!.chain_stop_reason).toBe(
        "complete: no runnable Pending phase left"
      );
      expect(finalGateEnqueued(env.db, pipe[7]!.id)?.stopReason).toBe(
        "complete: no runnable Pending phase left"
      );
      expect(chainSkipped(env.db, pipe[7]!.id)).toBeUndefined();
      expect(pipe[7]!.chain_handled_at).toBeTruthy();

      expect(env.spawns).toHaveLength(9);
      for (const spawn of env.spawns) {
        const role = WORKER_ROLE[spawn.workerKey]!;
        expect(modelSelectionKey(spawn.model)).toBe(
          modelSelectionKey(ROLE_MODELS[role])
        );
        expect(spawn.prompt).toContain(FEATURE_A.featureDir);
        const footerAt = spawn.prompt.indexOf("--- chained from ");
        const templated =
          footerAt === -1 ? spawn.prompt : spawn.prompt.slice(0, footerAt);
        expect(templated).not.toContain("{{");
      }

      for (let i = 1; i < env.spawns.length; i++) {
        if (env.spawns[i]!.workerKey === "final-gate") {
          // Preamble mentions the footer phrase; a real chain footer is absent.
          expect(env.spawns[i]!.prompt).not.toMatch(
            /--- chained from .+ \(run /
          );
          expect(env.spawns[i]!.prompt).toContain("final-gate");
          continue;
        }
        expect(env.spawns[i]!.prompt).toMatch(/--- chained from .+ ---/);
        expect(env.spawns[i]!.prompt).toContain("lca-handoff");
        expect(env.spawns[i]!.prompt).toContain(PARENT_HANDOFF_SUMMARY);
        expect(env.spawns[i]!.prompt).toContain("{{featureDir}}");
        // Surrounding prose must not leak; only the validated packet is appended.
        expect(env.spawns[i]!.prompt).not.toContain(
          "handoff unavailable"
        );
      }
    } finally {
      await destroyEnv(env);
    }
  });

  it("fail-safe: never re-budgeting yields exactly two runs and max-depth skip", async () => {
    const env = await createEnv({ mode: "no-rebudget" });
    try {
      const rootId = await kickoff(env, FEATURE_A, ROLE_MODELS);

      await until(() => {
        const pipe = listPipelineRuns(env.db, rootId);
        if (pipe.length < 2) return false;
        const leaf = pipe[1]!;
        return (
          leaf.status === "completed" &&
          chainSkipped(env.db, leaf.id)?.reason === "max-depth"
        );
      });

      const pipe = listPipelineRuns(env.db, rootId);
      expect(pipe).toHaveLength(2);
      expect(workerKeyFromConfigKey(pipe[0]!.config_key)).toBe("plan-skeleton");
      expect(workerKeyFromConfigKey(pipe[1]!.config_key)).toBe("plan-phase");
      expect(pipe[0]!.chain_max_depth).toBe(1);
      expect(pipe[0]!.chain_max_depth_override).toBeNull();
      expect(pipe[1]!.chain_max_depth).toBe(1);

      const skip = chainSkipped(env.db, pipe[1]!.id)!;
      expect(skip.reason).toBe("max-depth");
      expect(skip.maxDepth).toBe(1);
      expect(skip.depth).toBe(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("stop with deadlock: reason skips without a successor", async () => {
    const env = await createEnv({ mode: "deadlock-stop" });
    try {
      const rootId = await kickoff(env, FEATURE_A, ROLE_MODELS);

      await until(() => {
        const pipe = listPipelineRuns(env.db, rootId);
        if (pipe.length < 8) return false;
        const leaf = pipe[7]!;
        return chainSkipped(env.db, leaf.id)?.reason === "stopped";
      });

      const pipe = listPipelineRuns(env.db, rootId);
      expect(pipe).toHaveLength(8);
      const skip = chainSkipped(env.db, pipe[7]!.id)!;
      expect(skip.reason).toBe("stopped");
      expect(skip.detail).toBe("deadlock: two phases blocked on mutual deps");
      expect(
        listPipelineRuns(env.db).filter((r) => r.parent_run_id === pipe[7]!.id)
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("failed implement halts the pipeline with no review successor", async () => {
    const env = await createEnv({ mode: "fail-implement" });
    try {
      const rootId = await kickoff(env, FEATURE_A, ROLE_MODELS);

      await until(() => {
        const pipe = listPipelineRuns(env.db, rootId);
        const implement = pipe.find(
          (r) => workerKeyFromConfigKey(r.config_key) === "implement"
        );
        return implement?.status === "failed";
      });

      // Let the chain runner record the halt (status-mismatch); no successor.
      await until(() => {
        const pipe = listPipelineRuns(env.db, rootId);
        const implement = pipe.find(
          (r) => workerKeyFromConfigKey(r.config_key) === "implement"
        )!;
        return (
          implement.status === "failed" &&
          chainEvents(env.db, implement.id).length === 0 &&
          chainSkipped(env.db, implement.id)?.reason === "status-mismatch"
        );
      });

      const pipe = listPipelineRuns(env.db, rootId);
      expect(pipe.map((r) => workerKeyFromConfigKey(r.config_key))).toEqual([
        "plan-skeleton",
        "plan-phase",
        "implement",
      ]);
      expect(pipe[2]!.status).toBe("failed");
      expect(
        pipe.some((r) => workerKeyFromConfigKey(r.config_key) === "review")
      ).toBe(false);
      expect(chainEvents(env.db, pipe[2]!.id)).toHaveLength(0);
      expect(chainSkipped(env.db, pipe[2]!.id)?.reason).toBe("status-mismatch");
      expect(pipe[2]!.chain_handled_at).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("isolates two concurrent pipelines sharing the seven workers", async () => {
    const budgetA = computeImplementFullyBudget(2);
    const budgetB = computeImplementFullyBudget(3);
    const env = await createEnv({
      mode: "full",
      budgetByFeatureSlug: {
        [FEATURE_A.featureSlug]: budgetA,
        [FEATURE_B.featureSlug]: budgetB,
      },
    });
    try {
      const rootA = await kickoff(env, FEATURE_A, ROLE_MODELS);
      const rootB = await kickoff(env, FEATURE_B, ALT_ROLE_MODELS);

      await until(() => {
        const a = listPipelineRuns(env.db, rootA);
        const b = listPipelineRuns(env.db, rootB);
        const aDone =
          a.length === 9 &&
          workerKeyFromConfigKey(a[8]!.config_key) === "final-gate" &&
          a[8]!.status === "completed";
        const bDone =
          b.length === 9 &&
          workerKeyFromConfigKey(b[8]!.config_key) === "final-gate" &&
          b[8]!.status === "completed";
        return aDone && bDone;
      }, 30_000);

      const pipeA = listPipelineRuns(env.db, rootA);
      const pipeB = listPipelineRuns(env.db, rootB);
      expect(pipeA).toHaveLength(9);
      expect(pipeB).toHaveLength(9);

      const ctxA = pipeA[0]!.chain_context_json!;
      const ctxB = pipeB[0]!.chain_context_json!;
      expect(ctxA).not.toBe(ctxB);
      for (const run of pipeA) {
        expect(run.chain_context_json).toBe(ctxA);
        expect(run.prompt).toContain(FEATURE_A.featureDir);
        expect(run.prompt).not.toContain(FEATURE_B.featureDir);
      }
      for (const run of pipeB) {
        expect(run.chain_context_json).toBe(ctxB);
        expect(run.prompt).toContain(FEATURE_B.featureDir);
        expect(run.prompt).not.toContain(FEATURE_A.featureDir);
      }

      expect(pipeA[0]!.chain_max_depth_override).toBe(budgetA);
      expect(pipeB[0]!.chain_max_depth_override).toBe(budgetB);
      for (const run of pipeA.slice(1)) {
        expect(run.chain_max_depth).toBe(budgetA);
      }
      for (const run of pipeB.slice(1)) {
        expect(run.chain_max_depth).toBe(budgetB);
      }

      const spawnsA = env.spawns.filter((s) =>
        pipeA.some((r) => r.id === s.runId)
      );
      const spawnsB = env.spawns.filter((s) =>
        pipeB.some((r) => r.id === s.runId)
      );
      expect(spawnsA).toHaveLength(9);
      expect(spawnsB).toHaveLength(9);
      const spawnRoots = env.spawns.map((spawn) =>
        pipeA.some((run) => run.id === spawn.runId) ? "A" : "B"
      );
      expect(spawnRoots.indexOf("A")).toBeLessThan(spawnRoots.lastIndexOf("B"));
      expect(spawnRoots.indexOf("B")).toBeLessThan(spawnRoots.lastIndexOf("A"));

      for (const spawn of spawnsA) {
        const role = WORKER_ROLE[spawn.workerKey]!;
        expect(modelSelectionKey(spawn.model)).toBe(
          modelSelectionKey(ROLE_MODELS[role])
        );
      }
      for (const spawn of spawnsB) {
        const role = WORKER_ROLE[spawn.workerKey]!;
        expect(modelSelectionKey(spawn.model)).toBe(
          modelSelectionKey(ALT_ROLE_MODELS[role])
        );
      }

      expect(finalGateEnqueued(env.db, pipeA[7]!.id)?.stopReason).toMatch(
        /^complete:/
      );
      expect(finalGateEnqueued(env.db, pipeB[7]!.id)?.stopReason).toMatch(
        /^complete:/
      );
    } finally {
      await destroyEnv(env);
    }
  });
});
