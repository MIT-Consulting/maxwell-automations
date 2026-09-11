import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { resolveChildModelRole } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  collectPipelineDoctorFacts,
  formatPipelineBlockLines,
} from "../packages/cli/src/doctor.ts";

type Db = ReturnType<typeof openDatabase>;

const FOUR_ROLE_CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b59",
    featureSlug: "b59-architect-role-split",
    featureDir: "docs/roadmap/done/b59-architect-role-split",
    featureIndex: "docs/roadmap/done/b59-architect-role-split/00-index.md",
    idea: "architect/planner role split",
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
    architect: {
      id: "architect-model",
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
};

async function createEnv(): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b59-2-arch-"));
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
  await engine.shutdown();
  return { root, workspaceId, db, store };
}

async function destroyEnv(env: Env): Promise<void> {
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function planSkeletonAutomation(env: Env) {
  return env.store.getAutomation(
    automationId(
      env.workspaceId,
      `${GENERATED_CONFIG_KEY_PREFIX}plan-skeleton`
    )
  )!;
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
      id: "arch-run-aaaaaaaa",
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
      chain_depth: 0,
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
    modelRole: workerKey === "plan-skeleton" ? "architect" : "planner",
    chain: null,
    configPath: "generated.yaml",
    configKey,
    archivedAt: null,
    createdAt: "2026-08-08 12:00:00",
    updatedAt: "2026-08-08 12:00:00",
  };
}

describe("b59.2 catalog", () => {
  it("makes plan-skeleton the only architect-owned worker", () => {
    const architects = IMPLEMENT_FULLY_WORKERS.filter(
      (w) => w.modelRole === "architect"
    );
    expect(architects).toHaveLength(1);
    expect(architects[0]!.key).toBe("plan-skeleton");

    const planPhase = IMPLEMENT_FULLY_WORKERS.find((w) => w.key === "plan-phase")!;
    expect(planPhase.modelRole).toBe("planner");
  });
});

describe("b59.2 plan-skeleton ownership", () => {
  it("applies explicit architect selection when configured", async () => {
    const env = await createEnv();
    try {
      const target = planSkeletonAutomation(env);
      expect(target.model_role).toBe("architect");
      const resolved = resolveChildModelRole(
        true,
        SIX_ROLE_CONTEXT,
        target,
        () => {}
      );
      expect(resolved.modelRoleResolved).toBe(true);
      expect(resolved.modelSelectionOverride).toEqual(
        SIX_ROLE_CONTEXT.roleModels.architect
      );
      expect(resolved.architectSource).toBe("explicit");
      expect(resolved.gatekeeperSource).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("falls back to the concrete planner selection for four-role contexts", async () => {
    const env = await createEnv();
    try {
      const target = planSkeletonAutomation(env);
      const resolved = resolveChildModelRole(
        true,
        FOUR_ROLE_CONTEXT,
        target,
        () => {}
      );
      expect(resolved.modelRoleResolved).toBe(true);
      expect(resolved.modelSelectionOverride).toEqual(
        FOUR_ROLE_CONTEXT.roleModels.planner
      );
      expect(resolved.architectSource).toBe("planner-fallback");
      expect(resolved.gatekeeperSource).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("resolves a stale planner-owned plan-skeleton row through the ordinary path", async () => {
    const env = await createEnv();
    try {
      const target = planSkeletonAutomation(env);
      const stale = { ...target, model_role: "planner" };
      const resolved = resolveChildModelRole(
        true,
        SIX_ROLE_CONTEXT,
        stale,
        () => {}
      );
      expect(resolved.modelRole).toBe("planner");
      expect(resolved.modelRoleResolved).toBe(true);
      expect(resolved.modelSelectionOverride).toEqual(
        SIX_ROLE_CONTEXT.roleModels.planner
      );
      expect(resolved.architectSource).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });
});

describe("b59.2 doctor architect line", () => {
  it("prints explicit and planner-fallback architect lines for plan-skeleton", () => {
    const explicitFacts = collectPipelineDoctorFacts(
      doctorSnapshot("plan-skeleton", SIX_ROLE_CONTEXT),
      doctorAutomation("plan-skeleton")
    );
    expect(explicitFacts).not.toBeNull();
    expect(explicitFacts!.architectModelId).toBe("architect-model");
    expect(explicitFacts!.architectSource).toBe("explicit");
    const explicitBlock = formatPipelineBlockLines(explicitFacts!).join("\n");
    expect(explicitBlock).toContain(
      "architect:  architect=architect-model (explicit)"
    );

    const fallbackFacts = collectPipelineDoctorFacts(
      doctorSnapshot("plan-skeleton", FOUR_ROLE_CONTEXT),
      doctorAutomation("plan-skeleton")
    );
    expect(fallbackFacts).not.toBeNull();
    expect(fallbackFacts!.architectModelId).toBe("planner-model");
    expect(fallbackFacts!.architectSource).toBe("planner-fallback");
    const fallbackBlock = formatPipelineBlockLines(fallbackFacts!).join("\n");
    expect(fallbackBlock).toContain(
      "architect:  architect=planner-model (planner fallback)"
    );
  });

  it("omits the architect line for non-plan-skeleton workers and missing context", () => {
    const planPhaseFacts = collectPipelineDoctorFacts(
      doctorSnapshot("plan-phase", SIX_ROLE_CONTEXT),
      doctorAutomation("plan-phase")
    );
    expect(planPhaseFacts!.architectModelId).toBeNull();
    expect(planPhaseFacts!.architectSource).toBeNull();
    expect(formatPipelineBlockLines(planPhaseFacts!).join("\n")).not.toMatch(
      /^\s*architect:/m
    );

    const missingFacts = collectPipelineDoctorFacts(
      doctorSnapshot("plan-skeleton", null),
      doctorAutomation("plan-skeleton")
    );
    expect(missingFacts!.architectModelId).toBeNull();
    expect(formatPipelineBlockLines(missingFacts!).join("\n")).not.toMatch(
      /^\s*architect:/m
    );

    const corruptFacts = collectPipelineDoctorFacts(
      doctorSnapshot("plan-skeleton", "corrupt"),
      doctorAutomation("plan-skeleton")
    );
    expect(corruptFacts!.architectModelId).toBeNull();
    expect(formatPipelineBlockLines(corruptFacts!).join("\n")).not.toMatch(
      /^\s*architect:/m
    );
  });
});
