import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modelSelectionKey, type ModelSelection } from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import {
  selectionFromStored,
  splitSelectionForDb,
} from "../packages/daemon/src/models/selection-persist.ts";

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

function stubExecutor(
  result = "parent output",
  spawns?: Array<{ model: SpawnParams["model"] }>
): Executor {
  const activeRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-b36-2c",
    sdkRunId: "sdk-b36-2c",
    async *stream() {},
    wait: async () => ({ status: "finished", result }) as never,
    cancel: async () => {},
    dispose: async () => {},
  };
  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      spawns?.push({ model: params.model });
      return activeRun;
    },
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
    model?: string | null;
    modelParamsJson?: string | null;
    modelRole?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      model_params_json, model_role, config_path, config_key, chain_json
    ) VALUES (?, 'ws', ?, ?, 'enabled', ?, ?, ?, ?, ?, 'test.yaml', ?, ?)`
  ).run(
    input.id,
    input.name,
    input.enabled ?? 1,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name}`,
    input.model ?? null,
    input.modelParamsJson ?? null,
    input.modelRole ?? null,
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
  spawns: Array<{ model: SpawnParams["model"] }>;
  logs: string[];
};

async function createEnv(options?: {
  maxDepth?: number;
  result?: string;
}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-2c-"));
  const workspace = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  seedWorkspace(db, workspace);

  const spawns: Array<{ model: SpawnParams["model"] }> = [];
  const logs: string[] = [];
  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: stubExecutor(options?.result, spawns),
    events,
    inputHub,
    maxConcurrentRuns: 4,
  });
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: (message) => {
      logs.push(message);
    },
    maxDepth: options?.maxDepth,
  });
  chainRunner.start();
  return { root, db, events, store, engine, chainRunner, spawns, logs };
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
      `SELECT id, automation_id, parent_run_id, model, model_params_json,
              chain_handled_at, chain_root_run_id
       FROM runs ORDER BY created_at ASC, rowid ASC`
    )
    .all() as Array<{
    id: string;
    automation_id: string;
    parent_run_id: string | null;
    model: string | null;
    model_params_json: string | null;
    chain_handled_at: string | null;
    chain_root_run_id: string | null;
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

function chainSkippedAll(
  db: ReturnType<typeof openDatabase>,
  runId: string
): Array<Record<string, unknown>> {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = 'run.chain-skipped'
         ORDER BY seq ASC`
      )
      .all(runId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function chainEvents(
  db: ReturnType<typeof openDatabase>,
  runId: string
): Array<Record<string, unknown>> {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = 'run.chained'
         ORDER BY seq ASC`
      )
      .all(runId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

const IMPLEMENTER_SELECTION: ModelSelection = {
  id: "composer-2",
  params: [{ id: "fast", value: "true" }],
};

describe("b36-2c role resolution", () => {
  it("spawns the child with the pipeline role model and writes columns on insert", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        model: "parent-model",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
        model: "worker-default",
        modelRole: "implementer",
      });

      const rootId = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: {},
          roleModels: { implementer: IMPLEMENTER_SELECTION },
        },
        chainMaxDepth: 3,
        modelSelectionOverride: { id: "root-override" },
      });
      await until(() => listRuns(env.db).length >= 2 && env.spawns.length >= 2);

      const child = listRuns(env.db).find((r) => r.parent_run_id === rootId)!;
      expect(selectionFromStored(child.model, child.model_params_json)).toEqual(
        IMPLEMENTER_SELECTION
      );
      expect(modelSelectionKey(env.spawns[1]!.model)).toBe(
        modelSelectionKey(IMPLEMENTER_SELECTION)
      );

      const chained = chainEvents(env.db, rootId);
      expect(chained).toHaveLength(1);
      expect(chained[0]).toMatchObject({
        childRunId: child.id,
        targetAutomationId: "ws::b",
        next: "b",
        when: "completed",
        passedResult: false,
        modelRole: "implementer",
        modelRoleResolved: true,
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("falls back when an inherited object property name is absent from roleModels", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        chainJson: JSON.stringify({ next: "b" }),
      });
      const stored = splitSelectionForDb({
        id: "target-model",
        params: [{ id: "reasoning", value: "high" }],
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
        model: stored.model,
        modelParamsJson: stored.modelParamsJson,
        modelRole: "toString",
      });

      const rootId = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: {},
          roleModels: { planner: { id: "other" } },
        },
        chainMaxDepth: 3,
      });
      await until(() => listRuns(env.db).length >= 2 && env.spawns.length >= 2);

      const child = listRuns(env.db).find((r) => r.parent_run_id === rootId)!;
      // Fallback omits modelSelectionOverride — insert leaves model columns null;
      // buildContext resolves the target automation's own model at spawn.
      expect(child.model).toBeNull();
      expect(child.model_params_json).toBeNull();
      expect(modelSelectionKey(env.spawns[1]!.model)).toBe(
        modelSelectionKey({
          id: "target-model",
          params: [{ id: "reasoning", value: "high" }],
        })
      );

      const chained = chainEvents(env.db, rootId)[0]!;
      expect(chained.modelRole).toBe("toString");
      expect(chained.modelRoleResolved).toBe(false);
      expect(
        env.logs.some((l) =>
          l.includes('role "toString"') && l.includes("ws::b")
        )
      ).toBe(true);
    } finally {
      await destroyEnv(env);
    }
  });

  it("ignores roleModels when the target has no model_role", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
        model: "child-model",
      });

      const rootId = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: {},
          roleModels: { implementer: IMPLEMENTER_SELECTION },
        },
        chainMaxDepth: 3,
      });
      await until(() => listRuns(env.db).length >= 2 && env.spawns.length >= 2);

      expect(modelSelectionKey(env.spawns[1]!.model)).toBe(
        modelSelectionKey({ id: "child-model" })
      );
      const chained = chainEvents(env.db, rootId)[0]!;
      expect(chained.modelRole).toBeNull();
      expect(chained.modelRoleResolved).toBe(false);
    } finally {
      await destroyEnv(env);
    }
  });

  it("never resolves roles on a legacy no-context chain", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
        model: "child-model",
        modelRole: "implementer",
      });

      const rootId = await env.engine.triggerRun("ws::a", "manual");
      await until(() => listRuns(env.db).length >= 2 && env.spawns.length >= 2);

      expect(modelSelectionKey(env.spawns[1]!.model)).toBe(
        modelSelectionKey({ id: "child-model" })
      );
      const chained = chainEvents(env.db, rootId)[0]!;
      expect(chained.modelRole).toBe("implementer");
      expect(chained.modelRoleResolved).toBe(false);
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not inherit the parent run model", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        model: "parent-model",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
        model: "child-model",
        modelRole: "implementer",
      });

      await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: {},
          roleModels: { implementer: IMPLEMENTER_SELECTION },
        },
        chainMaxDepth: 3,
        modelSelectionOverride: { id: "root-override" },
      });
      await until(() => env.spawns.length >= 2);

      expect(env.spawns[0]!.model).toEqual({ id: "root-override" });
      expect(modelSelectionKey(env.spawns[1]!.model)).toBe(
        modelSelectionKey(IMPLEMENTER_SELECTION)
      );
      expect(modelSelectionKey(env.spawns[1]!.model)).not.toBe(
        modelSelectionKey({ id: "root-override" })
      );
    } finally {
      await destroyEnv(env);
    }
  });

  it("keeps concurrent pipelines' roleModels isolated on shared workers", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root {{featureId}}",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "worker {{featureId}}",
        model: "worker-default",
        modelRole: "implementer",
        enabled: 0,
      });

      const alphaSel: ModelSelection = {
        id: "alpha-model",
        params: [{ id: "fast", value: "true" }],
      };
      const betaSel: ModelSelection = {
        id: "beta-model",
        params: [{ id: "reasoning", value: "high" }],
      };

      const root1 = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: { featureId: "alpha" },
          roleModels: { implementer: alphaSel },
        },
        chainMaxDepth: 5,
      });
      const root2 = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: { featureId: "beta" },
          roleModels: { implementer: betaSel },
        },
        chainMaxDepth: 5,
      });
      await until(() => listRuns(env.db).length >= 4);

      const runs = listRuns(env.db);
      const child1 = runs.find((r) => r.parent_run_id === root1)!;
      const child2 = runs.find((r) => r.parent_run_id === root2)!;
      expect(selectionFromStored(child1.model, child1.model_params_json)).toEqual(
        alphaSel
      );
      expect(selectionFromStored(child2.model, child2.model_params_json)).toEqual(
        betaSel
      );
    } finally {
      await destroyEnv(env);
    }
  });
});

