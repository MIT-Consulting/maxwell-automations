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
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  modelSelectionKey,
  type ModelSelection,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
} from "@lca/shared";
import { DaemonClient } from "../packages/cli/src/client.ts";
import { cmdImplementFully } from "../packages/cli/src/implement-fully.ts";
import {
  assembleKickoffPayload,
  describeKickoffReviewFacts,
} from "../packages/dashboard/src/pipelineKickoff.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import {
  GENERATED_CONFIG_KEY_PREFIX as DAEMON_GENERATED_PREFIX,
  provisionGeneratedWorkers,
} from "../packages/daemon/src/config/generated-workers.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import {
  DEFAULT_SETTINGS,
  type ResolvedSettings,
} from "../packages/daemon/src/config/settings.ts";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
} from "../packages/daemon/src/pipelines/halt-discovery.ts";
import {
  IMPLEMENT_FULLY_DEFINITION,
  IMPLEMENT_FULLY_WORKERS,
  computeImplementFullyBudget,
  toPipelineIntrospection,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
});

type Db = ReturnType<typeof openDatabase>;

const DOCUMENTED_FEATURE_ID = "b56";
const DOCUMENTED_SLUG = "b56-optional-researcher-gatekeeper";
const DOCUMENTED_IDEA =
  "Optional researcher and gatekeeper. Prior art: docs/roadmap/done/b56-optional-researcher-gatekeeper/prd.md.";

const FOUR_ROLE_DEFAULTS: ResolvedSettings["pipelineRoleModels"] = {
  planner: { id: "planner-default" },
  implementer: {
    id: "implementer-default",
    params: [{ id: "fast", value: "true" }],
  },
  reviewer: { id: "reviewer-default" },
  docs: { id: "docs-default" },
};

const RESEARCHER_SELECTION: ModelSelection = {
  id: "fable-research",
  params: [{ id: "thinking", value: "high" }],
};

const GATEKEEPER_SELECTION: ModelSelection = { id: "fable-gate" };

const SIX_ROLE_DEFAULTS: ResolvedSettings["pipelineRoleModels"] = {
  ...FOUR_ROLE_DEFAULTS,
  researcher: RESEARCHER_SELECTION,
  gatekeeper: GATEKEEPER_SELECTION,
};

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn should not be called in kickoff tests");
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
      `- **${DOCUMENTED_FEATURE_ID}** Optional researcher. — [docs](./${DOCUMENTED_SLUG}/00-index.md)`,
      "",
    ].join("\n"),
    "utf8"
  );
  const featureDir = join(workspacePath, "docs", "roadmap", DOCUMENTED_SLUG);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, "00-index.md"), "# b56\n", "utf8");
  writeFileSync(join(featureDir, "prd.md"), "# prd\n", "utf8");
}

function seedWorkspaceDisk(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  writeRoadmapIndex(workspacePath);
}

function countAutomations(db: Db): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM automations").get() as { n: number }
  ).n;
}

