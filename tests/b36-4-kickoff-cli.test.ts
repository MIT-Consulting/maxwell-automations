import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAIN_VALUE_MAX_LENGTH,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type ModelSelection,
  type Workspace,
} from "@lca/shared";
import { DaemonClient } from "../packages/cli/src/client.ts";
import {
  assertVariablesMatchRequired,
  buildKickoffVariables,
  buildResolveKickoffRequest,
  cmdImplementFully,
  parseImplementFullyArgs,
  requiredRolesFromWorkers,
  resolveRoleRecipe,
  resolveWorkspaceFromCwd,
  validateFeatureSlugIdea,
} from "../packages/cli/src/implement-fully.ts";
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
import { IMPLEMENT_FULLY_ENTRY_WORKER_KEY } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
});

type Db = ReturnType<typeof openDatabase>;

const ROLE_DEFAULTS: ResolvedSettings["pipelineRoleModels"] = {
  planner: { id: "planner-default" },
  implementer: {
    id: "implementer-default",
    params: [{ id: "fast", value: "true" }],
  },
  reviewer: { id: "reviewer-default" },
  docs: { id: "docs-default" },
};

/** Deterministic documented feature for existing-feature kickoffs. */
const DOCUMENTED_FEATURE_ID = "b42";
const DOCUMENTED_SLUG = "b42-my-feature";
const DOCUMENTED_IDEA =
  "Ship the kickoff verb. Prior art: docs/roadmap/b42-my-feature/prd.md.";
/** Non-stale next id for idea-only kickoffs. */
const NEXT_FEATURE_ID = "b99";

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
      `<!-- next: ${NEXT_FEATURE_ID} -->`,
      "",
      "## Backlog",
      "",
      `- **${DOCUMENTED_FEATURE_ID}** Ship the kickoff verb. — [docs](./${DOCUMENTED_SLUG}/00-index.md)`,
      "",
    ].join("\n"),
    "utf8"
  );
  const featureDir = join(workspacePath, "docs", "roadmap", DOCUMENTED_SLUG);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, "00-index.md"), "# b42\n", "utf8");
  writeFileSync(join(featureDir, "prd.md"), "# prd\n", "utf8");
}

function seedWorkspaceDisk(
  workspacePath: string,
  opts?: { git?: boolean; roadmap?: boolean }
): void {
  mkdirSync(workspacePath, { recursive: true });
  if (opts?.git !== false) {
    mkdirSync(join(workspacePath, ".git"), { recursive: true });
  }
  if (opts?.roadmap !== false) {
    writeRoadmapIndex(workspacePath);
  }
}

function countAutomations(db: Db): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM automations").get() as { n: number }
  ).n;
}

