import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_PIPELINE_ID,
  describePipelineStep,
  pipelineSummaryFromContext,
  workerKeyFromConfigKey,
  type ChainRunContext,
  type Run,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import {
  GENERATED_CONFIG_KEY_PREFIX as DAEMON_GENERATED_PREFIX,
} from "../packages/daemon/src/config/generated-workers.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY as DAEMON_ENTRY_KEY,
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";

type Db = ReturnType<typeof openDatabase>;

const IDEA_TEXT =
  "SECRET_IDEA_TEXT_MUST_NOT_APPEAR_IN_LIST_RESPONSE_b36_5a";

function fullContext(overrides?: Partial<ChainRunContext["variables"]>): ChainRunContext {
  return {
    variables: {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b42",
      featureSlug: "b42-example",
      featureDir: "docs/roadmap/b42-example",
      featureIndex: "docs/roadmap/b42-example/00-index.md",
      idea: IDEA_TEXT,
      ...overrides,
    },
    roleModels: {
      planner: { id: "composer-2.5" },
      implementer: { id: "composer-2.5" },
      reviewer: { id: "composer-2.5" },
      docs: { id: "composer-2.5" },
    },
  };
}

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

function seedAutomation(
  db: Db,
  opts: { id: string; workspaceId: string; configKey: string; name: string }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, origin
    ) VALUES (?, ?, ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, 'generated')`
  ).run(
    opts.id,
    opts.workspaceId,
    opts.name,
    JSON.stringify({ type: "manual" }),
    `Prompt for ${opts.name}`,
    opts.configKey
  );
}

describe("b36.05a shared pipeline constants", () => {
  it("loop keys match the three sequential workers after the entry worker, in order", () => {
    const afterEntry = IMPLEMENT_FULLY_WORKERS.slice(1).map((w) => w.key);
    expect(afterEntry.slice(0, IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length)).toEqual([
      ...IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
    ]);
    expect(afterEntry).toContain("integrate-wave");
    expect(IMPLEMENT_FULLY_WORKERS[0]!.key).toBe(IMPLEMENT_FULLY_ENTRY_WORKER_KEY);
  });

  it("daemon re-exports are identity-equal to the shared originals", () => {
    expect(DAEMON_GENERATED_PREFIX).toBe(GENERATED_CONFIG_KEY_PREFIX);
    expect(DAEMON_ENTRY_KEY).toBe(IMPLEMENT_FULLY_ENTRY_WORKER_KEY);
  });
});

describe("b36.05a workerKeyFromConfigKey", () => {
  it("strips the generated prefix and rejects non-generated keys", () => {
    expect(workerKeyFromConfigKey("generated:implement")).toBe("implement");
    expect(workerKeyFromConfigKey("generated:plan-skeleton")).toBe(
      "plan-skeleton"
    );
    expect(workerKeyFromConfigKey("dashboard:1234")).toBeNull();
    expect(workerKeyFromConfigKey("b21-implement")).toBeNull();
    expect(workerKeyFromConfigKey(null)).toBeNull();
    expect(workerKeyFromConfigKey(undefined)).toBeNull();
    expect(workerKeyFromConfigKey("generated:")).toBeNull();
  });
});

describe("b36.05a describePipelineStep", () => {
  const loop = [...IMPLEMENT_FULLY_LOOP_WORKER_KEYS];

  it("depth 0 entry worker is the skeleton (null cycle/step)", () => {
    expect(
      describePipelineStep(
        `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
        0
      )
    ).toEqual({
      workerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
  });

  it("depths 1–3 are cycle 1 with stepInCycle 1–3", () => {
    for (let i = 0; i < loop.length; i++) {
      const depth = i + 1;
      expect(
        describePipelineStep(`${GENERATED_CONFIG_KEY_PREFIX}${loop[i]}`, depth)
      ).toEqual({
        workerKey: loop[i],
        stepInCycle: i + 1,
        cycle: 1,
      });
    }
  });

  it("depth 4 starts cycle 2 at step 1; depth 6 is cycle 2 step 3", () => {
    expect(
      describePipelineStep(`${GENERATED_CONFIG_KEY_PREFIX}${loop[0]}`, 4)
    ).toEqual({
      workerKey: loop[0],
      stepInCycle: 1,
      cycle: 2,
    });
    expect(
      describePipelineStep(`${GENERATED_CONFIG_KEY_PREFIX}${loop[2]}`, 6)
    ).toEqual({
      workerKey: loop[2],
      stepInCycle: 3,
      cycle: 2,
    });
  });

  it("docs-commit config key yields stepInCycle null while workerKey is preserved", () => {
    expect(
      describePipelineStep(`${GENERATED_CONFIG_KEY_PREFIX}docs-commit`, 4)
    ).toEqual({
      workerKey: "docs-commit",
      stepInCycle: null,
      cycle: null,
    });
  });

  it("null depth and unknown worker key degrade to nulls", () => {
    expect(
      describePipelineStep(`${GENERATED_CONFIG_KEY_PREFIX}implement`, null)
    ).toEqual({
      workerKey: "implement",
      stepInCycle: 2,
      cycle: null,
    });
    expect(
      describePipelineStep(`${GENERATED_CONFIG_KEY_PREFIX}unknown-worker`, 3)
    ).toEqual({
      workerKey: "unknown-worker",
      stepInCycle: null,
      cycle: null,
    });
    expect(describePipelineStep("plain-key", 2)).toEqual({
      workerKey: null,
      stepInCycle: null,
      cycle: null,
    });
  });
});

