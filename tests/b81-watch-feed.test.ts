import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type PipelineFeedResponse,
} from "@lca/shared";
import { PIPELINE_FEED_EVENT_BATCH_LIMIT } from "../packages/daemon/src/runs/pipeline-projection.ts";
import { PipelineFeedWaitRegistry } from "../packages/daemon/src/runs/pipeline-feed-wait.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
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

function chainContextJson(featureId: string): string {
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
    chainContextJson(args.featureId),
    args.createdAt,
    args.createdAt,
    args.createdAt
  );
}

function insertChainedChild(
  db: Db,
  args: {
    id: string;
    rootId: string;
    automationId: string;
    workspaceId: string;
    depth: number;
    createdAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status, trigger_kind, prompt,
       chain_root_run_id, chain_depth, chain_max_depth, chain_context_json,
       created_at, updated_at, started_at
     ) VALUES (?, ?, ?, 'running', 'manual', 'prompt', ?, ?, 9, NULL, ?, ?, ?)`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.rootId,
    args.depth,
    args.createdAt,
    args.createdAt,
    args.createdAt
  );
}

async function fetchFeed(
  port: number,
  rootId: string,
  since = 0,
  wait = 0
): Promise<Response> {
  const url = new URL(
    `http://127.0.0.1:${port}/api/pipeline-runs/${encodeURIComponent(rootId)}/events`
  );
  url.searchParams.set("since", String(since));
  url.searchParams.set("wait", String(wait));
  return fetch(url);
}

