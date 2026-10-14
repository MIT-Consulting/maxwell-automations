import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { FeatureQueueEntry, EnqueueFeatureRequest } from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import {
  FeatureQueueError,
  FeatureQueueStore,
} from "../packages/daemon/src/runs/feature-queue-store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { freeListenPort } from "./helpers/free-port.ts";

type Db = ReturnType<typeof openDatabase>;

function schemaVersion(db: Db): number {
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null };
  return row.v ?? 0;
}

function hasTable(db: Db, name: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(name) as { name: string } | undefined;
  return row != null;
}

function hasIndex(db: Db, name: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?"
    )
    .get(name) as { name: string } | undefined;
  return row != null;
}

function seedWorkspace(db: Db, workspacePath: string, id?: string): string {
  mkdirSync(workspacePath, { recursive: true });
  const workspaceId = id ?? workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");
  return workspaceId;
}

function seedAutomation(db: Db, workspaceId: string, automationId = "auto-1"): string {
  db.prepare(
    `INSERT INTO automations (
       id, workspace_id, name, enabled, status, trigger_json, prompt,
       config_path, config_key
     ) VALUES (?, ?, 'Test', 1, 'enabled', ?, 'prompt', 'c.yaml', 'a')`
  ).run(automationId, workspaceId, JSON.stringify({ type: "manual" }));
  return automationId;
}

