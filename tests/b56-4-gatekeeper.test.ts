import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type Automation,
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
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import {
  ChainRunner,
  resolveChildModelRole,
} from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  collectPipelineDoctorFacts,
  formatPipelineBlockLines,
} from "../packages/cli/src/doctor.ts";
import { selectionFromStored } from "../packages/daemon/src/models/selection-persist.ts";

type Db = ReturnType<typeof openDatabase>;

const FOUR_ROLE_CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b56",
    featureSlug: "b56-optional-researcher-gatekeeper",
    featureDir: "docs/roadmap/done/b56-optional-researcher-gatekeeper",
    featureIndex: "docs/roadmap/done/b56-optional-researcher-gatekeeper/00-index.md",
    idea: "gatekeeper terminal ownership",
    planningDepth: "jit",
    approvalPolicy: "none",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: {
      id: "reviewer-model",
      params: [{ id: "thinking", value: "high" }],
    },
    docs: { id: "docs-model" },
  },
};

const SIX_ROLE_CONTEXT: ChainRunContext = {
  ...FOUR_ROLE_CONTEXT,
  roleModels: {
    ...FOUR_ROLE_CONTEXT.roleModels,
    researcher: { id: "researcher-model" },
    gatekeeper: {
      id: "gatekeeper-model",
      params: [{ id: "thinking", value: "max" }],
    },
  },
};

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
  const root = mkdtempSync(join(tmpdir(), "lca-b56-4-gate-"));
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
    chainContext: opts.chainContext ?? FOUR_ROLE_CONTEXT,
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

function childRuns(
  db: Db,
  parentId: string
): Array<{ id: string; config_key: string }> {
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

function doctorSnapshot(
  workerKey: string,
  chainContext: ChainRunContext | null | "corrupt"
): RunSnapshot {
  const configKey = `${GENERATED_CONFIG_KEY_PREFIX}${workerKey}`;
  let chain_context_json: string | null;
  if (chainContext === "corrupt") {
    chain_context_json = "{not-json";
  } else if (chainContext == null) {
    chain_context_json = null;
  } else {
    chain_context_json = JSON.stringify(chainContext);
  }
  return {
    run: {
      id: "gate-run-aaaaaaaa",
      status: "completed",
      automation_id: `ws::${configKey}`,
      workspace_id: "ws-1",
      trigger_kind: "chain",
      agent_id: null,
      sdk_run_id: null,
      prompt: null,
      title: null,
      summary: null,
      started_at: "2026-08-08 12:00:00",
      ended_at: "2026-08-08 12:01:00",
      created_at: "2026-08-08 12:00:00",
      chain_root_run_id: "root-bbbbbbbb",
      chain_depth: 7,
      chain_max_depth: 13,
      chain_context_json,
      chain_handled_at: null,
    },
    events: [],
    inputRequests: [],
  };
}

function doctorAutomation(workerKey: string): Automation {
  const configKey = `${GENERATED_CONFIG_KEY_PREFIX}${workerKey}`;
  return {
    id: `ws::${configKey}`,
    workspaceId: "ws-1",
    name: workerKey,
    enabled: true,
    status: "enabled",
    origin: "generated",
    trigger: { type: "manual" },
    prompt: "x",
    model: null,
    modelSelection: null,
    modelRole: workerKey === "final-gate" ? "gatekeeper" : "reviewer",
    chain: null,
    configPath: "generated.yaml",
    configKey,
    archivedAt: null,
    createdAt: "2026-08-08 12:00:00",
    updatedAt: "2026-08-08 12:00:00",
  };
}

describe("b56.04 catalog", () => {
  it("makes final-gate the only gatekeeper-owned worker", () => {
    expect(IMPLEMENT_FULLY_WORKERS).toHaveLength(8);
    expect(IMPLEMENT_FULLY_WORKERS.map((w) => w.key)).toEqual([
      "plan-skeleton",
      "plan-phase",
      "implement",
      "review",
      "docs-commit",
      "integrate-wave",
      "final-gate",
      "research",
    ]);
    const gatekeepers = IMPLEMENT_FULLY_WORKERS.filter(
      (w) => w.modelRole === "gatekeeper"
    );
    expect(gatekeepers).toHaveLength(1);
    expect(gatekeepers[0]!.key).toBe(IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY);
    expect(gatekeepers[0]!.chain).toBeNull();

    const review = IMPLEMENT_FULLY_WORKERS.find((w) => w.key === "review")!;
    const integrate = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === "integrate-wave"
    )!;
    expect(review.modelRole).toBe("reviewer");
    expect(integrate.modelRole).toBe("reviewer");
  });
});