function countRuns(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

async function withServer(
  run: (args: {
    port: number;
    db: Db;
    workspacePath: string;
    workspaceId: string;
    client: DaemonClient;
    engine: RunEngine;
  }) => Promise<void>,
  opts?: {
    settings?: ResolvedSettings;
    seedDisk?: { git?: boolean; roadmap?: boolean };
    extraWorkspaces?: Array<{ path: string; name: string }>;
  }
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-4c-"));
  const workspacePath = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  seedWorkspaceDisk(workspacePath, opts?.seedDisk);
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");

  for (const extra of opts?.extraWorkspaces ?? []) {
    seedWorkspaceDisk(extra.path);
    const id = workspaceIdFromPath(extra.path);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(id, extra.path, extra.name);
  }

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
  const settings = opts?.settings ?? {
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

const FEATURE_ARGS = ["--feature", DOCUMENTED_FEATURE_ID];
const IDEA_TEXT = "brand new thinner kickoff work";
const IDEA_ARGS = ["--idea", IDEA_TEXT];
const IDEA_SLUG = `${NEXT_FEATURE_ID}-brand-new-thinner-kickoff-work`;

describe("b36.04c pure helpers", () => {
  describe("parseImplementFullyArgs / buildResolveKickoffRequest", () => {
    it("rejects missing input and both thin inputs", () => {
      expect(() => parseImplementFullyArgs([])).toThrow(
        /Exactly one of --feature/
      );
      expect(() =>
        parseImplementFullyArgs([
          "--feature",
          "b42",
          "--idea",
          "both",
        ])
      ).toThrow(/exactly one of --feature.*not both/i);
    });

    it("rejects removed --slug and unknown flags", () => {
      expect(() =>
        parseImplementFullyArgs([
          ...FEATURE_ARGS,
          "--slug",
          "b42-my-feature",
        ])
      ).toThrow(/Unknown flag "--slug"/);
      expect(() =>
        parseImplementFullyArgs([...FEATURE_ARGS, "--dry-runn"])
      ).toThrow(/Unknown flag "--dry-runn"/);
    });

    it("parses each thin form and validates through the shared schema", () => {
      const featureParsed = parseImplementFullyArgs([
        "--feature",
        "  b42  ",
      ]);
      expect(featureParsed.input).toEqual({
        kind: "feature-id",
        featureId: "  b42  ",
      });
      expect(featureParsed.profile).toBe("quick");
      const featureReq = buildResolveKickoffRequest(
        "ws-1",
        featureParsed.input
      );
      expect(featureReq).toEqual({
        workspaceId: "ws-1",
        input: { kind: "feature-id", featureId: "b42" },
      });
      expect(featureReq.input).not.toHaveProperty("idea");

      const ideaParsed = parseImplementFullyArgs([
        "--idea",
        "  ship it  ",
      ]);
      expect(ideaParsed.input).toEqual({
        kind: "idea",
        idea: "  ship it  ",
      });
      const ideaReq = buildResolveKickoffRequest("ws-1", ideaParsed.input);
      expect(ideaReq).toEqual({
        workspaceId: "ws-1",
        input: { kind: "idea", idea: "ship it" },
      });
      expect(ideaReq.input).not.toHaveProperty("featureId");
    });

    it("rejects malformed feature id, blank idea, and over-limit idea", () => {
      expect(() =>
        buildResolveKickoffRequest("ws", {
          kind: "feature-id",
          featureId: "42",
        })
      ).toThrow(/featureId must match/);
      expect(() =>
        buildResolveKickoffRequest("ws", { kind: "idea", idea: "   " })
      ).toThrow(/non-empty/);
      const over = "x".repeat(CHAIN_VALUE_MAX_LENGTH + 1);
      expect(() =>
        buildResolveKickoffRequest("ws", { kind: "idea", idea: over })
      ).toThrow(
        new RegExp(
          `${CHAIN_VALUE_MAX_LENGTH + 1} bytes.*${CHAIN_VALUE_MAX_LENGTH}`
        )
      );
      const overMultibyte = "é".repeat(CHAIN_VALUE_MAX_LENGTH + 1);
      expect(() =>
        buildResolveKickoffRequest("ws", {
          kind: "idea",
          idea: overMultibyte,
        })
      ).toThrow(/bytes/);
    });

    it("rejects malformed feature and slug/feature mismatch via validate helper", () => {
      expect(() =>
        validateFeatureSlugIdea("42", "42-x", "idea")
      ).toThrow(/Invalid --feature/);
      expect(() =>
        validateFeatureSlugIdea("b42", "b99-other", "idea")
      ).toThrow(/must start with "b42-"/);
      expect(() =>
        validateFeatureSlugIdea("b42", "b42_Bad", "idea")
      ).toThrow(/Invalid --slug/);
    });

    it("rejects an unknown role name and accepts last-wins for repeats", () => {
      expect(() =>
        parseImplementFullyArgs([
          ...FEATURE_ARGS,
          "--role",
          "planer=grok",
        ])
      ).toThrow(/Unknown role "planer"/);

      const parsed = parseImplementFullyArgs([
        ...FEATURE_ARGS,
        "--role",
        "planner=first",
        "--role",
        "planner=second",
      ]);
      expect(parsed.roleOverrides.planner).toBe("second");
    });

    it("rejects --role parameter syntax", () => {
      expect(() =>
        parseImplementFullyArgs([
          ...FEATURE_ARGS,
          "--role",
          "planner=id:fast",
        ])
      ).toThrow(/settings\.pipelineRoleModels/);
      expect(() =>
        parseImplementFullyArgs([
          ...FEATURE_ARGS,
          "--role",
          "planner=composer-2.5?reasoning_effort=high",
        ])
      ).toThrow(/settings\.pipelineRoleModels/);
    });

    it("rejects --execute with Quick/JIT profile", () => {
      expect(() =>
        parseImplementFullyArgs([...FEATURE_ARGS, "--execute"])
      ).toThrow(/--execute requires full upfront planning/);
      expect(() =>
        parseImplementFullyArgs([
          ...FEATURE_ARGS,
          "--execute",
          "--profile",
          "quick",
        ])
      ).toThrow(/--execute requires full upfront planning/);
    });

    it("accepts --execute with deep profile", () => {
      const parsed = parseImplementFullyArgs([
        ...FEATURE_ARGS,
        "--execute",
        "--profile",
        "deep",
      ]);
      expect(parsed.execute).toBe(true);
      expect(parsed.profile).toBe("deep");
    });
  });

  describe("buildKickoffVariables / assertVariablesMatchRequired", () => {
    it("derives the ten keys with forward slashes and Quick/JIT defaults", () => {
      const vars = buildKickoffVariables(
        "b42",
        "b42-my-feature",
        "an idea"
      );
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
      expect(vars.featureIndex.includes("\\")).toBe(false);
    });

    it("fails when required set and built set differ", () => {
      const vars = buildKickoffVariables("b42", "b42-x", "idea");
      expect(() =>
        assertVariablesMatchRequired(vars, [
          "pipelineId",
          "featureId",
          "featureSlug",
          "featureDir",
          "featureIndex",
          "idea",
          "planningDepth",
          "approvalPolicy",
          "extraThing",
        ])
      ).toThrow(/Variable key mismatch/);
    });
  });

  describe("resolveRoleRecipe", () => {
    it("lets override beat default and fills the rest from defaults", () => {
      const recipe = resolveRoleRecipe(
        ["planner", "implementer", "reviewer", "docs"],
        { reviewer: "override-reviewer" },
        {
          planner: { id: "d-planner" },
          implementer: {
            id: "d-impl",
            params: [{ id: "fast", value: "true" }],
          },
          reviewer: { id: "d-reviewer" },
          docs: { id: "d-docs" },
        }
      );
      expect(recipe.roleModels.reviewer).toEqual({ id: "override-reviewer" });
      expect(recipe.sources.reviewer).toBe("override");
      expect(recipe.roleModels.implementer).toEqual({
        id: "d-impl",
        params: [{ id: "fast", value: "true" }],
      });
      expect(recipe.sources.implementer).toBe("default");
    });

    it("preserves ModelSelection params on overrides", () => {
      const recipe = resolveRoleRecipe(
        ["planner", "implementer", "reviewer", "docs"],
        {
          planner: {
            id: "grok-4.5",
            params: [
              { id: "thinking", value: "high" },
              { id: "fast", value: "true" },
            ],
          },
        },
        {
          planner: { id: "d-planner" },
          implementer: { id: "d-impl" },
          reviewer: { id: "d-reviewer" },
          docs: { id: "d-docs" },
        }
      );
      expect(recipe.roleModels.planner).toEqual({
        id: "grok-4.5",
        params: [
          { id: "thinking", value: "high" },
          { id: "fast", value: "true" },
        ],
      });
      expect(recipe.sources.planner).toBe("override");
    });

    it("aborts when a role has neither override nor default", () => {
      expect(() =>
        resolveRoleRecipe(
          ["planner", "reviewer"],
          { planner: "p" },
          { planner: { id: "ignored" } }
        )
      ).toThrow(/Unresolved pipeline role\(s\): reviewer/);
    });
  });

  describe("resolveWorkspaceFromCwd", () => {
    it("picks the longest matching registered path and never __global__", () => {
      const parent = join(tmpdir(), "lca-ws-parent");
      const child = join(parent, "nested");
      const workspaces: Workspace[] = [
        {
          id: "__global__",
          path: parent,
          name: "global",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "parent-id",
          path: parent,
          name: "parent",
          createdAt: "",
          updatedAt: "",
        },
        {
          id: "child-id",
          path: child,
          name: "child",
          createdAt: "",
          updatedAt: "",
        },
      ];
      const picked = resolveWorkspaceFromCwd(workspaces, join(child, "src"));
      expect(picked.id).toBe("child-id");
    });

    it("errors for an unregistered cwd", () => {
      expect(() =>
        resolveWorkspaceFromCwd(
          [
            {
              id: "ws",
              path: join(tmpdir(), "somewhere-else"),
              name: "ws",
              createdAt: "",
              updatedAt: "",
            },
          ],
          tmpdir()
        )
      ).toThrow(/not inside a registered workspace/);
    });

    it("preserves case-sensitive path semantics outside Windows", () => {
      if (process.platform === "win32") return;
      const registered = join(tmpdir(), "CaseSensitiveWorkspace");
      expect(() =>
        resolveWorkspaceFromCwd(
          [
            {
              id: "ws",
              path: registered,
              name: "ws",
              createdAt: "",
              updatedAt: "",
            },
          ],
          join(tmpdir(), "casesensitiveworkspace", "src")
        )
      ).toThrow(/not inside a registered workspace/);
    });
  });

  it("requiredRolesFromWorkers returns distinct roles in worker order", () => {
    const roles = requiredRolesFromWorkers([
      {
        key: "plan-skeleton",
        name: "A",
        modelRole: "planner",
        chain: { onComplete: { target: "x", inherit: [] } },
      },
      {
        key: "plan-phase",
        name: "B",
        modelRole: "planner",
        chain: { onComplete: { target: "x", inherit: [] } },
      },
      {
        key: "implement",
        name: "C",
        modelRole: "implementer",
        chain: { onComplete: { target: "x", inherit: [] } },
      },
    ]);
    expect(roles).toEqual(["planner", "implementer"]);
  });
});

describe("b36.04c implement-fully integration", () => {
  it("happy path: existing feature uses daemon-resolved slug/idea at maxDepth 1", async () => {
    await withServer(async ({ db, workspacePath, workspaceId, client }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, FEATURE_ARGS);
        log.mockRestore();
      } finally {
        process.chdir(prev);
      }

      expect(countRuns(db)).toBe(1);
      const row = db
        .prepare(
          `SELECT id, automation_id, chain_root_run_id, chain_depth, chain_max_depth,
                  chain_context_json FROM runs LIMIT 1`
        )
        .get() as {
        id: string;
        automation_id: string;
        chain_root_run_id: string | null;
        chain_depth: number | null;
        chain_max_depth: number | null;
        chain_context_json: string | null;
      };
      expect(row.chain_max_depth).toBe(1);
      expect(row.chain_depth).toBe(0);
      expect(row.chain_root_run_id).toBe(row.id);
      expect(row.automation_id).toBe(
        automationId(workspaceId, `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`)
      );
      const ctx = JSON.parse(row.chain_context_json!) as {
        variables: Record<string, string>;
        roleModels: Record<string, ModelSelection>;
      };
      expect(ctx.variables).toEqual(
        {
          ...buildKickoffVariables(
            DOCUMENTED_FEATURE_ID,
            DOCUMENTED_SLUG,
            DOCUMENTED_IDEA
          ),
          researchApprovalPolicy: "none",
        }
      );
      expect(ctx.roleModels.planner).toEqual({ id: "planner-default" });
      expect(ctx.roleModels.implementer).toEqual({
        id: "implementer-default",
        params: [{ id: "fast", value: "true" }],
      });
      expect(countAutomations(db)).toBe(8);
      const integrate = db
        .prepare(
          `SELECT config_key, model_role FROM automations WHERE config_key = ?`
        )
        .get("generated:integrate-wave") as
        | { config_key: string; model_role: string | null }
        | undefined;
      expect(integrate).toEqual({
        config_key: "generated:integrate-wave",
        model_role: "reviewer",
      });
    });
  });

  it("idea-only kickoff persists derived id/slug and leaves the roadmap index unchanged", async () => {
    await withServer(async ({ db, workspacePath, client }) => {
      const indexPath = join(workspacePath, "docs", "roadmap", "00-index.md");
      const before = readFileSync(indexPath, "utf8");
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, IDEA_ARGS);
        log.mockRestore();
      } finally {
        process.chdir(prev);
      }

      expect(readFileSync(indexPath, "utf8")).toBe(before);
      expect(countRuns(db)).toBe(1);
      const ctx = JSON.parse(
        (
          db
            .prepare(`SELECT chain_context_json FROM runs LIMIT 1`)
            .get() as { chain_context_json: string }
        ).chain_context_json
      ) as { variables: Record<string, string> };
      expect(ctx.variables).toEqual(
        {
          ...buildKickoffVariables(NEXT_FEATURE_ID, IDEA_SLUG, IDEA_TEXT),
          researchApprovalPolicy: "none",
        }
      );
    });
  });

  it("resolver refusal writes no automations or runs", async () => {
    await withServer(async ({ db, workspacePath, client }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        await expect(
          cmdImplementFully(client, ["--feature", "b77"])
        ).rejects.toThrow(/Feature b77 not found in roadmap index/);
      } finally {
        process.chdir(prev);
      }
      expect(countAutomations(db)).toBe(0);
      expect(countRuns(db)).toBe(0);
    });
  });

  it("dry-run writes nothing and prints maxDepth: 1 plus canonical triple", async () => {
    await withServer(async ({ db, workspacePath, client }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      const lines: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((...a) => {
        lines.push(a.map(String).join(" "));
      });
      try {
        await cmdImplementFully(client, [...FEATURE_ARGS, "--dry-run"]);
      } finally {
        log.mockRestore();
        process.chdir(prev);
      }
      expect(countAutomations(db)).toBe(0);
      expect(countRuns(db)).toBe(0);
      const joined = lines.join("\n");
      expect(joined).toMatch(/"maxDepth": 1/);
      expect(joined).toMatch(/Dry run/);
      expect(joined).toContain(DOCUMENTED_FEATURE_ID);
      expect(joined).toContain(DOCUMENTED_SLUG);
      expect(joined).toContain("Ship the kickoff verb");
    });
  });

  it("refuses when a role has neither override nor default, before apply", async () => {
    await withServer(
      async ({ db, workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        try {
          await expect(
            cmdImplementFully(client, FEATURE_ARGS)
          ).rejects.toThrow(/Unresolved pipeline role/);
        } finally {
          process.chdir(prev);
        }
        expect(countAutomations(db)).toBe(0);
        expect(countRuns(db)).toBe(0);
      },
      { settings: { ...DEFAULT_SETTINGS, pipelineRoleModels: {} } }
    );
  });

  it("override beats default; default params reach roleModels intact", async () => {
    await withServer(async ({ db, workspacePath, client }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmdImplementFully(client, [
          ...FEATURE_ARGS,
          "--role",
          "planner=cli-planner",
        ]);
      } finally {
        log.mockRestore();
        process.chdir(prev);
      }
      const ctx = JSON.parse(
        (
          db
            .prepare(`SELECT chain_context_json FROM runs LIMIT 1`)
            .get() as { chain_context_json: string }
        ).chain_context_json
      ) as { roleModels: Record<string, ModelSelection> };
      expect(ctx.roleModels.planner).toEqual({ id: "cli-planner" });
      expect(ctx.roleModels.implementer).toEqual({
        id: "implementer-default",
        params: [{ id: "fast", value: "true" }],
      });
    });
  });

  it("resolves --workspace by id, name, and path tail", async () => {
    await withServer(async ({ workspacePath, workspaceId, client }) => {
      const prev = process.cwd();
      // cwd elsewhere so --workspace is required
      process.chdir(tmpdir());
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmdImplementFully(client, [
          ...FEATURE_ARGS,
          "--workspace",
          workspaceId,
          "--dry-run",
        ]);
        await cmdImplementFully(client, [
          ...FEATURE_ARGS,
          "--workspace",
          "Workspace",
          "--dry-run",
        ]);
        await cmdImplementFully(client, [
          ...FEATURE_ARGS,
          "--workspace",
          "workspace",
          "--dry-run",
        ]);
      } finally {
        log.mockRestore();
        process.chdir(prev);
      }
      expect(existsSync(join(workspacePath, "docs", "roadmap", "00-index.md"))).toBe(
        true
      );
    });
  });

  it("errors when cwd is unregistered", async () => {
    await withServer(async ({ client }) => {
      const prev = process.cwd();
      const orphan = mkdtempSync(join(tmpdir(), "lca-orphan-"));
      mkdirSync(join(orphan, ".git"), { recursive: true });
      process.chdir(orphan);
      try {
        await expect(cmdImplementFully(client, FEATURE_ARGS)).rejects.toThrow(
          /not inside a registered workspace/
        );
      } finally {
        process.chdir(prev);
        rmSync(orphan, { recursive: true, force: true });
      }
    });
  });

  it("errors when .git is missing with daemon-owned wording", async () => {
    await withServer(
      async ({ workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        try {
          await expect(cmdImplementFully(client, FEATURE_ARGS)).rejects.toThrow(
            /not a git repository/
          );
        } finally {
          process.chdir(prev);
        }
      },
      { seedDisk: { git: false, roadmap: true } }
    );
  });

  it("errors when docs/roadmap/00-index.md is missing with daemon-owned wording", async () => {
    await withServer(
      async ({ workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        try {
          await expect(cmdImplementFully(client, FEATURE_ARGS)).rejects.toThrow(
            /roadmap index not found/i
          );
        } finally {
          process.chdir(prev);
        }
      },
      { seedDisk: { git: true, roadmap: false } }
    );
  });

  it("guard refuses an active pipeline run and --force proceeds", async () => {
    await withServer(async ({ db, workspacePath, workspaceId, client }) => {
      // Provision once so workers exist, then seed a non-terminal run.
      await client.provisionPipelineWorkers(IMPLEMENT_FULLY_PIPELINE_ID, {
        workspaceId,
        dryRun: false,
      });
      const entryId = automationId(
        workspaceId,
        `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
      );
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status)
         VALUES ('blocking-run', ?, ?, 'running')`
      ).run(entryId, workspaceId);

      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        await expect(cmdImplementFully(client, FEATURE_ARGS)).rejects.toThrow(
          /blocking-run/
        );
        expect(countRuns(db)).toBe(1);

        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, [...FEATURE_ARGS, "--force"]);
        log.mockRestore();
        expect(countRuns(db)).toBe(2);
      } finally {
        process.chdir(prev);
      }
    });
  });

  it("a terminal run on the same worker does not block", async () => {
    await withServer(async ({ db, workspacePath, workspaceId, client }) => {
      await client.provisionPipelineWorkers(IMPLEMENT_FULLY_PIPELINE_ID, {
        workspaceId,
        dryRun: false,
      });
      const entryId = automationId(
        workspaceId,
        `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
      );
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status)
         VALUES ('old-done', ?, ?, 'completed')`
      ).run(entryId, workspaceId);

      const prev = process.cwd();
      process.chdir(workspacePath);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmdImplementFully(client, FEATURE_ARGS);
      } finally {
        log.mockRestore();
        process.chdir(prev);
      }
      expect(countRuns(db)).toBe(2);
    });
  });

  it("conflict with dashboard-origin automation names the worker and creates no run", async () => {
    await withServer(async ({ db, workspacePath, workspaceId, client }) => {
      const conflictId = automationId(workspaceId, "generated:plan-phase");
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, origin
        ) VALUES (?, ?, 'Dashboard Claim', 1, 'enabled', ?, 'dash', NULL,
          '__dashboard__', 'generated:plan-phase', 'dashboard')`
      ).run(conflictId, workspaceId, JSON.stringify({ type: "manual" }));

      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        await expect(cmdImplementFully(client, FEATURE_ARGS)).rejects.toThrow(
          /plan-phase/
        );
      } finally {
        process.chdir(prev);
      }
      expect(countRuns(db)).toBe(0);
      // Only the pre-seeded dashboard row — no generated workers applied.
      expect(countAutomations(db)).toBe(1);
    });
  });

  it("cwd fallback picks the longest registered path match", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-4c-nest-"));
    const parentPath = join(root, "parent");
    const childPath = join(parentPath, "child");
    try {
      await withServer(
        async ({ client, db }) => {
          // Re-seed parent/child into this server's db via extraWorkspaces —
          // withServer already inserted them. chdir into child.
          const prev = process.cwd();
          process.chdir(childPath);
          const log = vi.spyOn(console, "log").mockImplementation(() => {});
          try {
            await cmdImplementFully(client, [...FEATURE_ARGS, "--dry-run"]);
          } finally {
            log.mockRestore();
            process.chdir(prev);
          }
          // Dry-run against child: no automations in either workspace.
          expect(countAutomations(db)).toBe(0);
        },
        {
          extraWorkspaces: [
            { path: parentPath, name: "parent" },
            { path: childPath, name: "child" },
          ],
          // Primary workspace is unused; we chdir into child.
        }
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
