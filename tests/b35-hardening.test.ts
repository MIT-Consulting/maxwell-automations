import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUTOMATION_MODEL,
  modelSelectionFromLifecyclePayload,
  modelSelectionKey,
  type ModelSelection,
} from "@lca/shared";
import { refineTitleWithLlm } from "../packages/daemon/src/chats/auto-title.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { freeListenPort } from "./helpers/free-port.ts";

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

const RICH_SELECTION: ModelSelection = {
  id: "custom-not-in-catalog",
  params: [
    { id: "reasoning", value: "high" },
    { id: "fast", value: "true" },
  ],
};

function capturingExecutor(spawns: SpawnParams[]): Executor {
  const makeRun = (agentId: string, sdkRunId: string): ActiveRun => ({
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {},
    wait: async () => ({ status: "finished", result: "ok" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async () => makeRun(agentId, `${sdkRunId}-fu`),
  });
  return {
    kind: "sdk-local",
    spawn: async (params) => {
      spawns.push(params);
      return makeRun("agent-h", "sdk-h");
    },
    resume: async () => makeRun("agent-h", "sdk-resume"),
  };
}

describe("b35.6 lifecycle payload helpers", () => {
  it("prefers canonical modelSelection over legacy model", () => {
    expect(
      modelSelectionFromLifecyclePayload({
        model: "legacy-id",
        modelSelection: RICH_SELECTION,
      })
    ).toEqual({
      id: "custom-not-in-catalog",
      params: [
        { id: "fast", value: "true" },
        { id: "reasoning", value: "high" },
      ],
    });
  });

  it("falls back to legacy string model when selection is corrupt", () => {
    expect(
      modelSelectionFromLifecyclePayload({
        model: "composer-2.5",
        modelSelection: { id: "  ", params: [] },
      })
    ).toEqual({ id: "composer-2.5" });
  });

  it("returns undefined when neither field is usable", () => {
    expect(modelSelectionFromLifecyclePayload({})).toBeUndefined();
    expect(
      modelSelectionFromLifecyclePayload({ modelSelection: { id: "" } })
    ).toBeUndefined();
  });
});

describe("b35.6 auto-title settingSources isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the global default model with settingSources: []", async () => {
    // mockImplementation (not mockResolvedValue alone) so a partial/spy miss
    // can't fall through to a real Agent.prompt that returns null via catch.
    const promptSpy = vi.spyOn(Agent, "prompt").mockImplementation(async () => {
      return { result: "Refined Title" } as never;
    });

    const root = mkdtempSync(join(tmpdir(), "lca-b35-title-"));
    try {
      const title = await refineTitleWithLlm({
        apiKey: "key",
        cwd: root,
        heuristic: "Rough title",
        firstMessageText: "Explain the flaky test",
      });
      expect(promptSpy).toHaveBeenCalledOnce();
      expect(title).toBe("Refined Title");
      const opts = promptSpy.mock.calls[0]![1] as {
        model: { id: string };
        local: { settingSources: string[] };
      };
      expect(opts.model).toEqual({ id: DEFAULT_AUTOMATION_MODEL });
      expect(opts.local.settingSources).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b35.6 CLI-style trigger + catalog outage + corrupt params", () => {
  it("POST /api/runs with only automationId executes persisted selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-cli-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
    ).run("ws", workspace);
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        model_params_json, config_path, config_key
      ) VALUES (
        'auto-1', 'ws', 'CLI Auto', 1, 'enabled', '{"type":"manual"}', 'hi',
        ?, ?, 't.yaml', 'cli-auto'
      )`
    ).run(
      RICH_SELECTION.id,
      JSON.stringify(RICH_SELECTION.params)
    );

    const spawns: SpawnParams[] = [];
    const events = new DaemonEventBus();
    const executor = capturingExecutor(spawns);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor,
      events,
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
      settings: DEFAULT_SETTINGS,
      listModels: async () => {
        throw new Error("catalog unavailable");
      },
    });

    try {
      const modelsRes = await fetch(`http://127.0.0.1:${port}/api/models`);
      expect(modelsRes.status).toBe(200);
      const modelsBody = (await modelsRes.json()) as {
        models: unknown[];
        warning?: string;
      };
      expect(modelsBody.models).toEqual([]);
      expect(modelsBody.warning).toMatch(/catalog unavailable/);

      const triggerRes = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: "auto-1" }),
      });
      expect(triggerRes.status).toBe(201);
      const { runId } = (await triggerRes.json()) as { runId: string };
      expect(runId).toBeTruthy();

      await until(() => spawns.length >= 1);
      expect(modelSelectionKey(spawns[0]!.model)).toBe(
        modelSelectionKey(RICH_SELECTION)
      );
    } finally {
      await http.close();
      await engine.shutdown();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("degrades corrupt stored params and still spawns id-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-corrupt-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
    ).run("ws", workspace);
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        model_params_json, config_path, config_key
      ) VALUES (
        'auto-bad', 'ws', 'Bad Params', 1, 'enabled', '{"type":"manual"}', 'hi',
        'still-runs', '{not-json', 't.yaml', 'bad-params'
      )`
    ).run();

    const spawns: SpawnParams[] = [];
    const events = new DaemonEventBus();
    const executor = capturingExecutor(spawns);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
      events,
    });

    try {
      const listed = new DashboardStore(db).listAutomations();
      const auto = listed.find((a) => a.id === "auto-bad");
      expect(auto?.modelSelection).toEqual({ id: "still-runs" });

      const runId = await engine.triggerRun("auto-bad", "manual");
      await until(() => spawns.length >= 1);
      expect(spawns[0]!.model).toEqual({ id: "still-runs" });
      expect(runId).toBeTruthy();
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts legacy model-only PATCH from old clients", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-legacy-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
    ).run("ws", workspace);
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        config_path, config_key, origin
      ) VALUES (
        'auto-leg', 'ws', 'Legacy', 1, 'enabled', '{"type":"manual"}', 'hi',
        null, 't.yaml', 'legacy', 'dashboard'
      )`
    ).run();

    const events = new DaemonEventBus();
    const executor = capturingExecutor([]);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor,
      events,
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
      settings: DEFAULT_SETTINGS,
      listModels: async () => [],
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/automations/auto-leg`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "old-client-model" }),
        }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        automation: { model: string | null; modelSelection: ModelSelection | null };
      };
      expect(body.automation.model).toBe("old-client-model");
      expect(body.automation.modelSelection).toEqual({ id: "old-client-model" });
    } finally {
      await http.close();
      await engine.shutdown();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
