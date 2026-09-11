import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveSteerTargetRunId,
  type SteerTargetCandidate,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { freeListenPort } from "./helpers/free-port.ts";

type Db = ReturnType<typeof openDatabase>;

function schemaVersion(db: Db): number {
  return (
    db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as {
      version: number;
    }
  ).version;
}

function seedWorkspace(db: Db, workspace: string, workspaceId = "ws"): string {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run(workspaceId, workspace);
  return workspaceId;
}

function seedAutomation(db: Db, workspaceId: string, automationId = "auto"): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (?, ?, 'Automation', 1, 'enabled', '{"type":"manual"}', 'Prompt', 'a.yaml', 'auto')`
  ).run(automationId, workspaceId);
}

function seedRunRow(
  db: Db,
  input: {
    id: string;
    workspaceId: string;
    automationId: string;
    status: string;
    parentRunId?: string | null;
    chainRootRunId?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt,
      parent_run_id, chain_root_run_id
    ) VALUES (?, ?, ?, ?, 'manual', 'p', ?, ?)`
  ).run(
    input.id,
    input.automationId,
    input.workspaceId,
    input.status,
    input.parentRunId ?? null,
    input.chainRootRunId ?? null
  );
}

function noopExecutor(): Executor {
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

function chatEventTypes(db: Db, chatId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM chat_events WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function runEventTypes(db: Db, runId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

describe("resolveSteerTargetRunId", () => {
  const root = "root-1";
  const childRunning = "child-run";
  const childPaused = "child-paused";

  const baseCandidates: SteerTargetCandidate[] = [
    {
      id: root,
      status: "completed",
      parentRunId: null,
      chainRootRunId: root,
    },
    {
      id: childRunning,
      status: "running",
      parentRunId: root,
      chainRootRunId: root,
    },
  ];

  it("prefers an explicit pin when steerable", () => {
    expect(
      resolveSteerTargetRunId({
        pinnedRunId: childRunning,
        attachedRunId: root,
        candidates: baseCandidates,
      })
    ).toEqual({ kind: "resolved", runId: childRunning });
  });

  it("resolves an attached running run directly", () => {
    expect(
      resolveSteerTargetRunId({
        attachedRunId: childRunning,
        candidates: baseCandidates,
      })
    ).toEqual({ kind: "resolved", runId: childRunning });
  });

  it("resolves a single running frontier leaf from a pipeline root attach", () => {
    expect(
      resolveSteerTargetRunId({
        attachedRunId: root,
        candidates: baseCandidates,
      })
    ).toEqual({ kind: "resolved", runId: childRunning });
  });

  it("returns ambiguous when multiple running leaves exist", () => {
    const resolution = resolveSteerTargetRunId({
      attachedRunId: root,
      candidates: [
        ...baseCandidates,
        {
          id: "child-2",
          status: "running",
          parentRunId: root,
          chainRootRunId: root,
        },
      ],
    });
    expect(resolution.kind).toBe("ambiguous");
    if (resolution.kind === "ambiguous") {
      expect(resolution.runIds).toEqual(expect.arrayContaining([childRunning, "child-2"]));
    }
  });

  it("returns none when only paused workers are on the frontier", () => {
    const resolution = resolveSteerTargetRunId({
      attachedRunId: root,
      candidates: [
        { id: root, status: "completed", parentRunId: null, chainRootRunId: root },
        {
          id: childPaused,
          status: "paused",
          parentRunId: root,
          chainRootRunId: root,
        },
      ],
    });
    expect(resolution.kind).toBe("none");
  });

  it("returns none when no candidates exist", () => {
    expect(
      resolveSteerTargetRunId({
        attachedRunId: root,
        candidates: [],
      }).kind
    ).toBe("none");
  });

  it("D13: dangling terminal attach resolves the live frontier leaf", () => {
    expect(
      resolveSteerTargetRunId({
        attachedRunId: "dangling-root",
        candidates: [
          {
            id: childRunning,
            status: "running",
            parentRunId: "dangling-root",
            chainRootRunId: "dangling-root",
          },
        ],
      })
    ).toEqual({ kind: "resolved", runId: childRunning });
  });

  it("D13: non-steerable attached root still resolves the running frontier", () => {
    expect(
      resolveSteerTargetRunId({
        attachedRunId: root,
        candidates: [
          {
            id: childRunning,
            status: "running",
            parentRunId: root,
            chainRootRunId: root,
          },
        ],
      })
    ).toEqual({ kind: "resolved", runId: childRunning });
  });
});

describe("b50 chat steer schema and HTTP", () => {
  it("migrates to SCHEMA_VERSION 21 with attached_run_id on chat_sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-schema-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(21);
      const cols = db
        .prepare("PRAGMA table_info(chat_sessions)")
        .all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "attached_run_id")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /api/chats/:id/steer queues on the run and records chat.steer.queued", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-steer-http-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const workspaceId = seedWorkspace(db, workspace);
    const automationId = `${workspaceId}::auto`;
    seedAutomation(db, workspaceId, automationId);
    seedRunRow(db, {
      id: "run-live",
      workspaceId,
      automationId,
      status: "running",
    });

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: noopExecutor(),
      events,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      }),
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: noopExecutor(),
      events,
      lookupRun: (runId) => {
        const row = store.getRun(runId);
        if (!row) return undefined;
        return { workspaceId: row.workspace_id, status: row.status };
      },
    });

    const port = await freeListenPort();
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
    });

    try {
      const created = (await (
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${workspaceId}/chats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json()) as { chat: { id: string } };

      await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachedRunId: "run-live" }),
        }
      );

      const res = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}/steer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "  steer later  " }),
        }
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { ok: boolean; queuedMessageId?: string };
      expect(body.ok).toBe(true);
      expect(body.queuedMessageId).toBeTruthy();

      expect(chatEventTypes(db, created.chat.id)).toContain("chat.steer.queued");
      expect(runEventTypes(db, "run-live")).toEqual(["run.message.queued"]);
    } finally {
      await http.close();
      await chatEngine.shutdown();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("steer returns 409 for a non-running target and attach validation rejects bad runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-steer-attach-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceA = join(root, "ws-a");
    const workspaceB = join(root, "ws-b");
    const wsA = seedWorkspace(db, workspaceA, "ws-a");
    seedWorkspace(db, workspaceB, "ws-b");
    const autoA = `${wsA}::auto`;
    seedAutomation(db, wsA, autoA);
    seedRunRow(db, {
      id: "run-paused",
      workspaceId: wsA,
      automationId: autoA,
      status: "paused",
    });
    seedRunRow(db, {
      id: "run-done",
      workspaceId: wsA,
      automationId: autoA,
      status: "completed",
    });
    seedAutomation(db, "ws-b", "ws-b::auto");
    seedRunRow(db, {
      id: "run-other-ws",
      workspaceId: "ws-b",
      automationId: "ws-b::auto",
      status: "running",
    });

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: noopExecutor(),
      events,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      }),
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: noopExecutor(),
      events,
      lookupRun: (runId) => {
        const row = store.getRun(runId);
        if (!row) return undefined;
        return { workspaceId: row.workspace_id, status: row.status };
      },
    });

    const port = await freeListenPort();
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
    });

    try {
      const created = (await (
        await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsA}/chats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json()) as { chat: { id: string } };
      const chatId = created.chat.id;

      await fetch(`http://127.0.0.1:${port}/api/chats/${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachedRunId: "run-paused" }),
      });

      const steerPaused = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(chatId)}/steer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "nope" }),
        }
      );
      expect(steerPaused.status).toBe(409);

      const crossWs = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(chatId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachedRunId: "run-other-ws" }),
        }
      );
      expect(crossWs.status).toBe(409);

      const terminalAttach = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(chatId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachedRunId: "run-done" }),
        }
      );
      expect(terminalAttach.status).toBe(409);

      const detach = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(chatId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachedRunId: null }),
        }
      );
      expect(detach.status).toBe(200);
    } finally {
      await http.close();
      await chatEngine.shutdown();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