describe("b36-2c transition idempotency", () => {
  it("terminalizing twice yields one child and an already-chained skip", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
      });

      env.chainRunner.stop();
      await env.engine.shutdown();

      const rootId = "root-idem";
      env.store.insertRun({
        id: rootId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "root",
        chainContext: { variables: {}, roleModels: {} },
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 4,
      });
      env.store.appendEvent(rootId, "run.finished", {
        sdkStatus: "finished",
        result: "done",
      });

      const store2 = new RunStore(env.db, env.events);
      const engine2 = new RunEngine(env.db, {
        apiKey: "test-key",
        executor: stubExecutor("second", env.spawns),
        events: env.events,
        inputHub: new InputHub(new InputStore(env.db), {
          onNeedsInput: () => {},
          onAnswered: () => {},
        }),
        maxConcurrentRuns: 4,
      });
      const runner2 = new ChainRunner({
        store: store2,
        engine: engine2,
        events: env.events,
        onLog: () => {},
      });
      runner2.start();

      store2.setStatus(rootId, "completed");
      await until(() => listRuns(env.db).length >= 2);
      expect(chainEvents(env.db, rootId)).toHaveLength(1);

      // Rebuild again and re-terminalize — claim must survive.
      runner2.stop();
      await engine2.shutdown();

      const store3 = new RunStore(env.db, env.events);
      const engine3 = new RunEngine(env.db, {
        apiKey: "test-key",
        executor: stubExecutor("third", env.spawns),
        events: env.events,
        inputHub: new InputHub(new InputStore(env.db), {
          onNeedsInput: () => {},
          onAnswered: () => {},
        }),
        maxConcurrentRuns: 4,
      });
      const runner3 = new ChainRunner({
        store: store3,
        engine: engine3,
        events: env.events,
        onLog: () => {},
      });
      runner3.start();

      store3.setStatus(rootId, "completed");
      await until(
        () =>
          chainSkippedAll(env.db, rootId).some(
            (s) => s.reason === "already-chained"
          )
      );

      expect(listRuns(env.db).filter((r) => r.parent_run_id === rootId)).toHaveLength(
        1
      );
      expect(chainEvents(env.db, rootId)).toHaveLength(1);
      const skip = chainSkipped(env.db, rootId)!;
      expect(skip).toMatchObject({
        reason: "already-chained",
        next: "b",
        targetAutomationId: "ws::b",
      });
      expect(listRuns(env.db).find((r) => r.id === rootId)!.chain_handled_at).not.toBeNull();

      runner3.stop();
      await engine3.shutdown();
    } finally {
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("does not burn the claim on a max-depth skip", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::loop",
        configKey: "loop",
        name: "Loop",
        prompt: "n",
        chainJson: JSON.stringify({ next: "loop" }),
      });

      const rootId = await env.engine.triggerRun("ws::loop", "manual", {
        chainContext: { variables: {}, roleModels: {} },
        chainMaxDepth: 1,
      });

      // root(0) → child(1) then max-depth skip on the leaf — claim must stay null.
      await until(() => {
        const leaf = listRuns(env.db)
          .filter((r) => r.chain_root_run_id === rootId)
          .at(-1);
        return leaf != null && chainSkipped(env.db, leaf.id)?.reason === "max-depth";
      });

      const leaf = listRuns(env.db)
        .filter((r) => r.chain_root_run_id === rootId)
        .at(-1)!;
      expect(leaf.chain_handled_at).toBeNull();
      expect(chainSkipped(env.db, leaf.id)?.reason).toBe("max-depth");
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not burn the claim on a stopped skip", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
      });

      env.chainRunner.stop();

      const rootId = "root-stopped";
      env.store.insertRun({
        id: rootId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "root",
        chainContext: { variables: {}, roleModels: {} },
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 5,
      });
      expect(
        env.store.applyChainControl(rootId, {
          stop: { reason: "done" },
        }).ok
      ).toBe(true);

      env.chainRunner.start();
      env.store.setStatus(rootId, "completed");
      await until(() => chainSkipped(env.db, rootId)?.reason === "stopped");

      expect(listRuns(env.db).find((r) => r.id === rootId)!.chain_handled_at).toBeNull();
      expect(listRuns(env.db)).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("skips unresolved when the target row disappears after resolve", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
      });

      const origResolve = env.store.resolveChainTarget.bind(env.store);
      env.store.resolveChainTarget = (workspaceId, ref) => {
        const id = origResolve(workspaceId, ref);
        if (id) {
          env.db
            .prepare(
              `UPDATE automations SET archived_at = datetime('now') WHERE id = ?`
            )
            .run(id);
        }
        return id;
      };

      const rootId = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: { variables: {}, roleModels: {} },
        chainMaxDepth: 3,
      });
      await until(() => chainSkipped(env.db, rootId)?.reason === "unresolved");

      expect(listRuns(env.db)).toHaveLength(1);
      expect(chainSkipped(env.db, rootId)).toMatchObject({
        reason: "unresolved",
        next: "b",
        targetAutomationId: "ws::b",
      });
      expect(listRuns(env.db).find((r) => r.id === rootId)!.chain_handled_at).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });
});
