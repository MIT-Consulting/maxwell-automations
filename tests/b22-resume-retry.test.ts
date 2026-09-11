import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CursorAgentError,
} from "@cursor/sdk";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import {
  DEFAULT_RESUME_RETRY_POLICY,
  isTransientResumeError,
  ResumeAbortError,
  resumeWithRetry,
} from "../packages/daemon/src/executor/resume-retry.ts";
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

function eventTypes(db: ReturnType<typeof openDatabase>, runId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ event_type: string }>
  ).map((event) => event.event_type);
}

function chatEventTypes(db: ReturnType<typeof openDatabase>, chatId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM chat_events WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function statusOf(db: ReturnType<typeof openDatabase>, runId: string): string | undefined {
  const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function chatStatus(db: ReturnType<typeof openDatabase>, chatId: string): string | undefined {
  const row = db.prepare("SELECT status FROM chat_sessions WHERE id = ?").get(chatId) as
    | { status: string }
    | undefined;
  return row?.status;
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

function makeActiveRun(overrides?: Partial<ActiveRun>): ActiveRun {
  const base: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-ok",
    sdkRunId: "sdk-ok",
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "ok" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return { ...base, ...overrides };
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
          sendFollowUp: async (message: string | { text: string }) => {
            const text = typeof message === "string" ? message : message.text;
            const followUp = makeRun("agent-follow-up", "sdk-follow-up");
            return {
              ...followUp,
              async *stream() {
                yield {
                  type: "assistant",
                  message: { content: [{ type: "text", text: `follow-up: ${text}` }] },
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

function makeFlakyResumeExecutor(failuresBeforeSuccess: number): {
  executor: Executor;
  resumeCalls: () => number;
  followUpMessages: () => string[];
} {
  let resumeCalls = 0;
  const followUps: string[] = [];

  const shellWithFollowUp = (): ActiveRun => {
    const next = makeActiveRun({
      agentId: "agent-follow-up",
      sdkRunId: "sdk-follow-up",
    });
    return {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async (message: string | { text: string }) => {
        followUps.push(typeof message === "string" ? message : message.text);
        return next;
      },
    };
  };

  return {
    executor: {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async (_params: ResumeParams) => {
        resumeCalls += 1;
        if (resumeCalls <= failuresBeforeSuccess) {
          throw new CursorAgentError(`Agent agent-test not found (call ${resumeCalls})`);
        }
        return shellWithFollowUp();
      },
    },
    resumeCalls: () => resumeCalls,
    followUpMessages: () => followUps,
  };
}

describe("resume-retry helper", () => {
  it("classifies transient and non-transient errors", () => {
    expect(
      isTransientResumeError(new CursorAgentError("Agent agent-1 not found"))
    ).toBe(true);
    expect(
      isTransientResumeError(new CursorAgentError("busy", { isRetryable: true }))
    ).toBe(true);
    const timeoutErr = new Error("resume exceeded 50ms");
    timeoutErr.name = "SpawnTimeoutError";
    expect(isTransientResumeError(timeoutErr)).toBe(true);

    expect(isTransientResumeError(new Error("not found"))).toBe(false);
    expect(isTransientResumeError(new AuthenticationError("unauthenticated"))).toBe(
      false
    );
    expect(
      isTransientResumeError(
        new CursorAgentError("ERROR_NOT_LOGGED_IN: not logged in")
      )
    ).toBe(false);
  });

  it("retries transient failures with linear backoff metadata", async () => {
    let calls = 0;
    const retries: Array<{ attempt: number; delayMs: number }> = [];

    const result = await resumeWithRetry({
      make: async () => {
        calls += 1;
        if (calls < 3) {
          throw new CursorAgentError("Agent agent-1 not found");
        }
        return makeActiveRun();
      },
      signal: new AbortController().signal,
      policy: FAST_RETRY,
      onRetry: ({ attempt, delayMs }) => {
        retries.push({ attempt, delayMs });
      },
    });

    expect(result.agentId).toBe("agent-ok");
    expect(calls).toBe(3);
    expect(retries).toEqual([
      { attempt: 1, delayMs: FAST_RETRY.backoffMs },
      { attempt: 2, delayMs: FAST_RETRY.backoffMs * 2 },
    ]);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    await expect(
      resumeWithRetry({
        make: async () => {
          calls += 1;
          throw new Error("permanent failure");
        },
        signal: new AbortController().signal,
        policy: FAST_RETRY,
      })
    ).rejects.toThrow("permanent failure");
    expect(calls).toBe(1);
  });

  it("rethrows the final transient error after exactly maxAttempts", async () => {
    let calls = 0;
    const terminalError = new CursorAgentError("Agent agent-1 not found");

    await expect(
      resumeWithRetry({
        make: async () => {
          calls += 1;
          throw terminalError;
        },
        signal: new AbortController().signal,
        policy: FAST_RETRY,
      })
    ).rejects.toBe(terminalError);

    expect(calls).toBe(FAST_RETRY.maxAttempts);
  });

  it("aborts during backoff without another make() call", async () => {
    let calls = 0;
    const abort = new AbortController();

    const promise = resumeWithRetry({
      make: async () => {
        calls += 1;
        throw new CursorAgentError("Agent agent-1 not found");
      },
      signal: abort.signal,
      policy: { maxAttempts: 3, backoffMs: 100 },
    });

    await until(() => calls === 1);
    abort.abort();

    await expect(promise).rejects.toBeInstanceOf(ResumeAbortError);
    expect(calls).toBe(1);
  });

  it("disposes a late success when aborted in flight", async () => {
    let disposeCalls = 0;
    const abort = new AbortController();

    const promise = resumeWithRetry({
      make: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return makeActiveRun({
          dispose: async () => {
            disposeCalls += 1;
          },
        });
      },
      signal: abort.signal,
      policy: DEFAULT_RESUME_RETRY_POLICY,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    abort.abort();

    await expect(promise).rejects.toBeInstanceOf(ResumeAbortError);
    expect(disposeCalls).toBe(1);
  });
});

describe("b22 run-engine resume retry", () => {
  it("self-heals a terminal follow-up after one transient not-found", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-terminal-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const flaky = makeFlakyResumeExecutor(1);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: flaky.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      void engine.sendMessage("run", "follow up after restart");
      await until(() => statusOf(db, "run") === "completed");

      expect(flaky.resumeCalls()).toBe(2);
      expect(flaky.followUpMessages()).toEqual(["follow up after restart"]);
      expect(eventTypes(db, "run")).toContain("run.resume.retry");
      expect(statusOf(db, "run")).toBe("completed");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores a terminal run after exhausted retries with one stale error", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-stale-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const flaky = makeFlakyResumeExecutor(99);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: flaky.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "cancelled",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      void engine.sendMessage("run", "too late");
      await until(() => flaky.resumeCalls() === FAST_RETRY.maxAttempts);

      expect(statusOf(db, "run")).toBe("cancelled");
      const retryEvents = eventTypes(db, "run").filter((t) => t === "run.resume.retry");
      expect(retryEvents).toHaveLength(FAST_RETRY.maxAttempts - 1);

      const errorRow = db
        .prepare(
          `SELECT payload FROM run_events
           WHERE run_id = 'run' AND event_type = 'run.error'
           ORDER BY seq DESC LIMIT 1`
        )
        .get() as { payload: string };
      const payload = JSON.parse(errorRow.payload) as { stale?: boolean };
      expect(payload.stale).toBe(true);
      expect(flaky.followUpMessages()).toHaveLength(0);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-heals boot re-attach for a running run", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-boot-running-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const flaky = makeFlakyResumeExecutor(1);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: flaky.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      await engine.resumeInterruptedRuns();
      await until(() => statusOf(db, "run") === "completed");

      expect(flaky.resumeCalls()).toBe(2);
      expect(eventTypes(db, "run")).toContain("run.resume.retry");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("self-heals boot re-attach for needs_input and delivers the pending answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-boot-needs-input-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const flaky = makeFlakyResumeExecutor(1);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: flaky.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "needs_input",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });
      db.prepare(
        `INSERT INTO input_requests (id, run_id, question, status)
         VALUES ('req-1', 'run', 'Pick one', 'pending')`
      ).run();

      const boot = engine.resumeInterruptedRuns();
      await until(() => flaky.resumeCalls() === 2);
      await engine.submitAnswer("run", "option A");
      await boot;
      await until(() => statusOf(db, "run") === "completed");

      expect(flaky.resumeCalls()).toBe(2);
      expect(
        flaky.followUpMessages().some((m) => m.includes("option A"))
      ).toBe(true);
      expect(eventTypes(db, "run")).toContain("input.delivered");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops terminal follow-up retry without delivering a message", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-abort-run-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const flaky = makeFlakyResumeExecutor(1);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: flaky.executor,
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      void engine.sendMessage("run", "stop me");
      await until(() => eventTypes(db, "run").includes("run.resume.retry"));
      await engine.cancelRun("run");
      await until(() => statusOf(db, "run") === "cancelled");

      expect(flaky.resumeCalls()).toBe(1);
      expect(flaky.followUpMessages()).toHaveLength(0);
      expect(statusOf(db, "run")).toBe("cancelled");
      expect(eventTypes(db, "run").filter((t) => t === "run.error")).toHaveLength(0);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b22 chat-engine resume retry", () => {
  it("self-heals after restart when the first resume is transiently not found", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-chat-restart-"));
    const dbPath = join(root, "state.sqlite");
    const workspace = join(root, "workspace");
    let db = openDatabase(dbPath);
    const first = makeSimpleSpawnExecutor();
    const firstEngine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: first.executor,
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedWorkspace(db, workspace);
      const session = firstEngine.createChat({ workspaceId: "ws" });
      const chatId = session.id;

      void firstEngine.sendMessage(chatId, "first turn");
      await until(() => chatStatus(db, chatId) === "idle");
      expect(first.spawnCalls()).toBe(1);
      expect(first.resumeCalls()).toBe(0);

      await firstEngine.shutdown();
      db.close();
      db = openDatabase(dbPath);

      const second = makeFlakyResumeExecutor(1);
      const secondEngine = new ChatEngine(db, {
        apiKey: "test-key",
        executor: second.executor,
        resumeRetryPolicy: FAST_RETRY,
      });
      try {
        void secondEngine.sendMessage(chatId, "second turn after restart");
        await until(() => chatStatus(db, chatId) === "idle");

        expect(second.resumeCalls()).toBe(2);
        expect(second.followUpMessages()).toEqual(["second turn after restart"]);
        expect(chatEventTypes(db, chatId)).toContain("chat.resume.retry");
        expect(chatEventTypes(db, chatId)).toContain("chat.resumed");
      } finally {
        await secondEngine.shutdown();
      }
    } finally {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks chat error stale after exhausted not-found retries", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-chat-stale-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const flaky = makeFlakyResumeExecutor(99);
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: flaky.executor,
      resumeRetryPolicy: FAST_RETRY,
    });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      db.prepare(
        `UPDATE chat_sessions
         SET agent_id = 'agent-old', sdk_run_id = 'sdk-old', status = 'idle'
         WHERE id = ?`
      ).run(session.id);

      void engine.sendMessage(session.id, "gone forever");
      await until(() =>
        chatEventTypes(db, session.id).filter((t) => t === "chat.error").length > 0
      );

      const errorRow = db
        .prepare(
          `SELECT payload FROM chat_events
           WHERE chat_id = ? AND event_type = 'chat.error'
           ORDER BY seq DESC LIMIT 1`
        )
        .get(session.id) as { payload: string };
      expect(JSON.parse(errorRow.payload)).toMatchObject({ stale: true });
      expect(chatStatus(db, session.id)).toBe("error");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stop during resume backoff prevents follow-up delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b22-chat-abort-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const flaky = makeFlakyResumeExecutor(1);
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: flaky.executor,
      resumeRetryPolicy: { maxAttempts: 3, backoffMs: 100 },
    });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      db.prepare(
        `UPDATE chat_sessions
         SET agent_id = 'agent-old', sdk_run_id = 'sdk-old', status = 'idle'
         WHERE id = ?`
      ).run(session.id);

      void engine.sendMessage(session.id, "interrupt me");
      await until(() =>
        chatEventTypes(db, session.id).includes("chat.resume.retry")
      );
      await engine.cancelChat(session.id);
      await until(() => chatStatus(db, session.id) === "idle");

      expect(flaky.resumeCalls()).toBe(1);
      expect(flaky.followUpMessages()).toHaveLength(0);
      expect(chatStatus(db, session.id)).toBe("idle");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
