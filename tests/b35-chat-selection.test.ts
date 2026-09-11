import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOMATION_MODEL,
  modelSelectionKey,
  type ModelSelection,
} from "@lca/shared";
import {
  ChatEngine,
  createChatDefaultsResolver,
} from "../packages/daemon/src/chats/engine.ts";
import { ChatStore, mapChatSession } from "../packages/daemon/src/chats/store.ts";
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
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run(workspaceId, workspace);
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

function latestChatEventPayload(
  db: ReturnType<typeof openDatabase>,
  chatId: string,
  eventType: string
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM chat_events
       WHERE chat_id = ? AND event_type = ?
       ORDER BY seq DESC LIMIT 1`
    )
    .get(chatId, eventType) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
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

const WS_DEFAULT: ModelSelection = {
  id: "grok-4.5",
  params: [{ id: "reasoning_effort", value: "high" }],
};

const CHAT_OVERRIDE: ModelSelection = {
  id: "composer-2",
  params: [{ id: "reasoning_effort", value: "low" }],
};

describe("b35.4b chat selection resolution", () => {
  it("resolves workspace default params, prefers chat override, and falls back with params", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-chat-sel-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const store = new ChatStore(db);
    const { executor, spawnParams, resumeParams } = makeCapturingExecutor();
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      store,
      resolveDefaults: createChatDefaultsResolver(store),
    });

    try {
      seedWorkspace(db, workspace);
      store.upsertWorkspaceChatDefaults("ws", { model: WS_DEFAULT });

      const session = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(session.id, "use workspace default");
      await until(() => chatStatus(db, session.id) === "idle");

      const started = latestChatEventPayload(db, session.id, "chat.started");
      expect(started?.model).toBe(WS_DEFAULT.id);
      expect(started?.modelSelection).toEqual(WS_DEFAULT);
      expect(modelSelectionKey(started!.modelSelection as ModelSelection)).toBe(
        modelSelectionKey(WS_DEFAULT)
      );
      expect(spawnParams()[0]?.model).toEqual(WS_DEFAULT);

      await engine.patchChat(session.id, { model: CHAT_OVERRIDE });
      await engine.sendMessage(session.id, "use chat override");
      await until(() => chatStatus(db, session.id) === "idle");

      const resumedOverride = latestChatEventPayload(
        db,
        session.id,
        "chat.resumed"
      );
      expect(resumedOverride?.model).toBe(CHAT_OVERRIDE.id);
      expect(resumedOverride?.modelSelection).toEqual(CHAT_OVERRIDE);
      expect(resumeParams()[0]?.model).toEqual(CHAT_OVERRIDE);

      await engine.patchChat(session.id, { model: null });
      await engine.sendMessage(session.id, "back to workspace default");
      await until(() => chatStatus(db, session.id) === "idle");

      const resumedFallback = latestChatEventPayload(
        db,
        session.id,
        "chat.resumed"
      );
      expect(resumedFallback?.model).toBe(WS_DEFAULT.id);
      expect(resumedFallback?.modelSelection).toEqual(WS_DEFAULT);
      expect(resumeParams()[1]?.model).toEqual(WS_DEFAULT);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to DEFAULT_AUTOMATION_MODEL with no default or override", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-chat-global-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const store = new ChatStore(db);
    const { executor, spawnParams } = makeCapturingExecutor();
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      store,
      resolveDefaults: createChatDefaultsResolver(store),
    });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(session.id, "no defaults");
      await until(() => chatStatus(db, session.id) === "idle");

      const started = latestChatEventPayload(db, session.id, "chat.started");
      expect(started?.model).toBe(DEFAULT_AUTOMATION_MODEL);
      expect(started?.modelSelection).toEqual({ id: DEFAULT_AUTOMATION_MODEL });
      expect(spawnParams()[0]?.model).toEqual({ id: DEFAULT_AUTOMATION_MODEL });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("chat.started and chat.resumed carry agreeing model and modelSelection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-chat-events-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const store = new ChatStore(db);
    const { executor } = makeCapturingExecutor();
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      store,
      resolveDefaults: createChatDefaultsResolver(store),
    });

    try {
      seedWorkspace(db, workspace);
      store.upsertWorkspaceChatDefaults("ws", { model: WS_DEFAULT });

      const session = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(session.id, "first");
      await until(() => chatStatus(db, session.id) === "idle");

      const started = latestChatEventPayload(db, session.id, "chat.started");
      expect(started?.model).toBe(
        (started?.modelSelection as ModelSelection).id
      );
      expect(started?.modelSelection).toEqual(WS_DEFAULT);

      await engine.sendMessage(session.id, "second");
      await until(() => chatStatus(db, session.id) === "idle");

      const resumed = latestChatEventPayload(db, session.id, "chat.resumed");
      expect(resumed?.model).toBe(
        (resumed?.modelSelection as ModelSelection).id
      );
      expect(resumed?.modelSelection).toEqual(WS_DEFAULT);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("promotes a parameterized run selection into the chat session", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-chat-promote-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    seedWorkspace(db, workspace);

    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        model_params_json, config_path, config_key
      ) VALUES (
        'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Prompt',
        'parent-model', ?, 'test.yaml', 'auto'
      )`
    ).run(
      JSON.stringify([{ id: "reasoning_effort", value: "high" }])
    );
    db.prepare(
      `INSERT INTO runs (
        id, automation_id, workspace_id, status, trigger_kind, prompt,
        agent_id, sdk_run_id, model, model_params_json
      ) VALUES (
        'run-1', 'auto', 'ws', 'completed', 'manual', 'Stored prompt',
        'agent-local', 'sdk-local', 'composer-2', ?
      )`
    ).run(JSON.stringify([{ id: "reasoning_effort", value: "low" }]));

    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor: makeCapturingExecutor().executor,
      inputHub: new InputHub(new InputStore(db)),
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: makeCapturingExecutor().executor,
    });

    try {
      const source = runEngine.prepareForPromotion("run-1");
      expect(source.model).toEqual(CHAT_OVERRIDE);

      const chat = chatEngine.promoteFromRun({
        runId: "run-1",
        workspaceId: source.run.workspace_id,
        agentId: source.run.agent_id,
        sdkRunId: source.run.sdk_run_id,
        model: source.model,
        events: source.events,
      });

      const mapped = mapChatSession(chat);
      expect(mapped.modelSelection).toEqual(CHAT_OVERRIDE);
      expect(modelSelectionKey(mapped.modelSelection!)).toBe(
        modelSelectionKey(CHAT_OVERRIDE)
      );
      expect(mapped.model).toBe(CHAT_OVERRIDE.id);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a model changed between turns on the next turn only", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-chat-next-turn-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const store = new ChatStore(db);
    const { executor, spawnParams, resumeParams } = makeCapturingExecutor();
    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor,
      store,
      resolveDefaults: createChatDefaultsResolver(store),
    });

    try {
      seedWorkspace(db, workspace);
      const session = engine.createChat({
        workspaceId: "ws",
        model: WS_DEFAULT,
      });

      await engine.sendMessage(session.id, "turn one");
      await until(() => chatStatus(db, session.id) === "idle");
      expect(spawnParams()[0]?.model).toEqual(WS_DEFAULT);
      expect(
        latestChatEventPayload(db, session.id, "chat.started")?.modelSelection
      ).toEqual(WS_DEFAULT);

      await engine.patchChat(session.id, { model: CHAT_OVERRIDE });
      await engine.sendMessage(session.id, "turn two");
      await until(() => chatStatus(db, session.id) === "idle");

      expect(resumeParams()[0]?.model).toEqual(CHAT_OVERRIDE);
      expect(
        latestChatEventPayload(db, session.id, "chat.resumed")?.modelSelection
      ).toEqual(CHAT_OVERRIDE);
      // First turn's selection must not be reused.
      expect(spawnParams()[0]?.model).toEqual(WS_DEFAULT);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
