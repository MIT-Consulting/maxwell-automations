import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelSelectionKey, type ModelSelection } from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  OperatorMessage,
  ResumeParams,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import {
  ChatEngine,
  createChatDefaultsResolver,
} from "../packages/daemon/src/chats/engine.ts";
import { ChatStore } from "../packages/daemon/src/chats/store.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

const SELECTION_A: ModelSelection = {
  id: "composer-2",
  params: [{ id: "reasoning_effort", value: "medium" }],
};
const SELECTION_B: ModelSelection = {
  id: "composer-2",
  params: [{ id: "reasoning_effort", value: "high" }],
};
const SELECTION_C: ModelSelection = {
  id: "composer-2",
  params: [
    { id: "reasoning_effort", value: "high" },
    { id: "fast", value: "true" },
  ],
};

type RecordedSend = {
  input: unknown;
  options: unknown;
};

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

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')",
  ).run("ws", workspace);
}

function insertAutomation(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    model?: string | null;
    modelParamsJson?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt,
      config_path, config_key, model, model_params_json
    ) VALUES (
      ?, 'ws', 'B35', 1, 'enabled', '{"type":"manual"}', 'prompt',
      'config.yaml', ?, ?, ?
    )`,
  ).run(input.id, input.id, input.model ?? null, input.modelParamsJson ?? null);
}

function seedCompletedRun(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  runId: string,
): void {
  seedWorkspace(db, workspace);
  insertAutomation(db, {
    id: "auto",
    model: "composer-2",
    modelParamsJson: JSON.stringify([
      { id: "reasoning_effort", value: "medium" },
    ]),
  });
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt,
      agent_id, sdk_run_id
    ) VALUES (?, 'auto', 'ws', 'completed', 'manual', 'prompt', ?, ?)`,
  ).run(runId, "agent-retained", "sdk-retained");
}

function makeSuccessHandle(
  agentId: string,
  sdkRunId: string,
  onFollowUp?: (
    message: string | OperatorMessage,
    model: ModelSelection,
  ) => void,
): ActiveRun {
  const handle: ActiveRun = {
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "done" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async (message, model) => {
      onFollowUp?.(message, model);
      return makeSuccessHandle(`${agentId}-fu`, `${sdkRunId}-fu`, onFollowUp);
    },
  };
  return handle;
}

function seedRetainedRun(
  engine: RunEngine,
  runId: string,
  activeRun: ActiveRun,
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
    retainedAt: Date.now(),
  });
  internals.runTokens.set(runId, "token-retained");
}

