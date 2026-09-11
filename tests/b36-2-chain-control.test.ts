import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import type { ChainControlResponse } from "@lca/shared";
import { chainControlDaemon } from "../packages/automations-io/src/server.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

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

function stubExecutor(result = "ok"): Executor {
  const activeRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-b36-2b",
    sdkRunId: "sdk-b36-2b",
    async *stream() {},
    wait: async () => ({ status: "finished", result }) as never,
    cancel: async () => {},
    dispose: async () => {},
  };
  return {
    kind: "sdk-local",
    spawn: async (_params: SpawnParams) => activeRun,
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    "ws",
    workspace,
    "Workspace"
  );
}

function insertAutomation(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    configKey: string;
    name: string;
    enabled?: number;
    chainJson?: string | null;
    prompt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json
    ) VALUES (?, 'ws', ?, ?, 'enabled', ?, ?, NULL, 'test.yaml', ?, ?)`
  ).run(
    input.id,
    input.name,
    input.enabled ?? 1,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name}`,
    input.configKey,
    input.chainJson ?? null
  );
}

type Env = {
  root: string;
  db: ReturnType<typeof openDatabase>;
  events: DaemonEventBus;
  store: RunStore;
  engine: RunEngine;
  chainRunner: ChainRunner;
};

async function createEnv(options?: { maxDepth?: number }): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-2b-"));
  const workspace = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  seedWorkspace(db, workspace);

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: stubExecutor(),
    events,
    inputHub,
    maxConcurrentRuns: 4,
  });
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    maxDepth: options?.maxDepth,
  });
  chainRunner.start();
  return { root, db, events, store, engine, chainRunner };
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function listRuns(db: ReturnType<typeof openDatabase>) {
  return db
    .prepare(
      `SELECT id, automation_id, parent_run_id, status, chain_root_run_id,
              chain_depth, chain_max_depth, chain_max_depth_override,
              chain_stop_requested_at, chain_stop_reason
       FROM runs ORDER BY created_at ASC, rowid ASC`
    )
    .all() as Array<{
    id: string;
    automation_id: string;
    parent_run_id: string | null;
    status: string;
    chain_root_run_id: string | null;
    chain_depth: number | null;
    chain_max_depth: number | null;
    chain_max_depth_override: number | null;
    chain_stop_requested_at: string | null;
    chain_stop_reason: string | null;
  }>;
}

