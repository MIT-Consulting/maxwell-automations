import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import WebSocket from "ws";
import type { ChatSession, ChatSnapshot, WsServerMessage } from "@lca/shared";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import type { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  workspaceId = "ws"
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run(workspaceId, workspace);
}

function noopExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn not expected in HTTP tests");
    },
    resume: async () => {
      throw new Error("resume not expected in HTTP tests");
    },
  };
}

function stubRunEngine(): RunEngine {
  return {} as unknown as RunEngine;
}


describe("b31.2 chat HTTP lifecycle", () => {
  it("PATCH title sets title_source=user; DELETE removes chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b31-http-delete-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    seedWorkspace(db, workspace);
    const port = await freeListenPort();
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: noopExecutor(),
    });
    const http = await startHttpServer({
      engine: stubRunEngine(),
      chatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    try {
      const created = (await (
        await fetch(`http://127.0.0.1:${port}/api/workspaces/ws/chats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).json()) as { chat: ChatSession };
      expect(created.chat.titleSource).toBeNull();

      const renameRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "User title" }),
        }
      );
      expect(renameRes.status).toBe(200);
      const renamed = (await renameRes.json()) as { chat: ChatSession };
      expect(renamed.chat.title).toBe("User title");
      expect(renamed.chat.titleSource).toBe("user");

      const getRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`
      );
      expect(getRes.status).toBe(200);
      const snapshot = (await getRes.json()) as ChatSnapshot;
      expect(snapshot.session.title).toBe("User title");
      expect(snapshot.session.titleSource).toBe("user");

      const delRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        { method: "DELETE" }
      );
      expect(delRes.status).toBe(200);
      expect(await delRes.json()).toEqual({ ok: true });

      const missing = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`
      );
      expect(missing.status).toBe(404);

      const delAgain = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        { method: "DELETE" }
      );
      expect(delAgain.status).toBe(404);
    } finally {
      await http.close();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PATCH archive excludes chat from list; unarchive restores and emits", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b31-http-archive-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    seedWorkspace(db, workspace);
    const port = await freeListenPort();
    const events = new DaemonEventBus();
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: noopExecutor(),
      events,
    });
    const http = await startHttpServer({
      engine: stubRunEngine(),
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
    });

    try {
      const created = (await (
        await fetch(`http://127.0.0.1:${port}/api/workspaces/ws/chats`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Keep me" }),
        })
      ).json()) as { chat: ChatSession };

      const archiveRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true }),
        }
      );
      expect(archiveRes.status).toBe(200);
      const archived = (await archiveRes.json()) as { chat: ChatSession };
      expect(archived.chat.archivedAt).toBeTruthy();

      const listRes = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws/chats`);
      const listed = (await listRes.json()) as { chats: ChatSession[] };
      expect(listed.chats.some((c) => c.id === created.chat.id)).toBe(false);

      const archivedListRes = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/ws/chats?archived=true`
      );
      expect(archivedListRes.status).toBe(200);
      const archivedListed = (await archivedListRes.json()) as {
        chats: ChatSession[];
      };
      expect(archivedListed.chats.some((c) => c.id === created.chat.id)).toBe(
        true
      );

      const badArchived = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/ws/chats?archived=maybe`
      );
      expect(badArchived.status).toBe(400);

      const sendRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "should fail" }),
        }
      );
      expect(sendRes.status).toBe(409);
      expect(await sendRes.json()).toMatchObject({
        error: expect.stringMatching(/archived/i),
      });

      const queueRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}/queue-message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "should fail" }),
        }
      );
      expect(queueRes.status).toBe(409);

      const interruptRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}/interrupt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "should fail" }),
        }
      );
      expect(interruptRes.status).toBe(409);

      const getArchived = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`
      );
      expect(getArchived.status).toBe(200);
      const snap = (await getArchived.json()) as ChatSnapshot;
      expect(snap.session.archivedAt).toBeTruthy();

      const wsFrames: WsServerMessage[] = [];
      const unarchiveWs = await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WS open timed out")), 3000);
      });
      unarchiveWs.on("message", (data) => {
        wsFrames.push(JSON.parse(String(data)) as WsServerMessage);
      });

      const unarchiveRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: false }),
        }
      );
      expect(unarchiveRes.status).toBe(200);
      const restored = (await unarchiveRes.json()) as { chat: ChatSession };
      expect(restored.chat.archivedAt).toBeNull();

      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          if (
            wsFrames.some(
              (f) =>
                f.type === "chat_session" &&
                f.chatId === created.chat.id &&
                f.session.archivedAt === null
            )
          ) {
            resolve();
            return;
          }
          if (Date.now() - start > 3000) {
            reject(new Error("chat_session unarchive frame timed out"));
            return;
          }
          setTimeout(tick, 10);
        };
        tick();
      });
      unarchiveWs.close();

      const activeAgain = (await (
        await fetch(`http://127.0.0.1:${port}/api/workspaces/ws/chats`)
      ).json()) as { chats: ChatSession[] };
      expect(activeAgain.chats.some((c) => c.id === created.chat.id)).toBe(true);

      const archivedAgain = (await (
        await fetch(
          `http://127.0.0.1:${port}/api/workspaces/ws/chats?archived=true`
        )
      ).json()) as { chats: ChatSession[] };
      expect(archivedAgain.chats.some((c) => c.id === created.chat.id)).toBe(
        false
      );

      // Re-archive then hard-delete from archived state.
      await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true }),
        }
      );
      const delRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        { method: "DELETE" }
      );
      expect(delRes.status).toBe(200);
      const afterDelete = (await (
        await fetch(
          `http://127.0.0.1:${port}/api/workspaces/ws/chats?archived=true`
        )
      ).json()) as { chats: ChatSession[] };
      expect(afterDelete.chats.some((c) => c.id === created.chat.id)).toBe(
        false
      );
    } finally {
      await http.close();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards chat_session and chats_deleted WS frames", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b31-http-ws-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const events = new DaemonEventBus();
    const http = await startHttpServer({
      engine: stubRunEngine(),
      chatEngine: {} as unknown as ChatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
    });

    try {
      const frames: WsServerMessage[] = [];
      const session: ChatSession = {
        id: "chat-ws-2",
        workspaceId: "ws",
        title: "Titled",
        titleSource: "auto",
        status: "idle",
        agentId: null,
        sdkRunId: null,
        model: null,
        systemPrompt: null,
        originRunId: null,
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        lastMessageAt: null,
      };

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on("open", () => {
          events.emitChatSession("chat-ws-2", session);
          events.emitChatsDeleted(["chat-ws-2"]);
        });
        ws.on("message", (data) => {
          frames.push(JSON.parse(String(data)) as WsServerMessage);
          if (frames.length >= 2) {
            ws.close();
            resolve();
          }
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WS test timed out")), 3000);
      });

      expect(frames).toEqual(
        expect.arrayContaining([
          { type: "chat_session", chatId: "chat-ws-2", session },
          { type: "chats_deleted", chatIds: ["chat-ws-2"] },
        ])
      );
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
