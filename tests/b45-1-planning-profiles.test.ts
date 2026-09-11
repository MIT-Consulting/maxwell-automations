import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_VARIABLES,
  KickoffError,
  buildKickoffVariables,
  normalizeImplementFullyChainVariables,
  resolvePlanningControls,
  resolvePlanningProfile,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
} from "@lca/shared";
import { DaemonClient } from "../packages/cli/src/client.ts";
import {
  cmdImplementFully,
  parseImplementFullyArgs,
} from "../packages/cli/src/implement-fully.ts";
import { assembleKickoffPayload } from "../packages/dashboard/src/pipelineKickoff.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import {
  DEFAULT_SETTINGS,
  type ResolvedSettings,
} from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  IMPLEMENT_FULLY_DEFINITION,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_WORKERS,
  toPipelineIntrospection,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine, TriggerRunValidationError } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
});

type Db = ReturnType<typeof openDatabase>;

const ROLE_DEFAULTS: ResolvedSettings["pipelineRoleModels"] = {
  planner: { id: "planner-default" },
  implementer: { id: "implementer-default" },
  reviewer: { id: "reviewer-default" },
  docs: { id: "docs-default" },
};

const DOCUMENTED_FEATURE_ID = "b45";
const DOCUMENTED_SLUG = "b45-configurable-implement-fully-planning";
const DOCUMENTED_IDEA =
  "Configurable planning profiles. Prior art: docs/roadmap/b45-configurable-implement-fully-planning.md.";

const PROFILE_CASES = [
  {
    id: "quick",
    planningDepth: "jit",
    approvalPolicy: "none",
    label: "Quick/JIT",
  },
  {
    id: "deep",
    planningDepth: "full",
    approvalPolicy: "none",
    label: "Deep",
  },
  {
    id: "guided",
    planningDepth: "full",
    approvalPolicy: "before-implementation",
    label: "Guided",
  },
] as const;

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

function writeRoadmapIndex(workspacePath: string): void {
  const index = join(workspacePath, "docs", "roadmap", "00-index.md");
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(
    index,
    [
      "# Roadmap",
      "",
      "<!-- next: b99 -->",
      "",
      "## Backlog",
      "",
      `- **${DOCUMENTED_FEATURE_ID}** Configurable planning. — [docs](./${DOCUMENTED_SLUG}/00-index.md)`,
      "",
    ].join("\n"),
    "utf8"
  );
  const featureDir = join(workspacePath, "docs", "roadmap", DOCUMENTED_SLUG);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, "00-index.md"), "# b45\n", "utf8");
  writeFileSync(join(featureDir, "prd.md"), "# prd\n", "utf8");
}

function seedWorkspaceDisk(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  writeRoadmapIndex(workspacePath);
}

