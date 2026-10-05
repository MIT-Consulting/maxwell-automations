import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CHAIN_RENDERED_PROMPT_MAX_BYTES,
  IMPLEMENT_FULLY_PIPELINE_ID,
  PIPELINE_DIRECTIVE_MAX_COUNT,
  formatOperatorStopReason,
  projectPipelineFeedPayload,
  rejectsReservedStopReasonPrefix,
  resolvePipelineStopFrontier,
  validatePipelineDirectiveAppend,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import {
  appendOperatorDirectivesBlock,
  escapeOperatorDirectiveText,
  mergeDirectiveRoleOverrides,
} from "../packages/daemon/src/runs/pipeline-directive-render.ts";
import {
  buildChainedPromptOverride,
} from "../packages/daemon/src/runs/chain-runner.ts";
import {
  appendPipelineDirectiveForRoot,
  applyPipelineStopAfterStep,
} from "../packages/daemon/src/runs/pipeline-steering.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { parseEscalateArgs } from "../packages/cli/src/cli.ts";
type Db = ReturnType<typeof openDatabase>;

function schemaVersion(db: Db): number {
  const row = db
    .prepare(
      "SELECT MAX(version) AS version FROM schema_migrations"
    )
    .get() as { version: number | null };
  return row.version ?? 0;
}

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn not expected");
    },
    resume: async () => {
      throw new Error("resume not expected");
    },
  };
}

function seedWorkspace(db: Db, path: string): string {
  mkdirSync(path, { recursive: true });
  const id = "ws-steer";
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    id,
    path,
    "Steer"
  );
  return id;
}

function chainContextJson(featureId: string): string {
  return JSON.stringify({
    variables: {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId,
      featureSlug: featureId,
      featureDir: `docs/roadmap/${featureId}`,
      featureIndex: `docs/roadmap/${featureId}/00-index.md`,
      idea: "idea",
      planningDepth: "full",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode: "normal",
    },
    roleModels: {
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
    },
  });
}