function sampleKickoff(automationId: string): EnqueueFeatureRequest["kickoff"] {
  return { automationId };
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

describe("b58.1 feature queue store and routes", () => {
  async function withServer(
    run: (args: {
      port: number;
      db: Db;
      workspaceId: string;
      automationId: string;
      featureQueue: FeatureQueueStore;
    }) => Promise<void>
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca-b58-1-http-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const automationId = seedAutomation(db, workspaceId);
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
    const featureQueue = new FeatureQueueStore(db);
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
      featureQueue,
    });
    try {
      await run({ port, db, workspaceId, automationId, featureQueue });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("migrates fresh databases with feature_queue_entries at or past its schema version", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b58-1-migrate-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
      expect(hasTable(db, "feature_queue_entries")).toBe(true);
      expect(hasIndex(db, "idx_feature_queue_workspace_state")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasTable(db, "feature_queue_entries")).toBe(true);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assigns increasing position per workspace and enforces refusals", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b58-1-store-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const workspaceId = seedWorkspace(db, workspacePath);
    const automationId = seedAutomation(db, workspaceId);
    const queue = new FeatureQueueStore(db);
    const kickoff = sampleKickoff(automationId);
    try {
      const first = queue.enqueue({
        workspaceId,
        featureId: "b58",
        after: [],
        kickoff,
      });
      const second = queue.enqueue({
        workspaceId,
        featureId: "b59",
        after: ["b58"],
        kickoff,
      });
      expect(first.position).toBe(1);
      expect(second.position).toBe(2);

      expect(() =>
        queue.enqueue({
          workspaceId,
          featureId: "b58",
          after: [],
          kickoff,
        })
      ).toThrow(FeatureQueueError);
      try {
        queue.enqueue({
          workspaceId,
          featureId: "b58",
          after: [],
          kickoff,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(FeatureQueueError);
        expect((err as FeatureQueueError).code).toBe("duplicate");
      }

      expect(() =>
        queue.enqueue({
          workspaceId,
          featureId: "b60",
          after: ["b99"],
          kickoff,
        })
      ).toThrow(FeatureQueueError);
      try {
        queue.enqueue({
          workspaceId,
          featureId: "b60",
          after: ["b99"],
          kickoff,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(FeatureQueueError);
        expect((err as FeatureQueueError).code).toBe("unknown-dependency");
        expect((err as FeatureQueueError).message).toContain("b99");
      }

      const runningId = first.id;
      db.prepare(
        `UPDATE feature_queue_entries SET state = 'running' WHERE id = ?`
      ).run(runningId);
      expect(queue.cancelEntry(runningId)).toBe("running");
      expect(queue.getEntry(runningId)?.state).toBe("running");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves enqueue, list, and cancel over HTTP", async () => {
    await withServer(async ({ port, db, workspaceId, automationId }) => {
      const kickoff = sampleKickoff(automationId);
      const firstRes = await fetch(`http://127.0.0.1:${port}/api/feature-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          featureId: "b58",
          kickoff,
        }),
      });
      expect(firstRes.status).toBe(201);
      const firstBody = (await firstRes.json()) as { entry: FeatureQueueEntry };
      expect(firstBody.entry.featureId).toBe("b58");
      expect(firstBody.entry.position).toBe(1);
      expect("kickoff" in firstBody.entry).toBe(false);
      expect(firstBody.entry.entryDetail).toBeDefined();
      expect(firstBody.entry.entryDetail.roleModels).toBeNull();

      const secondRes = await fetch(`http://127.0.0.1:${port}/api/feature-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          featureId: "b59",
          after: ["b58"],
          kickoff,
        }),
      });
      expect(secondRes.status).toBe(201);

      const invalidRes = await fetch(`http://127.0.0.1:${port}/api/feature-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          featureId: "b60",
          kickoff: {},
        }),
      });
      expect(invalidRes.status).toBe(400);

      const dupRes = await fetch(`http://127.0.0.1:${port}/api/feature-queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          featureId: "b58",
          kickoff,
        }),
      });
      expect(dupRes.status).toBe(409);

      const unknownDepRes = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            featureId: "b60",
            after: ["b99"],
            kickoff,
          }),
        }
      );
      expect(unknownDepRes.status).toBe(400);
      const unknownDepBody = (await unknownDepRes.json()) as { error: string };
      expect(unknownDepBody.error).toContain("b99");

      const listRes = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { entries: FeatureQueueEntry[] };
      expect(listBody.entries.map((e) => e.featureId)).toEqual(["b58", "b59"]);
      expect(listBody.entries.map((e) => e.position)).toEqual([1, 2]);
      expect(listBody.entries.filter((e) => e.featureId === "b58")).toHaveLength(1);
      for (const row of listBody.entries) {
        expect(row.entryDetail).toBeDefined();
        expect("kickoff" in row).toBe(false);
      }

      const cancelQueuedRes = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue/${encodeURIComponent(listBody.entries[1]!.id)}`,
        { method: "DELETE" }
      );
      expect(cancelQueuedRes.status).toBe(200);
      const cancelBody = (await cancelQueuedRes.json()) as {
        entry: FeatureQueueEntry;
      };
      expect(cancelBody.entry.state).toBe("cancelled");
      expect(cancelBody.entry.featureId).toBe("b59");

      const afterCancelList = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      const afterCancelBody = (await afterCancelList.json()) as {
        entries: FeatureQueueEntry[];
      };
      const cancelled = afterCancelBody.entries.find((e) => e.featureId === "b59");
      expect(cancelled?.state).toBe("cancelled");

      dbPrepareRunning(db, firstBody.entry.id);

      const deleteRes = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue/${encodeURIComponent(firstBody.entry.id)}`,
        { method: "DELETE" }
      );
      expect(deleteRes.status).toBe(409);
    });
  });

  it("reorders movable rows without changing fixed positions", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b88-store-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const workspaceId = seedWorkspace(db, workspacePath);
    const automationId = seedAutomation(db, workspaceId);
    const queue = new FeatureQueueStore(db);
    try {
      const { runningId, queuedAId, queuedBId, doneId } = seedB88ReorderFixture(
        queue,
        db,
        workspaceId,
        automationId
      );
      expect(positionsByFeatureId(queue, workspaceId)).toEqual({
        "b88-run": 1,
        b88a: 2,
        b88b: 3,
        "b88-done": 4,
      });

      const outcome = queue.moveEntry(queuedBId, { top: true });
      expect(outcome.status).toBe("moved");
      if (outcome.status === "moved") {
        expect(outcome.row.position).toBe(2);
      }
      expect(positionsByFeatureId(queue, workspaceId)).toEqual({
        "b88-run": 1,
        b88b: 2,
        b88a: 3,
        "b88-done": 4,
      });
      expect(queue.getEntry(runningId)?.position).toBe(1);
      expect(queue.getEntry(doneId)?.position).toBe(4);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses move ahead of an unfinished after dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b88-dep-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const workspaceId = seedWorkspace(db, workspacePath);
    const automationId = seedAutomation(db, workspaceId);
    const queue = new FeatureQueueStore(db);
    try {
      const { queuedAId, queuedBId } = seedB88ReorderFixture(
        queue,
        db,
        workspaceId,
        automationId
      );
      db.prepare(
        `UPDATE feature_queue_entries SET after_json = ? WHERE id = ?`
      ).run(JSON.stringify(["b88a"]), queuedBId);
      const before = positionsByFeatureId(queue, workspaceId);

      const topOutcome = queue.moveEntry(queuedBId, { top: true });
      expect(topOutcome.status).toBe("ahead-of-dependency");
      if (topOutcome.status === "ahead-of-dependency") {
        expect(topOutcome.featureId).toBe("b88a");
      }
      expect(positionsByFeatureId(queue, workspaceId)).toEqual(before);

      const beforeOutcome = queue.moveEntry(queuedBId, { before: queuedAId });
      expect(beforeOutcome.status).toBe("ahead-of-dependency");
      expect(positionsByFeatureId(queue, workspaceId)).toEqual(before);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses moving a running entry", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b88-running-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const workspaceId = seedWorkspace(db, workspacePath);
    const automationId = seedAutomation(db, workspaceId);
    const queue = new FeatureQueueStore(db);
    try {
      const { runningId } = seedB88ReorderFixture(
        queue,
        db,
        workspaceId,
        automationId
      );
      const before = positionsByFeatureId(queue, workspaceId);
      const outcome = queue.moveEntry(runningId, { top: true });
      expect(outcome.status).toBe("not-movable");
      expect(positionsByFeatureId(queue, workspaceId)).toEqual(before);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves move over HTTP", async () => {
    await withServer(async ({ port, db, workspaceId, automationId, featureQueue }) => {
      const { queuedBId, runningId } = seedB88ReorderFixture(
        featureQueue,
        db,
        workspaceId,
        automationId
      );

      const invalidRes = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue/${encodeURIComponent(queuedBId)}/move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      expect(invalidRes.status).toBe(400);

      const beforeRunning = positionsByFeatureId(featureQueue, workspaceId);
      const runningRes = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue/${encodeURIComponent(runningId)}/move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ top: true }),
        }
      );
      expect(runningRes.status).toBe(409);
      expect(positionsByFeatureId(featureQueue, workspaceId)).toEqual(
        beforeRunning
      );

      const moveRes = await fetch(
        `http://127.0.0.1:${port}/api/feature-queue/${encodeURIComponent(queuedBId)}/move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ top: true }),
        }
      );
      expect(moveRes.status).toBe(200);
      const moveBody = (await moveRes.json()) as { entry: FeatureQueueEntry };
      expect(moveBody.entry.featureId).toBe("b88b");
      expect(moveBody.entry.position).toBe(2);
      expect(positionsByFeatureId(featureQueue, workspaceId)).toEqual({
        "b88-run": 1,
        b88b: 2,
        b88a: 3,
        "b88-done": 4,
      });
    });
  });
});

function dbPrepareRunning(db: Db, id: string): void {
  db.prepare(`UPDATE feature_queue_entries SET state = 'running' WHERE id = ?`).run(id);
}

function seedB88ReorderFixture(
  queue: FeatureQueueStore,
  db: Db,
  workspaceId: string,
  automationId: string
): {
  runningId: string;
  queuedAId: string;
  queuedBId: string;
  doneId: string;
} {
  const kickoff = sampleKickoff(automationId);
  const running = queue.enqueue({
    workspaceId,
    featureId: "b88-run",
    after: [],
    kickoff,
  });
  dbPrepareRunning(db, running.id);
  const queuedA = queue.enqueue({
    workspaceId,
    featureId: "b88a",
    after: [],
    kickoff,
  });
  const queuedB = queue.enqueue({
    workspaceId,
    featureId: "b88b",
    after: [],
    kickoff,
  });
  const done = queue.enqueue({
    workspaceId,
    featureId: "b88-done",
    after: [],
    kickoff,
  });
  db.prepare(`UPDATE feature_queue_entries SET state = 'done' WHERE id = ?`).run(
    done.id
  );
  return {
    runningId: running.id,
    queuedAId: queuedA.id,
    queuedBId: queuedB.id,
    doneId: done.id,
  };
}

function positionsByFeatureId(
  queue: FeatureQueueStore,
  workspaceId: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of queue.listEntries(workspaceId)) {
    out[row.feature_id] = row.position;
  }
  return out;
}
