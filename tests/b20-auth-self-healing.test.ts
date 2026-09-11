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

function makeSuccessFollowUpHandle(text: string): ActiveRun {
  return {
    kind: "sdk-local",
    agentId: "agent-follow-up",
    sdkRunId: "sdk-follow-up",
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: `follow-up: ${text}` }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "ok" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
}

function makeRetainedExecutor(): {
  executor: Executor;
  resumeCalls: () => number;
  followUpMessages: () => string[];
} {
  let resumes = 0;
  const followUps: string[] = [];
  return {
    resumeCalls: () => resumes,
    followUpMessages: () => followUps,
    executor: {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async (_params: ResumeParams) => {
        resumes += 1;
        const shell: ActiveRun = {
          kind: "sdk-local",
          agentId: "agent-resumed",
          sdkRunId: "sdk-resumed",
          async *stream() {},
          wait: async () => ({ status: "finished", result: null }) as never,
          cancel: async () => undefined,
          dispose: async () => undefined,
          sendFollowUp: async (message: string | { text: string }) => {
            const text = typeof message === "string" ? message : message.text;
            followUps.push(text);
            return makeSuccessFollowUpHandle(text);
          },
        };
        return shell;
      },
    },
  };
}

function seedRetainedRun(
  engine: RunEngine,
  runId: string,
  activeRun: ActiveRun,
  retainedAt = Date.now()
): void {
  const internals = engine as unknown as {
    retainedRuns: Map<
      string,
      { activeRun: ActiveRun; runToken: string; retainedAt: number }
    >;
    runTokens: Map<string, string>;
  };
  internals.retainedRuns.set(runId, {
    activeRun,
    runToken: "token-retained",
    retainedAt,
  });
  internals.runTokens.set(runId, "token-retained");
}

