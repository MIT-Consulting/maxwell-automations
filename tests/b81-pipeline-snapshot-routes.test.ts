import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type PipelineSnapshot,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { provisionGeneratedWorkers } from "../packages/daemon/src/config/generated-workers.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
});

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

function chainContextJson(featureId: string, createdAtSuffix: string): string {
  return JSON.stringify({
    variables: {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId,
      featureSlug: `b81-${featureId}`,
      featureDir: `docs/roadmap/b81-${featureId}`,
      featureIndex: `docs/roadmap/b81-${featureId}/00-index.md`,
      idea: "idea",
      planningDepth: "full",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode: "normal",
      roleModelProfileId: "balanced",
    },
    roleModels: {
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
      docs: { id: "docs-model" },
    },
  });
}

function insertPipelineRoot(
  db: Db,
  args: {
    id: string;
    automationId: string;
    workspaceId: string;
    featureId: string;
    createdAt: string;
    status?: string;
  }
): void {
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status, trigger_kind, prompt,
       chain_root_run_id, chain_depth, chain_max_depth, chain_context_json,
       created_at, updated_at, started_at
     ) VALUES (?, ?, ?, ?, 'manual', 'prompt', ?, 0, 9, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.status ?? "running",
    args.id,
    chainContextJson(args.featureId, args.createdAt),
    args.createdAt,
    args.createdAt,
    args.createdAt
  );
}

describe("b81 pipeline snapshot routes", () => {
  async function withServer(
    run: (args: {
      port: number;
      db: Db;
      root: string;
      workspaceId: string;
      entryAutomationId: string;
    }) => Promise<void>
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca-b81-routes-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    provisionGeneratedWorkers(db, workspaceId, IMPLEMENT_FULLY_WORKERS);
    const entryAutomationId = automationId(
      workspaceId,
      GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_ENTRY_WORKER_KEY
    );
    const events = new DaemonEventBus();
    const runStore = new RunStore(db, events);
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
    vi.spyOn(triggers, "refresh").mockImplementation(() => {});
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      runStore,
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      triggers,
    });
    try {
      await run({ port, db, root, workspaceId, entryAutomationId });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("GET /api/pipeline-runs/:rootRunId returns a hydrated snapshot", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });

      const res = await fetch(
        `http://127.0.0.1:${port}/api/pipeline-runs/${encodeURIComponent(rootId)}`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rootRunId: string;
        snapshot: PipelineSnapshot;
      };
      expect(body.rootRunId).toBe(rootId);
      expect(body.snapshot.featureId).toBe("b81");
      expect(body.snapshot.roleModelProfileId).toBe("balanced");
      expect(body.snapshot.outcome).toBe("running");
    });
  });

  it("GET /api/pipeline-runs resolves the newest root for workspace+feature", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId }) => {
      const olderRoot = randomUUID();
      const newerRoot = randomUUID();
      insertPipelineRoot(db, {
        id: olderRoot,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 10:00:00",
        status: "completed",
      });
      insertPipelineRoot(db, {
        id: newerRoot,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 14:00:00",
      });

      const res = await fetch(
        `http://127.0.0.1:${port}/api/pipeline-runs?workspace=${encodeURIComponent(workspaceId)}&feature=b81`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rootRunId: string;
        snapshot: PipelineSnapshot;
      };
      expect(body.rootRunId).toBe(newerRoot);
      expect(body.snapshot.rootRunId).toBe(newerRoot);
    });
  });

  it("returns 400 when resolver query params are missing", async () => {
    await withServer(async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/pipeline-runs`);
      expect(res.status).toBe(400);
    });
  });

  it("resolves a feature only within the named workspace", async () => {
    await withServer(async ({ port, db, root, workspaceId, entryAutomationId }) => {
      const localRoot = randomUUID();
      insertPipelineRoot(db, {
        id: localRoot,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 11:00:00",
      });

      const otherPath = join(root, "other-ws");
      const otherWorkspaceId = seedWorkspace(db, otherPath);
      provisionGeneratedWorkers(db, otherWorkspaceId, IMPLEMENT_FULLY_WORKERS);
      const otherAutomationId = automationId(
        otherWorkspaceId,
        GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_ENTRY_WORKER_KEY
      );
      const foreignNewerRoot = randomUUID();
      insertPipelineRoot(db, {
        id: foreignNewerRoot,
        automationId: otherAutomationId,
        workspaceId: otherWorkspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 16:00:00",
      });

      const res = await fetch(
        `http://127.0.0.1:${port}/api/pipeline-runs?workspace=${encodeURIComponent(workspaceId)}&feature=b81`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rootRunId: string;
        snapshot: PipelineSnapshot;
      };
      expect(body.rootRunId).toBe(localRoot);
      expect(body.snapshot.workspaceId).toBe(workspaceId);
    });
  });

  it("creates the chain_root_run_id index at schema v23", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b81-migrate-"));
    try {
      const db = openDatabase(join(root, "state.sqlite"));
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'runs'`
        )
        .all() as Array<{ name: string }>;
      expect(indexes.some((row) => row.name === "idx_runs_chain_root")).toBe(
        true
      );
      const version = db
        .prepare(
          "SELECT MAX(version) AS version FROM schema_migrations"
        )
        .get() as { version: number };
      expect(version.version).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
