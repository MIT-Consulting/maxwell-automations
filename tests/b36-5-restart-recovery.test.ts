import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  settingsSchema,
  type ChainRunContext,
} from "@lca/shared";
import { diagnoseRun } from "../packages/cli/src/doctor.ts";
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

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b36",
    featureSlug: "b36-resume",
    featureDir: "docs/roadmap/b36-resume",
    featureIndex: "docs/roadmap/b36-resume/00-index.md",
    idea: "restart recovery",
    planningDepth: "jit",
    approvalPolicy: "none",
    researchApprovalPolicy: "none",
    loopMode: "normal",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
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

function insertAutomation(
  db: Db,
  input: {
    id: string;
    configKey: string;
    name: string;
    prompt?: string;
    chainJson?: string | null;
    enabled?: number;
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
    input.prompt ?? `Prompt ${input.name} {{featureId}}`,
    input.configKey,
    input.chainJson ?? null
  );
}

function seedWorkers(db: Db, opts?: { noChain?: boolean; emptyNext?: boolean }): void {
  if (opts?.noChain) {
    insertAutomation(db, {
      id: "ws::a",
      configKey: "a",
      name: "A",
      chainJson: null,
    });
    return;
  }
  insertAutomation(db, {
    id: "ws::a",
    configKey: "a",
    name: "A",
    chainJson: opts?.emptyNext
      ? JSON.stringify({ when: "completed" })
      : JSON.stringify({ next: "b", when: "completed" }),
  });
  insertAutomation(db, {
    id: "ws::b",
    configKey: "b",
    name: "B",
    enabled: 0,
  });
}

function stubExecutor(resultStatus: "finished" | "error" = "finished"): Executor {
  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        wait: async () =>
          (resultStatus === "error"
            ? { status: "error", result: "sdk blew up" }
            : { status: "finished", result: "ok" }) as never,
        cancel: async () => {},
        dispose: async () => {},
      };
      return activeRun;
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function failingSpawnExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn failed for test");
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function chainSkipped(db: Db, runId: string) {
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

function pipelineResumed(db: Db, runId: string) {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = 'run.pipeline-resumed'
         ORDER BY seq ASC`
      )
      .all(runId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function errorEvents(db: Db, runId: string) {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = 'run.error'
         ORDER BY seq ASC`
      )
      .all(runId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function listChildren(db: Db, parentId: string) {
  return db
    .prepare(
      `SELECT id, automation_id, chain_depth, chain_root_run_id, chain_context_json
       FROM runs WHERE parent_run_id = ?`
    )
    .all(parentId) as Array<{
    id: string;
    automation_id: string;
    chain_depth: number | null;
    chain_root_run_id: string | null;
    chain_context_json: string | null;
  }>;
}

function readRun(db: Db, id: string) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | {
        id: string;
        status: string;
        chain_handled_at: string | null;
        chain_root_run_id: string | null;
        chain_depth: number | null;
        chain_context_json: string | null;
        ended_at: string | null;
      }
    | undefined;
}

type Env = {
  root: string;
  db: Db;
  store: RunStore;
  engine: RunEngine;
  chainRunner: ChainRunner;
};

async function createEnv(options?: {
  executor?: Executor;
  lookbackMs?: number;
  noChain?: boolean;
  emptyNext?: boolean;
  maxSpawnAttempts?: number;
  retryBackoffMs?: number;
}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-5-resume-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
  ).run("ws", workspace, "Workspace");
  seedWorkers(db, {
    noChain: options?.noChain,
    emptyNext: options?.emptyNext,
  });

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: options?.executor ?? stubExecutor(),
    events,
    inputHub,
    maxConcurrentRuns: 4,
    maxSpawnAttempts: options?.maxSpawnAttempts,
    retryBackoffMs: options?.retryBackoffMs,
  });
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: options?.lookbackMs ?? 86_400_000,
  });
  chainRunner.start();
  return { root, db, store, engine, chainRunner };
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function seedCompletedCandidate(
  store: RunStore,
  db: Db,
  opts: {
    id: string;
    depth?: number;
    maxDepth?: number;
    endedAt?: string;
    claimed?: boolean;
    stopped?: boolean;
    status?: "completed" | "failed";
    legacy?: boolean;
    automationId?: string;
  }
): void {
  const id = opts.id;
  if (opts.legacy) {
    store.insertRun({
      id,
      automationId: opts.automationId ?? "ws::a",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "legacy",
      parentRunId: "p",
    });
  } else {
    store.insertRun({
      id,
      automationId: opts.automationId ?? "ws::a",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "A prompt",
      chainContext: CONTEXT,
      chainRootRunId: "root-1",
      chainDepth: opts.depth ?? 1,
      chainMaxDepth: opts.maxDepth ?? 5,
    });
  }
  store.setStatus(id, opts.status ?? "completed");
  if (opts.endedAt) {
    db.prepare(`UPDATE runs SET ended_at = ? WHERE id = ?`).run(
      opts.endedAt,
      id
    );
  }
  if (opts.claimed) {
    store.claimChainHandled(id);
  }
  if (opts.stopped) {
    store.markChainStopped(id, "aborted: prior");
  }
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
});