describe("b81 pipeline feed route", () => {
  async function withServer(
    run: (args: {
      port: number;
      db: Db;
      root: string;
      workspaceId: string;
      entryAutomationId: string;
      runStore: RunStore;
      events: DaemonEventBus;
    }) => Promise<void>
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca-b81-feed-"));
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
      await run({
        port,
        db,
        root,
        workspaceId,
        entryAutomationId,
        runStore,
        events,
      });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("returns immediate lifecycle events and advances cursor", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId, runStore }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      const eventId = runStore.appendEvent(rootId, "run.started", { status: "running" });

      const res = await fetchFeed(port, rootId, 0, 0);
      expect(res.status).toBe(200);
      const body = (await res.json()) as PipelineFeedResponse;
      expect(body.rootRunId).toBe(rootId);
      expect(body.events).toHaveLength(1);
      expect(body.events[0]!.id).toBe(eventId);
      expect(body.events[0]!.kind).toBe("run.started");
      expect(body.cursor).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("blocks until a delayed lifecycle event arrives", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId, runStore }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });

      const started = Date.now();
      const pending = fetchFeed(port, rootId, 0, 5);
      await new Promise((r) => setTimeout(r, 200));
      runStore.appendEvent(rootId, "run.paused", { actor: "operator" });

      const res = await pending;
      expect(res.status).toBe(200);
      const body = (await res.json()) as PipelineFeedResponse;
      expect(body.events.some((e) => e.kind === "run.paused")).toBe(true);
      expect(Date.now() - started).toBeLessThan(4_500);
    });
  });

  it("times out with empty events and a fresh snapshot", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });

      const started = Date.now();
      const res = await fetchFeed(port, rootId, 0, 1);
      expect(res.status).toBe(200);
      const body = (await res.json()) as PipelineFeedResponse;
      expect(body.events).toHaveLength(0);
      expect(body.snapshot.rootRunId).toBe(rootId);
      expect(body.cursor).toBeGreaterThanOrEqual(0);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    });
  });

  it("accepts pruned/unknown since cursors without error", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId, runStore }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      runStore.appendEvent(rootId, "run.started", {});

      const res = await fetchFeed(port, rootId, 9_999_999, 0);
      expect(res.status).toBe(200);
      const body = (await res.json()) as PipelineFeedResponse;
      expect(body.events).toHaveLength(0);
      expect(body.cursor).toBeGreaterThanOrEqual(9_999_999);
    });
  });

  it("includes events from a newly chained child after the cursor", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId, runStore }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      const firstId = runStore.appendEvent(rootId, "run.started", {});

      const childId = randomUUID();
      insertChainedChild(db, {
        id: childId,
        rootId,
        automationId: entryAutomationId,
        workspaceId,
        depth: 1,
        createdAt: "2026-07-10 12:01:00",
      });
      runStore.appendEvent(childId, "run.chained", { reason: "next-step" });

      const res = await fetchFeed(port, rootId, firstId, 0);
      expect(res.status).toBe(200);
      const body = (await res.json()) as PipelineFeedResponse;
      expect(body.events.some((e) => e.runId === childId && e.kind === "run.chained")).toBe(
        true
      );
    });
  });

  it("does not leak transcript bodies in feed payloads", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId, runStore }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      runStore.appendEvent(rootId, "run.finished", {
        result: "SECRET TRANSCRIPT BODY ".repeat(40),
        sdkStatus: "completed",
      });

      const res = await fetchFeed(port, rootId, 0, 0);
      const body = (await res.json()) as PipelineFeedResponse;
      const payload = body.events[0]!.payload;
      expect(payload.resultPresent).toBe(true);
      expect(JSON.stringify(payload)).not.toContain("SECRET TRANSCRIPT");
    });
  });

  it("rejects malformed since and wait parameters", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });

      const badSince = await fetch(
        `http://127.0.0.1:${port}/api/pipeline-runs/${rootId}/events?since=-1`
      );
      expect(badSince.status).toBe(400);

      const badWait = await fetch(
        `http://127.0.0.1:${port}/api/pipeline-runs/${rootId}/events?wait=abc`
      );
      expect(badWait.status).toBe(400);
    });
  });

  it("does not skip remaining events when a feed page is full", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId, runStore }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      for (let i = 0; i < PIPELINE_FEED_EVENT_BATCH_LIMIT + 1; i += 1) {
        runStore.appendEvent(rootId, "run.started", { status: String(i) });
      }

      const first = await fetchFeed(port, rootId, 0, 0);
      const firstBody = (await first.json()) as PipelineFeedResponse;
      expect(firstBody.events).toHaveLength(PIPELINE_FEED_EVENT_BATCH_LIMIT);
      const lastReturned = firstBody.events[firstBody.events.length - 1]!.id;
      expect(firstBody.cursor).toBe(lastReturned);

      const second = await fetchFeed(port, rootId, firstBody.cursor, 0);
      const secondBody = (await second.json()) as PipelineFeedResponse;
      expect(secondBody.events.length).toBeGreaterThanOrEqual(1);
      expect(secondBody.events[0]!.id).toBeGreaterThan(lastReturned);
    });
  });

  it("registers the waiter before the second query so a sync wake is kept", async () => {
    await withServer(async ({ db, workspaceId, entryAutomationId, runStore, events }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      const registry = new PipelineFeedWaitRegistry(events, runStore);
      try {
        const started = Date.now();
        await registry.waitForChange(rootId, 4_000, {
          afterSubscribe: () => {
            runStore.appendEvent(rootId, "run.started", {});
            return false;
          },
        });
        expect(Date.now() - started).toBeLessThan(1_200);
        expect(registry.pendingWaiterCount).toBe(0);
      } finally {
        registry.close();
      }
    });
  });

  it("clears waiters and timers on abort and close", async () => {
    await withServer(async ({ db, workspaceId, entryAutomationId, runStore, events }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      const registry = new PipelineFeedWaitRegistry(events, runStore);
      try {
        const ac = new AbortController();
        const pending = registry.wait(rootId, 10_000, ac.signal);
        ac.abort();
        await pending;
        expect(registry.pendingWaiterCount).toBe(0);
        const closed = registry.wait(rootId, 8_000);
        registry.close();
        await closed;
        expect(registry.pendingWaiterCount).toBe(0);
      } finally {
        registry.close();
      }
    });
  });

  it("hydrates snapshot via hydratePipelineSnapshot on every response", async () => {
    await withServer(async ({ port, db, workspaceId, entryAutomationId, runStore }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      runStore.appendEvent(rootId, "run.started", {});

      const res = await fetchFeed(port, rootId, 0, 0);
      const body = (await res.json()) as PipelineFeedResponse;
      expect(body.snapshot.featureId).toBe("b81");
      expect(body.snapshot.outcome).toBe("running");
      expect(body.snapshot.cursor).not.toBeNull();
    });
  });
});
