import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthenticationError, CursorAgentError } from "@cursor/sdk";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

const FAST_RETRY = { maxAttempts: 3, backoffMs: 15 };

function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
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

function seedRun(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  input: {
    runId: string;
    status: string;
    agentId?: string | null;
    sdkRunId?: string | null;
  }
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    workspace
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Stored prompt',
      'config.yaml', 'auto'
    )`
  ).run();
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, agent_id, sdk_run_id
    ) VALUES (
      @runId, 'auto', 'ws', @status, 'manual', 'Stored prompt', @agentId, @sdkRunId
    )`
  ).run({
    runId: input.runId,
    status: input.status,
    agentId: input.agentId ?? null,
    sdkRunId: input.sdkRunId ?? null,
  });
}

function seedRunEvent(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  seq: number,
  eventType: string,
  payload: unknown
): void {
  db.prepare(
    "INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, ?, ?, ?)"
  ).run(runId, seq, eventType, JSON.stringify(payload));
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

function seedChatEvent(
  db: ReturnType<typeof openDatabase>,
  chatId: string,
  seq: number,
  eventType: string,
  payload: unknown
): void {
  db.prepare(
    "INSERT INTO chat_events (chat_id, seq, event_type, payload) VALUES (?, ?, ?, ?)"
  ).run(chatId, seq, eventType, JSON.stringify(payload));
}

function eventTypes(db: ReturnType<typeof openDatabase>, runId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ event_type: string }>
  ).map((event) => event.event_type);
}

function eventPayloads(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  eventType: string
): unknown[] {
  return (
    db
      .prepare(
        "SELECT payload FROM run_events WHERE run_id = ? AND event_type = ? ORDER BY seq"
      )
      .all(runId, eventType) as Array<{ payload: string }>
  ).map((row) => JSON.parse(row.payload) as unknown);
}

function chatEventTypes(db: ReturnType<typeof openDatabase>, chatId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM chat_events WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function chatEventPayloads(
  db: ReturnType<typeof openDatabase>,
  chatId: string,
  eventType: string
): unknown[] {
  return (
    db
      .prepare(
        "SELECT payload FROM chat_events WHERE chat_id = ? AND event_type = ? ORDER BY seq"
      )
      .all(chatId, eventType) as Array<{ payload: string }>
  ).map((row) => JSON.parse(row.payload) as unknown);
}

function statusOf(db: ReturnType<typeof openDatabase>, runId: string): string | undefined {
  const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function runAgentIds(
  db: ReturnType<typeof openDatabase>,
  runId: string
): { agent_id: string | null; sdk_run_id: string | null } | undefined {
  return db
    .prepare("SELECT agent_id, sdk_run_id FROM runs WHERE id = ?")
    .get(runId) as { agent_id: string | null; sdk_run_id: string | null } | undefined;
}

function chatStatus(db: ReturnType<typeof openDatabase>, chatId: string): string | undefined {
  const row = db.prepare("SELECT status FROM chat_sessions WHERE id = ?").get(chatId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function chatAgentIds(
  db: ReturnType<typeof openDatabase>,
  chatId: string
): { agent_id: string | null; sdk_run_id: string | null } | undefined {
  return db
    .prepare("SELECT agent_id, sdk_run_id FROM chat_sessions WHERE id = ?")
    .get(chatId) as { agent_id: string | null; sdk_run_id: string | null } | undefined;
}

function inputHubFor(db: ReturnType<typeof openDatabase>): InputHub {
  return new InputHub(new InputStore(db), {
    onNeedsInput: (runId) => {
      if (statusOf(db, runId) === "running") {
        db.prepare("UPDATE runs SET status = 'needs_input' WHERE id = ?").run(runId);
      }
    },
    onAnswered: (runId) => {
      if (statusOf(db, runId) === "needs_input") {
        db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
      }
    },
  });
}

/**
 * Executor whose resume permanently fails `not found` (the b32 trigger) and
 * whose spawn either succeeds with a working revived handle or throws.
 */
function makeDeadSessionExecutor(options?: {
  spawnFails?: boolean;
  resumeError?: () => Error;
  resumeDelayMs?: number;
}): {
  executor: Executor;
  spawnCalls: () => number;
  resumeCalls: () => number;
  spawnPrompts: () => string[];
} {
  let spawns = 0;
  let resumes = 0;
  const prompts: string[] = [];

  return {
    spawnCalls: () => spawns,
    resumeCalls: () => resumes,
    spawnPrompts: () => prompts,
    executor: {
      kind: "sdk-local",
      spawn: async (params: SpawnParams) => {
        spawns += 1;
        if (options?.spawnFails) {
          throw new Error("revive spawn exploded");
        }
        prompts.push(
          typeof params.prompt === "string" ? params.prompt : params.prompt.text
        );
        const handle: ActiveRun = {
          kind: "sdk-local",
          agentId: "agent-revived",
          sdkRunId: "sdk-revived",
          async *stream() {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "revived reply" }] },
            } as never;
          },
          wait: async () => ({ status: "finished", result: "ok" }) as never,
          cancel: async () => undefined,
          dispose: async () => undefined,
        };
        return handle;
      },
      resume: async (_params: ResumeParams) => {
        resumes += 1;
        if (options?.resumeDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.resumeDelayMs));
        }
        throw options?.resumeError?.() ??
          new CursorAgentError("Agent agent-old not found");
      },
    },
  };
}

