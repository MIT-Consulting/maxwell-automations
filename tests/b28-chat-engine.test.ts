import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatStatus, WsServerMessage } from "@lca/shared";
import {
  ChatEngine,
  ChatMessageError,
  type ChatDefaults,
} from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import type { DaemonEventSink } from "../packages/daemon/src/events.ts";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { normalizeOperatorMessage } from "../packages/daemon/src/executor/types.ts";

function spawnPromptText(params: SpawnParams): string {
  return normalizeOperatorMessage(params.prompt).text;
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

function chatStatus(db: ReturnType<typeof openDatabase>, chatId: string): string | undefined {
  const row = db.prepare("SELECT status FROM chat_sessions WHERE id = ?").get(chatId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function chatEventTypes(db: ReturnType<typeof openDatabase>, chatId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM chat_events WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function makeSimpleSpawnExecutor(): {
  executor: Executor;
  spawnCalls: () => number;
  resumeCalls: () => number;
} {
  let spawns = 0;
  let resumes = 0;

  const makeRun = (agentId: string, sdkRunId: string): ActiveRun => ({
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello from agent" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "done" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  });

  return {
    executor: {
      kind: "sdk-local",
      spawn: async (_params: SpawnParams) => {
        spawns += 1;
        return makeRun("agent-spawn", "sdk-spawn");
      },
      resume: async (_params: ResumeParams) => {
        resumes += 1;
        const shell = makeRun("agent-resume", "sdk-resume");
        return {
          ...shell,
          async *stream() {},
          sendFollowUp: async (message: string) => {
            const followUp = makeRun("agent-follow-up", "sdk-follow-up");
            return {
              ...followUp,
              async *stream() {
                yield {
                  type: "assistant",
                  message: { content: [{ type: "text", text: `follow-up: ${message}` }] },
                } as never;
              },
            };
          },
        };
      },
    },
    spawnCalls: () => spawns,
    resumeCalls: () => resumes,
  };
}

function makeBlockingExecutor(blockingTurns = 1): {
  executor: Executor;
  releaseStream: () => void;
  waitRunning: () => Promise<void>;
  cancelCalls: () => number;
} {
  let running = false;
  let cancelCount = 0;
  let turn = 0;
  let releaseStream: () => void = () => undefined;
  let streamGate = Promise.resolve();

  const resetGate = (): void => {
    streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
  };

  const makeRun = (opts?: { withFollowUp?: boolean }): ActiveRun => {
    const thisTurn = ++turn;
    const shouldBlock = thisTurn <= blockingTurns;
    if (shouldBlock) resetGate();

    const run: ActiveRun = {
      kind: "sdk-local",
      agentId: `agent-block-${thisTurn}`,
      sdkRunId: `sdk-block-${thisTurn}`,
      async *stream() {
        running = true;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "working" }] },
        } as never;
        if (shouldBlock) {
          await streamGate;
        }
      },
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => {
        cancelCount += 1;
        releaseStream();
      },
      dispose: async () => undefined,
    };

    if (opts?.withFollowUp) {
      return {
        ...run,
        async *stream() {},
        sendFollowUp: async (_message: string) => makeRun(),
      };
    }
    return run;
  };

  return {
    executor: {
      kind: "sdk-local",
      spawn: async () => makeRun(),
      resume: async () => makeRun({ withFollowUp: true }),
    },
    releaseStream: () => releaseStream(),
    waitRunning: async () => until(() => running),
    cancelCalls: () => cancelCount,
  };
}

function makeCapturingExecutor(): {
  executor: Executor;
  spawnParams: () => SpawnParams[];
} {
  const captured: SpawnParams[] = [];
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
  });

  return {
    executor: {
      kind: "sdk-local",
      spawn: async (params: SpawnParams) => {
        captured.push(params);
        return makeRun();
      },
      resume: async () => makeRun(),
    },
    spawnParams: () => captured,
  };
}

