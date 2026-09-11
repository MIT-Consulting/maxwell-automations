import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveRun, Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  ChainRunner,
  chainWhenMatches,
} from "../packages/daemon/src/runs/chain-runner.ts";
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

function stubExecutor(result = "parent output"): Executor {
  const activeRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-chain",
    sdkRunId: "sdk-chain",
    async *stream() {},
    wait: async () => ({ status: "finished", result }) as never,
    cancel: async () => {},
    dispose: async () => {},
  };
  return {
    kind: "sdk-local",
    spawn: async () => activeRun,
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

type ChainTestEnv = {
  root: string;
  db: ReturnType<typeof openDatabase>;
  events: DaemonEventBus;
  store: RunStore;
  engine: RunEngine;
  chainRunner: ChainRunner;
};

function seedWorkspace(db: ReturnType<typeof openDatabase>, workspace: string): void {
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
      id, workspace_id, name, enabled, status, trigger_json, prompt,
      config_path, config_key, chain_json
    ) VALUES (?, 'ws', ?, ?, 'enabled', ?, ?, 'test.yaml', ?, ?)`
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

async function createChainTestEnv(options?: {
  maxDepth?: number;
  result?: string;
}): Promise<ChainTestEnv> {
  const root = mkdtempSync(join(tmpdir(), "lca-b14-chain-"));
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
    executor: stubExecutor(options?.result),
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

function listRuns(db: ReturnType<typeof openDatabase>): Array<{
  id: string;
  automation_id: string;
  trigger_kind: string | null;
  parent_run_id: string | null;
  prompt: string | null;
}> {
  return db
    .prepare(
      `SELECT id, automation_id, trigger_kind, parent_run_id, prompt FROM runs ORDER BY created_at ASC`
    )
    .all() as Array<{
    id: string;
    automation_id: string;
    trigger_kind: string | null;
    parent_run_id: string | null;
    prompt: string | null;
  }>;
}

function chainSkippedPayload(
  db: ReturnType<typeof openDatabase>,
  runId: string
): { reason: string } | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND event_type = 'run.chain-skipped'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(runId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as { reason: string }) : undefined;
}

describe("chainWhenMatches", () => {
  it("defaults to completed only", () => {
    expect(chainWhenMatches("completed", undefined)).toBe(true);
    expect(chainWhenMatches("failed", undefined)).toBe(false);
  });

  it("honors failed and always", () => {
    expect(chainWhenMatches("failed", "failed")).toBe(true);
    expect(chainWhenMatches("completed", "failed")).toBe(false);
    expect(chainWhenMatches("completed", "always")).toBe(true);
    expect(chainWhenMatches("failed", "always")).toBe(true);
  });
});

describe("ChainRunner", () => {
  it("chains A → B on completion with parent link and trigger_kind chain", async () => {
    const env = await createChainTestEnv();
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

      const runA = await env.engine.triggerRun("ws::a");
      await until(() => env.store.getRun(runA)?.status === "completed");

      await until(() => listRuns(env.db).length >= 2);

      const runs = listRuns(env.db);
      const child = runs.find((r) => r.id !== runA);
      expect(child).toBeDefined();
      expect(child?.automation_id).toBe("ws::b");
      expect(child?.trigger_kind).toBe("chain");
      expect(child?.parent_run_id).toBe(runA);

      const chained = env.db
        .prepare(
          `SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'run.chained'`
        )
        .get(runA) as { payload: string } | undefined;
      expect(chained).toBeDefined();
      expect(JSON.parse(chained!.payload)).toMatchObject({
        childRunId: child!.id,
        targetAutomationId: "ws::b",
        next: "b",
      });
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("does not chain on failed when when defaults to completed", async () => {
    const env = await createChainTestEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, { id: "ws::b", configKey: "b", name: "B" });

      const runId = "run-failed-default";
      env.store.insertRun({
        id: runId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "p",
      });
      env.store.appendEvent(runId, "run.finished", {
        sdkStatus: "error",
        result: null,
      });
      env.store.setStatus(runId, "failed");

      await new Promise((r) => setTimeout(r, 50));
      expect(listRuns(env.db)).toHaveLength(1);
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("chains on failed only when when is failed", async () => {
    const env = await createChainTestEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        chainJson: JSON.stringify({ next: "b", when: "failed" }),
      });
      insertAutomation(env.db, { id: "ws::b", configKey: "b", name: "B" });

      const failRun = "run-fail-when";
      env.store.insertRun({
        id: failRun,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "p",
      });
      env.store.setStatus(failRun, "failed");
      await until(() => listRuns(env.db).length >= 2);

      const okRun = "run-ok-when";
      env.store.insertRun({
        id: okRun,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "p",
      });
      env.store.setStatus(okRun, "completed");
      await new Promise((r) => setTimeout(r, 50));
      expect(listRuns(env.db).filter((r) => r.parent_run_id === okRun)).toHaveLength(
        0
      );
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("chains on both completed and failed when when is always", async () => {
    const env = await createChainTestEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        chainJson: JSON.stringify({ next: "b", when: "always" }),
      });
      insertAutomation(env.db, { id: "ws::b", configKey: "b", name: "B" });

      for (const status of ["completed", "failed"] as const) {
        const runId = `run-always-${status}`;
        env.store.insertRun({
          id: runId,
          automationId: "ws::a",
          workspaceId: "ws",
          triggerKind: "manual",
          prompt: "p",
        });
        env.store.setStatus(runId, status);
        await until(
          () =>
            listRuns(env.db).some(
              (r) => r.parent_run_id === runId && r.automation_id === "ws::b"
            ),
          2000
        );
      }
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("stops self-referential chains at maxDepth with run.chain-skipped", async () => {
    const env = await createChainTestEnv({ maxDepth: 3 });
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        chainJson: JSON.stringify({ next: "a" }),
      });

      const rootRun = await env.engine.triggerRun("ws::a");
      await until(() => {
        const runs = listRuns(env.db);
        if (runs.length < 4) return false;
        const last = runs[runs.length - 1]!;
        return (
          env.store.getRun(last.id)?.status === "completed" &&
          chainSkippedPayload(env.db, last.id)?.reason === "max-depth"
        );
      }, 8000);

      const runs = listRuns(env.db);
      expect(runs).toHaveLength(4);
      expect(runs[0].id).toBe(rootRun);
      expect(
        chainSkippedPayload(env.db, runs[runs.length - 1]!.id)?.reason
      ).toBe("max-depth");
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("emits unresolved skip and does not create a child for unknown next", async () => {
    const env = await createChainTestEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        chainJson: JSON.stringify({ next: "does-not-exist" }),
      });

      const runId = "run-unresolved";
      env.store.insertRun({
        id: runId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "p",
      });
      env.store.setStatus(runId, "completed");
      await new Promise((r) => setTimeout(r, 50));

      expect(listRuns(env.db)).toHaveLength(1);
      const skip = chainSkippedPayload(env.db, runId);
      expect(skip?.reason).toBe("unresolved");
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("appends parent result to child prompt when passResult is true", async () => {
    const env = await createChainTestEnv({ result: "hello from parent" });
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "SourceAuto",
        chainJson: JSON.stringify({ next: "b", passResult: true }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "TargetAuto",
        prompt: "Base child prompt",
      });

      const runA = await env.engine.triggerRun("ws::a");
      await until(() => listRuns(env.db).length >= 2);

      const child = listRuns(env.db).find((r) => r.parent_run_id === runA);
      expect(child?.prompt).toContain("Base child prompt");
      expect(child?.prompt).toContain("chained from SourceAuto");
      expect(child?.prompt).toContain("hello from parent");
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("does not chain cancelled runs", async () => {
    const env = await createChainTestEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, { id: "ws::b", configKey: "b", name: "B" });

      const runId = "run-cancelled";
      env.store.insertRun({
        id: runId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "p",
      });
      env.store.setStatus(runId, "cancelled");
      await new Promise((r) => setTimeout(r, 50));
      expect(listRuns(env.db)).toHaveLength(1);
    } finally {
      env.chainRunner.stop();
      await env.engine.shutdown();
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });
});