async function withServer(
  run: (args: {
    port: number;
    db: Db;
    workspacePath: string;
    workspaceId: string;
    client: DaemonClient;
    engine: RunEngine;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b45-1-"));
  const workspacePath = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  seedWorkspaceDisk(workspacePath);
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");

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
  const settings: ResolvedSettings = {
    ...DEFAULT_SETTINGS,
    pipelineRoleModels: ROLE_DEFAULTS,
  };
  const http = await startHttpServer({
    engine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "test",
    port,
    settings,
    triggers,
  });
  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  try {
    await run({ port, db, workspacePath, workspaceId, client, engine });
  } finally {
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b45.1 shared planning profile contract", () => {
  it("maps all three profiles and defaults omitted id to Quick/JIT", () => {
    for (const c of PROFILE_CASES) {
      const profile = resolvePlanningProfile(c.id);
      expect(profile.label).toBe(c.label);
      expect(profile.planningDepth).toBe(c.planningDepth);
      expect(profile.approvalPolicy).toBe(c.approvalPolicy);
      expect(resolvePlanningControls(c.id)).toEqual({
        planningDepth: c.planningDepth,
        approvalPolicy: c.approvalPolicy,
      });
      expect(
        buildKickoffVariables(
          DOCUMENTED_FEATURE_ID,
          DOCUMENTED_SLUG,
          DOCUMENTED_IDEA,
          c.id
        )
      ).toMatchObject({
        planningDepth: c.planningDepth,
        approvalPolicy: c.approvalPolicy,
      });
    }

    expect(DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID).toBe("quick");
    expect(resolvePlanningProfile()).toEqual(resolvePlanningProfile("quick"));
    expect(
      buildKickoffVariables(
        DOCUMENTED_FEATURE_ID,
        DOCUMENTED_SLUG,
        DOCUMENTED_IDEA
      )
    ).toMatchObject({ planningDepth: "jit", approvalPolicy: "none" });
    expect(IMPLEMENT_FULLY_VARIABLES).toHaveLength(10);
    expect(IMPLEMENT_FULLY_VARIABLES).toContain("planningDepth");
    expect(IMPLEMENT_FULLY_VARIABLES).toContain("approvalPolicy");
    expect(IMPLEMENT_FULLY_VARIABLES).toContain("loopMode");
    expect(IMPLEMENT_FULLY_PLANNING_PROFILES.map((p) => p.id)).toEqual([
      "quick",
      "deep",
      "guided",
    ]);
  });

  it("rejects invalid profile ids and unsupported control combinations", () => {
    expect(() => resolvePlanningProfile("turbo")).toThrow(KickoffError);
    expect(() => resolvePlanningProfile("turbo")).toThrow(/Unknown planning profile/);
    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        planningDepth: "maybe",
      })
    ).toThrow(/Invalid planningDepth/);
    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        approvalPolicy: "after",
      })
    ).toThrow(/Invalid approvalPolicy/);
    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        planningDepth: "jit",
        approvalPolicy: "before-implementation",
      })
    ).toThrow(/Unsupported combination/);
    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        loopMode: "execute",
        planningDepth: "jit",
      })
    ).toThrow(/loopMode "execute" with planningDepth "jit"/);
  });

  it("fills missing controls, does not mutate input, and passes through other pipelines", () => {
    const six = {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b45",
      featureSlug: DOCUMENTED_SLUG,
      featureDir: `docs/roadmap/${DOCUMENTED_SLUG}`,
      featureIndex: `docs/roadmap/${DOCUMENTED_SLUG}/00-index.md`,
      idea: DOCUMENTED_IDEA,
      extraKeep: "preserved",
    };
    const before = { ...six };
    const normalized = normalizeImplementFullyChainVariables(six);
    expect(six).toEqual(before);
    expect(normalized).not.toBe(six);
    expect(normalized).toEqual({
      ...six,
      planningDepth: "jit",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode: "normal",
    });

    const other = { pipelineId: "other-pipe", foo: "bar" };
    expect(normalizeImplementFullyChainVariables(other)).toBe(other);
  });
});

describe("b45.1 introspection advertises shared profiles", () => {
  it("returns catalog copies, default id, ten variables, and eight workers", () => {
    const body = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
      pipelineRoleModels: ROLE_DEFAULTS,
      pipelineRoleModelProfiles: {},
      defaultPipelineRoleModelProfile: null,
    });
    expect(body.requiredVariables).toHaveLength(10);
    expect(body.requiredVariables).toEqual([...IMPLEMENT_FULLY_VARIABLES]);
    expect(body.workers).toHaveLength(8);
    expect(body.workers.map((w) => w.key)).toEqual(
      IMPLEMENT_FULLY_WORKERS.map((w) => w.key)
    );
    expect(body.defaultPlanningProfileId).toBe("quick");
    expect(body.planningProfiles).toEqual([...IMPLEMENT_FULLY_PLANNING_PROFILES]);
    expect(body.planningProfiles).not.toBe(IMPLEMENT_FULLY_PLANNING_PROFILES);
    expect(JSON.stringify(body)).not.toContain("## Must do");
    expect(JSON.stringify(body)).not.toContain("lca-handoff");
  });
});

