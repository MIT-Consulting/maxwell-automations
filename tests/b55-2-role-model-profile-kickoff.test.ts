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
  DEFAULT_ROLE_MODEL_PROFILE_ID,
  IMPLEMENT_FULLY_PIPELINE_ID,
  KickoffError,
  resolveRoleModelProfileDefaults,
  resolveRoleRecipe,
  type ModelSelection,
  type PipelineIntrospectionResponse,
  type PipelineModelRole,
} from "@lca/shared";
import { DaemonClient } from "../packages/cli/src/client.ts";
import {
  cmdImplementFully,
  parseImplementFullyArgs,
} from "../packages/cli/src/implement-fully.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
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
  toPipelineIntrospection,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
});

type Db = ReturnType<typeof openDatabase>;

const DOCUMENTED_FEATURE_ID = "b55";
const DOCUMENTED_SLUG = "b55-named-pipeline-role-model-profiles";
const DOCUMENTED_IDEA =
  "Named pipeline role-model profiles. Prior art: docs/roadmap/done/b55-named-pipeline-role-model-profiles/prd.md.";

const QUALITY_DEFAULTS: Partial<Record<PipelineModelRole, ModelSelection>> = {
  planner: { id: "gpt-5.6-sol" },
  implementer: { id: "grok-4.5" },
  reviewer: { id: "claude-opus-5" },
  docs: { id: "composer-2.5" },
};

const CHEAP_PROFILE: Partial<Record<PipelineModelRole, ModelSelection>> = {
  planner: { id: "grok-4.5" },
  implementer: { id: "composer-2.5" },
  reviewer: { id: "grok-4.5" },
  docs: { id: "composer-2.5" },
};

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
      `- **${DOCUMENTED_FEATURE_ID}** Role model profiles. — [docs](./${DOCUMENTED_SLUG}/00-index.md)`,
      "",
    ].join("\n"),
    "utf8"
  );
  const featureDir = join(workspacePath, "docs", "roadmap", DOCUMENTED_SLUG);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, "00-index.md"), "# b55\n", "utf8");
  writeFileSync(join(featureDir, "prd.md"), "# prd\n", "utf8");
}

function seedWorkspaceDisk(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  writeRoadmapIndex(workspacePath);
}

function buildIntrospection(
  settings: Pick<
    ResolvedSettings,
    | "pipelineRoleModels"
    | "pipelineRoleModelProfiles"
    | "defaultPipelineRoleModelProfile"
  >
): PipelineIntrospectionResponse {
  return toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, settings);
}

