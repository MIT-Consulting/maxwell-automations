import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext, RunStatus } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
} from "@lca/shared";
import { provisionGeneratedWorkers } from "../packages/daemon/src/config/generated-workers.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
  HALT_DISCOVERY_WORKERS,
} from "../packages/daemon/src/pipelines/halt-discovery.ts";
import { reconcileHaltDiscoveryAdvisoryTerminal } from "../packages/daemon/src/runs/halt-discovery-orchestrator.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b44",
    featureSlug: "b44-halt-discovery-agent",
    featureDir: "docs/roadmap/done/b44-halt-discovery-agent",
    featureIndex: "docs/roadmap/done/b44-halt-discovery-agent/00-index.md",
    idea: "halt discovery reconciliation",
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

const LOOKBACK_MS = 86_400_000;

vi.unmock("node:os");

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:os");
});

type Env = {
  root: string;
  db: Db;
  store: RunStore;
};

function createEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "lca-b44-reconcile-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, "package.json"), '{"name":"ws"}\n');

  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
  ).run("ws", workspace, "Workspace");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role, origin
    ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, ?, ?, ?)`
  ).run(
    "ws::review",
    "Review",
    JSON.stringify({ type: "manual" }),
    "Review prompt",
    "generated:review",
    JSON.stringify({ next: "generated:docs-commit", when: "completed" }),
    "reviewer",
    "generated"
  );

  const store = new RunStore(db, new DaemonEventBus());
  return { root, db, store };
}

function destroyEnv(env: Env): void {
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function seedFailedHalt(
  store: RunStore,
  db: Db,
  opts: {
    id: string;
    endedAt?: string;
    depth?: number;
  }
): void {
  store.insertRun({
    id: opts.id,
    automationId: "ws::review",
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: "Review prompt stored",
    chainContext: CONTEXT,
    chainRootRunId: "root-1",
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: 9,
  });
  store.setStatus(opts.id, "failed");
  const endedAt = opts.endedAt ?? new Date().toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  db.prepare(`UPDATE runs SET ended_at = ? WHERE id = ?`).run(
    endedAt,
    opts.id
  );
}

function appendRequested(store: RunStore, runId: string): void {
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

function ensureHaltDiscoveryAutomation(env: Env): string {
  const plan = provisionGeneratedWorkers(
    env.db,
    "ws",
    [...HALT_DISCOVERY_WORKERS]
  );
  expect(plan.applied).toBe(true);
  return automationId("ws", HALT_DISCOVERY_CONFIG_KEY);
}

function seedAdvisoryChild(
  env: Env,
  opts: {
    sourceId: string;
    childId: string;
    status: RunStatus;
    triggerKind?: string;
    automationId?: string;
  }
): void {
  const autoId = opts.automationId ?? ensureHaltDiscoveryAutomation(env);
  env.store.insertRun({
    id: opts.childId,
    automationId: autoId,
    workspaceId: "ws",
    triggerKind: opts.triggerKind ?? HALT_DISCOVERY_TRIGGER_KIND,
    prompt: "seeded advisory",
    parentRunId: opts.sourceId,
    chainContext: CONTEXT,
    chainRootRunId: "root-1",
    chainDepth: 2,
    chainMaxDepth: 9,
  });
  env.store.setStatus(opts.childId, opts.status);
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

function readRunStatus(db: Db, id: string): string | undefined {
  const row = db
    .prepare(`SELECT status, chain_handled_at, chain_stop_requested_at FROM runs WHERE id = ?`)
    .get(id) as
    | {
        status: string;
        chain_handled_at: string | null;
        chain_stop_requested_at: string | null;
      }
    | undefined;
  return row?.status;
}

function readAuthority(db: Db, id: string) {
  return db
    .prepare(
      `SELECT status, chain_handled_at, chain_stop_requested_at,
              chain_depth, chain_max_depth, chain_max_depth_override
       FROM runs WHERE id = ?`
    )
    .get(id) as {
    status: string;
    chain_handled_at: string | null;
    chain_stop_requested_at: string | null;
    chain_depth: number | null;
    chain_max_depth: number | null;
    chain_max_depth_override: number | null;
  };
}

describe("listUnresolvedHaltDiscoveryAdvisoryCandidates", () => {
  it("returns newest-first bounded sources needing enqueue or terminal reconcile", () => {
    const env = createEnv();
    try {
      const now = Date.now();
      const fmt = (ms: number) =>
        new Date(ms)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d{3}Z$/, "");

      seedFailedHalt(env.store, env.db, {
        id: "halt-old",
        endedAt: fmt(now - 60_000),
      });
      appendRequested(env.store, "halt-old");

      seedFailedHalt(env.store, env.db, {
        id: "halt-new",
        endedAt: fmt(now - 10_000),
      });
      appendRequested(env.store, "halt-new");

      seedFailedHalt(env.store, env.db, {
        id: "halt-mid-failed-child",
        endedAt: fmt(now - 30_000),
      });
      appendRequested(env.store, "halt-mid-failed-child");
      seedAdvisoryChild(env, {
        sourceId: "halt-mid-failed-child",
        childId: "child-failed",
        status: "failed",
      });

      const rows = env.store.listUnresolvedHaltDiscoveryAdvisoryCandidates(
        LOOKBACK_MS,
        now
      );
      expect(rows.map((r) => r.id)).toEqual([
        "halt-new",
        "halt-mid-failed-child",
        "halt-old",
      ]);
    } finally {
      destroyEnv(env);
    }
  });

  it("excludes sources that ended before the lookback cutoff", () => {
    const env = createEnv();
    try {
      const now = Date.now();
      const fmt = (ms: number) =>
        new Date(ms)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d{3}Z$/, "");

      seedFailedHalt(env.store, env.db, {
        id: "halt-inside",
        endedAt: fmt(now - 30_000),
      });
      appendRequested(env.store, "halt-inside");

      seedFailedHalt(env.store, env.db, {
        id: "halt-outside",
        endedAt: fmt(now - 300_000),
      });
      appendRequested(env.store, "halt-outside");

      const ids = env.store
        .listUnresolvedHaltDiscoveryAdvisoryCandidates(60_000, now)
        .map((r) => r.id);
      expect(ids).toEqual(["halt-inside"]);
    } finally {
      destroyEnv(env);
    }
  });

  it("returns empty for non-positive lookback", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-zb" });
      appendRequested(env.store, "halt-zb");
      expect(
        env.store.listUnresolvedHaltDiscoveryAdvisoryCandidates(0)
      ).toEqual([]);
      expect(
        env.store.listUnresolvedHaltDiscoveryAdvisoryCandidates(-1)
      ).toEqual([]);
    } finally {
      destroyEnv(env);
    }
  });

  it("requires discovery-requested and excludes discovery-failed", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-no-req" });
      env.store.appendEvent("halt-no-req", "run.pipeline-halt-unrecovered", {
        action: "none",
        code: "not-safe-class",
        detail: "declined",
      });

      seedFailedHalt(env.store, env.db, { id: "halt-already-failed" });
      appendRequested(env.store, "halt-already-failed");
      env.store.appendEvent(
        "halt-already-failed",
        "run.pipeline-halt-discovery-failed",
        {
          stage: "spawn",
          code: "enqueue-failed",
          detail: "prior",
        }
      );

      seedFailedHalt(env.store, env.db, { id: "halt-ok" });
      appendRequested(env.store, "halt-ok");

      const ids = env.store
        .listUnresolvedHaltDiscoveryAdvisoryCandidates(LOOKBACK_MS)
        .map((r) => r.id);
      expect(ids).toEqual(["halt-ok"]);
    } finally {
      destroyEnv(env);
    }
  });

  it("filters by exact generated child identity and terminal status", () => {
    const env = createEnv();
    try {
      const statuses: RunStatus[] = [
        "queued",
        "running",
        "needs_input",
        "completed",
        "failed",
        "cancelled",
      ];

      for (const status of statuses) {
        const sourceId = `halt-${status}`;
        seedFailedHalt(env.store, env.db, { id: sourceId });
        appendRequested(env.store, sourceId);
        seedAdvisoryChild(env, {
          sourceId,
          childId: `child-${status}`,
          status,
        });
      }

      // Wrong trigger — treated as absent exact child → included.
      seedFailedHalt(env.store, env.db, { id: "halt-wrong-trigger" });
      appendRequested(env.store, "halt-wrong-trigger");
      env.store.insertRun({
        id: "child-wrong-trigger",
        automationId: ensureHaltDiscoveryAutomation(env),
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "not advisory",
        parentRunId: "halt-wrong-trigger",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("child-wrong-trigger", "failed");

      // Wrong worker config key — treated as absent exact child → included.
      env.db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, chain_json, model_role, origin
        ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, NULL, 'generated')`
      ).run(
        "ws::other",
        "Other",
        JSON.stringify({ type: "manual" }),
        "other",
        "generated:other-worker"
      );
      seedFailedHalt(env.store, env.db, { id: "halt-wrong-worker" });
      appendRequested(env.store, "halt-wrong-worker");
      env.store.insertRun({
        id: "child-wrong-worker",
        automationId: "ws::other",
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "wrong worker",
        parentRunId: "halt-wrong-worker",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("child-wrong-worker", "failed");

      // Missing child → included.
      seedFailedHalt(env.store, env.db, { id: "halt-missing" });
      appendRequested(env.store, "halt-missing");

      const ids = new Set(
        env.store
          .listUnresolvedHaltDiscoveryAdvisoryCandidates(LOOKBACK_MS)
          .map((r) => r.id)
      );

      expect(ids.has("halt-failed")).toBe(true);
      expect(ids.has("halt-cancelled")).toBe(true);
      expect(ids.has("halt-missing")).toBe(true);
      expect(ids.has("halt-wrong-trigger")).toBe(true);
      expect(ids.has("halt-wrong-worker")).toBe(true);

      expect(ids.has("halt-queued")).toBe(false);
      expect(ids.has("halt-running")).toBe(false);
      expect(ids.has("halt-needs_input")).toBe(false);
      expect(ids.has("halt-completed")).toBe(false);

      // Phase 1 request candidate query remains unchanged in shape.
      expect(
        env.store.listPipelineHaltDiscoveryCandidates(LOOKBACK_MS)
      ).toEqual([]);
    } finally {
      destroyEnv(env);
    }
  });

  it("uses oldest exact child when multiple children exist", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-multi" });
      appendRequested(env.store, "halt-multi");
      const autoId = ensureHaltDiscoveryAutomation(env);
      env.store.insertRun({
        id: "older-child",
        automationId: autoId,
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "older",
        parentRunId: "halt-multi",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("older-child", "completed");
      env.store.insertRun({
        id: "newer-child",
        automationId: autoId,
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "newer",
        parentRunId: "halt-multi",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("newer-child", "failed");

      const ids = env.store
        .listUnresolvedHaltDiscoveryAdvisoryCandidates(LOOKBACK_MS)
        .map((r) => r.id);
      // Authoritative (oldest) child is completed → excluded.
      expect(ids).not.toContain("halt-multi");
    } finally {
      destroyEnv(env);
    }
  });
});