describe("b45.1 CLI profile surface", () => {
  it("accepts every profile id and rejects missing/unknown before network I/O", () => {
    for (const c of PROFILE_CASES) {
      const parsed = parseImplementFullyArgs([
        "--feature",
        "b45",
        "--profile",
        c.id,
      ]);
      expect(parsed.profile).toBe(c.id);
    }
    expect(parseImplementFullyArgs(["--feature", "b45"]).profile).toBe("quick");
    expect(() =>
      parseImplementFullyArgs(["--feature", "b45", "--profile"])
    ).toThrow(/--profile requires a value/);
    expect(() =>
      parseImplementFullyArgs(["--feature", "b45", "--profile", "turbo"])
    ).toThrow(/Unknown --profile "turbo"/);
  });

  it("persists selected controls in chain_context_json; dry-run writes nothing", async () => {
    await withServer(async ({ db, workspacePath, client }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, [
          "--feature",
          DOCUMENTED_FEATURE_ID,
          "--profile",
          "guided",
          "--dry-run",
        ]);
        const dryOut = log.mock.calls.map((c) => String(c[0])).join("\n");
        log.mockRestore();
        expect(dryOut).toMatch(/Guided/);
        expect(dryOut).toMatch(/depth=full/);
        expect(dryOut).toMatch(/approval=before-implementation/);
        expect(
          (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number })
            .n
        ).toBe(0);

        const log2 = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, [
          "--feature",
          DOCUMENTED_FEATURE_ID,
          "--profile",
          "deep",
        ]);
        log2.mockRestore();
      } finally {
        process.chdir(prev);
      }

      const row = db
        .prepare(`SELECT chain_context_json FROM runs LIMIT 1`)
        .get() as { chain_context_json: string };
      const ctx = JSON.parse(row.chain_context_json) as {
        variables: Record<string, string>;
      };
      expect(ctx.variables.planningDepth).toBe("full");
      expect(ctx.variables.approvalPolicy).toBe("none");
      expect(ctx.variables.researchApprovalPolicy).toBe("none");
      expect(Object.keys(ctx.variables).sort()).toEqual(
        [...IMPLEMENT_FULLY_VARIABLES].sort()
      );
    });
  });
});

describe("b45.1 dashboard assembly maps profiles", () => {
  it("maps each profile via shared helpers and uses introspection metadata", () => {
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
          chain: { next: "plan-phase", when: "completed" },
        },
        {
          key: "docs-commit",
          name: "Docs commit",
          modelRole: "docs",
          chain: { next: "plan-phase", when: "completed" },
        },
        {
          key: "integrate-wave",
          name: "Integrate wave",
          modelRole: "reviewer",
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
          id: "default",
          label: "Default",
          roleModels: {
            planner: { id: "planner-model" },
            implementer: { id: "implementer-model" },
            reviewer: { id: "reviewer-model" },
            docs: { id: "docs-model" },
          },
        },
      ],
      defaultRoleModelProfileId: "default",
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

    for (const c of PROFILE_CASES) {
      const payload = assembleKickoffPayload({
        introspection,
        plan,
        feature: DOCUMENTED_FEATURE_ID,
        slug: DOCUMENTED_SLUG,
        idea: DOCUMENTED_IDEA,
        roleOverrides: {},
        profileId: c.id,
      });
      expect(payload.variables).toMatchObject({
        planningDepth: c.planningDepth,
        approvalPolicy: c.approvalPolicy,
      });
      expect(Object.keys(payload.variables ?? {}).sort()).toEqual(
        [...IMPLEMENT_FULLY_VARIABLES].sort()
      );
    }
  });
});