function countRuns(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

function countProvisionCalls(client: DaemonClient): {
  dry: number;
  apply: number;
  triggers: number;
} {
  const c = client as DaemonClient & {
    _provisionCalls?: { dry: number; apply: number; triggers: number };
  };
  return c._provisionCalls ?? { dry: 0, apply: 0, triggers: 0 };
}

function wrapClient(client: DaemonClient): DaemonClient {
  const tallies = { dry: 0, apply: 0, triggers: 0 };
  const origProvision = client.provisionPipelineWorkers.bind(client);
  const origTrigger = client.triggerRunWithContext.bind(client);
  client.provisionPipelineWorkers = async (pipelineId, body) => {
    if (body.dryRun) tallies.dry += 1;
    else tallies.apply += 1;
    return origProvision(pipelineId, body);
  };
  client.triggerRunWithContext = async (req) => {
    tallies.triggers += 1;
    return origTrigger(req);
  };
  (client as DaemonClient & { _provisionCalls: typeof tallies })._provisionCalls =
    tallies;
  return client;
}

async function withServer(
  settings: ResolvedSettings,
  run: (args: {
    port: number;
    db: Db;
    workspacePath: string;
    workspaceId: string;
    client: DaemonClient;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b56-7-"));
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
  const client = wrapClient(new DaemonClient(`http://127.0.0.1:${port}`));
  try {
    await run({ port, db, workspacePath, workspaceId, client });
  } finally {
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function kickoffFixtures(opts?: {
  includeResearchPlanItem?: boolean;
}): {
  introspection: PipelineIntrospectionResponse;
  plan: ProvisionPipelineWorkersResponse;
} {
  const introspection = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
    pipelineRoleModels: FOUR_ROLE_DEFAULTS,
    pipelineRoleModelProfiles: {},
    defaultPipelineRoleModelProfile: null,
  });
  const items: ProvisionPipelineWorkersResponse["plan"]["items"] = [
    {
      key: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      configKey: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
      automationId: `ws::${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
      action: "unchanged",
    },
  ];
  if (opts?.includeResearchPlanItem !== false) {
    items.push({
      key: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
      configKey: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
      automationId: `ws::${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
      action: "create",
    });
  }
  return {
    introspection,
    plan: {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      missingSkills: [],
      plan: {
        workspaceId: "ws",
        dryRun: true,
        applied: false,
        items,
      },
    },
  };
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

function makeActiveRun(agentId: string, sdkRunId: string): ActiveRun {
  return {
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {},
    wait: async () => ({ status: "finished", result: "ok" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
}

function handoffPacketFor(workerKey: string): string {
  return [
    "```text",
    "lca-handoff",
    "version: 1",
    `pipeline: ${IMPLEMENT_FULLY_PIPELINE_ID}`,
    `worker: ${workerKey}`,
    "feature: b56",
    "phase: -",
    "outcome: planned",
    "summary: researched chain budget probe",
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

function workerKeyFromConfigKey(configKey: string): string {
  return configKey.startsWith(DAEMON_GENERATED_PREFIX)
    ? configKey.slice(DAEMON_GENERATED_PREFIX.length)
    : configKey;
}

describe("b56.7 dashboard conditional entry", () => {
  it("four-role kickoff still targets plan-skeleton with planner model", () => {
    const { introspection, plan } = kickoffFixtures();
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: DOCUMENTED_FEATURE_ID,
      slug: DOCUMENTED_SLUG,
      idea: DOCUMENTED_IDEA,
      roleOverrides: {},
    });
    expect(payload.automationId).toBe(
      `ws::${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
    );
    expect(payload.modelSelection).toEqual(FOUR_ROLE_DEFAULTS.planner);
    expect(payload.roleModels).toEqual(FOUR_ROLE_DEFAULTS);
    expect(payload.maxDepth).toBe(1);
  });

  it("researcher recipe targets research with researcher model and preserves params", () => {
    const { introspection, plan } = kickoffFixtures();
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: DOCUMENTED_FEATURE_ID,
      slug: DOCUMENTED_SLUG,
      idea: DOCUMENTED_IDEA,
      roleOverrides: {
        researcher: RESEARCHER_SELECTION.id,
        gatekeeper: GATEKEEPER_SELECTION.id,
      },
    });
    expect(payload.automationId).toBe(
      `ws::${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`
    );
    expect(payload.modelSelection).toEqual({ id: RESEARCHER_SELECTION.id });
    expect(payload.roleModels?.researcher).toEqual({
      id: RESEARCHER_SELECTION.id,
    });
    expect(payload.roleModels?.gatekeeper).toEqual({
      id: GATEKEEPER_SELECTION.id,
    });
    expect(payload.roleModels?.planner).toEqual(FOUR_ROLE_DEFAULTS.planner);

    const withParams = assembleKickoffPayload({
      introspection: toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
        pipelineRoleModels: SIX_ROLE_DEFAULTS,
        pipelineRoleModelProfiles: {},
        defaultPipelineRoleModelProfile: null,
      }),
      plan,
      feature: DOCUMENTED_FEATURE_ID,
      slug: DOCUMENTED_SLUG,
      idea: DOCUMENTED_IDEA,
      roleOverrides: {},
    });
    expect(withParams.modelSelection).toEqual(RESEARCHER_SELECTION);
    expect(withParams.modelSelection).not.toBe(RESEARCHER_SELECTION);
    expect(withParams.modelSelection?.params).toEqual(
      RESEARCHER_SELECTION.params
    );
    expect(withParams.roleModels?.gatekeeper).toEqual(GATEKEEPER_SELECTION);
  });

  it("before-planning without researcher throws before any side effect", () => {
    const { introspection, plan } = kickoffFixtures();
    expect(() =>
      assembleKickoffPayload({
        introspection,
        plan,
        feature: DOCUMENTED_FEATURE_ID,
        slug: DOCUMENTED_SLUG,
        idea: DOCUMENTED_IDEA,
        roleOverrides: {},
        researchApprovalPolicy: "before-planning",
      })
    ).toThrow(/before-planning.*researcher/);
  });

  it("describeKickoffReviewFacts covers four-role and six-role recipes", () => {
    const { introspection } = kickoffFixtures();
    const four = describeKickoffReviewFacts({
      introspection,
      roleModels: FOUR_ROLE_DEFAULTS,
    });
    expect(four).toEqual({
      entryWorkerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      rootRole: "planner",
      researcher: null,
      researchApprovalPolicy: "none",
      architect: FOUR_ROLE_DEFAULTS.planner,
      architectSource: "planner-fallback",
      gatekeeper: FOUR_ROLE_DEFAULTS.reviewer,
      gatekeeperSource: "reviewer-fallback",
    });

    const six = describeKickoffReviewFacts({
      introspection,
      roleModels: SIX_ROLE_DEFAULTS,
      researchApprovalPolicy: "before-planning",
    });
    expect(six.entryWorkerKey).toBe(IMPLEMENT_FULLY_RESEARCH_WORKER_KEY);
    expect(six.rootRole).toBe("researcher");
    expect(six.researcher).toEqual(RESEARCHER_SELECTION);
    expect(six.researchApprovalPolicy).toBe("before-planning");
    expect(six.architect).toEqual(FOUR_ROLE_DEFAULTS.planner);
    expect(six.architectSource).toBe("planner-fallback");
    expect(six.gatekeeper).toEqual(GATEKEEPER_SELECTION);
    expect(six.gatekeeperSource).toBe("explicit");
  });
});

describe("b56.7 CLI conditional entry", () => {
  const featureArgs = ["--feature", DOCUMENTED_FEATURE_ID];

  it("four-role kickoff targets plan-skeleton planner and is unchanged", async () => {
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels: FOUR_ROLE_DEFAULTS },
      async ({ db, workspacePath, workspaceId, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        try {
          const log = vi.spyOn(console, "log").mockImplementation(() => {});
          await cmdImplementFully(client, featureArgs);
          log.mockRestore();
        } finally {
          process.chdir(prev);
        }
        expect(countRuns(db)).toBe(1);
        const row = db
          .prepare(
            `SELECT automation_id, chain_context_json FROM runs LIMIT 1`
          )
          .get() as { automation_id: string; chain_context_json: string };
        expect(row.automation_id).toBe(
          automationId(
            workspaceId,
            `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
          )
        );
        const ctx = JSON.parse(row.chain_context_json) as {
          roleModels: Record<string, ModelSelection>;
        };
        expect(ctx.roleModels).toEqual(FOUR_ROLE_DEFAULTS);
      }
    );
  });

  it("researcher override starts research with researcher model", async () => {
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels: FOUR_ROLE_DEFAULTS },
      async ({ db, workspacePath, workspaceId, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        try {
          const log = vi.spyOn(console, "log").mockImplementation(() => {});
          await cmdImplementFully(client, [
            ...featureArgs,
            "--role",
            `researcher=${RESEARCHER_SELECTION.id}`,
            "--role",
            `gatekeeper=${GATEKEEPER_SELECTION.id}`,
          ]);
          log.mockRestore();
        } finally {
          process.chdir(prev);
        }
        const row = db
          .prepare(
            `SELECT automation_id, chain_context_json FROM runs LIMIT 1`
          )
          .get() as { automation_id: string; chain_context_json: string };
        expect(row.automation_id).toBe(
          automationId(
            workspaceId,
            `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`
          )
        );
        const ctx = JSON.parse(row.chain_context_json) as {
          roleModels: Record<string, ModelSelection>;
        };
        expect(ctx.roleModels.researcher).toEqual({
          id: RESEARCHER_SELECTION.id,
        });
        expect(ctx.roleModels.gatekeeper).toEqual({
          id: GATEKEEPER_SELECTION.id,
        });
      }
    );
  });

  it("before-planning without researcher fails before provision/trigger writes", async () => {
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels: FOUR_ROLE_DEFAULTS },
      async ({ db, workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        try {
          await expect(
            cmdImplementFully(client, featureArgs, {
              researchApprovalPolicy: "before-planning",
            })
          ).rejects.toThrow(/before-planning.*researcher/);
        } finally {
          process.chdir(prev);
        }
        expect(countAutomations(db)).toBe(0);
        expect(countRuns(db)).toBe(0);
        const calls = countProvisionCalls(client);
        expect(calls.dry).toBe(0);
        expect(calls.apply).toBe(0);
        expect(calls.triggers).toBe(0);
      }
    );
  });

  it("dry-run prints entry and research rows and writes nothing", async () => {
    await withServer(
      {
        ...DEFAULT_SETTINGS,
        pipelineRoleModels: SIX_ROLE_DEFAULTS,
      },
      async ({ db, workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...a) => {
          lines.push(a.map(String).join(" "));
        });
        try {
          await cmdImplementFully(client, [...featureArgs, "--dry-run"]);
        } finally {
          log.mockRestore();
          process.chdir(prev);
        }
        expect(countAutomations(db)).toBe(0);
        expect(countRuns(db)).toBe(0);
        const joined = lines.join("\n");
        expect(joined).toMatch(
          new RegExp(`Entry:\\s+${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY} \\(researcher\\)`)
        );
        expect(joined).toMatch(
          new RegExp(`Research:\\s+${RESEARCHER_SELECTION.id}`)
        );
        expect(joined).toMatch(/"maxDepth": 1/);
      }
    );
  });
});

describe("b56.7 research worker least authority", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function seedImplementFullyAutomations(
    db: Db,
    workspaceId: string
  ): Map<string, string> {
    const plan = provisionGeneratedWorkers(
      db,
      workspaceId,
      IMPLEMENT_FULLY_WORKERS
    );
    const byKey = new Map<string, string>();
    for (const item of plan.items) {
      byKey.set(item.key, item.automationId);
    }
    return byKey;
  }

  it("restricts research to ask_user on spawn; other workers unrestricted; halt-discovery unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-7-auth-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = workspaceIdFromPath(workspace);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, workspace, "Workspace");
    const byKey = seedImplementFullyAutomations(db, workspaceId);

    const spawns: SpawnParams[] = [];
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (params) => {
        spawns.push(params);
        return makeActiveRun(`agent-${params.runId}`, `sdk-${params.runId}`);
      },
      resume: async () => {
        throw new Error("resume should not be called");
      },
    };

    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      events: new DaemonEventBus(),
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 4,
    });

    try {
      const researchId = await engine.triggerRun(
        byKey.get(IMPLEMENT_FULLY_RESEARCH_WORKER_KEY)!,
        "manual"
      );
      await until(() => spawns.some((s) => s.runId === researchId));
      expect(
        spawns.find((s) => s.runId === researchId)?.automationsIoTools
      ).toEqual(["ask_user"]);

      const unrestricted = [
        IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
        "plan-phase",
        "implement",
        "review",
        "integrate-wave",
        IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
      ] as const;
      for (const key of unrestricted) {
        const runId = await engine.triggerRun(byKey.get(key)!, "manual");
        await until(() => spawns.some((s) => s.runId === runId));
        expect(
          spawns.find((s) => s.runId === runId)?.automationsIoTools
        ).toBeUndefined();
      }

      const haltId = await engine.triggerRun(
        byKey.get(IMPLEMENT_FULLY_ENTRY_WORKER_KEY)!,
        HALT_DISCOVERY_TRIGGER_KIND
      );
      await until(() => spawns.some((s) => s.runId === haltId));
      expect(
        spawns.find((s) => s.runId === haltId)?.automationsIoTools
      ).toEqual(["ask_user"]);
    } finally {
      await engine.shutdown();
      db.close();
    }
  });

  it("keeps research ask_user restriction on needs_input resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-7-resume-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = workspaceIdFromPath(workspace);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, workspace, "Workspace");
    const byKey = seedImplementFullyAutomations(db, workspaceId);
    const researchAutomationId = byKey.get(IMPLEMENT_FULLY_RESEARCH_WORKER_KEY)!;
    const runId = "research-resume";

    db.prepare(
      `INSERT INTO runs (
        id, automation_id, workspace_id, status, trigger_kind, prompt,
        agent_id, sdk_run_id
      ) VALUES (?, ?, ?, 'needs_input', ?, ?, ?, ?)`
    ).run(
      runId,
      researchAutomationId,
      workspaceId,
      "manual",
      "research prompt",
      "agent-prior",
      "sdk-prior"
    );

    const resumes: ResumeParams[] = [];
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async (params) => {
        resumes.push(params);
        return makeActiveRun(params.agentId, params.sdkRunId);
      },
    };

    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      events: new DaemonEventBus(),
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 2,
    });

    try {
      await engine.resumeInterruptedRuns();
      await until(() => resumes.length >= 1);
      expect(resumes[0]?.automationsIoTools).toEqual(["ask_user"]);
      expect(resumes[0]?.runId).toBe(runId);
    } finally {
      await engine.shutdown();
      db.close();
    }
  });
});