describe("reconcileHaltDiscoveryAdvisoryTerminal", () => {
  it("records spawn-stage failure before run.started and diagnosis after", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-spawn" });
      appendRequested(env.store, "halt-spawn");
      seedAdvisoryChild(env, {
        sourceId: "halt-spawn",
        childId: "adv-spawn",
        status: "failed",
      });
      env.store.appendEvent("adv-spawn", "run.error", {
        message: "spawn boom",
      });

      const before = readAuthority(env.db, "halt-spawn");
      const spawnResult = reconcileHaltDiscoveryAdvisoryTerminal({
        store: env.store,
        onLog: () => {},
        advisoryRunId: "adv-spawn",
        status: "failed",
      });
      expect(spawnResult).toEqual({
        kind: "handled",
        stage: "spawn",
        code: "advisory-failed",
        detail: "spawn boom",
        advisoryRunId: "adv-spawn",
      });
      const spawnFailures = eventsOfType(
        env.db,
        "halt-spawn",
        "run.pipeline-halt-discovery-failed"
      );
      expect(spawnFailures).toHaveLength(1);
      expect(spawnFailures[0]).toEqual({
        stage: "spawn",
        code: "advisory-failed",
        detail: "spawn boom",
        advisoryRunId: "adv-spawn",
      });
      expect(readAuthority(env.db, "halt-spawn")).toEqual(before);
      expect(readRunStatus(env.db, "adv-spawn")).toBe("failed");

      seedFailedHalt(env.store, env.db, { id: "halt-diag" });
      appendRequested(env.store, "halt-diag");
      seedAdvisoryChild(env, {
        sourceId: "halt-diag",
        childId: "adv-diag",
        status: "failed",
      });
      env.store.appendEvent("adv-diag", "run.started", {
        agentId: "a1",
        sdkRunId: "s1",
      });
      env.store.appendEvent("adv-diag", "run.error", {
        reason: "sdk_error",
      });

      const diagResult = reconcileHaltDiscoveryAdvisoryTerminal({
        store: env.store,
        onLog: () => {},
        advisoryRunId: "adv-diag",
        status: "failed",
      });
      expect(diagResult).toMatchObject({
        kind: "handled",
        stage: "diagnosis",
        code: "advisory-failed",
        detail: "sdk_error",
        advisoryRunId: "adv-diag",
      });
      expect(
        eventsOfType(env.db, "halt-diag", "run.pipeline-halt-discovery-failed")
      ).toEqual([
        {
          stage: "diagnosis",
          code: "advisory-failed",
          detail: "sdk_error",
          advisoryRunId: "adv-diag",
        },
      ]);
    } finally {
      destroyEnv(env);
    }
  });

  it("handles cancellation with advisory-cancelled and includes advisory id", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-cancel" });
      appendRequested(env.store, "halt-cancel");
      seedAdvisoryChild(env, {
        sourceId: "halt-cancel",
        childId: "adv-cancel",
        status: "cancelled",
      });
      env.store.appendEvent("adv-cancel", "run.started", { agentId: "a" });
      env.store.appendEvent("adv-cancel", "run.finished", {
        result: "operator cancelled mid-diagnosis",
      });

      const result = reconcileHaltDiscoveryAdvisoryTerminal({
        store: env.store,
        onLog: () => {},
        advisoryRunId: "adv-cancel",
        status: "cancelled",
      });
      expect(result).toEqual({
        kind: "handled",
        stage: "diagnosis",
        code: "advisory-cancelled",
        detail: "operator cancelled mid-diagnosis",
        advisoryRunId: "adv-cancel",
      });
    } finally {
      destroyEnv(env);
    }
  });

  it("is idempotent on duplicate reconciliation", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-dup" });
      appendRequested(env.store, "halt-dup");
      seedAdvisoryChild(env, {
        sourceId: "halt-dup",
        childId: "adv-dup",
        status: "failed",
      });
      env.store.appendEvent("adv-dup", "run.error", { message: "once" });

      const first = reconcileHaltDiscoveryAdvisoryTerminal({
        store: env.store,
        onLog: () => {},
        advisoryRunId: "adv-dup",
        status: "failed",
      });
      expect(first.kind).toBe("handled");

      const second = reconcileHaltDiscoveryAdvisoryTerminal({
        store: env.store,
        onLog: () => {},
        advisoryRunId: "adv-dup",
        status: "failed",
      });
      expect(second).toEqual({ kind: "noop", reason: "already-failed" });
      expect(
        eventsOfType(env.db, "halt-dup", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(1);
    } finally {
      destroyEnv(env);
    }
  });

  it("no-ops for wrong identity, missing source, and non-terminal statuses", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-src" });
      appendRequested(env.store, "halt-src");
      const autoId = ensureHaltDiscoveryAutomation(env);

      seedAdvisoryChild(env, {
        sourceId: "halt-src",
        childId: "adv-wrong-trigger",
        status: "failed",
        triggerKind: "manual",
      });
      expect(
        reconcileHaltDiscoveryAdvisoryTerminal({
          store: env.store,
          onLog: () => {},
          advisoryRunId: "adv-wrong-trigger",
          status: "failed",
        })
      ).toEqual({ kind: "noop", reason: "wrong-trigger-kind" });

      env.db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, chain_json, model_role, origin
        ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, NULL, 'generated')`
      ).run(
        "ws::not-halt",
        "Not halt",
        JSON.stringify({ type: "manual" }),
        "x",
        "generated:not-halt-discovery"
      );
      env.store.insertRun({
        id: "adv-wrong-worker",
        automationId: "ws::not-halt",
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "wrong",
        parentRunId: "halt-src",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("adv-wrong-worker", "failed");
      expect(
        reconcileHaltDiscoveryAdvisoryTerminal({
          store: env.store,
          onLog: () => {},
          advisoryRunId: "adv-wrong-worker",
          status: "failed",
        })
      ).toEqual({ kind: "noop", reason: "wrong-worker-identity" });

      env.store.insertRun({
        id: "adv-orphan",
        automationId: autoId,
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "orphan",
        parentRunId: "missing-parent",
        chainContext: CONTEXT,
        chainRootRunId: "root-1",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("adv-orphan", "failed");
      expect(
        reconcileHaltDiscoveryAdvisoryTerminal({
          store: env.store,
          onLog: () => {},
          advisoryRunId: "adv-orphan",
          status: "failed",
        })
      ).toEqual({ kind: "noop", reason: "source-not-found" });

      for (const status of [
        "queued",
        "running",
        "needs_input",
        "completed",
      ] as const) {
        seedAdvisoryChild(env, {
          sourceId: "halt-src",
          childId: `adv-${status}`,
          status,
        });
        expect(
          reconcileHaltDiscoveryAdvisoryTerminal({
            store: env.store,
            onLog: () => {},
            advisoryRunId: `adv-${status}`,
            status,
          })
        ).toEqual({ kind: "noop", reason: "non-terminal-status" });
      }

      expect(
        eventsOfType(env.db, "halt-src", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(0);
    } finally {
      destroyEnv(env);
    }
  });

  it("bounds detail and never exposes raw unbounded payloads", () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "halt-bound" });
      appendRequested(env.store, "halt-bound");
      seedAdvisoryChild(env, {
        sourceId: "halt-bound",
        childId: "adv-bound",
        status: "failed",
      });
      const huge = "火".repeat(3000);
      env.store.appendEvent("adv-bound", "run.error", { message: huge });

      const result = reconcileHaltDiscoveryAdvisoryTerminal({
        store: env.store,
        onLog: () => {},
        advisoryRunId: "adv-bound",
        status: "failed",
      });
      expect(result.kind).toBe("handled");
      if (result.kind !== "handled") return;
      expect(Buffer.byteLength(result.detail, "utf8")).toBeLessThanOrEqual(
        4096
      );
      expect(result.detail.includes("\uFFFD")).toBe(false);

      const payload = eventsOfType(
        env.db,
        "halt-bound",
        "run.pipeline-halt-discovery-failed"
      )[0]!;
      expect(typeof payload.detail).toBe("string");
      expect(
        Buffer.byteLength(payload.detail as string, "utf8")
      ).toBeLessThanOrEqual(4096);
      // Failure envelope stays structured — no raw event dump fields.
      expect(payload).not.toHaveProperty("message");
      expect(payload).not.toHaveProperty("payload");
      expect(payload).toMatchObject({
        stage: "spawn",
        code: "advisory-failed",
        advisoryRunId: "adv-bound",
      });
    } finally {
      destroyEnv(env);
    }
  });
});