describe("b36.05a pipelineSummaryFromContext", () => {
  it("returns the three identity fields from a full context", () => {
    expect(pipelineSummaryFromContext(fullContext())).toEqual({
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b42",
      featureSlug: "b42-example",
    });
  });

  it("returns null when any identity field is missing", () => {
    expect(
      pipelineSummaryFromContext(fullContext({ pipelineId: "" }))
    ).toBeNull();
    expect(
      pipelineSummaryFromContext(fullContext({ featureId: undefined }))
    ).toBeNull();
    const noSlug = fullContext();
    delete noSlug.variables.featureSlug;
    expect(pipelineSummaryFromContext(noSlug)).toBeNull();
    expect(pipelineSummaryFromContext(null)).toBeNull();
    expect(pipelineSummaryFromContext(undefined)).toBeNull();
  });

  it("never surfaces idea or roleModels on the summary", () => {
    const summary = pipelineSummaryFromContext(fullContext());
    expect(summary).not.toBeNull();
    expect(Object.keys(summary!)).toEqual([
      "pipelineId",
      "featureId",
      "featureSlug",
    ]);
    expect(JSON.stringify(summary)).not.toContain(IDEA_TEXT);
    expect(JSON.stringify(summary)).not.toContain("roleModels");
    expect(JSON.stringify(summary)).not.toContain("composer-2.5");
  });
});