describe("b35.4c SdkLocalExecutor selection delivery", () => {
  const createCalls: unknown[] = [];
  const resumeCalls: unknown[] = [];
  const sends: RecordedSend[] = [];
  let getRunShouldFail = false;
  let runCounter = 0;

  beforeEach(() => {
    createCalls.length = 0;
    resumeCalls.length = 0;
    sends.length = 0;
    getRunShouldFail = false;
    runCounter = 0;
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@cursor/sdk");
    vi.resetModules();
  });

  async function loadExecutor() {
    vi.doMock("@cursor/sdk", () => {
      function makeAgent(agentId: string) {
        return {
          agentId,
          send: async (input: unknown, options?: unknown) => {
            sends.push({ input, options });
            runCounter += 1;
            const id = `sdk-run-${runCounter}`;
            return {
              id,
              stream: async function* () {},
              wait: async () => ({ status: "finished", id, result: null }),
              supports: () => true,
              cancel: async () => undefined,
            };
          },
          [Symbol.asyncDispose]: async () => undefined,
        };
      }

      return {
        Agent: {
          create: async (options: unknown) => {
            createCalls.push(options);
            return makeAgent("agent-created");
          },
          resume: async (agentId: string, options: unknown) => {
            resumeCalls.push({ agentId, options });
            return makeAgent(agentId);
          },
          getRun: async () => {
            if (getRunShouldFail) {
              throw new Error("run not found");
            }
            runCounter += 1;
            const id = `sdk-get-${runCounter}`;
            return {
              id,
              stream: async function* () {},
              wait: async () => ({ status: "finished", id, result: null }),
              supports: () => true,
              cancel: async () => undefined,
            };
          },
        },
        CursorAgentError: class CursorAgentError extends Error {},
      };
    });

    const { SdkLocalExecutor } =
      await import("../packages/daemon/src/executor/sdk-local.ts");
    return new SdkLocalExecutor();
  }

  it("passes full selection on Agent.create and initial send", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-sdk-create-"));
    try {
      const executor = await loadExecutor();
      const active = await executor.spawn({
        apiKey: "key",
        cwd: root,
        model: SELECTION_A,
        prompt: "hello",
        runId: "run-1",
      });

      expect(createCalls).toHaveLength(1);
      const createOpts = createCalls[0] as {
        model: ModelSelection;
        local: { settingSources: string[] };
      };
      expect(createOpts.model).toEqual(SELECTION_A);
      expect(createOpts.local.settingSources).toEqual(["all"]);

      expect(sends).toHaveLength(1);
      expect((sends[0]!.options as { model: ModelSelection }).model).toEqual(
        SELECTION_A,
      );
      expect(sends[0]!.input).toContain(`Workspace root: ${root}`);
      expect(sends[0]!.input).toContain(
        "Run repository commands from this workspace.",
      );
      expect(sends[0]!.input).toContain("hello");
      expect(active.agentId).toBe("agent-created");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sendFollowUp uses the argument selection, not a captured spawn model", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-sdk-followup-"));
    try {
      const executor = await loadExecutor();
      const active = await executor.spawn({
        apiKey: "key",
        cwd: root,
        model: SELECTION_A,
        prompt: "first",
        runId: "run-1",
      });
      sends.length = 0;

      const next = await active.sendFollowUp!("second", SELECTION_B);
      expect(sends).toHaveLength(1);
      const optsB = sends[0]!.options as {
        model: ModelSelection;
        local: { force: boolean };
        mcpServers: Record<string, unknown>;
      };
      expect(optsB.model).toEqual(SELECTION_B);
      expect(optsB.local.force).toBe(true);
      expect(optsB.mcpServers).toBeTruthy();

      sends.length = 0;
      await next.sendFollowUp!("third", SELECTION_C);
      expect(sends).toHaveLength(1);
      expect((sends[0]!.options as { model: ModelSelection }).model).toEqual(
        SELECTION_C,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Agent.resume receives selection; follow-up uses sendFollowUp argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-sdk-resume-"));
    try {
      const executor = await loadExecutor();
      const active = await executor.resume({
        apiKey: "key",
        cwd: root,
        model: SELECTION_A,
        prompt: "ignored",
        runId: "run-1",
        agentId: "agent-old",
        sdkRunId: "sdk-old",
      });

      expect(resumeCalls).toHaveLength(1);
      const resumeOpts = (
        resumeCalls[0] as {
          options: {
            model: ModelSelection;
            local: { settingSources: string[] };
          };
        }
      ).options;
      expect(resumeOpts.model).toEqual(SELECTION_A);
      expect(resumeOpts.local.settingSources).toEqual(["all"]);

      sends.length = 0;
      await active.sendFollowUp!("after resume", SELECTION_B);
      expect((sends[0]!.options as { model: ModelSelection }).model).toEqual(
        SELECTION_B,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wrapResumedAgentOnly still delivers sendFollowUp selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-sdk-agent-only-"));
    try {
      getRunShouldFail = true;
      const executor = await loadExecutor();
      const active = await executor.resume({
        apiKey: "key",
        cwd: root,
        model: SELECTION_A,
        prompt: "ignored",
        runId: "run-1",
        agentId: "agent-old",
        sdkRunId: "sdk-missing",
      });

      expect(active.sdkRunId).toBe("sdk-missing");
      sends.length = 0;
      await active.sendFollowUp!("from agent-only", SELECTION_C);
      const opts = sends[0]!.options as {
        model: ModelSelection;
        local: { force: boolean };
        mcpServers: Record<string, unknown>;
      };
      expect(opts.model).toEqual(SELECTION_C);
      expect(opts.local.force).toBe(true);
      expect(opts.mcpServers).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b35.4c engine selection propagation", () => {
  it("spawn receives full ModelSelection with params", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-eng-spawn-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const spawned: SpawnParams[] = [];
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (params) => {
        spawned.push(params);
        return makeSuccessHandle("a", "s");
      },
      resume: async () => makeSuccessHandle("a", "s"),
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
    });

    try {
      seedWorkspace(db, workspace);
      insertAutomation(db, {
        id: "auto",
        model: "grok-4.5",
        modelParamsJson: JSON.stringify([
          { id: "reasoning_effort", value: "high" },
        ]),
      });
      const runId = await engine.triggerRun("auto");
      await until(() => {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(runId) as { status: string } | undefined;
        return row?.status === "completed";
      });

      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.model).toEqual({
        id: "grok-4.5",
        params: [{ id: "reasoning_effort", value: "high" }],
      });
      expect(typeof spawned[0]!.model).toBe("object");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retained follow-up picks up a model changed since the prior turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-eng-retained-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const followUpModels: ModelSelection[] = [];
    const retainedHandle = makeSuccessHandle(
      "agent-retained",
      "sdk-retained",
      (_message, model) => {
        followUpModels.push(model);
      },
    );
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async () => {
        throw new Error("resume should not be called");
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
    });

    try {
      seedCompletedRun(db, workspace, "run");
      seedRetainedRun(engine, "run", retainedHandle);

      expect(
        engine.setRunModel("run", {
          id: "composer-2",
          params: [{ id: "reasoning_effort", value: "high" }],
        }),
      ).toBe(true);

      void engine.sendMessage("run", "next turn after model change");
      await until(() => followUpModels.length >= 1);
      await until(() => {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get("run") as { status: string } | undefined;
        return row?.status === "completed";
      });

      expect(followUpModels[0]).toEqual({
        id: "composer-2",
        params: [{ id: "reasoning_effort", value: "high" }],
      });
      expect(modelSelectionKey(followUpModels[0]!)).toBe(
        modelSelectionKey({
          id: "composer-2",
          params: [{ id: "reasoning_effort", value: "high" }],
        }),
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("transcript revive spawn delivers current selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-eng-revive-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const spawned: SpawnParams[] = [];
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (params) => {
        spawned.push(params);
        return makeSuccessHandle("agent-revived", "sdk-revived");
      },
      resume: async () => {
        throw new Error("Agent agent-old not found");
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
      resumeRetryPolicy: { maxAttempts: 1, backoffMs: 1 },
      sessionRevive: true,
    });

    try {
      seedCompletedRun(db, workspace, "run");
      engine.setRunModel("run", SELECTION_B);

      void engine.sendMessage("run", "revive me");
      await until(() => spawned.length >= 1);
      await until(() => {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get("run") as { status: string } | undefined;
        return row?.status === "completed" || row?.status === "failed";
      });

      expect(spawned[0]!.model).toEqual(SELECTION_B);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cold interactive resume delivers current selection on resume + follow-up", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-eng-resume-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const resumed: ResumeParams[] = [];
    const followUpModels: ModelSelection[] = [];
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not run");
      },
      resume: async (params) => {
        resumed.push(params);
        return makeSuccessHandle(
          params.agentId,
          params.sdkRunId,
          (_m, model) => {
            followUpModels.push(model);
          },
        );
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
    });

    try {
      seedCompletedRun(db, workspace, "run");
      engine.setRunModel("run", SELECTION_C);

      void engine.sendMessage("run", "cold follow-up");
      await until(() => followUpModels.length >= 1);
      await until(() => {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get("run") as { status: string } | undefined;
        return row?.status === "completed";
      });

      expect(modelSelectionKey(resumed[0]!.model)).toBe(
        modelSelectionKey(SELECTION_C),
      );
      expect(modelSelectionKey(followUpModels[0]!)).toBe(
        modelSelectionKey(SELECTION_C),
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ask-user answer follow-up delivers the currently resolved selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-eng-answer-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const followUpModels: ModelSelection[] = [];
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not run");
        },
        resume: async () => {
          throw new Error("resume should not run");
        },
      },
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
    });

    try {
      seedCompletedRun(db, workspace, "run");
      expect(engine.setRunModel("run", SELECTION_C)).toBe(true);
      db.prepare("UPDATE runs SET status = 'running' WHERE id = 'run'").run();

      const internals = engine as unknown as {
        activeRuns: Map<string, ActiveRun>;
        inFlight: Map<string, AbortController>;
        deliverAnswerFollowUp(runId: string, answer: string): Promise<void>;
      };
      internals.activeRuns.set(
        "run",
        makeSuccessHandle("agent-answer", "sdk-answer", (_message, model) => {
          followUpModels.push(model);
        }),
      );
      internals.inFlight.set("run", new AbortController());

      await internals.deliverAnswerFollowUp("run", "use the safer fix");

      expect(followUpModels).toHaveLength(1);
      expect(modelSelectionKey(followUpModels[0]!)).toBe(
        modelSelectionKey(SELECTION_C),
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("chat spawn, resume follow-up, and revive deliver modelSelection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-eng-chat-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const store = new ChatStore(db);
    const spawned: SpawnParams[] = [];
    const resumed: ResumeParams[] = [];
    const followUpModels: ModelSelection[] = [];
    let resumeShouldFail = false;
    const selection: ModelSelection = {
      id: "chat-model",
      params: [{ id: "reasoning_effort", value: "low" }],
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (params) => {
        spawned.push(params);
        return makeSuccessHandle("chat-a", "sdk-a", (_m, model) => {
          followUpModels.push(model);
        });
      },
      resume: async (params) => {
        resumed.push(params);
        if (resumeShouldFail) {
          throw new Error("Agent chat-a not found");
        }
        return makeSuccessHandle(
          params.agentId,
          params.sdkRunId,
          (_m, model) => {
            followUpModels.push(model);
          },
        );
      },
    };
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      store,
      resolveDefaults: createChatDefaultsResolver(store),
      sessionRevive: true,
      resumeRetryPolicy: { maxAttempts: 1, backoffMs: 1 },
    });

    try {
      seedWorkspace(db, workspace);
      store.upsertWorkspaceChatDefaults("ws", { model: selection });

      const session = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(session.id, "spawn turn");
      await until(() => {
        const row = db
          .prepare("SELECT status FROM chat_sessions WHERE id = ?")
          .get(session.id) as { status: string } | undefined;
        return row?.status === "idle";
      });
      expect(spawned[0]!.model).toEqual(selection);

      await engine.sendMessage(session.id, "resume turn");
      await until(() => resumed.length >= 1);
      await until(() => {
        const row = db
          .prepare("SELECT status FROM chat_sessions WHERE id = ?")
          .get(session.id) as { status: string } | undefined;
        return row?.status === "idle";
      });
      expect(modelSelectionKey(resumed[0]!.model)).toBe(
        modelSelectionKey(selection),
      );
      expect(
        followUpModels.some(
          (m) => modelSelectionKey(m) === modelSelectionKey(selection),
        ),
      ).toBe(true);

      resumeShouldFail = true;
      await engine.sendMessage(session.id, "revive turn");
      await until(() => spawned.length >= 2);
      await until(() => {
        const row = db
          .prepare("SELECT status FROM chat_sessions WHERE id = ?")
          .get(session.id) as { status: string } | undefined;
        return row?.status === "idle";
      });
      expect(spawned[1]!.model).toEqual(selection);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("in-flight turn keeps the selection resolved at turn entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-eng-immutable-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    let releaseStream: (() => void) | undefined;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const spawned: SpawnParams[] = [];
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (params) => {
        spawned.push(params);
        return {
          kind: "sdk-local",
          agentId: "agent-slow",
          sdkRunId: "sdk-slow",
          async *stream() {
            await streamGate;
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "done" }] },
            } as never;
          },
          wait: async () => ({ status: "finished", result: "ok" }) as never,
          cancel: async () => undefined,
          dispose: async () => undefined,
        };
      },
      resume: async () => {
        throw new Error("resume unexpected");
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
    });

    try {
      seedWorkspace(db, workspace);
      insertAutomation(db, {
        id: "auto",
        model: "composer-2",
        modelParamsJson: JSON.stringify([
          { id: "reasoning_effort", value: "medium" },
        ]),
      });

      const runIdPromise = engine.triggerRun("auto");
      await until(() => spawned.length >= 1);
      const runId = await runIdPromise;

      // Change model while the turn is still streaming.
      expect(
        engine.setRunModel(runId, {
          id: "composer-2",
          params: [{ id: "reasoning_effort", value: "high" }],
        }),
      ).toBe(true);

      releaseStream?.();
      await until(() => {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(runId) as { status: string } | undefined;
        return row?.status === "completed";
      });

      // Spawn already happened with the turn-entry selection.
      expect(spawned[0]!.model).toEqual({
        id: "composer-2",
        params: [{ id: "reasoning_effort", value: "medium" }],
      });
    } finally {
      releaseStream?.();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
