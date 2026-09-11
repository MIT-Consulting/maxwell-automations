import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext } from "@lca/shared";
import { DaemonClient } from "../packages/cli/src/client.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b43",
    featureSlug: "b43-unattended-halt-recovery",
    featureDir: "docs/roadmap/b43-unattended-halt-recovery",
    featureIndex: "docs/roadmap/b43-unattended-halt-recovery/00-index.md",
    idea: "auto escalation runtime",
    planningDepth: "jit",
    approvalPolicy: "none",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

vi.unmock("node:os");

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  delete process.env.LCA_PIPELINE_AUTO_ESCALATE;
  delete process.env.LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE;
});

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        wait: async () => ({ status: "finished", result: "ok" }) as never,
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

function insertAutomation(
  db: Db,
  input: {
    id: string;
    configKey: string;
    name: string;
    prompt?: string;
    chainJson?: string | null;
    modelRole?: string | null;
    enabled?: number;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role
    ) VALUES (?, 'ws', ?, ?, 'enabled', ?, ?, NULL, 'test.yaml', ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    input.enabled ?? 1,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name} {{featureId}}`,
    input.configKey,
    input.chainJson ?? null,
    input.modelRole ?? null
  );
}

function seedPipelineWorkers(db: Db): void {
  insertAutomation(db, {
    id: "ws::implement",
    configKey: "generated:implement",
    name: "Implement",
    prompt: "Implement {{featureId}}",
    chainJson: JSON.stringify({
      next: "generated:review",
      when: "completed",
    }),
    modelRole: "implementer",
  });
  insertAutomation(db, {
    id: "ws::review",
    configKey: "generated:review",
    name: "Review",
    prompt: "Review {{featureId}}",
    chainJson: JSON.stringify({
      next: "generated:docs-commit",
      when: "completed",
    }),
    modelRole: "reviewer",
  });
  insertAutomation(db, {
    id: "ws::docs",
    configKey: "generated:docs-commit",
    name: "Docs",
    prompt: "Docs {{featureId}}",
    modelRole: "docs",
    enabled: 0,
  });
}

function seedFailedHalt(
  store: RunStore,
  db: Db,
  opts: {
    id: string;
    automationId?: string;
    depth?: number;
    maxDepth?: number;
    rootId?: string;
    withSafeEvidence?: boolean;
    withChainSkipped?: boolean;
    failureReason?: string;
    endedAt?: string;
  }
): void {
  const id = opts.id;
  const rootId = opts.rootId ?? "root-1";
  store.insertRun({
    id,
    automationId: opts.automationId ?? "ws::review",
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: "Review prompt stored",
    chainContext: CONTEXT,
    chainRootRunId: rootId,
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: opts.maxDepth ?? 9,
  });
  store.setStatus(id, "failed");
  if (opts.endedAt) {
    db.prepare(`UPDATE runs SET ended_at = ? WHERE id = ?`).run(
      opts.endedAt,
      id
    );
  }
  if (opts.withSafeEvidence !== false) {
    store.appendEvent(id, "assistant", {
      message: { content: [{ type: "text", text: "working" }] },
    });
    store.appendEvent(id, "tool_call", { name: "Shell" });
    store.appendEvent(id, "run.error", {
      reason: opts.failureReason ?? "sdk_error",
      sdkStatus: "error",
    });
  }
  if (opts.withChainSkipped) {
    store.appendEvent(id, "run.chain-skipped", {
      reason: "status-mismatch",
      next: "generated:docs-commit",
      status: "failed",
      when: "completed",
    });
  }
}

function listChildren(db: Db, parentId: string) {
  return db
    .prepare(
      `SELECT id, automation_id, trigger_kind, chain_depth, prompt
       FROM runs WHERE parent_run_id = ? ORDER BY rowid ASC`
    )
    .all(parentId) as Array<{
    id: string;
    automation_id: string;
    trigger_kind: string | null;
    chain_depth: number | null;
    prompt: string | null;
  }>;
}

function eventsOfType(db: Db, runId: string, eventType: string) {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = ?
         ORDER BY seq ASC`
      )
      .all(runId, eventType) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function readRun(db: Db, id: string) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | {
        id: string;
        chain_handled_at: string | null;
        status: string;
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
  autoEscalate?: boolean;
  maxPerPipeline?: number;
  lookbackMs?: number;
  /** When true, subscribe to status events (avoid seeding failed while started). */
  start?: boolean;
}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b43-runtime-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
  ).run("ws", workspace, "Workspace");
  seedPipelineWorkers(db);

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test",
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
    pipelineResumeLookbackMs: options?.lookbackMs ?? 86_400_000,
    pipelineAutoEscalate: options?.autoEscalate,
    pipelineAutoEscalateMaxPerPipeline: options?.maxPerPipeline,
  });
  if (options?.start) {
    chainRunner.start();
  }
  return { root, db, store, engine, chainRunner };
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

