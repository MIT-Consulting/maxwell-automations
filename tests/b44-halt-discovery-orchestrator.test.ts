import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext, GeneratedWorkerPlan, RunStatus } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  type GeneratedWorkerSpec,
} from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { provisionGeneratedWorkers } from "../packages/daemon/src/config/generated-workers.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
  HALT_DISCOVERY_WORKERS,
} from "../packages/daemon/src/pipelines/halt-discovery.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import * as haltDiscoveryFacts from "../packages/daemon/src/runs/halt-discovery-facts.ts";
import { orchestrateHaltDiscoveryAdvisory } from "../packages/daemon/src/runs/halt-discovery-orchestrator.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b44",
    featureSlug: "b44-halt-discovery-agent",
    featureDir: "docs/roadmap/done/b44-halt-discovery-agent",
    featureIndex: "docs/roadmap/done/b44-halt-discovery-agent/00-index.md",
    idea: "halt discovery orchestrator",
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

const HALT_DISCOVERY_CONFIG_KEY =
  GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;

vi.unmock("node:os");

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:os");
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
    origin?: string;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role, origin
    ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name}`,
    input.configKey,
    input.chainJson ?? null,
    input.modelRole ?? null,
    input.origin ?? "generated"
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
}

type Env = {
  root: string;
  workspace: string;
  db: Db;
  store: RunStore;
  engine: RunEngine;
  provisionCalls: number;
};

function createEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "lca-b44-orch-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  mkdirSync(join(workspace, "docs", "roadmap"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), '{"name":"ws"}\n');
  writeFileSync(join(workspace, "docs", "roadmap", "00-index.md"), "# idx\n");

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
    apiKey: "test-key",
    executor: stubExecutor(),
    events,
    inputHub,
    maxConcurrentRuns: 4,
  });
  return { root, workspace, db, store, engine, provisionCalls: 0 };
}

async function destroyEnv(env: Env): Promise<void> {
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
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
    parentRunId?: string | null;
    chainContext?: ChainRunContext | null;
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
    parentRunId: opts.parentRunId,
    chainContext: opts.chainContext === undefined ? CONTEXT : opts.chainContext,
    chainRootRunId: rootId,
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: opts.maxDepth ?? 9,
  });
  store.setStatus(id, "failed");
  db.prepare(`UPDATE runs SET ended_at = datetime('now') WHERE id = ?`).run(id);
  store.appendEvent(id, "run.error", {
    reason: "sdk_error",
    sdkStatus: "error",
  });
}

function appendRequestedAndUnrecovered(store: RunStore, runId: string): void {
  store.appendEvent(runId, "run.pipeline-halt-unrecovered", {
    action: "none",
    code: "not-safe-class",
    detail: "Classifier declined auto-escalation",
    observedReason: "sdk_error",
  });
  store.appendEvent(runId, "run.pipeline-halt-discovery-requested", {
    code: "unrecovered-halt",
    recoveryCode: "not-safe-class",
    recoveryDetail: "Classifier declined auto-escalation",
    observedReason: "sdk_error",
  });
}

function makeProvision(
  env: Env,
  override?: (
    workspaceId: string,
    workers: readonly GeneratedWorkerSpec[]
  ) => GeneratedWorkerPlan
): (
  workspaceId: string,
  workers: readonly GeneratedWorkerSpec[]
) => GeneratedWorkerPlan {
  return (workspaceId, workers) => {
    env.provisionCalls += 1;
    if (override) {
      return override(workspaceId, workers);
    }
    return provisionGeneratedWorkers(env.db, workspaceId, [...workers]);
  };
}

async function runCore(
  env: Env,
  sourceRunId: string,
  provision?: (
    workspaceId: string,
    workers: readonly GeneratedWorkerSpec[]
  ) => GeneratedWorkerPlan
) {
  return orchestrateHaltDiscoveryAdvisory({
    store: env.store,
    engine: env.engine,
    provisionWorkers: makeProvision(env, provision),
    onLog: () => {},
    sourceRunId,
  });
}

function readRun(db: Db, id: string) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | {
        id: string;
        status: string;
        parent_run_id: string | null;
        trigger_kind: string | null;
        chain_root_run_id: string | null;
        chain_depth: number | null;
        chain_max_depth: number | null;
        chain_handled_at: string | null;
        chain_stop_requested_at: string | null;
        chain_max_depth_override: number | null;
        pipeline_wave_id: string | null;
        pipeline_track_id: string | null;
        execution_cwd: string | null;
        model: string | null;
        prompt: string | null;
        automation_id: string;
      }
    | undefined;
}

function listChildren(db: Db, parentId: string) {
  return db
    .prepare(
      `SELECT r.id, r.status, r.trigger_kind, r.chain_depth, r.model, a.config_key
       FROM runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.parent_run_id = ?
       ORDER BY r.rowid ASC`
    )
    .all(parentId) as Array<{
    id: string;
    status: string;
    trigger_kind: string | null;
    chain_depth: number | null;
    model: string | null;
    config_key: string;
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

function eventTypes(db: Db, runId: string): string[] {
  return (
    db
      .prepare(
        `SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq ASC`
      )
      .all(runId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

function seedAdvisoryChild(
  env: Env,
  sourceId: string,
  childId: string,
  status: RunStatus
): void {
  const autoId = automationId("ws", HALT_DISCOVERY_CONFIG_KEY);
  const plan = provisionGeneratedWorkers(
    env.db,
    "ws",
    [...HALT_DISCOVERY_WORKERS]
  );
  expect(plan.applied).toBe(true);
  env.store.insertRun({
    id: childId,
    automationId: autoId,
    workspaceId: "ws",
    triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
    prompt: "seeded advisory",
    parentRunId: sourceId,
    chainContext: CONTEXT,
    chainRootRunId: "root-1",
    chainDepth: 2,
    chainMaxDepth: 9,
  });
  env.store.setStatus(childId, status);
}

describe("b44 halt discovery orchestrator", () => {
  it("enqueues one same-depth advisory with copied context and reviewer model", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-1", depth: 2, maxDepth: 9 });
      appendRequestedAndUnrecovered(env.store, "halt-1");

      const before = readRun(env.db, "halt-1")!;
      const result = await runCore(env, "halt-1");
      expect(result).toMatchObject({ kind: "enqueued" });
      if (result.kind !== "enqueued") return;

      expect(env.provisionCalls).toBe(1);
      const children = listChildren(env.db, "halt-1");
      expect(children).toHaveLength(1);
      expect(children[0]!.id).toBe(result.advisoryRunId);
      expect(children[0]!.trigger_kind).toBe(HALT_DISCOVERY_TRIGGER_KIND);
      expect(children[0]!.config_key).toBe(HALT_DISCOVERY_CONFIG_KEY);
      expect(children[0]!.chain_depth).toBe(2);
      expect(children[0]!.model).toBe("reviewer-model");

      const child = readRun(env.db, result.advisoryRunId)!;
      expect(child.parent_run_id).toBe("halt-1");
      expect(child.chain_root_run_id).toBe("root-1");
      expect(child.chain_depth).toBe(2);
      expect(child.chain_max_depth).toBe(9);
      expect(child.pipeline_wave_id).toBeNull();
      expect(child.pipeline_track_id).toBeNull();
      expect(child.execution_cwd).toBeNull();
      expect(child.prompt).toContain("<<<LCA_HALT_DISCOVERY_FACTS>>>");
      expect(child.prompt).toContain("halt-1");
      expect(Buffer.byteLength(child.prompt ?? "", "utf8")).toBeLessThanOrEqual(
        256 * 1024
      );

      const after = readRun(env.db, "halt-1")!;
      expect(after.status).toBe("failed");
      expect(after.chain_handled_at).toBeNull();
      expect(after.chain_stop_requested_at).toBeNull();
      expect(after.chain_depth).toBe(before.chain_depth);
      expect(after.chain_max_depth).toBe(before.chain_max_depth);
      expect(after.chain_max_depth_override).toBe(before.chain_max_depth_override);
      expect(eventTypes(env.db, "halt-1")).not.toContain("run.chained");
      expect(eventTypes(env.db, "halt-1")).not.toContain("run.pipeline-escalated");
      expect(eventTypes(env.db, "halt-1")).not.toContain("run.chain-control");
      expect(
        eventsOfType(env.db, "halt-1", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("returns existing child on repeat and for every pre-seeded status", async () => {
    const statuses: RunStatus[] = [
      "queued",
      "running",
      "needs_input",
      "completed",
      "failed",
      "cancelled",
    ];

    for (const status of statuses) {
      const env = createEnv();
      try {
        seedFailedHalt(env.store, env.db, { id: "halt-exist" });
        appendRequestedAndUnrecovered(env.store, "halt-exist");
        seedAdvisoryChild(env, "halt-exist", `child-${status}`, status);
        env.provisionCalls = 0;

        const first = await runCore(env, "halt-exist");
        expect(first).toEqual({
          kind: "existing",
          advisoryRunId: `child-${status}`,
        });
        expect(env.provisionCalls).toBe(0);
        expect(listChildren(env.db, "halt-exist")).toHaveLength(1);

        const second = await runCore(env, "halt-exist");
        expect(second).toEqual(first);
        expect(env.provisionCalls).toBe(0);
        expect(listChildren(env.db, "halt-exist")).toHaveLength(1);
      } finally {
        await destroyEnv(env);
      }
    }

    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-twice" });
      appendRequestedAndUnrecovered(env.store, "halt-twice");
      const first = await runCore(env, "halt-twice");
      expect(first.kind).toBe("enqueued");
      const second = await runCore(env, "halt-twice");
      expect(second).toEqual({
        kind: "existing",
        advisoryRunId: first.kind === "enqueued" ? first.advisoryRunId : "",
      });
      expect(listChildren(env.db, "halt-twice")).toHaveLength(1);
      expect(env.provisionCalls).toBe(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("findHaltDiscoveryAdvisoryChild returns oldest and sees archived automations", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-lookup" });
      const autoId = automationId("ws", HALT_DISCOVERY_CONFIG_KEY);
      provisionGeneratedWorkers(env.db, "ws", [...HALT_DISCOVERY_WORKERS]);
      env.store.insertRun({
        id: "older-child",
        automationId: autoId,
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "older",
        parentRunId: "halt-lookup",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.insertRun({
        id: "newer-child",
        automationId: autoId,
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "newer",
        parentRunId: "halt-lookup",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      expect(env.store.findHaltDiscoveryAdvisoryChild("halt-lookup")?.id).toBe(
        "older-child"
      );

      env.db
        .prepare(
          `UPDATE automations SET archived_at = datetime('now') WHERE id = ?`
        )
        .run(autoId);
      expect(env.store.findHaltDiscoveryAdvisoryChild("halt-lookup")?.id).toBe(
        "older-child"
      );
    } finally {
      await destroyEnv(env);
    }
  });

  it("treats an existing discovery-failed event as a settled no-op", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-settled" });
      appendRequestedAndUnrecovered(env.store, "halt-settled");
      env.store.appendEvent("halt-settled", "run.pipeline-halt-discovery-failed", {
        stage: "spawn",
        code: "enqueue-failed",
        detail: "prior failure",
      });

      const result = await runCore(env, "halt-settled");
      expect(result).toEqual({
        kind: "no-longer-actionable",
        reason: "already-failed",
      });
      expect(env.provisionCalls).toBe(0);
      expect(listChildren(env.db, "halt-settled")).toHaveLength(0);
      expect(
        eventsOfType(env.db, "halt-settled", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("records one spawn failure for malformed/stale source", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-bad" });
      const result = await runCore(env, "halt-bad");
      expect(result).toMatchObject({ kind: "failed", code: "invalid-trigger" });
      const failed = eventsOfType(
        env.db,
        "halt-bad",
        "run.pipeline-halt-discovery-failed"
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ stage: "spawn", code: "invalid-trigger" });
      expect(listChildren(env.db, "halt-bad")).toHaveLength(0);
      expect(readRun(env.db, "halt-bad")!.chain_handled_at).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("records one spawn failure for provisioning conflict", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-conflict" });
      appendRequestedAndUnrecovered(env.store, "halt-conflict");
      insertAutomation(env.db, {
        id: automationId("ws", HALT_DISCOVERY_CONFIG_KEY),
        configKey: HALT_DISCOVERY_CONFIG_KEY,
        name: "User conflict",
        origin: "config",
      });

      const result = await runCore(env, "halt-conflict");
      expect(result).toMatchObject({
        kind: "failed",
        code: "provision-conflict",
      });
      expect(
        eventsOfType(
          env.db,
          "halt-conflict",
          "run.pipeline-halt-discovery-failed"
        )
      ).toHaveLength(1);
      expect(listChildren(env.db, "halt-conflict")).toHaveLength(0);
      expect(readRun(env.db, "halt-conflict")!.chain_handled_at).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("records one spawn failure for missing target", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-missing" });
      appendRequestedAndUnrecovered(env.store, "halt-missing");
      const provision = (): GeneratedWorkerPlan => ({
        workspaceId: "ws",
        dryRun: false,
        applied: true,
        items: [
          {
            key: HALT_DISCOVERY_WORKER_KEY,
            configKey: HALT_DISCOVERY_CONFIG_KEY,
            automationId: "ws::does-not-exist",
            action: "unchanged",
          },
        ],
      });

      const result = await runCore(env, "halt-missing", provision);
      expect(result).toMatchObject({ kind: "failed", code: "missing-target" });
      expect(
        eventsOfType(
          env.db,
          "halt-missing",
          "run.pipeline-halt-discovery-failed"
        )
      ).toHaveLength(1);
      expect(listChildren(env.db, "halt-missing")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("records spawn failure for prompt build errors", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-prompt" });
      appendRequestedAndUnrecovered(env.store, "halt-prompt");
      vi.spyOn(haltDiscoveryFacts, "buildHaltDiscoveryPrompt").mockReturnValue({
        ok: false,
        code: "oversized-prompt",
        detail: "prompt exceeds byte limit",
      });

      const result = await runCore(env, "halt-prompt");
      expect(result).toMatchObject({
        kind: "failed",
        code: "oversized-prompt",
      });
      expect(
        eventsOfType(env.db, "halt-prompt", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(1);
      expect(listChildren(env.db, "halt-prompt")).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("bounds spawn failure detail to 4 KiB without splitting code points", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-huge" });
      appendRequestedAndUnrecovered(env.store, "halt-huge");
      vi.spyOn(env.engine, "triggerRun").mockRejectedValue(
        new Error("\u00e9".repeat(8000))
      );

      const result = await runCore(env, "halt-huge");
      expect(result).toMatchObject({ kind: "failed", code: "enqueue-failed" });
      if (result.kind !== "failed") return;
      expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(4096);
      expect(result.detail).not.toContain("\uFFFD");
    } finally {
      await destroyEnv(env);
    }
  });

  it("records spawn failure when triggerRun throws and leaves source intact", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-throw" });
      appendRequestedAndUnrecovered(env.store, "halt-throw");
      vi.spyOn(env.engine, "triggerRun").mockRejectedValue(
        new Error("forced enqueue failure")
      );

      const before = readRun(env.db, "halt-throw")!;
      const result = await runCore(env, "halt-throw");
      expect(result).toMatchObject({
        kind: "failed",
        code: "enqueue-failed",
      });
      const failed = eventsOfType(
        env.db,
        "halt-throw",
        "run.pipeline-halt-discovery-failed"
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        stage: "spawn",
        code: "enqueue-failed",
      });
      expect(String(failed[0]!.detail)).toContain("forced enqueue failure");
      expect(listChildren(env.db, "halt-throw")).toHaveLength(0);
      const after = readRun(env.db, "halt-throw")!;
      expect(after.status).toBe("failed");
      expect(after.chain_handled_at).toBeNull();
      expect(after.chain_depth).toBe(before.chain_depth);
    } finally {
      await destroyEnv(env);
    }
  });
});