async function withServer(
  settings: ResolvedSettings,
  run: (args: { client: DaemonClient; workspacePath: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b55-2-"));
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
  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  try {
    await run({ client, workspacePath });
  } finally {
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b55.2 resolveRoleModelProfileDefaults", () => {
  const introspection = buildIntrospection({
    pipelineRoleModels: QUALITY_DEFAULTS,
    pipelineRoleModelProfiles: { cheap: CHEAP_PROFILE },
    defaultPipelineRoleModelProfile: "cheap",
  });

  it("uses defaultRoleModelProfileId when profileId is omitted", () => {
    const resolved = resolveRoleModelProfileDefaults(undefined, introspection);
    expect(resolved).toEqual(CHEAP_PROFILE);
    expect(resolved).not.toBe(introspection.roleDefaults);
  });

  it("selects a named profile by id", () => {
    const resolved = resolveRoleModelProfileDefaults("cheap", introspection);
    expect(resolved).toEqual(CHEAP_PROFILE);
  });

  it("selects synthetic default when explicitly requested", () => {
    const resolved = resolveRoleModelProfileDefaults("default", introspection);
    expect(resolved).toEqual(QUALITY_DEFAULTS);
  });

  it("throws for unknown profile ids with valid id list", () => {
    expect(() =>
      resolveRoleModelProfileDefaults("missing", introspection)
    ).toThrow(KickoffError);
    expect(() =>
      resolveRoleModelProfileDefaults("missing", introspection)
    ).toThrow(/Unknown role model profile "missing"/);
    expect(() =>
      resolveRoleModelProfileDefaults("missing", introspection)
    ).toThrow(/default, cheap/);
  });

  it("lets --role overrides win over profile defaults", () => {
    const base = resolveRoleModelProfileDefaults("cheap", introspection);
    const recipe = resolveRoleRecipe(
      ["planner", "implementer", "reviewer", "docs"],
      { planner: "override-model" },
      base
    );
    expect(recipe.roleModels.planner).toEqual({ id: "override-model" });
    expect(recipe.sources.planner).toBe("override");
    expect(recipe.roleModels.implementer).toEqual(CHEAP_PROFILE.implementer);
    expect(recipe.sources.implementer).toBe("default");
  });
});

describe("b55.2 introspection role-model profiles", () => {
  it("always includes synthetic default and defaultRoleModelProfileId default", () => {
    const body = buildIntrospection({
      pipelineRoleModels: {},
      pipelineRoleModelProfiles: {},
      defaultPipelineRoleModelProfile: null,
    });
    expect(body.defaultRoleModelProfileId).toBe(DEFAULT_ROLE_MODEL_PROFILE_ID);
    expect(body.roleModelProfiles.map((p) => p.id)).toEqual(["default"]);
    expect(body.roleModelProfiles[0]).toMatchObject({
      id: "default",
      label: "Default",
      roleModels: {},
    });
    expect(body.roleDefaults).toEqual({});
  });

  it("lists named profiles in stable id order", () => {
    const body = buildIntrospection({
      pipelineRoleModels: QUALITY_DEFAULTS,
      pipelineRoleModelProfiles: {
        cheap: CHEAP_PROFILE,
        quality: QUALITY_DEFAULTS,
      },
      defaultPipelineRoleModelProfile: null,
    });
    expect(body.roleModelProfiles.map((p) => p.id)).toEqual([
      "default",
      "cheap",
      "quality",
    ]);
    expect(body.roleDefaults).toEqual(QUALITY_DEFAULTS);
    expect(body.defaultRoleModelProfileId).toBe("default");
  });

  it("sets roleDefaults from defaultPipelineRoleModelProfile when configured", () => {
    const body = buildIntrospection({
      pipelineRoleModels: QUALITY_DEFAULTS,
      pipelineRoleModelProfiles: { cheap: CHEAP_PROFILE },
      defaultPipelineRoleModelProfile: "cheap",
    });
    expect(body.defaultRoleModelProfileId).toBe("cheap");
    expect(body.roleDefaults).toEqual(CHEAP_PROFILE);
    expect(body.roleModelProfiles.find((p) => p.id === "cheap")?.roleModels).toEqual(
      CHEAP_PROFILE
    );
  });
});

describe("b55.2 CLI --role-profile", () => {
  it("parses --role-profile and keeps --profile planning-only", () => {
    const parsed = parseImplementFullyArgs([
      "--feature",
      DOCUMENTED_FEATURE_ID,
      "--role-profile",
      "cheap",
      "--profile",
      "deep",
    ]);
    expect(parsed.roleProfile).toBe("cheap");
    expect(parsed.profile).toBe("deep");
  });

  it("dry-run selects cheap recipe unless --role overrides", async () => {
    const settings: ResolvedSettings = {
      ...DEFAULT_SETTINGS,
      pipelineRoleModels: QUALITY_DEFAULTS,
      pipelineRoleModelProfiles: { cheap: CHEAP_PROFILE },
      defaultPipelineRoleModelProfile: "cheap",
    };

    await withServer(settings, async ({ client, workspacePath }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, [
          "--feature",
          DOCUMENTED_FEATURE_ID,
          "--role-profile",
          "cheap",
          "--dry-run",
        ]);
        const cheapOut = log.mock.calls.map((c) => String(c[0])).join("\n");
        log.mockRestore();
        expect(cheapOut).toMatch(/planner: grok-4\.5/);
        expect(cheapOut).toMatch(/implementer: composer-2\.5/);

        const log2 = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, [
          "--feature",
          DOCUMENTED_FEATURE_ID,
          "--role-profile",
          "cheap",
          "--role",
          "planner=override-model",
          "--dry-run",
        ]);
        const overrideOut = log2.mock.calls.map((c) => String(c[0])).join("\n");
        log2.mockRestore();
        expect(overrideOut).toMatch(/planner: override-model \(override\)/);
        expect(overrideOut).toMatch(/implementer: composer-2\.5 \(default\)/);
      } finally {
        process.chdir(prev);
      }
    });
  });

  it("rejects unknown --role-profile before writing", async () => {
    const settings: ResolvedSettings = {
      ...DEFAULT_SETTINGS,
      pipelineRoleModels: QUALITY_DEFAULTS,
      pipelineRoleModelProfiles: { cheap: CHEAP_PROFILE },
      defaultPipelineRoleModelProfile: null,
    };

    await withServer(settings, async ({ client, workspacePath }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        await expect(
          cmdImplementFully(client, [
            "--feature",
            DOCUMENTED_FEATURE_ID,
            "--role-profile",
            "missing",
            "--dry-run",
          ])
        ).rejects.toThrow(/Unknown role model profile "missing"/);
      } finally {
        process.chdir(prev);
      }
    });
  });

  it("uses default profile from settings when --role-profile is omitted", async () => {
    const settings: ResolvedSettings = {
      ...DEFAULT_SETTINGS,
      pipelineRoleModels: QUALITY_DEFAULTS,
      pipelineRoleModelProfiles: { cheap: CHEAP_PROFILE },
      defaultPipelineRoleModelProfile: "cheap",
    };

    await withServer(settings, async ({ client, workspacePath }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdImplementFully(client, [
          "--feature",
          DOCUMENTED_FEATURE_ID,
          "--dry-run",
        ]);
        const out = log.mock.calls.map((c) => String(c[0])).join("\n");
        log.mockRestore();
        expect(out).toMatch(/planner: grok-4\.5/);
      } finally {
        process.chdir(prev);
      }
    });
  });
});