function capturingSink(): {
  sink: DaemonEventSink;
  wsMessages: WsServerMessage[];
  chatStatuses: Array<{ chatId: string; status: ChatStatus }>;
} {
  const wsMessages: WsServerMessage[] = [];
  const chatStatuses: Array<{ chatId: string; status: ChatStatus }> = [];
  const sink: DaemonEventSink = {
    emitRunEvent: () => undefined,
    emitRunStatus: () => undefined,
    emitChatEvent: (_chatId, event) => {
      wsMessages.push({ type: "chat_event", chatId: _chatId, event });
    },
    emitChatStatus: (chatId, status) => {
      chatStatuses.push({ chatId, status });
      wsMessages.push({ type: "chat_status", chatId, status });
    },
    emitChatInputRequest: (chatId, request) => {
      wsMessages.push({ type: "chat_input_request", chatId, request });
    },
  };
  return { sink, wsMessages, chatStatuses };
}

describe("b28.2 ChatEngine", () => {
  it("create → spawn → events persisted → idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-spawn-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor } = makeSimpleSpawnExecutor();
    const { sink, chatStatuses } = capturingSink();

    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      events: sink,
    });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(session.id, "hello chat");

      await until(() => chatStatus(db, session.id) === "idle");

      expect(chatEventTypes(db, session.id)).toEqual(
        expect.arrayContaining([
          "chat.message",
          "chat.started",
          "assistant",
          "chat.finished",
        ])
      );

      const row = db
        .prepare("SELECT agent_id, sdk_run_id FROM chat_sessions WHERE id = ?")
        .get(session.id) as { agent_id: string; sdk_run_id: string };
      expect(row.agent_id).toBe("agent-spawn");
      expect(row.sdk_run_id).toBe("sdk-spawn");

      expect(chatStatuses.map((s) => s.status)).toEqual(
        expect.arrayContaining(["running", "idle"])
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues with resume when agent ids exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-resume-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, resumeCalls } = makeSimpleSpawnExecutor();
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({
        workspaceId: "ws",
        agentId: "existing-agent",
        sdkRunId: "existing-sdk",
      });

      await engine.sendMessage(session.id, "continue please");
      await until(() => chatStatus(db, session.id) === "idle");

      expect(resumeCalls()).toBe(1);
      expect(chatEventTypes(db, session.id)).toContain("chat.resumed");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queues while running and delivers one message per turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-queue-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, releaseStream, waitRunning } = makeBlockingExecutor(1);
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      void engine.sendMessage(session.id, "first turn");
      await waitRunning();
      // queueMessage requires DB status=running (not just stream started).
      await until(() => chatStatus(db, session.id) === "running");

      const queuedId = await engine.queueMessage(session.id, "queued message");
      expect(queuedId).toBeTruthy();
      expect(chatEventTypes(db, session.id)).toContain("chat.message.queued");

      releaseStream();
      // settleTurn schedules deliverNextQueuedMessage via setTimeout(0), so idle
      // can land a tick before the queued row flips to delivered — wait on the
      // queue status itself (same pattern as the FIFO test below).
      await until(() => {
        const queued = db
          .prepare("SELECT status FROM chat_queued_messages WHERE id = ?")
          .get(queuedId) as { status: string } | undefined;
        return queued?.status === "delivered";
      }, 8000);
      await until(() => chatStatus(db, session.id) === "idle", 8000);

      expect(chatEventTypes(db, session.id).filter((t) => t === "chat.message").length).toBe(
        2
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it("interrupt aborts active turn and starts follow-up", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-interrupt-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, releaseStream, waitRunning, cancelCalls } = makeBlockingExecutor(2);
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      void engine.sendMessage(session.id, "first");
      await waitRunning();

      await engine.interruptChat(session.id, "send now");
      expect(cancelCalls()).toBeGreaterThan(0);
      expect(chatEventTypes(db, session.id)).toContain("chat.interrupted");

      releaseStream();
      await until(() => chatStatus(db, session.id) === "idle", 10000);

      const userMessages = db
        .prepare(
          `SELECT payload FROM chat_events
           WHERE chat_id = ? AND event_type = 'chat.message'`
        )
        .all(session.id) as Array<{ payload: string }>;
      expect(userMessages.length).toBeGreaterThanOrEqual(2);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it("stop cancels queued messages without delivering them", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-stop-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, waitRunning } = makeBlockingExecutor();
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      void engine.sendMessage(session.id, "running turn");
      await waitRunning();

      await engine.queueMessage(session.id, "never deliver");
      await engine.cancelChat(session.id);

      await until(() => chatStatus(db, session.id) === "idle");

      const queued = db
        .prepare(
          `SELECT status FROM chat_queued_messages
           WHERE chat_id = ? AND message = 'never deliver'`
        )
        .get(session.id) as { status: string };
      expect(queued.status).toBe("cancelled");

      const messageCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM chat_events
             WHERE chat_id = ? AND event_type = 'chat.message'`
          )
          .get(session.id) as { n: number }
      ).n;
      expect(messageCount).toBe(1);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ask_user round-trip via answerChat", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-ask-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    let sessionToken: string | undefined;
    const { executor, waitRunning } = makeBlockingExecutor();
    const { sink, wsMessages } = capturingSink();
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      events: sink,
    });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      void engine.sendMessage(session.id, "start");
      await waitRunning();

      const internals = engine as unknown as {
        sessionTokens: Map<string, string>;
      };
      sessionToken = internals.sessionTokens.get(session.id);
      expect(sessionToken).toBeTruthy();

      const answerPromise = engine.askAndWait(session.id, "pick one?", sessionToken);
      await until(() => chatStatus(db, session.id) === "needs_input");
      expect(chatEventTypes(db, session.id)).toContain("input.asked");
      expect(
        wsMessages.some((m) => m.type === "chat_input_request" && m.chatId === session.id)
      ).toBe(true);

      engine.answerChat(session.id, "option A");
      await expect(answerPromise).resolves.toBe("option A");
      expect(chatStatus(db, session.id)).toBe("running");
      expect(chatEventTypes(db, session.id)).toContain("input.delivered");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects __global__ workspace on sendMessage", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-global-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const { executor } = makeSimpleSpawnExecutor();
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('global', '__global__', 'Global')").run();
      const globalChat = engine.createChat({ workspaceId: "global" });
      await expect(engine.sendMessage(globalChat.id, "hi")).rejects.toMatchObject({
        code: "context_missing",
      } satisfies Partial<ChatMessageError>);
      expect(chatStatus(db, globalChat.id)).toBe("idle");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumeInterruptedChats resets stale running chats to idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-boot-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor } = makeSimpleSpawnExecutor();
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      db.prepare("UPDATE chat_sessions SET status = 'running' WHERE id = ?").run(session.id);

      await engine.resumeInterruptedChats();

      expect(chatStatus(db, session.id)).toBe("idle");
      expect(chatEventTypes(db, session.id)).toContain("chat.reconciled");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes (not respawns) across a simulated daemon restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-durable-"));
    const dbPath = join(root, "state.sqlite");
    const workspace = join(root, "workspace");
    let db = openDatabase(dbPath);
    const first = makeSimpleSpawnExecutor();
    const firstEngine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: first.executor,
    });

    try {
      seedWorkspace(db, workspace);
      const session = firstEngine.createChat({ workspaceId: "ws" });
      const chatId = session.id;

      await firstEngine.sendMessage(chatId, "first turn");
      await until(() => chatStatus(db, chatId) === "idle");
      expect(first.spawnCalls()).toBe(1);
      expect(first.resumeCalls()).toBe(0);

      // Tear the engine down and reopen the same DB file — as if the daemon
      // restarted. The persisted agent_id/sdk_run_id must drive a resume.
      await firstEngine.shutdown();
      db.close();
      db = openDatabase(dbPath);

      const second = makeSimpleSpawnExecutor();
      const secondEngine = new ChatEngine(db, {
        apiKey: "test-key",
        executor: second.executor,
      });
      try {
        await secondEngine.sendMessage(chatId, "second turn after restart");
        await until(() => chatStatus(db, chatId) === "idle");

        expect(second.resumeCalls()).toBe(1);
        expect(second.spawnCalls()).toBe(0);
        expect(chatEventTypes(db, chatId)).toContain("chat.resumed");
      } finally {
        await secondEngine.shutdown();
      }
    } finally {
      try {
        db.close();
      } catch {
        /* already closed during the simulated restart */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers two queued messages in enqueue order, one per turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-queue-fifo-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, releaseStream, waitRunning } = makeBlockingExecutor(1);
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      void engine.sendMessage(session.id, "first turn");
      await waitRunning();

      const firstQueuedId = await engine.queueMessage(session.id, "queued one");
      const secondQueuedId = await engine.queueMessage(session.id, "queued two");
      expect(firstQueuedId).toBeTruthy();
      expect(secondQueuedId).toBeTruthy();
      expect(firstQueuedId).not.toBe(secondQueuedId);

      // Release the blocking first turn; the two queued messages must drain
      // one-per-turn in enqueue order.
      releaseStream();
      await until(() => {
        const rows = db
          .prepare("SELECT status FROM chat_queued_messages WHERE chat_id = ?")
          .all(session.id) as Array<{ status: string }>;
        return rows.length === 2 && rows.every((r) => r.status === "delivered");
      }, 8000);
      await until(() => chatStatus(db, session.id) === "idle", 8000);

      const userTexts = (
        db
          .prepare(
            `SELECT payload FROM chat_events
             WHERE chat_id = ? AND event_type = 'chat.message' ORDER BY seq`
          )
          .all(session.id) as Array<{ payload: string }>
      ).map((row) => (JSON.parse(row.payload) as { text: string }).text);

      expect(userTexts).toEqual(["first turn", "queued one", "queued two"]);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);

  it("flows workspace defaults into spawn and lets per-chat overrides win", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-defaults-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, spawnParams } = makeCapturingExecutor();
    const defaults: ChatDefaults = {
      model: { id: "default-model" },
      systemPrompt: "default prompt",
      mcpExtra: { "extra-server": { url: "http://127.0.0.1:65000/mcp" } },
      mcpDisable: ["disabled-one"],
    };
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      resolveDefaults: () => defaults,
    });

    try {
      seedWorkspace(db, workspace);

      const defaulted = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(defaulted.id, "use defaults");
      await until(() => chatStatus(db, defaulted.id) === "idle");

      const overridden = engine.createChat({
        workspaceId: "ws",
        model: "chat-model",
        systemPrompt: "chat prompt",
      });
      await engine.sendMessage(overridden.id, "use overrides");
      await until(() => chatStatus(db, overridden.id) === "idle");

      const [defaultSpawn, overrideSpawn] = spawnParams();
      expect(defaultSpawn.model).toEqual({ id: "default-model" });
      expect(spawnPromptText(defaultSpawn)).toBe("default prompt\n\nuse defaults");
      expect(defaultSpawn.mcpExtra).toEqual(defaults.mcpExtra);
      expect(defaultSpawn.mcpDisable).toEqual(defaults.mcpDisable);

      expect(overrideSpawn.model).toEqual({ id: "chat-model" });
      expect(spawnPromptText(overrideSpawn)).toBe("chat prompt\n\nuse overrides");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the global composer-2.5 model with no default or override", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-2-global-model-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, spawnParams } = makeCapturingExecutor();
    const engine = new ChatEngine(db, { apiKey: "test-key", executor });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(session.id, "no defaults here");
      await until(() => chatStatus(db, session.id) === "idle");

      const [spawn] = spawnParams();
      expect(spawn.model).toEqual({ id: "composer-2.5" });
      expect(spawnPromptText(spawn)).toBe("no defaults here");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