function chainSkipped(
  db: ReturnType<typeof openDatabase>,
  runId: string
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND event_type = 'run.chain-skipped'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(runId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

function chainControlEvents(
  db: ReturnType<typeof openDatabase>,
  runId: string
): Array<Record<string, unknown>> {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = 'run.chain-control'
         ORDER BY seq ASC`
      )
      .all(runId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function setRunToken(engine: RunEngine, runId: string, token: string): void {
  const internals = engine as unknown as { runTokens: Map<string, string> };
  internals.runTokens.set(runId, token);
}

describe("b36-2b ChainRunner stop and re-budget", () => {
  it("stop skips chaining for one pipeline without affecting another on the same workers", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "Root {{featureId}}",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "Worker {{featureId}}",
        enabled: 0,
      });

      env.chainRunner.stop();

      const stoppedRoot = "root-stopped";
      env.store.insertRun({
        id: stoppedRoot,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "Root alpha",
        chainContext: {
          variables: { featureId: "alpha" },
          roleModels: {},
        },
        chainRootRunId: stoppedRoot,
        chainDepth: 0,
        chainMaxDepth: 5,
      });
      const stopResult = env.store.applyChainControl(stoppedRoot, {
        stop: { reason: "no runnable phase left" },
      });
      expect(stopResult.ok).toBe(true);

      const liveRoot = "root-live";
      env.store.insertRun({
        id: liveRoot,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "Root beta",
        chainContext: {
          variables: { featureId: "beta" },
          roleModels: {},
        },
        chainRootRunId: liveRoot,
        chainDepth: 0,
        chainMaxDepth: 5,
      });

      env.chainRunner.start();
      env.store.setStatus(stoppedRoot, "completed");
      env.store.setStatus(liveRoot, "completed");

      await until(() => {
        const runs = listRuns(env.db);
        const liveChild = runs.find((r) => r.parent_run_id === liveRoot);
        const stopSkip = chainSkipped(env.db, stoppedRoot);
        return liveChild != null && stopSkip?.reason === "stopped";
      });

      const runs = listRuns(env.db);
      expect(runs.find((r) => r.parent_run_id === stoppedRoot)).toBeUndefined();
      expect(runs.find((r) => r.parent_run_id === liveRoot)).toBeDefined();

      const skip = chainSkipped(env.db, stoppedRoot)!;
      expect(skip.reason).toBe("stopped");
      expect(skip.detail).toBe("no runnable phase left");
      expect(skip.next).toBe("b");
    } finally {
      await destroyEnv(env);
    }
  });

  it("extendBudget raises from the effective ceiling; children inherit; depth/root continue", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::loop",
        configKey: "loop",
        name: "Loop",
        prompt: "n={{n}}",
        chainJson: JSON.stringify({ next: "loop" }),
      });

      env.chainRunner.stop();

      const rootId = "root-extend";
      env.store.insertRun({
        id: rootId,
        automationId: "ws::loop",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "n=pipe",
        chainContext: { variables: { n: "pipe" }, roleModels: {} },
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 1,
      });

      const raised = env.engine.applyChainControl(
        rootId,
        { extendBudget: { transitions: 2 } },
        undefined
      );
      expect(raised.ok).toBe(true);
      if (raised.ok) {
        expect(raised.response.maxDepth).toBe(1);
        expect(raised.response.maxDepthOverride).toBe(3);
        expect(raised.response.effectiveMaxDepth).toBe(3);
        expect(raised.response.budgetExtension).toEqual({
          previousEffectiveMaxDepth: 1,
          requestedTransitions: 2,
          appliedTransitions: 2,
          clamped: false,
        });
      }

      const events = chainControlEvents(env.db, rootId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        extendBudget: true,
        previousEffectiveMaxDepth: 1,
        requestedTransitions: 2,
        appliedTransitions: 2,
        effectiveMaxDepth: 3,
        clamped: false,
      });

      // Identical retry does not double-apply or emit a second event.
      const retry = env.engine.applyChainControl(
        rootId,
        { extendBudget: { transitions: 2 } },
        undefined
      );
      expect(retry.ok).toBe(true);
      expect(chainControlEvents(env.db, rootId)).toHaveLength(1);
      expect(env.store.getRun(rootId)!.chain_max_depth_override).toBe(3);

      env.chainRunner.start();
      env.store.setStatus(rootId, "completed");

      await until(() => {
        const pipe = listRuns(env.db).filter(
          (r) => r.chain_root_run_id === rootId
        );
        const leaf = pipe.at(-1);
        return (
          leaf != null &&
          chainSkipped(env.db, leaf.id)?.reason === "max-depth"
        );
      }, 10000);

      const pipe = listRuns(env.db).filter(
        (r) => r.chain_root_run_id === rootId
      );
      // override 3 → root(0) + child(1) + child(2) + child(3) then skip = 4 runs
      expect(pipe).toHaveLength(4);
      expect(pipe[0]!.chain_depth).toBe(0);
      expect(pipe[0]!.chain_root_run_id).toBe(rootId);
      expect(pipe[0]!.chain_max_depth).toBe(1);
      expect(pipe[0]!.chain_max_depth_override).toBe(3);
      expect(pipe[1]!.chain_max_depth).toBe(3);
      expect(pipe[1]!.chain_depth).toBe(1);
      expect(pipe[1]!.chain_root_run_id).toBe(rootId);
      expect(pipe[2]!.chain_max_depth).toBe(3);
      expect(pipe[3]!.chain_max_depth).toBe(3);

      const skip = chainSkipped(env.db, pipe.at(-1)!.id)!;
      expect(skip.depth).toBe(3);
      expect(skip.maxDepth).toBe(3);
    } finally {
      await destroyEnv(env);
    }
  });

  it("rebudget raises then stops at the new boundary; original maxDepth stays", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::loop",
        configKey: "loop",
        name: "Loop",
        prompt: "n={{n}}",
        chainJson: JSON.stringify({ next: "loop" }),
      });

      env.chainRunner.stop();

      const rootId = "root-budget";
      env.store.insertRun({
        id: rootId,
        automationId: "ws::loop",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "n=pipe",
        chainContext: { variables: { n: "pipe" }, roleModels: {} },
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 1,
      });

      // Raise budget before the root transitions so depth 0 can chain past 1.
      const raised = env.engine.applyChainControl(
        rootId,
        { rebudget: { maxDepth: 2 } },
        undefined
      );
      expect(raised.ok).toBe(true);
      if (raised.ok) {
        expect(raised.response.maxDepth).toBe(1);
        expect(raised.response.maxDepthOverride).toBe(2);
        expect(raised.response.effectiveMaxDepth).toBe(2);
      }

      const beforeOverride = env.store.getRun(rootId)!;
      expect(beforeOverride.chain_max_depth).toBe(1);
      expect(beforeOverride.chain_max_depth_override).toBe(2);

      env.chainRunner.start();
      env.store.setStatus(rootId, "completed");

      await until(() => {
        const pipe = listRuns(env.db).filter(
          (r) => r.chain_root_run_id === rootId
        );
        const leaf = pipe.at(-1);
        return (
          leaf != null &&
          chainSkipped(env.db, leaf.id)?.reason === "max-depth"
        );
      }, 10000);

      const pipe = listRuns(env.db).filter(
        (r) => r.chain_root_run_id === rootId
      );
      // override 2 → root(0) + child(1) + child(2) then skip = 3 runs
      expect(pipe).toHaveLength(3);
      expect(pipe[0]!.chain_max_depth).toBe(1);
      expect(pipe[0]!.chain_max_depth_override).toBe(2);
      expect(pipe[1]!.chain_max_depth).toBe(2);
      expect(pipe[2]!.chain_max_depth).toBe(2);

      const skip = chainSkipped(env.db, pipe.at(-1)!.id)!;
      expect(skip.depth).toBe(2);
      expect(skip.maxDepth).toBe(2);
    } finally {
      await destroyEnv(env);
    }
  });

  it("lowering the budget stops at the new smaller boundary", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::loop",
        configKey: "loop",
        name: "Loop",
        prompt: "n={{n}}",
        chainJson: JSON.stringify({ next: "loop" }),
      });

      env.chainRunner.stop();

      const rootId = "root-lower";
      env.store.insertRun({
        id: rootId,
        automationId: "ws::loop",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "n=lower",
        chainContext: { variables: { n: "lower" }, roleModels: {} },
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 5,
      });
      // Child already at depth 2; lower budget to 2 so it cannot chain further.
      const childId = "child-at-2";
      env.store.insertRun({
        id: childId,
        automationId: "ws::loop",
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "n=lower",
        parentRunId: rootId,
        chainContext: { variables: { n: "lower" }, roleModels: {} },
        chainRootRunId: rootId,
        chainDepth: 2,
        chainMaxDepth: 5,
      });
      const lowered = env.store.applyChainControl(childId, {
        rebudget: { maxDepth: 2 },
      });
      expect(lowered.ok).toBe(true);

      env.chainRunner.start();
      env.store.setStatus(childId, "completed");

      await until(
        () => chainSkipped(env.db, childId)?.reason === "max-depth"
      );

      expect(listRuns(env.db).filter((r) => r.parent_run_id === childId)).toHaveLength(
        0
      );
      const skip = chainSkipped(env.db, childId)!;
      expect(skip.depth).toBe(2);
      expect(skip.maxDepth).toBe(2);
      expect(skip.maxDepthOverride).toBe(2);
      expect(env.store.getRun(childId)!.chain_max_depth).toBe(5);
    } finally {
      await destroyEnv(env);
    }
  });

  it("legacy no-context chains ignore override and keep fallback depth 20", async () => {
    const env = await createEnv({ maxDepth: 20 });
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        enabled: 0,
      });

      env.chainRunner.stop();
      const runId = "legacy-override";
      env.store.insertRun({
        id: runId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "legacy",
      });
      // Simulate a stray override on a legacy row — must not affect depth.
      env.db
        .prepare(
          `UPDATE runs SET chain_max_depth_override = 1 WHERE id = ?`
        )
        .run(runId);

      env.chainRunner.start();
      env.store.setStatus(runId, "completed");
      await until(() => listRuns(env.db).length >= 2);

      const child = listRuns(env.db).find((r) => r.parent_run_id === runId);
      expect(child).toBeDefined();
      expect(chainSkipped(env.db, runId)).toBeUndefined();
    } finally {
      await destroyEnv(env);
    }
  });
});

describe("b36-2b POST /api/runs/:id/chain-control", () => {
  it("maps auth, validation, and conflict statuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2b-http-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    seedWorkspace(db, workspace);
    insertAutomation(db, {
      id: "ws::a",
      configKey: "a",
      name: "A",
    });

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
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
    });

    const runId = "ctrl-run";
    store.insertRun({
      id: runId,
      automationId: "ws::a",
      workspaceId: "ws",
      triggerKind: "manual",
      prompt: "p",
      chainContext: { variables: {}, roleModels: {} },
      chainRootRunId: runId,
      chainDepth: 0,
      chainMaxDepth: 4,
    });
    setRunToken(engine, runId, "good-token");

    const chat = chatEngine.createChat({ workspaceId: "ws" });
    const base = `http://127.0.0.1:${port}`;

    try {
      const empty = await fetch(`${base}/api/runs/${runId}/chain-control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);

      const wrong = await fetch(`${base}/api/runs/${runId}/chain-control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "bad-token",
        },
        body: JSON.stringify({ stop: { reason: "x" } }),
      });
      expect(wrong.status).toBe(403);

      const missing = await fetch(`${base}/api/runs/${runId}/chain-control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stop: { reason: "x" } }),
      });
      expect(missing.status).toBe(403);

      const unknown = await fetch(
        `${base}/api/runs/no-such-run/chain-control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-lca-run-token": "good-token",
          },
          body: JSON.stringify({ stop: { reason: "x" } }),
        }
      );
      expect(unknown.status).toBe(404);

      const chatId = await fetch(
        `${base}/api/runs/${encodeURIComponent(chat.id)}/chain-control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-lca-run-token": "good-token",
          },
          body: JSON.stringify({ stop: { reason: "x" } }),
        }
      );
      expect(chatId.status).toBe(404);

      const ok = await fetch(`${base}/api/runs/${runId}/chain-control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify({
          stop: { reason: "done" },
          rebudget: { maxDepth: 8 },
        }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as ChainControlResponse;
      expect(body.stopRequested).toBe(true);
      expect(body.stopReason).toBe("done");
      expect(body.maxDepthOverride).toBe(8);
      expect(chainControlEvents(db, runId)).toHaveLength(1);

      const repeat = await fetch(`${base}/api/runs/${runId}/chain-control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify({ stop: { reason: "done again" } }),
      });
      expect(repeat.status).toBe(200);
      expect(chainControlEvents(db, runId)).toHaveLength(1);

      const conflict = await fetch(`${base}/api/runs/${runId}/chain-control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify({ rebudget: { maxDepth: 9 } }),
      });
      expect(conflict.status).toBe(409);

      store.setStatus(runId, "completed");
      const terminal = await fetch(`${base}/api/runs/${runId}/chain-control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify({ stop: { reason: "late" } }),
      });
      expect(terminal.status).toBe(409);
      const terminalBody = (await terminal.json()) as { error: string };
      expect(terminalBody.error).toMatch(/terminal/i);

      // Fresh run for additive extension HTTP mapping.
      const extendId = "run-extend-http";
      store.insertRun({
        id: extendId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "extend",
        chainContext: { variables: { featureId: "b36" }, roleModels: {} },
        chainRootRunId: extendId,
        chainDepth: 0,
        chainMaxDepth: 10,
      });
      setRunToken(engine, extendId, "good-token");

      const both = await fetch(`${base}/api/runs/${extendId}/chain-control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify({
          rebudget: { maxDepth: 20 },
          extendBudget: { transitions: 6 },
        }),
      });
      expect(both.status).toBe(400);

      const extended = await fetch(
        `${base}/api/runs/${extendId}/chain-control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-lca-run-token": "good-token",
          },
          body: JSON.stringify({ extendBudget: { transitions: 6 } }),
        }
      );
      expect(extended.status).toBe(200);
      const extBody = (await extended.json()) as ChainControlResponse;
      expect(extBody.effectiveMaxDepth).toBe(16);
      expect(extBody.budgetExtension?.appliedTransitions).toBe(6);
      expect(chainControlEvents(db, extendId)).toHaveLength(1);

      const extendConflict = await fetch(
        `${base}/api/runs/${extendId}/chain-control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-lca-run-token": "good-token",
          },
          body: JSON.stringify({ extendBudget: { transitions: 12 } }),
        }
      );
      expect(extendConflict.status).toBe(409);
      const conflictBody = (await extendConflict.json()) as { error: string };
      expect(conflictBody.error).toMatch(/extendBudget refused/i);

      const legacyId = "run-legacy-http";
      store.insertRun({
        id: legacyId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "legacy",
      });
      setRunToken(engine, legacyId, "good-token");
      const noContext = await fetch(
        `${base}/api/runs/${legacyId}/chain-control`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-lca-run-token": "good-token",
          },
          body: JSON.stringify({ extendBudget: { transitions: 6 } }),
        }
      );
      expect(noContext.status).toBe(409);
      const noCtxBody = (await noContext.json()) as { error: string };
      expect(noCtxBody.error).toMatch(/budget metadata/i);
    } finally {
      await http.close();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b36-2b chain_control MCP tool", () => {
  type Handler = (
    req: IncomingMessage,
    body: string
  ) => { status: number; json: unknown } | { status: number; raw: string };

  let server: Server;
  let baseUrl: string;
  let lastRequest:
    | {
        method?: string;
        url?: string;
        headers: NodeJS.Dict<string | string[]>;
        body: string;
      }
    | undefined;
  let requestCount = 0;
  const savedEnv: Record<string, string | undefined> = {};

  function startStubDaemon(handler: Handler): Promise<void> {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestCount += 1;
        lastRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        };
        const result = handler(req, body);
        res.statusCode = result.status;
        if ("json" in result) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result.json));
        } else {
          res.end(result.raw);
        }
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  beforeEach(() => {
    requestCount = 0;
    lastRequest = undefined;
    for (const key of ["LCA_RUN_ID", "LCA_DAEMON_URL", "LCA_RUN_TOKEN"]) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of ["LCA_RUN_ID", "LCA_DAEMON_URL", "LCA_RUN_TOKEN"]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects stop without reason locally and does not call the daemon", async () => {
    await startStubDaemon(() => ({ status: 200, json: {} }));
    process.env.LCA_RUN_ID = "run-1";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok";

    await expect(chainControlDaemon({ stop: true })).rejects.toThrow(
      /reason/
    );
    expect(requestCount).toBe(0);
  });

  it("posts stop and rebudget wire shapes with the run token", async () => {
    await startStubDaemon(() => ({
      status: 200,
      json: {
        runId: "run-1",
        depth: 0,
        effectiveMaxDepth: 3,
        maxDepth: 2,
        maxDepthOverride: 3,
        stopRequested: true,
        stopReason: "done",
      } satisfies ChainControlResponse,
    }));
    process.env.LCA_RUN_ID = "run-1";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok-abc";

    await chainControlDaemon({ stop: true, reason: "done" });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe("/api/runs/run-1/chain-control");
    expect(lastRequest?.headers["x-lca-run-token"]).toBe("tok-abc");
    expect(JSON.parse(lastRequest!.body)).toEqual({
      stop: { reason: "done" },
    });

    await chainControlDaemon({ maxDepth: 7 });
    expect(JSON.parse(lastRequest!.body)).toEqual({
      rebudget: { maxDepth: 7 },
    });

    await chainControlDaemon({ extendBy: 12 });
    expect(JSON.parse(lastRequest!.body)).toEqual({
      extendBudget: { transitions: 12 },
    });
  });

  it("rejects maxDepth+extendBy locally and does not call the daemon", async () => {
    await startStubDaemon(() => ({ status: 200, json: {} }));
    process.env.LCA_RUN_ID = "run-1";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok";

    await expect(
      chainControlDaemon({ maxDepth: 7, extendBy: 6 })
    ).rejects.toThrow(/mutually exclusive/i);
    expect(requestCount).toBe(0);
  });

  it("surfaces non-2xx status and body in the error", async () => {
    await startStubDaemon(() => ({
      status: 409,
      raw: '{"error":"Run run-1 is already terminal; chain control refused"}',
    }));
    process.env.LCA_RUN_ID = "run-1";
    process.env.LCA_DAEMON_URL = baseUrl;

    await expect(
      chainControlDaemon({ stop: true, reason: "late" })
    ).rejects.toThrow(/daemon chain_control failed \(409\):.*terminal/i);
  });
});
