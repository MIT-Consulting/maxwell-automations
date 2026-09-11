import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import {
  CHAIN_VALUE_MAX_LENGTH,
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  DEFAULT_ROLE_MODEL_PROFILE_ID,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_VARIABLES,
  assertVariablesMatchRequired,
  buildKickoffVariables,
  findActivePipelineBlocker,
  requiredRolesFromWorkers,
  resolveRoleRecipe,
  validateFeatureSlugIdea,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
} from "@lca/shared";
import { assembleKickoffPayload } from "../packages/dashboard/src/pipelineKickoff.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";

type Db = ReturnType<typeof openDatabase>;

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
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");
  return workspaceId;
}

describe("b36.05c dashboard kickoff parity", () => {
  it("rejects slug not starting with feature id and over-long ideas", () => {
    expect(() =>
      validateFeatureSlugIdea("feature-42", "b42-x", "idea")
    ).toThrow(/Invalid --feature/);
    expect(() => validateFeatureSlugIdea("b42", "b42-Bad", "idea")).toThrow(
      /Invalid --slug/
    );
    expect(() =>
      validateFeatureSlugIdea("b42", "b99-other", "idea")
    ).toThrow(/must start with "b42-"/);
    const over = "x".repeat(CHAIN_VALUE_MAX_LENGTH + 1);
    expect(() => validateFeatureSlugIdea("b42", "b42-x", over)).toThrow(
      new RegExp(`${CHAIN_VALUE_MAX_LENGTH + 1} bytes.*${CHAIN_VALUE_MAX_LENGTH}`)
    );
  });

  it("derives ten variables with forward slashes and Quick/JIT defaults", () => {
    const vars = buildKickoffVariables("b42", "b42-my-feature", "an idea");
    expect(vars).toEqual({
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b42",
      featureSlug: "b42-my-feature",
      featureDir: "docs/roadmap/b42-my-feature",
      featureIndex: "docs/roadmap/b42-my-feature/00-index.md",
      idea: "an idea",
      planningDepth: "jit",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode: "normal",
    });
    expect(vars.featureDir.includes("\\")).toBe(false);
  });

  it("fails variable key mismatch and unresolved roles", () => {
    const vars = buildKickoffVariables("b42", "b42-x", "idea");
    expect(() =>
      assertVariablesMatchRequired(vars, [...IMPLEMENT_FULLY_VARIABLES, "extra"])
    ).toThrow(/Variable key mismatch/);
    expect(() =>
      assertVariablesMatchRequired(
        vars,
        IMPLEMENT_FULLY_VARIABLES.filter((key) => key !== "idea")
      )
    ).toThrow(/Variable key mismatch/);

    expect(() =>
      resolveRoleRecipe(
        ["planner", "reviewer"],
        { planner: "p" },
        { planner: { id: "ignored" } }
      )
    ).toThrow(/Unresolved pipeline role\(s\): reviewer/);
  });

  it("lets override beat default and preserves b35 params on defaults", () => {
    const recipe = resolveRoleRecipe(
      ["planner", "implementer"],
      { planner: "override-planner" },
      {
        planner: { id: "d-planner" },
        implementer: {
          id: "d-impl",
          params: [{ id: "fast", value: "true" }],
        },
      }
    );
    expect(recipe.roleModels.planner).toEqual({ id: "override-planner" });
    expect(recipe.sources.planner).toBe("override");
    expect(recipe.roleModels.implementer).toEqual({
      id: "d-impl",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("active-pipeline guard names a non-terminal provisioned run", () => {
    const ids = new Set(["ws::generated:plan-skeleton", "ws::generated:implement"]);
    const blocker = findActivePipelineBlocker(
      [
        {
          id: "run-1",
          automationId: "ws::generated:implement",
          status: "running",
        },
      ],
      ids
    );
    expect(blocker?.id).toBe("run-1");

    expect(
      findActivePipelineBlocker(
        [
          {
            id: "done",
            automationId: "ws::generated:implement",
            status: "completed",
          },
        ],
        ids
      )
    ).toBeNull();

    expect(
      findActivePipelineBlocker(
        [
          {
            id: "other",
            automationId: "unrelated",
            status: "running",
          },
        ],
        ids
      )
    ).toBeNull();
  });

  it("assembles kickoff payload with maxDepth 1 and plan automation id", () => {
    const introspection: PipelineIntrospectionResponse = {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      entryWorkerKey: "plan-skeleton",
      entryWorkerConfigKey: "generated:plan-skeleton",
      roleContract: {
        required: ["planner", "implementer", "reviewer", "docs"],
        optional: ["researcher", "gatekeeper", "architect"],
        conditionalEntryRole: "researcher",
        conditionalEntryWorkerKey: "research",
        fallbackRole: "gatekeeper",
        fallbackToRole: "reviewer",
        skeletonFallbackRole: "architect",
        skeletonFallbackToRole: "planner",
      },
      requiredVariables: IMPLEMENT_FULLY_VARIABLES,
      requiredSkills: [],
      budgetFormula: "6 × phaseCount + 1",
      executeBudgetFormula: "3 × phaseCount + 2",
      workers: [
        {
          key: "plan-skeleton",
          name: "Plan skeleton",
          modelRole: "planner",
          chain: { next: "plan-phase", when: "completed" },
        },
        {
          key: "plan-phase",
          name: "Plan phase",
          modelRole: "planner",
          chain: { next: "implement", when: "completed" },
        },
        {
          key: "implement",
          name: "Implement",
          modelRole: "implementer",
          chain: { next: "review", when: "completed" },
        },
        {
          key: "review",
          name: "Review",
          modelRole: "reviewer",
          chain: { next: "update-docs", when: "completed" },
        },
        {
          key: "update-docs",
          name: "Update docs",
          modelRole: "docs",
          chain: { next: "plan-phase", when: "completed" },
        },
      ],
      roleDefaults: {
        planner: { id: "planner-model" },
        implementer: { id: "implementer-model" },
        reviewer: { id: "reviewer-model" },
        docs: { id: "docs-model" },
      },
      roleModelProfiles: [
        {
          id: DEFAULT_ROLE_MODEL_PROFILE_ID,
          label: "Default",
          roleModels: {
            planner: { id: "planner-model" },
            implementer: { id: "implementer-model" },
            reviewer: { id: "reviewer-model" },
            docs: { id: "docs-model" },
          },
        },
      ],
      defaultRoleModelProfileId: DEFAULT_ROLE_MODEL_PROFILE_ID,
      planningProfiles: [...IMPLEMENT_FULLY_PLANNING_PROFILES],
      defaultPlanningProfileId: DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
    };
    const plan: ProvisionPipelineWorkersResponse = {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      missingSkills: [],
      plan: {
        workspaceId: "ws",
        dryRun: true,
        applied: false,
        items: [
          {
            key: "plan-skeleton",
            configKey: "generated:plan-skeleton",
            automationId: "ws::generated:plan-skeleton",
            action: "unchanged",
          },
        ],
      },
    };
    const roles = requiredRolesFromWorkers(introspection.workers);
    expect(roles).toEqual(["planner", "implementer", "reviewer", "docs"]);

    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b42",
      slug: "b42-demo",
      idea: "ship it",
      roleOverrides: {},
    });
    expect(payload.maxDepth).toBe(1);
    expect(payload.automationId).toBe("ws::generated:plan-skeleton");
    expect(Object.keys(payload.variables ?? {}).sort()).toEqual(
      [...IMPLEMENT_FULLY_VARIABLES].sort()
    );
    expect(payload.variables).toEqual({
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b42",
      featureSlug: "b42-demo",
      featureDir: "docs/roadmap/b42-demo",
      featureIndex: "docs/roadmap/b42-demo/00-index.md",
      idea: "ship it",
      planningDepth: "jit",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode: "normal",
    });
    expect(payload.roleModels).toEqual({
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
      docs: { id: "docs-model" },
    });
    expect(payload.modelSelection).toEqual({ id: "planner-model" });
  });

  it("introspection preconditions are additive and accurate", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-5c-pre-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);

    mkdirSync(join(workspacePath, ".git"));
    mkdirSync(join(workspacePath, "docs", "roadmap"), { recursive: true });
    writeFileSync(join(workspacePath, "docs", "roadmap", "00-index.md"), "#\n");

    const events = new DaemonEventBus();
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub,
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const triggers = new TriggerManager(db, engine, { port });
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      triggers,
    });

    try {
      const withWs = await fetch(
        `http://127.0.0.1:${port}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      expect(withWs.status).toBe(200);
      const body = (await withWs.json()) as PipelineIntrospectionResponse;
      expect(body.preconditions).toEqual({
        workspaceId,
        gitRepo: true,
        roadmapIndex: true,
      });

      rmSync(join(workspacePath, ".git"), { recursive: true, force: true });
      const noGit = await fetch(
        `http://127.0.0.1:${port}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      const noGitBody = (await noGit.json()) as PipelineIntrospectionResponse;
      expect(noGitBody.preconditions?.gitRepo).toBe(false);
      expect(noGitBody.preconditions?.roadmapIndex).toBe(true);

      rmSync(join(workspacePath, "docs", "roadmap", "00-index.md"));
      mkdirSync(join(workspacePath, ".git"));
      const noIndex = await fetch(
        `http://127.0.0.1:${port}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      const noIndexBody = (await noIndex.json()) as PipelineIntrospectionResponse;
      expect(noIndexBody.preconditions?.gitRepo).toBe(true);
      expect(noIndexBody.preconditions?.roadmapIndex).toBe(false);

      const bad = await fetch(
        `http://127.0.0.1:${port}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}?workspaceId=missing-ws`
      );
      expect(bad.status).toBe(400);

      const plain = await fetch(
        `http://127.0.0.1:${port}/api/pipelines/${IMPLEMENT_FULLY_PIPELINE_ID}`
      );
      expect(plain.status).toBe(200);
      const plainBody = (await plain.json()) as Record<string, unknown>;
      expect("preconditions" in plainBody).toBe(false);
      const withWsWithoutPreconditions = { ...body };
      delete withWsWithoutPreconditions.preconditions;
      expect(plainBody).toEqual(withWsWithoutPreconditions);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