describe("b36.05a GET /api/runs projection", () => {
  async function withServer(
    run: (args: {
      port: number;
      db: Db;
      workspaceId: string;
      store: RunStore;
    }) => Promise<void>
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-5a-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
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
      await run({ port, db, workspaceId, store });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("projects chain scalars and pipeline; omits idea; nulls for legacy", async () => {
    await withServer(async ({ port, db, workspaceId, store }) => {
      seedAutomation(db, {
        id: "auto-skeleton",
        workspaceId,
        configKey: `${GENERATED_CONFIG_KEY_PREFIX}plan-skeleton`,
        name: "Skeleton",
      });
      seedAutomation(db, {
        id: "auto-phase",
        workspaceId,
        configKey: `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`,
        name: "Plan phase",
      });
      seedAutomation(db, {
        id: "auto-legacy",
        workspaceId,
        configKey: "legacy-manual",
        name: "Legacy",
      });

      const ctx = fullContext();
      const rootId = "run-root";
      const childId = "run-child";
      const legacyId = "run-legacy";

      store.insertRun({
        id: rootId,
        automationId: "auto-skeleton",
        workspaceId,
        triggerKind: "manual",
        prompt: "root prompt",
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 9,
        chainContext: ctx,
      });
      store.insertRun({
        id: childId,
        automationId: "auto-phase",
        workspaceId,
        triggerKind: "chain",
        prompt: "child prompt",
        parentRunId: rootId,
        chainRootRunId: rootId,
        chainDepth: 1,
        chainMaxDepth: 9,
        chainContext: ctx,
      });
      db.prepare(
        `UPDATE runs SET
           chain_max_depth_override = 13,
           chain_stop_requested_at = '2026-01-01T00:00:00.000Z',
           chain_stop_reason = 'test-stop',
           chain_handled_at = '2026-01-02T00:00:00.000Z'
         WHERE id = ?`
      ).run(childId);

      store.insertRun({
        id: legacyId,
        automationId: "auto-legacy",
        workspaceId,
        triggerKind: "manual",
        prompt: "legacy prompt",
      });

      const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: Run[] };
      const byId = new Map(body.runs.map((r) => [r.id, r]));

      const root = byId.get(rootId)!;
      expect(root.chainRootRunId).toBe(rootId);
      expect(root.chainDepth).toBe(0);
      expect(root.chainMaxDepth).toBe(9);
      expect(root.chainMaxDepthOverride).toBeNull();
      expect(root.chainStopRequestedAt).toBeNull();
      expect(root.chainStopReason).toBeNull();
      expect(root.chainHandledAt).toBeNull();
      expect(root.pipeline).toEqual({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        featureId: "b42",
        featureSlug: "b42-example",
      });
      expect(root).not.toHaveProperty("chainContext");

      const child = byId.get(childId)!;
      expect(child.chainRootRunId).toBe(rootId);
      expect(child.chainDepth).toBe(1);
      expect(child.chainMaxDepth).toBe(9);
      expect(child.chainMaxDepthOverride).toBe(13);
      expect(child.chainStopRequestedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(child.chainStopReason).toBe("test-stop");
      expect(child.chainHandledAt).toBe("2026-01-02T00:00:00.000Z");
      expect(child.pipeline).toEqual({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        featureId: "b42",
        featureSlug: "b42-example",
      });

      const legacy = byId.get(legacyId)!;
      expect(legacy.chainRootRunId).toBeNull();
      expect(legacy.chainDepth).toBeNull();
      expect(legacy.chainMaxDepth).toBeNull();
      expect(legacy.chainMaxDepthOverride).toBeNull();
      expect(legacy.chainStopRequestedAt).toBeNull();
      expect(legacy.chainStopReason).toBeNull();
      expect(legacy.chainHandledAt).toBeNull();
      expect(legacy.pipeline).toBeNull();
      expect(legacy.pipelineWave).toBeNull();
      expect(legacy.pipelineTrack).toBeNull();

      const serialized = JSON.stringify(body.runs);
      expect(serialized).not.toContain(IDEA_TEXT);
      expect(serialized).not.toContain('"chainContext"');
      expect(serialized).not.toContain('"roleModels"');
    });
  });

  it("corrupt chain_context_json still lists with pipeline null and scalars intact", async () => {
    await withServer(async ({ port, db, workspaceId, store }) => {
      seedAutomation(db, {
        id: "auto-bad",
        workspaceId,
        configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
        name: "Implement",
      });

      const badJsonId = "run-bad-json";
      const wrongShapeId = "run-wrong-shape";

      store.insertRun({
        id: badJsonId,
        automationId: "auto-bad",
        workspaceId,
        triggerKind: "chain",
        prompt: "bad json",
        chainRootRunId: "run-root-x",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      db.prepare(
        `UPDATE runs SET chain_context_json = ? WHERE id = ?`
      ).run("{", badJsonId);

      store.insertRun({
        id: wrongShapeId,
        automationId: "auto-bad",
        workspaceId,
        triggerKind: "chain",
        prompt: "wrong shape",
        chainRootRunId: "run-root-y",
        chainDepth: 3,
        chainMaxDepth: 11,
      });
      db.prepare(
        `UPDATE runs SET chain_context_json = ? WHERE id = ?`
      ).run(JSON.stringify({ not: "a chain context" }), wrongShapeId);

      const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runs: Run[] };
      const byId = new Map(body.runs.map((r) => [r.id, r]));

      const badJson = byId.get(badJsonId)!;
      expect(badJson.chainRootRunId).toBe("run-root-x");
      expect(badJson.chainDepth).toBe(2);
      expect(badJson.chainMaxDepth).toBe(9);
      expect(badJson.pipeline).toBeNull();

      const wrongShape = byId.get(wrongShapeId)!;
      expect(wrongShape.chainRootRunId).toBe("run-root-y");
      expect(wrongShape.chainDepth).toBe(3);
      expect(wrongShape.chainMaxDepth).toBe(11);
      expect(wrongShape.pipeline).toBeNull();
    });
  });
});
