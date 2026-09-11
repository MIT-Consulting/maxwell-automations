import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import WebSocket from "ws";
import type { ChatSession, WsServerMessage } from "@lca/shared";
import {
  ChatEngine,
  ChatMessageError,
} from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import {
  checkControlToken,
  startHttpServer,
} from "../packages/daemon/src/http/server.ts";
import type { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  workspaceId = "ws"
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')").run(
    workspaceId,
    workspace
  );
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


describe("b28.3 chat HTTP routes", () => {
  it("create + list + get happy path", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-create-"));
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
      const createRes = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/ws/chats`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "My chat" }),
        }
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { chat: ChatSession };
      expect(created.chat.title).toBe("My chat");
      expect(created.chat.workspaceId).toBe("ws");
      expect(created.chat.status).toBe("idle");

      const listRes = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws/chats`);
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()) as { chats: ChatSession[] };
      expect(listed.chats.map((c) => c.id)).toContain(created.chat.id);

      const getRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`
      );
      expect(getRes.status).toBe(200);
      const snapshot = (await getRes.json()) as {
        session: ChatSession;
        events: unknown[];
      };
      expect(snapshot.session.id).toBe(created.chat.id);
      expect(Array.isArray(snapshot.events)).toBe(true);
    } finally {
      await http.close();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /message returns 202 and forwards trimmed text", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-message-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const calls: Array<{ chatId: string; message: string }> = [];
    const chatEngine = {
      sendMessage: async (chatId: string, message: string) => {
        calls.push({ chatId, message });
      },
    } as unknown as ChatEngine;
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
      const res = await fetch(`http://127.0.0.1:${port}/api/chats/chat-1/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "  hello chat  " }),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toEqual([{ chatId: "chat-1", message: "hello chat" }]);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /queue-message returns 202 with queuedMessageId", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-queue-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const chatEngine = {
      queueMessage: async () => "queued-id",
    } as unknown as ChatEngine;
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
      const res = await fetch(
        `http://127.0.0.1:${port}/api/chats/chat-1/queue-message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "queue later" }),
        }
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, queuedMessageId: "queued-id" });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /interrupt returns 202 and POST /cancel returns 200", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-interrupt-cancel-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    let interrupted = false;
    let cancelled = false;
    const chatEngine = {
      interruptChat: async () => {
        interrupted = true;
      },
      cancelChat: async () => {
        cancelled = true;
      },
    } as unknown as ChatEngine;
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
      const interruptRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/chat-1/interrupt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "stop and do this" }),
        }
      );
      expect(interruptRes.status).toBe(202);
      expect(await interruptRes.json()).toEqual({ ok: true });
      expect(interrupted).toBe(true);

      const cancelRes = await fetch(`http://127.0.0.1:${port}/api/chats/chat-1/cancel`, {
        method: "POST",
      });
      expect(cancelRes.status).toBe(200);
      expect(await cancelRes.json()).toEqual({ ok: true });
      expect(cancelled).toBe(true);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("POST /answer returns 200 and calls answerChat", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-answer-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const calls: Array<{ chatId: string; answer: string }> = [];
    const chatEngine = {
      answerChat: (chatId: string, answer: string) => {
        calls.push({ chatId, answer });
      },
    } as unknown as ChatEngine;
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
      const res = await fetch(`http://127.0.0.1:${port}/api/chats/chat-1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "  yes  " }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toEqual([{ chatId: "chat-1", answer: "yes" }]);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps ChatMessageError codes to HTTP statuses on message routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-errors-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    let error: ChatMessageError | undefined;
    const chatEngine = {
      sendMessage: async () => {
        if (error) throw error;
      },
    } as unknown as ChatEngine;
    const http = await startHttpServer({
      engine: stubRunEngine(),
      chatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    async function post(message: string) {
      return fetch(`http://127.0.0.1:${port}/api/chats/chat-1/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
    }

    try {
      error = new ChatMessageError("not_found", "Chat not found: chat-1");
      expect((await post("hello")).status).toBe(404);

      error = new ChatMessageError("busy", "Chat chat-1 is busy");
      expect((await post("hello")).status).toBe(409);

      error = new ChatMessageError("needs_input", "Chat chat-1 is awaiting input");
      expect((await post("hello")).status).toBe(409);

      error = new ChatMessageError("context_missing", "workspace path unavailable");
      expect((await post("hello")).status).toBe(400);

      error = new ChatMessageError("empty_message", "message is required");
      expect((await post("hello")).status).toBe(400);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects __global__ workspace for chat create", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-global-"));
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('global', '__global__', 'Global')").run();
    const port = await freeListenPort();
    const chatEngine = {
      createChat: () => {
        throw new Error("createChat should not be called");
      },
    } as unknown as ChatEngine;
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
      const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/global/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PATCH rename + archive; list excludes archived chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-patch-"));
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
          body: JSON.stringify({ title: "Original" }),
        })
      ).json()) as { chat: ChatSession };

      const renameRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Renamed" }),
        }
      );
      expect(renameRes.status).toBe(200);
      expect(((await renameRes.json()) as { chat: ChatSession }).chat.title).toBe("Renamed");

      const archiveRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ archived: true }),
        }
      );
      expect(archiveRes.status).toBe(200);

      const listRes = await fetch(`http://127.0.0.1:${port}/api/workspaces/ws/chats`);
      const listed = (await listRes.json()) as { chats: ChatSession[] };
      expect(listed.chats.some((c) => c.id === created.chat.id)).toBe(false);
    } finally {
      await http.close();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards chat WS frames on /ws", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-ws-"));
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
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on("open", () => {
          events.emitChatStatus("chat-ws-1", "running");
          events.emitChatEvent("chat-ws-1", {
            id: 1,
            chatId: "chat-ws-1",
            seq: 1,
            eventType: "chat.message",
            payload: '{"role":"user","text":"hi"}',
            createdAt: new Date().toISOString(),
          });
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
          { type: "chat_status", chatId: "chat-ws-1", status: "running" },
          expect.objectContaining({
            type: "chat_event",
            chatId: "chat-ws-1",
            event: expect.objectContaining({ eventType: "chat.message" }),
          }),
        ])
      );
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps error codes on queue-message, interrupt, and answer routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-route-errors-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    // The /answer route uses its own token-aware mapping (run-token → 403, else
    // 400) and answerChat throws a plain Error, so it is exercised separately
    // from the chatMessageErrorStatus-backed queue/interrupt routes.
    let answerError: Error = new Error("Chat is not awaiting input (status=idle)");
    const chatEngine = {
      queueMessage: async () => {
        throw new ChatMessageError("busy", "Chat is busy (status=running)");
      },
      interruptChat: async () => {
        throw new ChatMessageError("not_found", "Chat not found: chat-1");
      },
      answerChat: () => {
        throw answerError;
      },
    } as unknown as ChatEngine;
    const http = await startHttpServer({
      engine: stubRunEngine(),
      chatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    async function post(path: string, body: unknown) {
      return fetch(`http://127.0.0.1:${port}/api/chats/chat-1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    try {
      expect((await post("queue-message", { message: "later" })).status).toBe(409);
      expect((await post("interrupt", { message: "stop" })).status).toBe(404);

      answerError = new Error("Chat is not awaiting input (status=idle)");
      expect((await post("answer", { answer: "yes" })).status).toBe(400);

      answerError = new Error("invalid run token");
      expect((await post("answer", { answer: "yes" })).status).toBe(403);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces CSRF + control-token guards on chat routes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-3-guards-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const controlToken = "control-secret-token";
    const calls: string[] = [];
    const chatEngine = {
      sendMessage: async (chatId: string) => {
        calls.push(chatId);
      },
    } as unknown as ChatEngine;
    const http = await startHttpServer({
      engine: stubRunEngine(),
      chatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      controlToken,
      port,
    });

    try {
      // CSRF guard fires on a chat route: a foreign Origin on a mutating POST is
      // rejected before the engine is touched.
      const csrfRes = await fetch(`http://127.0.0.1:${port}/api/chats/chat-1/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://evil.test",
          "x-lca-control-token": controlToken,
        },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(csrfRes.status).toBe(403);
      expect(calls).toHaveLength(0);

      // Same-origin JSON over loopback proceeds (loopback is token-exempt).
      const okRes = await fetch(`http://127.0.0.1:${port}/api/chats/chat-1/message`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: `http://127.0.0.1:${port}`,
          "x-lca-control-token": controlToken,
        },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(okRes.status).toBe(202);
      expect(calls).toEqual(["chat-1"]);

      // Control-token gate on /api/* (chat routes included): non-loopback without
      // a valid token is refused. 127.0.0.1 cannot present as non-loopback over a
      // real socket, so assert the gate the daemon applies (missing → 401,
      // mismatch → 403, match → ok) exactly as the b13 suite does.
      expect(checkControlToken({ isLoopbackSource: false, controlToken })).toBe("missing");
      expect(
        checkControlToken({ isLoopbackSource: false, controlToken, presented: "wrong" })
      ).toBe("mismatch");
      expect(
        checkControlToken({ isLoopbackSource: false, controlToken, presented: controlToken })
      ).toBe("ok");
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
