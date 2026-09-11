import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import WebSocket from "ws";
import type { ChatSession, ChatSnapshot, WsServerMessage } from "@lca/shared";
import {
  createChatSchema,
  updateChatSchema,
} from "@lca/shared";
import {
  ChatEngine,
  type ChatDefaults,
} from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import type { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";

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


function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("until() timed out"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function chatStatus(
  db: ReturnType<typeof openDatabase>,
  chatId: string
): string | undefined {
  const row = db
    .prepare("SELECT status FROM chat_sessions WHERE id = ?")
    .get(chatId) as { status: string } | undefined;
  return row?.status;
}

function makeCapturingExecutor(): {
  executor: Executor;
  spawnParams: () => SpawnParams[];
  resumeParams: () => ResumeParams[];
} {
  const spawned: SpawnParams[] = [];
  const resumed: ResumeParams[] = [];
  const makeRun = (): ActiveRun => ({
    kind: "sdk-local",
    agentId: "agent-cap",
    sdkRunId: "sdk-cap",
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "captured" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "done" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async () => makeRun(),
  });

  return {
    executor: {
      kind: "sdk-local",
      spawn: async (params: SpawnParams) => {
        spawned.push(params);
        return makeRun();
      },
      resume: async (params: ResumeParams) => {
        resumed.push(params);
        return makeRun();
      },
    },
    spawnParams: () => spawned,
    resumeParams: () => resumed,
  };
}

describe("b34.1 chat model schemas", () => {
  it("accepts optional model on create; rejects empty model", () => {
    expect(createChatSchema.safeParse({}).success).toBe(true);
    expect(createChatSchema.safeParse({ model: "composer-2.5" }).success).toBe(
      true
    );
    expect(createChatSchema.safeParse({ model: "" }).success).toBe(false);
    expect(createChatSchema.safeParse({ model: "  " }).success).toBe(false);
  });

  it("allows model on update including null clear; requires at least one field", () => {
    expect(updateChatSchema.safeParse({ model: "gpt-5" }).success).toBe(true);
    expect(updateChatSchema.safeParse({ model: null }).success).toBe(true);
    expect(updateChatSchema.safeParse({}).success).toBe(false);
    expect(updateChatSchema.safeParse({ model: "" }).success).toBe(false);
  });
});

describe("b34.1 chat model HTTP", () => {
  it("creates with model, PATCHes set/clear, and emits chat_session", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b34-http-model-"));
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
      const createdRes = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/ws/chats`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "composer-2.5" }),
        }
      );
      expect(createdRes.status).toBe(201);
      const created = (await createdRes.json()) as { chat: ChatSession };
      expect(created.chat.model).toBe("composer-2.5");

      const noModelRes = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/ws/chats`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      expect(noModelRes.status).toBe(201);
      const noModel = (await noModelRes.json()) as { chat: ChatSession };
      expect(noModel.chat.model).toBeNull();

      const getRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`
      );
      expect(getRes.status).toBe(200);
      const snap = (await getRes.json()) as ChatSnapshot;
      expect(snap.session.model).toBe("composer-2.5");

      const wsFrames: WsServerMessage[] = [];
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        socket.on("open", () => resolve(socket));
        socket.on("error", reject);
        setTimeout(() => reject(new Error("WS open timed out")), 3000);
      });
      ws.on("message", (data) => {
        wsFrames.push(JSON.parse(String(data)) as WsServerMessage);
      });

      const setRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-5.2" }),
        }
      );
      expect(setRes.status).toBe(200);
      const setBody = (await setRes.json()) as { chat: ChatSession };
      expect(setBody.chat.model).toBe("gpt-5.2");

      await until(() =>
        wsFrames.some(
          (f) =>
            f.type === "chat_session" &&
            f.chatId === created.chat.id &&
            f.session.model === "gpt-5.2"
        )
      );

      const clearRes = await fetch(
        `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: null }),
        }
      );
      expect(clearRes.status).toBe(200);
      const clearBody = (await clearRes.json()) as { chat: ChatSession };
      expect(clearBody.chat.model).toBeNull();

      await until(() =>
        wsFrames.some(
          (f) =>
            f.type === "chat_session" &&
            f.chatId === created.chat.id &&
            f.session.model === null
        )
      );
      ws.close();

      const afterClear = (await (
        await fetch(
          `http://127.0.0.1:${port}/api/chats/${encodeURIComponent(created.chat.id)}`
        )
      ).json()) as ChatSnapshot;
      expect(afterClear.session.model).toBeNull();
    } finally {
      await http.close();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b34.1 chat model engine resolution", () => {
  it("PATCH model applies on next send; null restores workspace default", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b34-engine-model-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, spawnParams, resumeParams } = makeCapturingExecutor();
    const defaults: ChatDefaults = {
      model: { id: "workspace-default" },
      systemPrompt: null,
    };
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      resolveDefaults: () => defaults,
    });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      expect(session.model).toBeNull();

      await engine.patchChat(session.id, { model: "patched-model" });
      const patched = engine.getChatSnapshot(session.id);
      expect(patched?.session.model).toBe("patched-model");

      await engine.sendMessage(session.id, "with patched model");
      await until(() => chatStatus(db, session.id) === "idle");

      await engine.patchChat(session.id, { model: null });
      expect(engine.getChatSnapshot(session.id)?.session.model).toBeNull();

      await engine.sendMessage(session.id, "with workspace default");
      await until(() => chatStatus(db, session.id) === "idle");

      const [first] = spawnParams();
      const [second] = resumeParams();
      expect(first?.model).toEqual({ id: "patched-model" });
      expect(second?.model).toEqual({ id: "workspace-default" });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