describe("b32 run-engine revive tier", () => {
  it("revives a follow-up after exhausted not-found retries", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-run-happy-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor();
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-old",
        sdkRunId: "sdk-old",
      });
      seedRunEvent(db, "run", 1, "run.message", {
        role: "user",
        text: "original ask",
      });
      seedRunEvent(db, "run", 2, "assistant", {
        type: "assistant",
        message: { content: [{ type: "text", text: "original answer" }] },
      });

      void engine.sendMessage("run", "follow up into the void");
      await until(() => eventTypes(db, "run").includes("run.finished"));
      await until(() => statusOf(db, "run") === "completed");

      expect(dead.resumeCalls()).toBe(FAST_RETRY.maxAttempts);
      expect(dead.spawnCalls()).toBe(1);

      const types = eventTypes(db, "run");
      const lastRetryIdx = types.lastIndexOf("run.resume.retry");
      const revivedIdx = types.indexOf("run.revived");
      expect(revivedIdx).toBeGreaterThan(lastRetryIdx);
      expect(types).toContain("run.finished");
      expect(types).not.toContain("run.error");
      expect(types).not.toContain("run.started");
      expect(types).not.toContain("run.spawn.attempt");

      const revivedPayload = eventPayloads(db, "run", "run.revived")[0] as {
        previousAgentId?: string;
        previousSdkRunId?: string;
        agentId?: string;
        sdkRunId?: string;
        transcriptMessages?: number;
        truncated?: boolean;
      };
      expect(revivedPayload.previousAgentId).toBe("agent-old");
      expect(revivedPayload.previousSdkRunId).toBe("sdk-old");
      expect(revivedPayload.agentId).toBe("agent-revived");
      expect(revivedPayload.sdkRunId).toBe("sdk-revived");
      expect(revivedPayload.truncated).toBe(false);
      expect(revivedPayload.transcriptMessages).toBeGreaterThan(0);

      expect(runAgentIds(db, "run")).toEqual({
        agent_id: "agent-revived",
        sdk_run_id: "sdk-revived",
      });

      const prompt = dead.spawnPrompts()[0];
      expect(prompt).toContain("continuing a prior conversation");
      expect(prompt).toContain("original answer");
      expect(prompt).toContain("follow up into the void");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps pre-b32 stale behavior when sessionRevive is off", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-run-kill-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor();
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
      sessionRevive: false,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-old",
        sdkRunId: "sdk-old",
      });

      void engine.sendMessage("run", "dropped on the floor");
      await until(() => eventTypes(db, "run").includes("run.error"));
      await until(() => statusOf(db, "run") === "completed");

      expect(dead.spawnCalls()).toBe(0);
      const errors = eventPayloads(db, "run", "run.error") as Array<{
        stale?: boolean;
        reviveFailed?: boolean;
      }>;
      expect(errors).toHaveLength(1);
      expect(errors[0].stale).toBe(true);
      expect(errors[0].reviveFailed).toBeUndefined();
      expect(eventTypes(db, "run")).not.toContain("run.revived");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades to a reviveFailed stale error when the revive spawn throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-run-spawn-fail-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor({ spawnFails: true });
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "cancelled",
        agentId: "agent-old",
        sdkRunId: "sdk-old",
      });

      void engine.sendMessage("run", "revive me if you can");
      await until(() => eventTypes(db, "run").includes("run.error"));
      await until(() => statusOf(db, "run") === "cancelled");

      expect(dead.spawnCalls()).toBe(1);
      const errors = eventPayloads(db, "run", "run.error") as Array<{
        stale?: boolean;
        reviveFailed?: boolean;
      }>;
      expect(errors).toHaveLength(1);
      expect(errors[0].stale).toBe(true);
      expect(errors[0].reviveFailed).toBe(true);
      expect(eventTypes(db, "run")).not.toContain("run.revived");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never revives on auth_expired", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-run-auth-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor({
      resumeError: () => new AuthenticationError("ERROR_NOT_LOGGED_IN"),
    });
    const authCalls: string[] = [];
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
      onAuthExpired: (_kind, id) => {
        authCalls.push(id);
      },
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-old",
        sdkRunId: "sdk-old",
      });

      void engine.sendMessage("run", "dead login");
      await until(() => authCalls.length === 1);
      await until(() => statusOf(db, "run") === "completed");

      expect(dead.spawnCalls()).toBe(0);
      const errors = eventPayloads(db, "run", "run.error") as Array<{
        reason?: string;
      }>;
      expect(errors.some((p) => p.reason === "auth_expired")).toBe(true);
      expect(eventTypes(db, "run")).not.toContain("run.revived");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not spawn a revive when cancelled during the resume retries", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-run-abort-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor({ resumeDelayMs: 30 });
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: { maxAttempts: 3, backoffMs: 100 },
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-old",
        sdkRunId: "sdk-old",
      });

      void engine.sendMessage("run", "cancel me");
      await until(() => dead.resumeCalls() === 1);
      await engine.cancelRun("run");
      await until(() => statusOf(db, "run") === "cancelled");

      expect(dead.spawnCalls()).toBe(0);
      expect(eventTypes(db, "run")).not.toContain("run.revived");
      expect(eventTypes(db, "run").filter((t) => t === "run.error")).toHaveLength(0);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b32 chat-engine revive tier", () => {
  function seedChat(
    db: ReturnType<typeof openDatabase>,
    input: { chatId: string; systemPrompt?: string | null }
  ): void {
    db.prepare(
      `INSERT INTO chat_sessions (
        id, workspace_id, status, title, title_source, agent_id, sdk_run_id, system_prompt
      ) VALUES (
        @chatId, 'ws', 'idle', NULL, 'none', 'agent-old', 'sdk-old', @systemPrompt
      )`
    ).run({ chatId: input.chatId, systemPrompt: input.systemPrompt ?? null });
  }

  it("revives a chat turn and returns the chat to idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-chat-happy-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor();
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedWorkspace(db, join(root, "workspace"));
      seedChat(db, { chatId: "chat", systemPrompt: "Always answer tersely." });
      seedChatEvent(db, "chat", 1, "chat.message", {
        role: "user",
        text: "earlier chat turn",
      });

      void engine.sendMessage("chat", "hello again after expiry");
      await until(() => chatStatus(db, "chat") === "idle");

      expect(dead.resumeCalls()).toBe(FAST_RETRY.maxAttempts);
      expect(dead.spawnCalls()).toBe(1);
      expect(chatEventTypes(db, "chat")).toContain("chat.revived");
      expect(chatEventTypes(db, "chat")).not.toContain("chat.error");

      const revivedPayload = chatEventPayloads(db, "chat", "chat.revived")[0] as {
        previousAgentId?: string;
        agentId?: string;
      };
      expect(revivedPayload.previousAgentId).toBe("agent-old");
      expect(revivedPayload.agentId).toBe("agent-revived");
      expect(chatAgentIds(db, "chat")).toEqual({
        agent_id: "agent-revived",
        sdk_run_id: "sdk-revived",
      });

      const prompt = dead.spawnPrompts()[0];
      expect(prompt).toContain("Always answer tersely.");
      expect(prompt).toContain("continuing a prior conversation");
      expect(prompt).toContain("earlier chat turn");
      expect(prompt).toContain("hello again after expiry");
      expect(prompt.indexOf("Always answer tersely.")).toBeLessThan(
        prompt.indexOf("continuing a prior conversation")
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps pre-b32 stale error behavior when sessionRevive is off", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-chat-kill-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor();
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      resumeRetryPolicy: FAST_RETRY,
      sessionRevive: false,
    });

    try {
      seedWorkspace(db, join(root, "workspace"));
      seedChat(db, { chatId: "chat" });

      void engine.sendMessage("chat", "gone forever");
      await until(() => chatStatus(db, "chat") === "error");

      expect(dead.spawnCalls()).toBe(0);
      const errors = chatEventPayloads(db, "chat", "chat.error") as Array<{
        stale?: boolean;
        reviveFailed?: boolean;
      }>;
      expect(errors).toHaveLength(1);
      expect(errors[0].stale).toBe(true);
      expect(errors[0].reviveFailed).toBeUndefined();
      expect(chatEventTypes(db, "chat")).not.toContain("chat.revived");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks reviveFailed when the chat revive spawn throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-chat-spawn-fail-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor({ spawnFails: true });
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedWorkspace(db, join(root, "workspace"));
      seedChat(db, { chatId: "chat" });

      void engine.sendMessage("chat", "revive me if you can");
      await until(() => chatStatus(db, "chat") === "error");

      expect(dead.spawnCalls()).toBe(1);
      const errors = chatEventPayloads(db, "chat", "chat.error") as Array<{
        stale?: boolean;
        reviveFailed?: boolean;
      }>;
      expect(errors).toHaveLength(1);
      expect(errors[0].stale).toBe(true);
      expect(errors[0].reviveFailed).toBe(true);
      expect(chatEventTypes(db, "chat")).not.toContain("chat.revived");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never revives a chat on auth_expired", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b32-chat-auth-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const dead = makeDeadSessionExecutor({
      resumeError: () => new AuthenticationError("ERROR_NOT_LOGGED_IN"),
    });
    const authCalls: string[] = [];
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: dead.executor,
      resumeRetryPolicy: FAST_RETRY,
      onAuthExpired: (_kind, id) => {
        authCalls.push(id);
      },
    });

    try {
      seedWorkspace(db, join(root, "workspace"));
      seedChat(db, { chatId: "chat" });

      void engine.sendMessage("chat", "dead login");
      await until(() => authCalls.length === 1);
      await until(() => chatStatus(db, "chat") === "error");

      expect(dead.spawnCalls()).toBe(0);
      const errors = chatEventPayloads(db, "chat", "chat.error") as Array<{
        reason?: string;
      }>;
      expect(errors.some((p) => p.reason === "auth_expired")).toBe(true);
      expect(chatEventTypes(db, "chat")).not.toContain("chat.revived");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