describe("b56.7 one-phase researched budget reaches final-gate", () => {
  it("walks research → … → final-gate under 6×1+1", async () => {
    const budget = computeImplementFullyBudget(1);
    expect(budget).toBe(7);

    const root = mkdtempSync(join(tmpdir(), "lca-b56-7-budget-"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = workspaceIdFromPath(workspacePath);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, workspacePath, "Workspace");

    provisionGeneratedWorkers(db, workspaceId, IMPLEMENT_FULLY_WORKERS);

    type SpawnRecord = {
      runId: string;
      workerKey: string;
      model: SpawnParams["model"];
    };
    const spawns: SpawnRecord[] = [];
    const engineRef: { current: RunEngine | null } = { current: null };
    const planPhaseByRoot = new Map<string, number>();

    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (params: SpawnParams) => {
        const run = db
          .prepare(
            `SELECT id, automation_id, chain_root_run_id FROM runs WHERE id = ?`
          )
          .get(params.runId) as
          | {
              id: string;
              automation_id: string;
              chain_root_run_id: string | null;
            }
          | undefined;
        if (!run) throw new Error(`unknown run ${params.runId}`);
        const automation = db
          .prepare(`SELECT config_key FROM automations WHERE id = ?`)
          .get(run.automation_id) as { config_key: string } | undefined;
        if (!automation) throw new Error("missing automation");
        const workerKey = workerKeyFromConfigKey(automation.config_key);
        spawns.push({ runId: params.runId, workerKey, model: params.model });

        const engine = engineRef.current!;
        const rootId = run.chain_root_run_id ?? run.id;

        if (workerKey === IMPLEMENT_FULLY_ENTRY_WORKER_KEY) {
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
          // One phase: first visit plans, second visit completes the feature.
          if (count === 2) {
            const applied = engine.applyChainControl(
              params.runId,
              {
                stop: {
                  reason: "complete: no runnable Pending phase left",
                },
              },
              params.runToken
            );
            if (!applied.ok) {
              throw new Error(`stop failed: ${applied.reason}`);
            }
          }
        }

        return {
          kind: "sdk-local",
          agentId: `agent-${params.runId}`,
          sdkRunId: `sdk-${params.runId}`,
          async *stream() {},
          wait: async () =>
            ({
              status: "finished",
              result: handoffPacketFor(workerKey),
            }) as never,
          cancel: async () => {},
          dispose: async () => {},
        };
      },
      resume: async () => {
        throw new Error("resume should not be called");
      },
    };

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      events,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      }),
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

    const roleModels = {
      planner: { id: "planner-model" } satisfies ModelSelection,
      implementer: { id: "implementer-model" } satisfies ModelSelection,
      reviewer: { id: "reviewer-model" } satisfies ModelSelection,
      docs: { id: "docs-model" } satisfies ModelSelection,
      researcher: RESEARCHER_SELECTION,
    };

    try {
      const researchAutomationId = automationId(
        workspaceId,
        `${DAEMON_GENERATED_PREFIX}${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`
      );
      const rootId = await engine.triggerRun(researchAutomationId, "manual", {
        chainContext: {
          variables: {
            pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
            featureId: "b56",
            featureSlug: "b56-budget-probe",
            featureDir: "docs/roadmap/b56-budget-probe",
            featureIndex: "docs/roadmap/b56-budget-probe/00-index.md",
            idea: "prove researched budget",
            planningDepth: "jit",
            approvalPolicy: "none",
            researchApprovalPolicy: "none",
          },
          roleModels,
        },
        chainMaxDepth: 1,
        modelSelectionOverride: roleModels.researcher,
      });

      await until(() => {
        const pipe = db
          .prepare(
            `SELECT r.status, a.config_key
             FROM runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.chain_root_run_id = ?
             ORDER BY r.created_at ASC, r.rowid ASC`
          )
          .all(rootId) as Array<{ status: string; config_key: string }>;
        if (pipe.length < 7) return false;
        const leaf = pipe[pipe.length - 1]!;
        return (
          leaf.status === "completed" &&
          workerKeyFromConfigKey(leaf.config_key) ===
            IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
        );
      });

      const pipe = db
        .prepare(
          `SELECT r.chain_depth, r.chain_max_depth, r.chain_max_depth_override,
                  r.status, a.config_key
           FROM runs r
           JOIN automations a ON a.id = r.automation_id
           WHERE r.chain_root_run_id = ?
           ORDER BY r.created_at ASC, r.rowid ASC`
        )
        .all(rootId) as Array<{
        chain_depth: number | null;
        chain_max_depth: number | null;
        chain_max_depth_override: number | null;
        status: string;
        config_key: string;
      }>;

      expect(pipe.map((r) => workerKeyFromConfigKey(r.config_key))).toEqual([
        IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
        IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
        "plan-phase",
        "implement",
        "review",
        "plan-phase",
        IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
      ]);
      expect(pipe).toHaveLength(7);
      expect(pipe.every((r) => r.status === "completed")).toBe(true);
      expect(pipe[0]!.chain_max_depth).toBe(1);
      expect(pipe[1]!.chain_max_depth_override ?? pipe[1]!.chain_max_depth).toBe(
        7
      );
      expect(
        modelSelectionKey(spawns[0]!.model)
      ).toBe(modelSelectionKey(RESEARCHER_SELECTION));
    } finally {
      chainRunner.stop();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