describe("b56.04 final-gate ownership", () => {
  it("enqueues an explicit gatekeeper with structured params", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-explicit",
        stopReason: "complete: no runnable Pending phase left",
        chainContext: SIX_ROLE_CONTEXT,
      });
      await env.chainRunner.handleTerminal("pp-explicit", "completed");

      const children = childRuns(env.db, "pp-explicit");
      expect(children).toHaveLength(1);
      expect(children[0]!.config_key).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}final-gate`
      );
      const gate = env.store.getRun(children[0]!.id)!;
      expect(
        selectionFromStored(gate.model, gate.model_params_json)
      ).toEqual({
        id: "gatekeeper-model",
        params: [{ id: "thinking", value: "max" }],
      });

      const enqueued = eventPayload(
        env.db,
        "pp-explicit",
        "run.pipeline-final-gate-enqueued"
      );
      expect(enqueued?.childRunId).toBe(children[0]!.id);
      expect(enqueued?.stopReason).toBe(
        "complete: no runnable Pending phase left"
      );
      expect(enqueued?.gatekeeperSource).toBe("explicit");
      expect(enqueued?.modelRole).toBe("gatekeeper");
      expect(enqueued?.modelRoleResolved).toBe(true);
    } finally {
      await destroyEnv(env);
    }
  });

  it("falls back to the concrete reviewer selection for four-role contexts", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-fallback",
        stopReason: "complete: no runnable Pending phase left",
        chainContext: FOUR_ROLE_CONTEXT,
      });
      await env.chainRunner.handleTerminal("pp-fallback", "completed");

      const children = childRuns(env.db, "pp-fallback");
      expect(children).toHaveLength(1);
      const gate = env.store.getRun(children[0]!.id)!;
      expect(
        selectionFromStored(gate.model, gate.model_params_json)
      ).toEqual({
        id: "reviewer-model",
        params: [{ id: "thinking", value: "high" }],
      });

      const enqueued = eventPayload(
        env.db,
        "pp-fallback",
        "run.pipeline-final-gate-enqueued"
      );
      expect(enqueued?.childRunId).toBe(children[0]!.id);
      expect(enqueued?.stopReason).toBe(
        "complete: no runnable Pending phase left"
      );
      expect(enqueued?.gatekeeperSource).toBe("reviewer-fallback");
      expect(enqueued?.modelRoleResolved).toBe(true);
    } finally {
      await destroyEnv(env);
    }
  });

  it("keeps review and integrate-wave on reviewer when a gatekeeper is configured", async () => {
    const env = await createEnv();
    try {
      for (const key of ["review", "integrate-wave"] as const) {
        const target = env.store.getAutomation(
          automationId(env.workspaceId, `${GENERATED_CONFIG_KEY_PREFIX}${key}`)
        )!;
        expect(target.model_role).toBe("reviewer");
        const resolved = resolveChildModelRole(
          true,
          SIX_ROLE_CONTEXT,
          target,
          () => {}
        );
        expect(resolved.modelRoleResolved).toBe(true);
        expect(resolved.modelSelectionOverride).toEqual(
          SIX_ROLE_CONTEXT.roleModels.reviewer
        );
        expect(resolved.gatekeeperSource).toBeNull();
      }
    } finally {
      await destroyEnv(env);
    }
  });

  it("resolves a stale reviewer-owned final-gate row through the ordinary path", async () => {
    const env = await createEnv();
    try {
      const target = env.store.getAutomation(
        automationId(
          env.workspaceId,
          `${GENERATED_CONFIG_KEY_PREFIX}final-gate`
        )
      )!;
      const stale = { ...target, model_role: "reviewer" };
      const resolved = resolveChildModelRole(
        true,
        SIX_ROLE_CONTEXT,
        stale,
        () => {}
      );
      expect(resolved.modelRole).toBe("reviewer");
      expect(resolved.modelRoleResolved).toBe(true);
      expect(resolved.modelSelectionOverride).toEqual(
        SIX_ROLE_CONTEXT.roleModels.reviewer
      );
      expect(resolved.gatekeeperSource).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("enqueues exactly one final-gate across duplicate terminal deliveries", async () => {
    const env = await createEnv();
    try {
      seedPlanPhaseRun(env, {
        id: "pp-once",
        stopReason: "complete: done",
        chainContext: SIX_ROLE_CONTEXT,
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

describe("b56.04 doctor gate line", () => {
  it("prints explicit and reviewer-fallback gate lines for final-gate", () => {
    const explicitFacts = collectPipelineDoctorFacts(
      doctorSnapshot("final-gate", SIX_ROLE_CONTEXT),
      doctorAutomation("final-gate")
    );
    expect(explicitFacts).not.toBeNull();
    expect(explicitFacts!.gatekeeperModelId).toBe("gatekeeper-model");
    expect(explicitFacts!.gatekeeperSource).toBe("explicit");
    const explicitBlock = formatPipelineBlockLines(explicitFacts!).join("\n");
    expect(explicitBlock).toContain(
      "gate:       gatekeeper=gatekeeper-model (explicit)"
    );

    const fallbackFacts = collectPipelineDoctorFacts(
      doctorSnapshot("final-gate", FOUR_ROLE_CONTEXT),
      doctorAutomation("final-gate")
    );
    expect(fallbackFacts).not.toBeNull();
    expect(fallbackFacts!.gatekeeperModelId).toBe("reviewer-model");
    expect(fallbackFacts!.gatekeeperSource).toBe("reviewer-fallback");
    const fallbackBlock = formatPipelineBlockLines(fallbackFacts!).join("\n");
    expect(fallbackBlock).toContain(
      "gate:       gatekeeper=reviewer-model (reviewer fallback)"
    );
  });

  it("omits the gate line for non-final-gate workers and missing context", () => {
    const reviewFacts = collectPipelineDoctorFacts(
      doctorSnapshot("review", SIX_ROLE_CONTEXT),
      doctorAutomation("review")
    );
    expect(reviewFacts!.gatekeeperModelId).toBeNull();
    expect(reviewFacts!.gatekeeperSource).toBeNull();
    expect(formatPipelineBlockLines(reviewFacts!).join("\n")).not.toMatch(
      /^\s*gate:/m
    );

    const missingFacts = collectPipelineDoctorFacts(
      doctorSnapshot("final-gate", null),
      doctorAutomation("final-gate")
    );
    expect(missingFacts!.gatekeeperModelId).toBeNull();
    expect(formatPipelineBlockLines(missingFacts!).join("\n")).not.toMatch(
      /^\s*gate:/m
    );

    const corruptFacts = collectPipelineDoctorFacts(
      doctorSnapshot("final-gate", "corrupt"),
      doctorAutomation("final-gate")
    );
    expect(corruptFacts!.gatekeeperModelId).toBeNull();
    expect(formatPipelineBlockLines(corruptFacts!).join("\n")).not.toMatch(
      /^\s*gate:/m
    );
  });
});