describe("b36-5 halt reasons and sdk_error", () => {
  it("emits status-mismatch on failed chained run and leaves claim null", async () => {
    const env = await createEnv({ executor: stubExecutor("error") });
    try {
      env.chainRunner.stop();
      env.store.insertRun({
        id: "fail-halt",
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "A",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 1,
        chainMaxDepth: 5,
      });
      env.store.setStatus("fail-halt", "failed");
      await env.chainRunner.handleTerminal("fail-halt", "failed");

      const skipped = chainSkipped(env.db, "fail-halt");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({
        reason: "status-mismatch",
        next: "b",
        status: "failed",
        when: "completed",
        depth: 1,
        maxDepth: 5,
      });
      expect(readRun(env.db, "fail-halt")!.chain_handled_at).toBeNull();
      expect(listChildren(env.db, "fail-halt")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("emits no chain event when there is no chain edge", async () => {
    const env = await createEnv({ noChain: true });
    try {
      env.chainRunner.stop();
      env.store.insertRun({
        id: "no-edge",
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "A",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 0,
        chainMaxDepth: 5,
      });
      env.store.setStatus("no-edge", "failed");
      await env.chainRunner.handleTerminal("no-edge", "failed");
      expect(chainSkipped(env.db, "no-edge")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }

    const envEmpty = await createEnv({ emptyNext: true });
    try {
      envEmpty.chainRunner.stop();
      envEmpty.store.insertRun({
        id: "empty-next",
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "A",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 0,
        chainMaxDepth: 5,
      });
      envEmpty.store.setStatus("empty-next", "failed");
      await envEmpty.chainRunner.handleTerminal("empty-next", "failed");
      expect(chainSkipped(envEmpty.db, "empty-next")).toHaveLength(0);
    } finally {
      await destroyEnv(envEmpty);
    }
  });

  it("appends sdk_error so diagnoseRun names a reason; no duplicate after retries_exhausted", async () => {
    const env = await createEnv({ executor: stubExecutor("error") });
    try {
      const runId = await env.engine.triggerRun("ws::a", "manual");
      await until(() => {
        const row = readRun(env.db, runId);
        return row?.status === "failed";
      });
      const errors = errorEvents(env.db, runId);
      expect(errors.filter((e) => e.reason === "sdk_error")).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        reason: "sdk_error",
        sdkStatus: "error",
      });

      const events = env.store.listRunEvents(runId).map((e) => ({
        seq: e.seq,
        event_type: e.event_type,
        payload: e.payload,
      }));
      const row = readRun(env.db, runId)!;
      const verdict = diagnoseRun(
        {
          run: {
            id: row.id,
            status: "failed",
            automation_id: "ws::a",
            workspace_id: "ws",
            trigger_kind: "manual",
            started_at: null,
            ended_at: row.ended_at,
            created_at: "",
          },
          events,
          inputRequests: [],
        },
        []
      );
      expect(verdict).not.toMatch(/no captured reason/i);
      // Chained workers also get run.chain-skipped status-mismatch; doctor prefers
      // that actionable pipeline halt over the bare sdk_error string. The event
      // above still records sdk_error for non-pipeline / log inspection.
      expect(verdict).toMatch(/sdk_error|status-mismatch|Pipeline halted/i);
    } finally {
      await destroyEnv(env);
    }

    const retryEnv = await createEnv({
      executor: failingSpawnExecutor(),
      maxSpawnAttempts: 2,
      retryBackoffMs: 0,
    });
    try {
      const runId = await retryEnv.engine.triggerRun("ws::a", "manual");
      await until(() => readRun(retryEnv.db, runId)?.status === "failed");
      const errors = errorEvents(retryEnv.db, runId);
      expect(errors.at(-1)).toMatchObject({
        reason: "retries_exhausted",
        cause: "spawn_error",
        attempts: 2,
      });
      expect(errors.some((e) => e.reason === "sdk_error")).toBe(false);
    } finally {
      await destroyEnv(retryEnv);
    }
  });
});

describe("b36-5 restart recovery sweep", () => {
  it("replays a completed context-aware candidate exactly once", async () => {
    const env = await createEnv();
    try {
      env.chainRunner.stop();
      seedCompletedCandidate(env.store, env.db, {
        id: "missed-1",
        depth: 1,
        maxDepth: 5,
      });
      const beforeContext = readRun(env.db, "missed-1")!.chain_context_json;
      const n = await env.chainRunner.resumeMissedTransitions();
      expect(n).toBe(1);
      await until(() => listChildren(env.db, "missed-1").length === 1);
      const child = listChildren(env.db, "missed-1")[0]!;
      expect(child.automation_id).toBe("ws::b");
      expect(child.chain_depth).toBe(2);
      expect(child.chain_root_run_id).toBe("root-1");
      expect(child.chain_context_json).toBe(beforeContext);
      const resumed = pipelineResumed(env.db, "missed-1");
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({
        reason: "missed-transition",
        depth: 1,
        maxDepth: 5,
      });
      expect(readRun(env.db, "missed-1")!.chain_handled_at).toBeTruthy();

      const n2 = await env.chainRunner.resumeMissedTransitions();
      expect(n2).toBe(0);
      expect(listChildren(env.db, "missed-1")).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("excludes failed, legacy, claimed, stopped, stale, and max-depth candidates", async () => {
    const env = await createEnv();
    try {
      env.chainRunner.stop();
      seedCompletedCandidate(env.store, env.db, {
        id: "ex-failed",
        status: "failed",
      });
      seedCompletedCandidate(env.store, env.db, {
        id: "ex-legacy",
        legacy: true,
      });
      seedCompletedCandidate(env.store, env.db, {
        id: "ex-claimed",
        claimed: true,
      });
      seedCompletedCandidate(env.store, env.db, {
        id: "ex-stopped",
        stopped: true,
      });
      seedCompletedCandidate(env.store, env.db, {
        id: "ex-stale",
        endedAt: "2000-01-01 00:00:00",
      });
      seedCompletedCandidate(env.store, env.db, {
        id: "ex-budget",
        depth: 5,
        maxDepth: 5,
      });

      await env.chainRunner.resumeMissedTransitions();

      expect(listChildren(env.db, "ex-failed")).toHaveLength(0);
      expect(listChildren(env.db, "ex-legacy")).toHaveLength(0);
      expect(listChildren(env.db, "ex-claimed")).toHaveLength(0);
      expect(listChildren(env.db, "ex-stopped")).toHaveLength(0);
      expect(listChildren(env.db, "ex-stale")).toHaveLength(0);
      // max-depth: handleTerminal may run (candidate matches query) but creates no child
      expect(listChildren(env.db, "ex-budget")).toHaveLength(0);
      const skipped = chainSkipped(env.db, "ex-budget");
      expect(skipped.some((e) => e.reason === "max-depth")).toBe(true);
    } finally {
      await destroyEnv(env);
    }
  });

  it("lookback 0 disables the sweep", async () => {
    const env = await createEnv({ lookbackMs: 0 });
    try {
      env.chainRunner.stop();
      seedCompletedCandidate(env.store, env.db, { id: "disabled-1" });
      const n = await env.chainRunner.resumeMissedTransitions();
      expect(n).toBe(0);
      expect(listChildren(env.db, "disabled-1")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("settings schema accepts lookback key with neighbours; rejects negative", async () => {
    const parsed = settingsSchema.parse({
      maxConcurrentRuns: 4,
      controlToken: "tok",
      pipelineResumeLookbackMs: 3600000,
      pipelineRoleModels: { planner: "m1" },
    });
    expect(parsed.pipelineResumeLookbackMs).toBe(3600000);
    expect(parsed.maxConcurrentRuns).toBe(4);
    expect(parsed.controlToken).toBe("tok");
    expect(parsed.pipelineRoleModels).toEqual({ planner: "m1" });

    expect(
      settingsSchema.safeParse({ pipelineResumeLookbackMs: -1 }).success
    ).toBe(false);
    expect(
      settingsSchema.safeParse({ pipelineResumeLookbackMs: 0 }).success
    ).toBe(true);
  });

  it("loadSettings keeps lookback alongside existing YAML keys", async () => {
    const home = mkdtempSync(join(tmpdir(), "lca-b36-5-home-"));
    try {
      const cfgDir = join(home, ".cursor-local-automations");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "automations.yaml"),
        [
          "settings:",
          "  maxConcurrentRuns: 7",
          "  pipelineResumeLookbackMs: 12345",
          "  controlToken: keep-me",
          "",
        ].join("\n"),
        "utf8"
      );
      vi.doMock("node:os", async () => {
        const actual = await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => home };
      });
      const { loadSettings } = await import(
        "../packages/daemon/src/config/settings.ts"
      );
      const settings = loadSettings();
      expect(settings.pipelineResumeLookbackMs).toBe(12345);
      expect(settings.maxConcurrentRuns).toBe(7);
      expect(settings.controlToken).toBe("keep-me");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a candidate with deleted automation does not block a later candidate", async () => {
    const env = await createEnv();
    try {
      env.chainRunner.stop();
      insertAutomation(env.db, {
        id: "ws::gone",
        configKey: "gone",
        name: "Gone",
        chainJson: JSON.stringify({ next: "b", when: "completed" }),
      });
      seedCompletedCandidate(env.store, env.db, {
        id: "bad-auto",
        automationId: "ws::gone",
        endedAt: "2099-01-01 12:00:00",
      });
      env.db.prepare(`DELETE FROM automations WHERE id = ?`).run("ws::gone");

      seedCompletedCandidate(env.store, env.db, {
        id: "good-1",
        endedAt: "2099-01-01 13:00:00",
      });

      await env.chainRunner.resumeMissedTransitions();
      expect(listChildren(env.db, "bad-auto")).toHaveLength(0);
      await until(() => listChildren(env.db, "good-1").length === 1);
      expect(listChildren(env.db, "good-1")[0]!.automation_id).toBe("ws::b");
    } finally {
      await destroyEnv(env);
    }
  });
});