describe("b43 auto-escalation runtime", () => {
  it("live failed review halt auto-retries with daemon recovery metadata", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-review-1",
        withChainSkipped: false,
      });
      await env.chainRunner.handleTerminal("halt-review-1", "failed");

      const skipped = eventsOfType(env.db, "halt-review-1", "run.chain-skipped");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ reason: "status-mismatch" });

      const children = listChildren(env.db, "halt-review-1");
      expect(children).toHaveLength(1);
      expect(children[0]!.automation_id).toBe("ws::review");
      expect(children[0]!.trigger_kind).toBe("escalation");
      expect(children[0]!.chain_depth).toBe(2);

      expect(readRun(env.db, "halt-review-1")!.chain_handled_at).toBeTruthy();

      const escalated = eventsOfType(
        env.db,
        "halt-review-1",
        "run.pipeline-escalated"
      );
      expect(escalated).toHaveLength(1);
      expect(escalated[0]).toMatchObject({
        action: "retry",
        actor: "daemon",
        recoveryCode: "safe-class",
        childRunId: children[0]!.id,
      });
      expect(typeof escalated[0]!.recoveryDetail).toBe("string");
      expect(escalated[0]!.recoveryDetail).toMatch(/retry/i);
    } finally {
      await destroyEnv(env);
    }
  });

  it("non-allowlisted failure appends one unrecovered decision", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-unsafe",
        failureReason: "auth_failed",
        withChainSkipped: false,
      });
      await env.chainRunner.handleTerminal("halt-unsafe", "failed");

      expect(listChildren(env.db, "halt-unsafe")).toHaveLength(0);
      expect(readRun(env.db, "halt-unsafe")!.chain_handled_at).toBeNull();
      const unrecovered = eventsOfType(
        env.db,
        "halt-unsafe",
        "run.pipeline-halt-unrecovered"
      );
      expect(unrecovered).toHaveLength(1);
      expect(unrecovered[0]).toMatchObject({
        action: "none",
        code: "not-safe-class",
        observedReason: "auth_failed",
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("disabled policy appends unrecovered with code disabled", async () => {
    const env = await createEnv({ autoEscalate: false });
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-disabled",
        withChainSkipped: false,
      });
      await env.chainRunner.handleTerminal("halt-disabled", "failed");

      expect(listChildren(env.db, "halt-disabled")).toHaveLength(0);
      expect(readRun(env.db, "halt-disabled")!.chain_handled_at).toBeNull();
      const unrecovered = eventsOfType(
        env.db,
        "halt-disabled",
        "run.pipeline-halt-unrecovered"
      );
      expect(unrecovered).toHaveLength(1);
      expect(unrecovered[0]).toMatchObject({
        action: "none",
        code: "disabled",
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("lineage cap is two; operator and foreign-root events do not spend it", async () => {
    const env = await createEnv({ maxPerPipeline: 2 });
    try {
      // Prior daemon escalations under same root (on other runs) spend budget.
      for (const id of ["prior-d1", "prior-d2"]) {
        storeInsertLineageRun(env.store, env.db, {
          id,
          rootId: "root-1",
          depth: 1,
          actor: "daemon",
        });
      }
      // Operator + foreign root must not spend.
      storeInsertLineageRun(env.store, env.db, {
        id: "prior-op",
        rootId: "root-1",
        depth: 1,
        actor: "operator",
      });
      storeInsertLineageRun(env.store, env.db, {
        id: "prior-foreign",
        rootId: "other-root",
        depth: 1,
        actor: "daemon",
      });

      seedFailedHalt(env.store, env.db, {
        id: "halt-budget",
        rootId: "root-1",
        withChainSkipped: false,
      });
      await env.chainRunner.handleTerminal("halt-budget", "failed");

      expect(listChildren(env.db, "halt-budget")).toHaveLength(0);
      const unrecovered = eventsOfType(
        env.db,
        "halt-budget",
        "run.pipeline-halt-unrecovered"
      );
      expect(unrecovered).toHaveLength(1);
      expect(unrecovered[0]).toMatchObject({ code: "budget-spent" });

      // With only one daemon fact, recovery still acts (operator/foreign ignored).
      seedFailedHalt(env.store, env.db, {
        id: "halt-ok-budget",
        rootId: "root-2",
        withChainSkipped: false,
      });
      storeInsertLineageRun(env.store, env.db, {
        id: "one-daemon",
        rootId: "root-2",
        depth: 1,
        actor: "daemon",
      });
      storeInsertLineageRun(env.store, env.db, {
        id: "op-root-2",
        rootId: "root-2",
        depth: 1,
        actor: "operator",
      });
      await env.chainRunner.handleTerminal("halt-ok-budget", "failed");
      expect(listChildren(env.db, "halt-ok-budget")).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("second-rung review halt exhausts the ladder without skipping", async () => {
    const env = await createEnv();
    try {
      storeInsertLineageRun(env.store, env.db, {
        id: "rung1-daemon",
        rootId: "root-skip",
        depth: 2,
        actor: "daemon",
      });
      seedFailedHalt(env.store, env.db, {
        id: "halt-skip",
        rootId: "root-skip",
        depth: 2,
        withChainSkipped: false,
      });
      await env.chainRunner.handleTerminal("halt-skip", "failed");

      expect(listChildren(env.db, "halt-skip")).toHaveLength(0);
      expect(readRun(env.db, "halt-skip")!.chain_handled_at).toBeNull();
      const unrecovered = eventsOfType(
        env.db,
        "halt-skip",
        "run.pipeline-halt-unrecovered"
      );
      expect(unrecovered).toHaveLength(1);
      expect(unrecovered[0]).toMatchObject({
        action: "none",
        code: "ladder-exhausted",
      });
      expect(
        eventsOfType(env.db, "halt-skip", "run.pipeline-escalated")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("startup recovery acts once; replay is a no-op without new chain-skipped", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "startup-halt",
        withChainSkipped: true,
      });
      const beforeSkipped = eventsOfType(
        env.db,
        "startup-halt",
        "run.chain-skipped"
      ).length;

      const first = await env.chainRunner.resumeFailedHaltRecovery();
      expect(first).toBe(1);
      expect(listChildren(env.db, "startup-halt")).toHaveLength(1);
      expect(
        eventsOfType(env.db, "startup-halt", "run.chain-skipped")
      ).toHaveLength(beforeSkipped);

      const second = await env.chainRunner.resumeFailedHaltRecovery();
      expect(second).toBe(0);
      expect(listChildren(env.db, "startup-halt")).toHaveLength(1);
      expect(
        eventsOfType(env.db, "startup-halt", "run.pipeline-escalated")
      ).toHaveLength(1);
      expect(
        eventsOfType(env.db, "startup-halt", "run.chain-skipped")
      ).toHaveLength(beforeSkipped);
    } finally {
      await destroyEnv(env);
    }
  });

  it("overlapping live recovery and operator race yield one child, no unrecovered", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "race-halt",
        withChainSkipped: false,
      });

      // Operator wins the claim first.
      const op = await env.engine.escalateRun("race-halt", {
        action: "retry",
        reason: "operator first",
      });
      expect(op.ok).toBe(true);

      // Live path still appends halt evidence then sees claim.
      await env.chainRunner.handleTerminal("race-halt", "failed");

      expect(listChildren(env.db, "race-halt")).toHaveLength(1);
      expect(
        eventsOfType(env.db, "race-halt", "run.pipeline-halt-unrecovered")
      ).toHaveLength(0);
      const escalated = eventsOfType(
        env.db,
        "race-halt",
        "run.pipeline-escalated"
      );
      expect(escalated).toHaveLength(1);
      expect(escalated[0]).toMatchObject({
        actor: "operator",
        action: "retry",
      });
      expect(escalated[0]!.recoveryCode).toBeUndefined();
    } finally {
      await destroyEnv(env);
    }
  });

  it("duplicate live/startup invocations create at most one child", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "dup-halt",
        withChainSkipped: true,
      });
      const [a, b] = await Promise.all([
        env.chainRunner.resumeFailedHaltRecovery(),
        env.chainRunner.handleTerminal("dup-halt", "failed"),
      ]);
      void a;
      void b;
      expect(listChildren(env.db, "dup-halt")).toHaveLength(1);
      expect(
        eventsOfType(env.db, "dup-halt", "run.pipeline-escalated")
      ).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("settings defaults, YAML accept, kill switch, and positive cap override", async () => {
    expect(DEFAULT_SETTINGS.pipelineAutoEscalate).toBe(true);
    expect(DEFAULT_SETTINGS.pipelineAutoEscalateMaxPerPipeline).toBe(2);

    const { settingsSchema } = await import("@lca/shared");
    const parsed = settingsSchema.parse({
      pipelineResumeLookbackMs: 1000,
      pipelineAutoEscalate: false,
      pipelineAutoEscalateMaxPerPipeline: 4,
      maxConcurrentRuns: 3,
    });
    expect(parsed.pipelineAutoEscalate).toBe(false);
    expect(parsed.pipelineAutoEscalateMaxPerPipeline).toBe(4);
    expect(
      settingsSchema.safeParse({ pipelineAutoEscalateMaxPerPipeline: 0 })
        .success
    ).toBe(false);

    const home = mkdtempSync(join(tmpdir(), "lca-b43-settings-"));
    try {
      const cfgDir = join(home, ".cursor-local-automations");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "automations.yaml"),
        [
          "settings:",
          "  pipelineAutoEscalate: true",
          "  pipelineAutoEscalateMaxPerPipeline: 5",
          "  pipelineResumeLookbackMs: 999",
          "",
        ].join("\n"),
        "utf8"
      );

      vi.resetModules();
      vi.doMock("node:os", async () => {
        const actual = await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => home };
      });
      process.env.LCA_PIPELINE_AUTO_ESCALATE = "0";
      process.env.LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE = "3";
      const { loadSettings } = await import(
        "../packages/daemon/src/config/settings.ts"
      );
      const settings = loadSettings();
      expect(settings.pipelineAutoEscalate).toBe(false);
      expect(settings.pipelineAutoEscalateMaxPerPipeline).toBe(3);
      expect(settings.pipelineResumeLookbackMs).toBe(999);

      delete process.env.LCA_PIPELINE_AUTO_ESCALATE;
      delete process.env.LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE;
      vi.resetModules();
      vi.doMock("node:os", async () => {
        const actual = await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => home };
      });
      const { loadSettings: loadSettings2 } = await import(
        "../packages/daemon/src/config/settings.ts"
      );
      const fromYaml = loadSettings2();
      expect(fromYaml.pipelineAutoEscalate).toBe(true);
      expect(fromYaml.pipelineAutoEscalateMaxPerPipeline).toBe(5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("operator escalation retains actor operator without recovery fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b43-op-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
    ).run("ws", workspace, "Workspace");
    seedPipelineWorkers(db);

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
      inputHub,
      maxConcurrentRuns: 4,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const triggers = new TriggerManager(db, engine, { port });
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      triggers,
    });
    const client = new DaemonClient(`http://127.0.0.1:${port}`);

    try {
      seedFailedHalt(store, db, {
        id: "op-esc",
        withSafeEvidence: false,
        withChainSkipped: false,
      });
      const response = await client.escalate("op-esc", {
        action: "retry",
        reason: "manual",
      });
      expect(response.childRunId).toBeTruthy();
      const escalated = eventsOfType(db, "op-esc", "run.pipeline-escalated");
      expect(escalated).toHaveLength(1);
      expect(escalated[0]).toMatchObject({
        action: "retry",
        actor: "operator",
        reason: "manual",
        childRunId: response.childRunId,
      });
      expect(escalated[0]!.recoveryCode).toBeUndefined();
      expect(escalated[0]!.recoveryDetail).toBeUndefined();
    } finally {
      await http.close();
      await engine.shutdown();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function storeInsertLineageRun(
  store: RunStore,
  db: Db,
  opts: {
    id: string;
    rootId: string;
    depth: number;
    actor: "daemon" | "operator";
  }
): void {
  store.insertRun({
    id: opts.id,
    automationId: "ws::implement",
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: "prior",
    chainContext: CONTEXT,
    chainRootRunId: opts.rootId,
    chainDepth: opts.depth,
    chainMaxDepth: 9,
  });
  store.setStatus(opts.id, "failed");
  store.claimChainHandled(opts.id);
  store.appendEvent(opts.id, "run.pipeline-escalated", {
    action: "retry",
    actor: opts.actor,
    reason: "prior",
    childRunId: `${opts.id}-child`,
    ...(opts.actor === "daemon"
      ? { recoveryCode: "safe-class", recoveryDetail: "prior" }
      : {}),
  });
  void db;
}