describe("b45.1 daemon six-variable compatibility", () => {
  it("normalizes legacy contexts on root/descendant persist and rejects invalid controls", async () => {
    await withServer(async ({ db, workspaceId, engine }) => {
      const entryId = automationId(
        workspaceId,
        `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
      );
      const childAutoId = automationId(workspaceId, "generated:plan-phase");
      const promptTemplate = IMPLEMENT_FULLY_VARIABLES.map(
        (n) => `${n}: {{${n}}}`
      ).join("\n");
      for (const [id, key, next, role] of [
        [entryId, "generated:plan-skeleton", "generated:plan-phase", "planner"],
        [
          childAutoId,
          "generated:plan-phase",
          "generated:implement",
          "planner",
        ],
      ] as const) {
        db.prepare(
          `INSERT INTO automations (
            id, workspace_id, name, enabled, status, origin, trigger_json, prompt,
            config_path, config_key, chain_json, model_role
          ) VALUES (?, ?, ?, 1, 'enabled', 'generated', '{"type":"manual"}', ?,
            'generated.yaml', ?, ?, ?)`
        ).run(
          id,
          workspaceId,
          key,
          `Worker ${key}\n${promptTemplate}`,
          key,
          JSON.stringify({ next, when: "completed", passResult: true }),
          role
        );
      }

      const sixVars = {
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        featureId: DOCUMENTED_FEATURE_ID,
        featureSlug: DOCUMENTED_SLUG,
        featureDir: `docs/roadmap/${DOCUMENTED_SLUG}`,
        featureIndex: `docs/roadmap/${DOCUMENTED_SLUG}/00-index.md`,
        idea: DOCUMENTED_IDEA,
      };
      const roleModels = {
        planner: { id: "planner-default" },
        implementer: { id: "implementer-default" },
        reviewer: { id: "reviewer-default" },
        docs: { id: "docs-default" },
      };
      const expectedNormalized = {
        ...sixVars,
        planningDepth: "jit",
        approvalPolicy: "none",
        researchApprovalPolicy: "none",
        loopMode: "normal",
      };

      const rootId = await engine.triggerRun(entryId, "manual", {
        chainContext: { variables: sixVars, roleModels },
        chainMaxDepth: 2,
        modelSelectionOverride: roleModels.planner,
      });

      const root = db
        .prepare(`SELECT prompt, chain_context_json FROM runs WHERE id = ?`)
        .get(rootId) as { prompt: string; chain_context_json: string };
      const persisted = JSON.parse(root.chain_context_json) as {
        variables: Record<string, string>;
        roleModels: Record<string, { id: string }>;
      };
      expect(persisted.variables).toEqual(expectedNormalized);
      expect(persisted.roleModels).toEqual(roleModels);
      expect(root.prompt).toContain("planningDepth: jit");
      expect(root.prompt).toContain("approvalPolicy: none");

      // Descendant from a historical context persists normalized controls.
      const childId = await engine.triggerRun(childAutoId, "chain", {
        parentRunId: rootId,
        promptOverride: "already-rendered child prompt",
        chainContext: { variables: sixVars, roleModels },
        chainRootRunId: rootId,
        chainDepth: 1,
        chainMaxDepth: 2,
        modelSelectionOverride: roleModels.planner,
      });
      const child = db
        .prepare(`SELECT chain_context_json FROM runs WHERE id = ?`)
        .get(childId) as { chain_context_json: string };
      const childCtx = JSON.parse(child.chain_context_json) as {
        variables: Record<string, string>;
        roleModels: Record<string, { id: string }>;
      };
      expect(childCtx.variables).toEqual(expectedNormalized);
      expect(childCtx.roleModels).toEqual(roleModels);

      const beforeInvalid = (
        db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }
      ).n;
      await expect(
        engine.triggerRun(entryId, "manual", {
          chainContext: {
            variables: {
              ...sixVars,
              planningDepth: "bogus",
            },
            roleModels,
          },
          chainMaxDepth: 1,
        })
      ).rejects.toBeInstanceOf(TriggerRunValidationError);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n
      ).toBe(beforeInvalid);
    });
  });
});