describe("b20 retained-session self-healing", () => {
  it("falls back to cold resume when retained sendFollowUp throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-throw-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const { executor, resumeCalls, followUpMessages } = makeRetainedExecutor();
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
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

      const retainedRun: ActiveRun = {
        kind: "sdk-local",
        agentId: "agent-retained",
        sdkRunId: "sdk-retained",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => {
          throw new Error("ERROR_NOT_LOGGED_IN");
        },
      };
      seedRetainedRun(engine, "run", retainedRun);

      void engine.sendMessage("run", "hello after idle");
      await until(() => statusOf(db, "run") === "completed");

      expect(resumeCalls()).toBe(1);
      expect(followUpMessages()).toEqual(["hello after idle"]);
      const types = eventTypes(db, "run");
      const fallbackIdx = types.indexOf("run.retained.fallback");
      const resumedIndexes = types.reduce<number[]>((acc, t, i) => {
        if (t === "run.resumed") acc.push(i);
        return acc;
      }, []);
      expect(fallbackIdx).toBeGreaterThan(-1);
      expect(resumedIndexes.some((i) => i > fallbackIdx)).toBe(true);
      const resumedPayloads = eventPayloads(db, "run", "run.resumed");
      expect(
        resumedPayloads.some((p) => (p as { retained?: boolean }).retained !== true)
      ).toBe(true);
      expect(
        eventPayloads(db, "run", "run.finished").some(
          (p) => (p as { sdkStatus?: string }).sdkStatus === "error"
        )
      ).toBe(false);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back when retained wait returns error with no meaningful output", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-silent-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const { executor, resumeCalls } = makeRetainedExecutor();
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
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

      const retainedRun: ActiveRun = {
        kind: "sdk-local",
        agentId: "agent-retained",
        sdkRunId: "sdk-retained",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => ({
          kind: "sdk-local",
          agentId: "agent-bad",
          sdkRunId: "sdk-bad",
          async *stream() {
            yield { type: "status", status: "running" } as never;
          },
          wait: async () => ({ status: "error", result: null }) as never,
          cancel: async () => undefined,
          dispose: async () => undefined,
        }),
      };
      seedRetainedRun(engine, "run", retainedRun);

      void engine.sendMessage("run", "silent failure");
      await until(() => statusOf(db, "run") === "completed");

      expect(resumeCalls()).toBe(1);
      expect(eventTypes(db, "run")).toContain("run.retained.fallback");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fallback when retained turn produced assistant output then errored", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-genuine-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let resumes = 0;
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          resumes += 1;
          throw new Error("resume should not be called");
        },
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      const retainedRun: ActiveRun = {
        kind: "sdk-local",
        agentId: "agent-retained",
        sdkRunId: "sdk-retained",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => ({
          kind: "sdk-local",
          agentId: "agent-bad",
          sdkRunId: "sdk-bad",
          async *stream() {
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "partial" }] },
            } as never;
          },
          wait: async () => ({ status: "error", result: null }) as never,
          cancel: async () => undefined,
          dispose: async () => undefined,
        }),
      };
      seedRetainedRun(engine, "run", retainedRun);

      void engine.sendMessage("run", "real output then fail");
      await until(() => statusOf(db, "run") === "failed");

      expect(resumes).toBe(0);
      expect(eventTypes(db, "run")).not.toContain("run.retained.fallback");
      expect(eventTypes(db, "run")).toContain("run.finished");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores terminal status when fallback cold resume is stale after retries", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-stale-fallback-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let resumes = 0;
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          resumes += 1;
          throw new CursorAgentError("Agent agent-test not found");
        },
      },
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

      seedRetainedRun(engine, "run", {
        kind: "sdk-local",
        agentId: "agent-retained",
        sdkRunId: "sdk-retained",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => {
          throw new Error("stale retained");
        },
      });

      void engine.sendMessage("run", "too late");
      await until(() => resumes === FAST_RETRY.maxAttempts);

      expect(statusOf(db, "run")).toBe("cancelled");
      expect(eventTypes(db, "run")).toContain("run.retained.fallback");
      const errors = eventPayloads(db, "run", "run.error");
      expect(errors.some((p) => (p as { stale?: boolean }).stale === true)).toBe(true);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not cold resume when aborted between retained failure and fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-abort-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let resumes = 0;
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          resumes += 1;
          throw new Error("should not resume");
        },
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      seedRetainedRun(engine, "run", {
        kind: "sdk-local",
        agentId: "agent-retained",
        sdkRunId: "sdk-retained",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new Error("retained dead");
        },
      });

      void engine.sendMessage("run", "cancel me");
      await until(() => statusOf(db, "run") === "running");
      await engine.cancelRun("run");
      await until(() => {
        const status = statusOf(db, "run");
        return status === "completed" || status === "cancelled";
      });

      expect(resumes).toBe(0);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disposes retained sessions older than TTL on sweep", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-ttl-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let disposed = false;
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: { kind: "sdk-local", spawn: async () => { throw new Error("no spawn"); } },
      inputHub: inputHubFor(db),
      retainedSessionTtlMs: 60_000,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      seedRetainedRun(
        engine,
        "run",
        {
          kind: "sdk-local",
          agentId: "agent-retained",
          sdkRunId: "sdk-retained",
          async *stream() {},
          wait: async () => ({ status: "finished", result: null }) as never,
          cancel: async () => undefined,
          dispose: async () => {
            disposed = true;
          },
        },
        Date.now() - 61_000
      );

      engine.retainedSessionSweep();

      expect(disposed).toBe(true);
      const internals = engine as unknown as {
        retainedRuns: Map<string, unknown>;
        runTokens: Map<string, string>;
      };
      expect(internals.retainedRuns.size).toBe(0);
      expect(internals.runTokens.has("run")).toBe(false);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never disposes retained sessions when TTL is zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-ttl-off-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let disposed = false;
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: { kind: "sdk-local", spawn: async () => { throw new Error("no spawn"); } },
      inputHub: inputHubFor(db),
      retainedSessionTtlMs: 0,
    });

    try {
      seedRetainedRun(
        engine,
        "run",
        {
          kind: "sdk-local",
          agentId: "agent-retained",
          sdkRunId: "sdk-retained",
          async *stream() {},
          wait: async () => ({ status: "finished", result: null }) as never,
          cancel: async () => undefined,
          dispose: async () => {
            disposed = true;
          },
        },
        Date.now() - 999_999
      );

      engine.retainedSessionSweep();

      expect(disposed).toBe(false);
      const internals = engine as unknown as { retainedRuns: Map<string, unknown> };
      expect(internals.retainedRuns.size).toBe(1);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fires auth_expired when the retained fallback's cold resume also fails auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-fallback-auth-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const authCalls: Array<[string, string, string]> = [];
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          throw new AuthenticationError("not logged in");
        },
      },
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
      onAuthExpired: (kind, id, message) => {
        authCalls.push([kind, id, message]);
      },
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      seedRetainedRun(engine, "run", {
        kind: "sdk-local",
        agentId: "agent-retained",
        sdkRunId: "sdk-retained",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => {
          throw new Error("retained dead");
        },
      });

      void engine.sendMessage("run", "self-heal then true failure");
      await until(() => authCalls.length === 1);
      await until(() => statusOf(db, "run") === "completed");

      expect(eventTypes(db, "run")).toContain("run.retained.fallback");
      expect(eventTypes(db, "run")).not.toContain("run.resume.retry");
      const errors = eventPayloads(db, "run", "run.error");
      expect(errors.some((p) => (p as { reason?: string }).reason === "auth_expired")).toBe(
        true
      );
      expect(authCalls[0]?.[0]).toBe("run");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies cold-path auth failure and restores terminal status", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-auth-run-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const authCalls: Array<[string, string, string]> = [];
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          throw new AuthenticationError("ERROR_NOT_LOGGED_IN");
        },
      },
      inputHub: inputHubFor(db),
      resumeRetryPolicy: FAST_RETRY,
      onAuthExpired: (kind, id, message) => {
        authCalls.push([kind, id, message]);
      },
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      void engine.sendMessage("run", "dead login");
      await until(() => authCalls.length === 1);

      expect(statusOf(db, "run")).toBe("completed");
      expect(eventTypes(db, "run")).not.toContain("run.resume.retry");
      const errors = eventPayloads(db, "run", "run.error");
      expect(errors.some((p) => (p as { reason?: string }).reason === "auth_expired")).toBe(
        true
      );
      expect(authCalls[0]).toEqual(["run", "run", expect.stringContaining("ERROR_NOT_LOGGED_IN")]);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies chat cold-path auth failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b20-auth-chat-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const authCalls: Array<[string, string, string]> = [];
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          throw new Error("ERROR_NOT_LOGGED_IN");
        },
      },
      resumeRetryPolicy: FAST_RETRY,
      onAuthExpired: (kind, id, message) => {
        authCalls.push([kind, id, message]);
      },
    });

    try {
      seedWorkspace(db, join(root, "workspace"));
      db.prepare(
        `INSERT INTO chat_sessions (
          id, workspace_id, status, title, title_source, agent_id, sdk_run_id
        ) VALUES (
          'chat', 'ws', 'idle', NULL, 'none', 'agent-chat', 'sdk-chat'
        )`
      ).run();

      void engine.sendMessage("chat", "dead login");
      await until(() => authCalls.length === 1);

      expect(chatStatus(db, "chat")).toBe("error");
      expect(chatEventTypes(db, "chat")).toContain("chat.error");
      expect(authCalls[0]?.[0]).toBe("chat");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