function insertAutomation(db: Db, workspaceId: string, id: string, configKey: string) {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key
    ) VALUES (?, ?, ?, 1, 'enabled', ?, 'target prompt', NULL, 't.yaml', ?)`
  ).run(
    id,
    workspaceId,
    configKey,
    JSON.stringify({ type: "manual" }),
    configKey
  );
}

function insertRun(
  db: Db,
  args: {
    id: string;
    automationId: string;
    workspaceId: string;
    rootId: string;
    depth: number;
    status?: string;
    parentId?: string | null;
    pipelineTrackId?: string | null;
    pipelineWaveId?: string | null;
  }
) {
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status, trigger_kind, prompt,
       parent_run_id, chain_root_run_id, chain_depth, chain_max_depth,
       chain_context_json, pipeline_track_id, pipeline_wave_id,
       created_at, updated_at, started_at
     ) VALUES (?, ?, ?, ?, 'manual', 'prompt', ?, ?, ?, 9, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.status ?? "running",
    args.parentId ?? null,
    args.rootId,
    args.depth,
    chainContextJson("b81"),
    args.pipelineTrackId ?? null,
    args.pipelineWaveId ?? null
  );
}

function createEnv() {
  const root = mkdtempSync(join(tmpdir(), "lca-b81-steer-"));
  const workspacePath = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  migrate(db);
  const workspaceId = seedWorkspace(db, workspacePath);
  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const dash = new DashboardStore(db);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    events,
    inputHub,
    maxConcurrentRuns: 2,
  });
  return { root, db, store, dash, engine, workspaceId, events };
}

describe("b81 pipeline steering", () => {
  it("migrates to SCHEMA_VERSION 24 with pipeline_directives table", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b81-mig-"));
    const db = openDatabase(join(root, "state.sqlite"));
    migrate(db);
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(24);
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_directives'"
      )
      .get();
    expect(table).toBeTruthy();
    migrate(db);
    expect(schemaVersion(db)).toBe(24);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("validates directive append and reserved stop prefixes", () => {
    expect(validatePipelineDirectiveAppend({ kind: "note", text: "hello" }).ok).toBe(
      true
    );
    expect(
      validatePipelineDirectiveAppend({ kind: "note", text: "   " }).ok
    ).toBe(false);
    expect(
      validatePipelineDirectiveAppend({
        kind: "role-override",
        roleModels: { reviewer: { id: "" } },
      }).ok
    ).toBe(false);
    expect(
      validatePipelineDirectiveAppend({
        kind: "role-override",
        roleModels: { reviewer: { notAModel: true } as never },
      }).ok
    ).toBe(false);
    expect(rejectsReservedStopReasonPrefix("complete: fake")).toBe(true);
    expect(rejectsReservedStopReasonPrefix("operator-stop: ok")).toBe(false);
    expect(formatOperatorStopReason("bot-a", "hold")).toMatch(
      /^operator-stop: bot-a hold$/
    );
    expect(() => formatOperatorStopReason(undefined, "complete: nope")).toThrow();
  });

  it("projects directive and stop-requested feed metadata", () => {
    const directive = projectPipelineFeedPayload(
      "run.pipeline-directive",
      JSON.stringify({
        kind: "note",
        directiveId: "dir-1",
        actorId: "bot-a",
      })
    );
    expect(directive.kind).toBe("note");
    expect(directive.directiveId).toBe("dir-1");
    expect(directive.actorId).toBe("bot-a");

    const stop = projectPipelineFeedPayload(
      "run.pipeline-stop-requested",
      JSON.stringify({
        frontierRunId: "front-1",
        stopReason: "operator-stop: operator hold",
        actorId: "bot-a",
      })
    );
    expect(stop.frontierRunId).toBe("front-1");
    expect(stop.stopReason).toContain("operator-stop:");
  });

  it("resolves stop frontier for running or paused workers", () => {
    const candidates = [
      {
        id: "root",
        status: "running",
        parentRunId: null,
        chainRootRunId: "root",
      },
      {
        id: "child",
        status: "running",
        parentRunId: "root",
        chainRootRunId: "root",
      },
    ];
    expect(
      resolvePipelineStopFrontier({ rootRunId: "root", candidates })
    ).toEqual({ kind: "resolved", runId: "child" });

    const paused = [
      ...candidates.map((c) =>
        c.id === "child" ? { ...c, status: "paused" } : c
      ),
    ];
    expect(
      resolvePipelineStopFrontier({ rootRunId: "root", candidates: paused })
    ).toEqual({ kind: "resolved", runId: "child" });
  });

  it("appends notes, merges role overrides, and renders prompt block", () => {
    const env = createEnv();
    const rootId = "root-1";
    const autoRoot = "auto-root";
    const autoChild = "auto-child";
    insertAutomation(env.db, env.workspaceId, autoRoot, "generated:kickoff");
    insertAutomation(env.db, env.workspaceId, autoChild, "generated:implement");
    insertRun(env.db, {
      id: rootId,
      automationId: autoRoot,
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
    });
    insertRun(env.db, {
      id: "child-1",
      automationId: autoChild,
      workspaceId: env.workspaceId,
      rootId,
      depth: 1,
      parentId: rootId,
      status: "completed",
    });

    env.store.appendPipelineDirective({
      rootRunId: rootId,
      kind: "note",
      actorId: "bot-a",
      body: { text: "watch the caps" },
    });
    env.store.appendPipelineDirective({
      rootRunId: rootId,
      kind: "role-override",
      body: { roleModels: { reviewer: { id: "reviewer-override" } } },
    });

    const directives = env.store.listPipelineDirectives(rootId);
    expect(directives).toHaveLength(2);

    const merged = mergeDirectiveRoleOverrides(
      JSON.parse(chainContextJson("b81")),
      directives
    );
    expect(merged.roleModels.reviewer?.id).toBe("reviewer-override");

    const block = appendOperatorDirectivesBlock("base prompt", directives);
    expect(block).toContain("--- operator directives");
    expect(block).toContain(escapeOperatorDirectiveText("watch the caps"));

    env.store.appendEvent("child-1", "run.finished", {
      result: "```text\nlca-handoff\nversion: 1\noutcome: implemented\n```",
    });
    const built = buildChainedPromptOverride(
      env.store,
      "child-1",
      "completed",
      "implement",
      env.store.getAutomation(autoChild)!,
      true,
      JSON.parse(chainContextJson("b81")),
      () => {}
    );
    expect(built.ok).toBe(true);
    if (built.ok && built.promptOverride) {
      expect(built.promptOverride).toContain("operator directives");
      expect(built.promptOverride).toContain("watch the caps");
    }

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("enforces directive count cap by dropping oldest", () => {
    const env = createEnv();
    const rootId = "root-cap";
    insertAutomation(env.db, env.workspaceId, "auto-cap", "generated:kickoff");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-cap",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
    });

    for (let i = 0; i < PIPELINE_DIRECTIVE_MAX_COUNT + 2; i += 1) {
      env.store.appendPipelineDirective({
        rootRunId: rootId,
        kind: "note",
        body: { text: `note-${i}` },
      });
    }
    const listed = env.store.listPipelineDirectives(rootId);
    expect(listed.length).toBeLessThanOrEqual(PIPELINE_DIRECTIVE_MAX_COUNT);
    expect(listed[listed.length - 1]?.body).toEqual({
      text: `note-${PIPELINE_DIRECTIVE_MAX_COUNT + 1}`,
    });

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("applies stop-after-step on frontier without cancelling", async () => {
    const env = createEnv();
    const rootId = "root-stop";
    insertAutomation(env.db, env.workspaceId, "auto-r", "generated:kickoff");
    insertAutomation(env.db, env.workspaceId, "auto-i", "generated:implement");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-r",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
    });
    insertRun(env.db, {
      id: "frontier",
      automationId: "auto-i",
      workspaceId: env.workspaceId,
      rootId,
      depth: 1,
      parentId: rootId,
      status: "running",
    });

    const result = applyPipelineStopAfterStep({
      store: env.store,
      dashboardStore: env.dash,
      engine: env.engine,
      rootRunId: rootId,
      reason: "hold here",
      actorId: "bot-a",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const frontier = env.store.getRun("frontier")!;
    expect(frontier.status).toBe("running");
    expect(frontier.chain_stop_requested_at).toBeTruthy();
    expect(frontier.chain_stop_reason).toMatch(/^operator-stop: bot-a/);

    const dup = applyPipelineStopAfterStep({
      store: env.store,
      dashboardStore: env.dash,
      engine: env.engine,
      rootRunId: rootId,
    });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.reason).toBe("already-stopped");

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("refuses stop on wave-track frontiers", () => {
    const env = createEnv();
    const rootId = "root-wave";
    insertAutomation(env.db, env.workspaceId, "auto-r", "generated:kickoff");
    insertAutomation(env.db, env.workspaceId, "auto-i", "generated:implement");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-r",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
    });
    insertRun(env.db, {
      id: "wave-front",
      automationId: "auto-i",
      workspaceId: env.workspaceId,
      rootId,
      depth: 1,
      parentId: rootId,
      status: "running",
      pipelineTrackId: "track-1",
      pipelineWaveId: "wave-1",
    });

    const result = applyPipelineStopAfterStep({
      store: env.store,
      dashboardStore: env.dash,
      engine: env.engine,
      rootRunId: rootId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("wave-track");
    expect(result.message).toContain("lca wave wave-1 retry|abort");

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("appendPipelineDirectiveForRoot emits lifecycle event on root", async () => {
    const env = createEnv();
    const rootId = "root-dir";
    insertAutomation(env.db, env.workspaceId, "auto-r", "generated:kickoff");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-r",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
    });
    insertRun(env.db, {
      id: "child",
      automationId: "auto-r",
      workspaceId: env.workspaceId,
      rootId,
      depth: 1,
      parentId: rootId,
      status: "running",
    });

    const appended = await appendPipelineDirectiveForRoot({
      store: env.store,
      dashboardStore: env.dash,
      engine: env.engine,
      rootRunId: rootId,
      request: { kind: "note", text: "forward this" },
      actorId: "bot-a",
    });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const events = env.db
      .prepare(
        `SELECT event_type, payload FROM run_events WHERE run_id = ? AND event_type = 'run.pipeline-directive'`
      )
      .all(rootId) as Array<{ event_type: string; payload: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload.directiveId).toBe(appended.id);
    expect(payload.actorId).toBe("bot-a");
    expect(JSON.stringify(payload)).not.toContain("forward this");

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("parseEscalateArgs accepts running role-only escalate", () => {
    const parsed = parseEscalateArgs([
      "--feature",
      "b81",
      "--role",
      "reviewer=reviewer-model",
    ]);
    expect(parsed.roleDirectiveOnly).toBe(true);
    expect(parsed.action).toBeUndefined();
    expect(parsed.roleModels?.reviewer?.id).toBe("reviewer-model");
  });

  it("parseEscalateArgs keeps halted actions and refuses --role with abort", () => {
    const retry = parseEscalateArgs(["run-halted", "retry"]);
    expect(retry.roleDirectiveOnly).toBe(false);
    expect(retry.action).toBe("retry");
    const skipRole = parseEscalateArgs([
      "--feature",
      "b81",
      "skip",
      "--role",
      "reviewer=reviewer-model",
    ]);
    expect(skipRole.roleDirectiveOnly).toBe(false);
    expect(skipRole.action).toBe("skip");
    expect(() =>
      parseEscalateArgs(["run-halted", "abort", "--role", "reviewer=reviewer-model"])
    ).toThrow(/--role is only valid with retry or skip/);
  });

  it("cascades directive deletion when root run is removed", () => {
    const env = createEnv();
    const rootId = "root-cascade";
    insertAutomation(env.db, env.workspaceId, "auto-r", "generated:kickoff");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-r",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
      status: "completed",
    });
    env.store.appendPipelineDirective({
      rootRunId: rootId,
      kind: "note",
      body: { text: "survives until root delete" },
    });
    env.db.prepare("DELETE FROM runs WHERE id = ?").run(rootId);
    const count = env.db
      .prepare("SELECT COUNT(*) AS n FROM pipeline_directives")
      .get() as { n: number };
    expect(count.n).toBe(0);

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("directives survive event pruning", () => {
    const env = createEnv();
    const rootId = "root-prune";
    insertAutomation(env.db, env.workspaceId, "auto-prune", "generated:kickoff");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-prune",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
    });
    env.store.appendPipelineDirective({
      rootRunId: rootId,
      kind: "note",
      body: { text: "keep me after prune" },
    });
    for (let i = 0; i < 8; i += 1) {
      env.store.appendEvent(rootId, "run.progress", { i });
    }
    env.store.pruneRunEvents(rootId, 2);
    const listed = env.store.listPipelineDirectives(rootId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.body).toEqual({ text: "keep me after prune" });

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("escapes operator notes and drops oldest when the byte budget is tight", () => {
    expect(escapeOperatorDirectiveText("use `code`")).toContain("\\`");
    const composed = "p".repeat(CHAIN_RENDERED_PROMPT_MAX_BYTES - 650);
    const rendered = appendOperatorDirectivesBlock(composed, [
      {
        id: "old",
        kind: "note",
        actorId: null,
        body: { text: "oldest-should-drop ".repeat(20) },
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "new",
        kind: "note",
        actorId: null,
        body: { text: "newest-should-keep" },
        createdAt: "2026-01-01T00:00:01Z",
      },
    ]);
    expect(rendered).toContain("newest-should-keep");
    expect(rendered).not.toContain("oldest-should-drop");
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(
      CHAIN_RENDERED_PROMPT_MAX_BYTES
    );
  });

  it("later role-override wins merge order", () => {
    const merged = mergeDirectiveRoleOverrides(
      JSON.parse(chainContextJson("b81")),
      [
        {
          id: "first",
          kind: "role-override",
          actorId: null,
          body: { roleModels: { reviewer: { id: "first-reviewer" } } },
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "second",
          kind: "role-override",
          actorId: null,
          body: { roleModels: { reviewer: { id: "second-reviewer" } } },
          createdAt: "2026-01-01T00:00:01Z",
        },
      ]
    );
    expect(merged.roleModels.reviewer?.id).toBe("second-reviewer");
    expect(merged.roleModels.implementer?.id).toBe("implementer-model");
  });

  it("applies stop-after-step on a paused frontier", () => {
    const env = createEnv();
    const rootId = "root-paused";
    insertAutomation(env.db, env.workspaceId, "auto-r", "generated:kickoff");
    insertAutomation(env.db, env.workspaceId, "auto-i", "generated:implement");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-r",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
      status: "completed",
    });
    insertRun(env.db, {
      id: "paused-front",
      automationId: "auto-i",
      workspaceId: env.workspaceId,
      rootId,
      depth: 1,
      parentId: rootId,
      status: "paused",
    });

    const result = applyPipelineStopAfterStep({
      store: env.store,
      dashboardStore: env.dash,
      engine: env.engine,
      rootRunId: rootId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frontier = env.store.getRun("paused-front")!;
    expect(frontier.status).toBe("paused");
    expect(frontier.chain_stop_requested_at).toBeTruthy();

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });

  it("refuses reserved stop prefixes and does not pick among multiple frontiers", () => {
    const env = createEnv();
    const rootId = "root-multi";
    insertAutomation(env.db, env.workspaceId, "auto-r", "generated:kickoff");
    insertAutomation(env.db, env.workspaceId, "auto-i", "generated:implement");
    insertRun(env.db, {
      id: rootId,
      automationId: "auto-r",
      workspaceId: env.workspaceId,
      rootId,
      depth: 0,
    });
    insertRun(env.db, {
      id: "front-a",
      automationId: "auto-i",
      workspaceId: env.workspaceId,
      rootId,
      depth: 1,
      parentId: rootId,
      status: "running",
    });
    insertRun(env.db, {
      id: "front-b",
      automationId: "auto-i",
      workspaceId: env.workspaceId,
      rootId,
      depth: 1,
      parentId: rootId,
      status: "running",
    });

    const reserved = applyPipelineStopAfterStep({
      store: env.store,
      dashboardStore: env.dash,
      engine: env.engine,
      rootRunId: rootId,
      reason: "complete: impersonate",
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) {
      expect(reserved.reason).toBe("validation");
    }

    const multi = applyPipelineStopAfterStep({
      store: env.store,
      dashboardStore: env.dash,
      engine: env.engine,
      rootRunId: rootId,
      reason: "hold",
    });
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.reason).toBe("ambiguous-frontier");
    }
    expect(env.store.getRun("front-a")!.chain_stop_requested_at).toBeNull();
    expect(env.store.getRun("front-b")!.chain_stop_requested_at).toBeNull();

    env.db.close();
    rmSync(env.root, { recursive: true, force: true });
  });
});
