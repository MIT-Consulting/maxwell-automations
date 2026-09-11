import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext } from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import type { HaltRecoveryResult } from "../packages/daemon/src/runs/halt-recovery-runtime.ts";
import { requestPipelineHaltDiscovery } from "../packages/daemon/src/runs/halt-discovery-trigger.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b44",
    featureSlug: "b44-halt-discovery-agent",
    featureDir: "docs/roadmap/done/b44-halt-discovery-agent",
    featureIndex: "docs/roadmap/done/b44-halt-discovery-agent/00-index.md",
    idea: "halt discovery trigger",
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
  delete process.env.LCA_PIPELINE_HALT_DISCOVERY;
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
    pipelineWaveId?: string | null;
    pipelineTrackId?: string | null;
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
    chainContext: opts.chainContext === undefined ? CONTEXT : opts.chainContext,
    chainRootRunId: rootId,
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: opts.maxDepth ?? 9,
    pipelineWaveId: opts.pipelineWaveId,
    pipelineTrackId: opts.pipelineTrackId,
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

function readRun(db: Db, id: string) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | {
        id: string;
        chain_handled_at: string | null;
        status: string;
      }
    | undefined;
}

function listChildren(db: Db, parentId: string) {
  return db
    .prepare(
      `SELECT id FROM runs WHERE parent_run_id = ? ORDER BY rowid ASC`
    )
    .all(parentId) as Array<{ id: string }>;
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
  discovery?: boolean;
  maxPerPipeline?: number;
  lookbackMs?: number;
  onHaltRecoveryDecision?: (runId: string, result: HaltRecoveryResult) => void;
}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b44-discovery-"));
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
    pipelineHaltDiscovery: options?.discovery,
    onHaltRecoveryDecision: options?.onHaltRecoveryDecision,
  });
  return { root, db, store, engine, chainRunner };
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

describe("b44 halt discovery trigger", () => {
  it("live unsafe decline appends one discovery request after unrecovered", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-unsafe",
        failureReason: "auth_failed",
        withSafeEvidence: true,
      });
      await env.chainRunner.handleTerminal("halt-unsafe", "failed");

      const unrecovered = eventsOfType(
        env.db,
        "halt-unsafe",
        "run.pipeline-halt-unrecovered"
      );
      expect(unrecovered).toHaveLength(1);
      const requested = eventsOfType(
        env.db,
        "halt-unsafe",
        "run.pipeline-halt-discovery-requested"
      );
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({
        code: "unrecovered-halt",
        recoveryCode: "not-safe-class",
        observedReason: "auth_failed",
      });
      expect(typeof requested[0]!.recoveryDetail).toBe("string");
      expect(readRun(env.db, "halt-unsafe")!.chain_handled_at).toBeNull();
      expect(listChildren(env.db, "halt-unsafe")).toHaveLength(0);

      const types = eventTypes(env.db, "halt-unsafe");
      expect(types.indexOf("run.pipeline-halt-unrecovered")).toBeLessThan(
        types.indexOf("run.pipeline-halt-discovery-requested")
      );
    } finally {
      await destroyEnv(env);
    }
  });

  it("b43 disabled decline still requests discovery when discovery enabled", async () => {
    const env = await createEnv({ autoEscalate: false });
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-b43-disabled",
        withSafeEvidence: true,
      });
      await env.chainRunner.handleTerminal("halt-b43-disabled", "failed");

      expect(
        eventsOfType(
          env.db,
          "halt-b43-disabled",
          "run.pipeline-halt-unrecovered"
        )
      ).toEqual([
        expect.objectContaining({ action: "none", code: "disabled" }),
      ]);
      const requested = eventsOfType(
        env.db,
        "halt-b43-disabled",
        "run.pipeline-halt-discovery-requested"
      );
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({
        code: "unrecovered-halt",
        recoveryCode: "disabled",
      });
      expect(readRun(env.db, "halt-b43-disabled")!.chain_handled_at).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("successful b43 retry skips discovery; review ladder-exhausted requests it", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-retry",
        withSafeEvidence: true,
      });
      await env.chainRunner.handleTerminal("halt-retry", "failed");
      expect(listChildren(env.db, "halt-retry")).toHaveLength(1);
      expect(
        eventsOfType(
          env.db,
          "halt-retry",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(0);
      expect(
        eventsOfType(env.db, "halt-retry", "run.pipeline-halt-discovery-skipped")
      ).toHaveLength(0);

      // Second-rung review has no skip — ladder-exhausted requests discovery.
      env.store.insertRun({
        id: "rung1-daemon",
        automationId: "ws::implement",
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "prior",
        chainContext: CONTEXT,
        chainRootRunId: "root-skip",
        chainDepth: 2,
        chainMaxDepth: 9,
      });
      env.store.setStatus("rung1-daemon", "failed");
      env.store.claimChainHandled("rung1-daemon");
      env.store.appendEvent("rung1-daemon", "run.pipeline-escalated", {
        action: "retry",
        actor: "daemon",
        reason: "prior",
        childRunId: "rung1-daemon-child",
        recoveryCode: "safe-class",
        recoveryDetail: "prior",
      });
      seedFailedHalt(env.store, env.db, {
        id: "halt-skip",
        rootId: "root-skip",
        depth: 2,
        withSafeEvidence: true,
      });
      await env.chainRunner.handleTerminal("halt-skip", "failed");
      expect(listChildren(env.db, "halt-skip")).toHaveLength(0);
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
      const requested = eventsOfType(
        env.db,
        "halt-skip",
        "run.pipeline-halt-discovery-requested"
      );
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatchObject({
        code: "unrecovered-halt",
        recoveryCode: "ladder-exhausted",
      });
      expect(
        eventsOfType(env.db, "halt-skip", "run.pipeline-halt-discovery-skipped")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("discovery disabled records one skipped:disabled and no request", async () => {
    const env = await createEnv({ discovery: false });
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-disc-off",
        failureReason: "auth_failed",
      });
      await env.chainRunner.handleTerminal("halt-disc-off", "failed");

      expect(
        eventsOfType(
          env.db,
          "halt-disc-off",
          "run.pipeline-halt-unrecovered"
        )
      ).toHaveLength(1);
      const skipped = eventsOfType(
        env.db,
        "halt-disc-off",
        "run.pipeline-halt-discovery-skipped"
      );
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ code: "disabled" });
      expect(
        eventsOfType(
          env.db,
          "halt-disc-off",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(0);
      expect(readRun(env.db, "halt-disc-off")!.chain_handled_at).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("wave/track scope, claimed/stopped, malformed trigger, and invalid source skip", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "halt-wave",
        failureReason: "auth_failed",
        pipelineWaveId: "wave-1",
        pipelineTrackId: "track-1",
      });
      await env.chainRunner.handleTerminal("halt-wave", "failed");
      expect(
        eventsOfType(env.db, "halt-wave", "run.pipeline-halt-discovery-skipped")
      ).toEqual([expect.objectContaining({ code: "wave-scoped" })]);
      expect(
        eventsOfType(
          env.db,
          "halt-wave",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(0);

      seedFailedHalt(env.store, env.db, {
        id: "halt-claimed",
        failureReason: "auth_failed",
      });
      env.store.appendEvent("halt-claimed", "run.pipeline-halt-unrecovered", {
        action: "none",
        code: "not-safe-class",
        detail: "pre-seeded",
        observedReason: "auth_failed",
      });
      env.store.claimChainHandled("halt-claimed");
      const claimed = requestPipelineHaltDiscovery(
        env.store,
        "halt-claimed",
        true,
        () => {}
      );
      expect(claimed).toMatchObject({ kind: "skipped", code: "source-resolved" });

      seedFailedHalt(env.store, env.db, {
        id: "halt-stopped",
        failureReason: "auth_failed",
      });
      env.store.appendEvent("halt-stopped", "run.pipeline-halt-unrecovered", {
        action: "none",
        code: "not-safe-class",
        detail: "pre-seeded",
      });
      env.db
        .prepare(
          `UPDATE runs SET chain_stop_requested_at = datetime('now') WHERE id = ?`
        )
        .run("halt-stopped");
      const stopped = requestPipelineHaltDiscovery(
        env.store,
        "halt-stopped",
        true,
        () => {}
      );
      expect(stopped).toMatchObject({ kind: "skipped", code: "source-resolved" });

      seedFailedHalt(env.store, env.db, {
        id: "halt-malformed",
        failureReason: "auth_failed",
      });
      env.store.appendEvent("halt-malformed", "run.pipeline-halt-unrecovered", {
        action: "retry",
        code: "safe-class",
        detail: "bad",
      });
      const malformed = requestPipelineHaltDiscovery(
        env.store,
        "halt-malformed",
        true,
        () => {}
      );
      expect(malformed).toMatchObject({
        kind: "skipped",
        code: "invalid-trigger",
      });
      expect(
        eventsOfType(
          env.db,
          "halt-malformed",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(0);
      expect(readRun(env.db, "halt-malformed")!.chain_handled_at).toBeNull();

      seedFailedHalt(env.store, env.db, {
        id: "halt-ineligible",
        failureReason: "auth_failed",
        chainContext: null,
      });
      env.db
        .prepare(
          `UPDATE runs SET chain_root_run_id = NULL, chain_depth = NULL,
           chain_max_depth = NULL WHERE id = ?`
        )
        .run("halt-ineligible");
      env.store.appendEvent("halt-ineligible", "run.pipeline-halt-unrecovered", {
        action: "none",
        code: "not-safe-class",
        detail: "pre-seeded",
      });
      const ineligible = requestPipelineHaltDiscovery(
        env.store,
        "halt-ineligible",
        true,
        () => {}
      );
      expect(ineligible).toMatchObject({
        kind: "skipped",
        code: "ineligible-source",
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("startup discovers pre-seeded unrecovered; replay and overlap stay single-request", async () => {
    const env = await createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "startup-disc",
        failureReason: "auth_failed",
        withChainSkipped: true,
      });
      env.store.appendEvent("startup-disc", "run.pipeline-halt-unrecovered", {
        action: "none",
        code: "not-safe-class",
        detail: "pre-seeded unrecovered",
        observedReason: "auth_failed",
      });

      const first = await env.chainRunner.resumeHaltDiscovery();
      expect(first).toBe(1);
      expect(
        eventsOfType(
          env.db,
          "startup-disc",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(1);

      const second = await env.chainRunner.resumeHaltDiscovery();
      expect(second).toBe(0);
      expect(
        eventsOfType(
          env.db,
          "startup-disc",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(1);

      seedFailedHalt(env.store, env.db, {
        id: "overlap-disc",
        failureReason: "auth_failed",
        withChainSkipped: true,
      });
      env.store.appendEvent("overlap-disc", "run.pipeline-halt-unrecovered", {
        action: "none",
        code: "not-safe-class",
        detail: "overlap",
        observedReason: "auth_failed",
      });
      await Promise.all([
        env.chainRunner.resumeHaltDiscovery(),
        env.chainRunner.resumeHaltDiscovery(),
      ]);
      expect(
        eventsOfType(
          env.db,
          "overlap-disc",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(1);
      expect(readRun(env.db, "overlap-disc")!.chain_handled_at).toBeNull();

      // Live decline first, then a startup sweep over the same source.
      seedFailedHalt(env.store, env.db, {
        id: "live-then-startup",
        failureReason: "auth_failed",
      });
      await env.chainRunner.handleTerminal("live-then-startup", "failed");
      expect(
        eventsOfType(
          env.db,
          "live-then-startup",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(1);
      expect(await env.chainRunner.resumeHaltDiscovery()).toBe(0);
      expect(
        eventsOfType(
          env.db,
          "live-then-startup",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(1);
      expect(
        eventsOfType(
          env.db,
          "live-then-startup",
          "run.pipeline-halt-discovery-skipped"
        )
      ).toHaveLength(0);
      expect(readRun(env.db, "live-then-startup")!.chain_handled_at).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("prior requested/skipped/failed lifecycle events suppress another write", async () => {
    const env = await createEnv();
    try {
      for (const [id, eventType, payload] of [
        [
          "prior-req",
          "run.pipeline-halt-discovery-requested",
          {
            code: "unrecovered-halt",
            recoveryCode: "not-safe-class",
            recoveryDetail: "prior",
          },
        ],
        [
          "prior-skip",
          "run.pipeline-halt-discovery-skipped",
          { code: "disabled", detail: "prior" },
        ],
        [
          "prior-fail",
          "run.pipeline-halt-discovery-failed",
          {
            stage: "spawn",
            code: "test",
            detail: "prior failure",
          },
        ],
      ] as const) {
        seedFailedHalt(env.store, env.db, {
          id,
          failureReason: "auth_failed",
        });
        env.store.appendEvent(id, "run.pipeline-halt-unrecovered", {
          action: "none",
          code: "not-safe-class",
          detail: "pre-seeded",
        });
        env.store.appendEvent(id, eventType, payload);
        const result = requestPipelineHaltDiscovery(
          env.store,
          id,
          true,
          () => {}
        );
        expect(result).toEqual({ kind: "already-recorded" });
        expect(
          eventsOfType(env.db, id, "run.pipeline-halt-discovery-requested")
            .length +
            eventsOfType(env.db, id, "run.pipeline-halt-discovery-skipped")
              .length +
            eventsOfType(env.db, id, "run.pipeline-halt-discovery-failed").length
        ).toBe(1);
      }
    } finally {
      await destroyEnv(env);
    }
  });

  it("discovery trigger failures are isolated from b43 declined callback", async () => {
    const decisions: Array<{ runId: string; kind: string }> = [];
    const env = await createEnv({
      onHaltRecoveryDecision: (runId, result) => {
        decisions.push({ runId, kind: result.kind });
      },
    });
    try {
      const original = env.store.appendEvent.bind(env.store);
      vi.spyOn(env.store, "appendEvent").mockImplementation(
        (runId, eventType, payload) => {
          if (eventType === "run.pipeline-halt-discovery-requested") {
            throw new Error("discovery write boom");
          }
          return original(runId, eventType, payload);
        }
      );

      seedFailedHalt(env.store, env.db, {
        id: "halt-iso",
        failureReason: "auth_failed",
      });
      await env.chainRunner.handleTerminal("halt-iso", "failed");

      expect(decisions).toEqual([{ runId: "halt-iso", kind: "declined" }]);
      expect(
        eventsOfType(env.db, "halt-iso", "run.pipeline-halt-unrecovered")
      ).toHaveLength(1);
      expect(
        eventsOfType(
          env.db,
          "halt-iso",
          "run.pipeline-halt-discovery-requested"
        )
      ).toHaveLength(0);
      expect(readRun(env.db, "halt-iso")!.chain_handled_at).toBeNull();
      expect(readRun(env.db, "halt-iso")!.status).toBe("failed");
    } finally {
      await destroyEnv(env);
    }
  });

  it("settings default on, YAML accept, and LCA_PIPELINE_HALT_DISCOVERY kill switch", async () => {
    expect(DEFAULT_SETTINGS.pipelineHaltDiscovery).toBe(true);

    const { settingsSchema } = await import("@lca/shared");
    const parsed = settingsSchema.parse({
      pipelineHaltDiscovery: false,
      maxConcurrentRuns: 3,
    });
    expect(parsed.pipelineHaltDiscovery).toBe(false);
    expect(
      settingsSchema.safeParse({ pipelineHaltDiscovery: "yes" }).success
    ).toBe(false);

    const home = mkdtempSync(join(tmpdir(), "lca-b44-settings-"));
    try {
      const cfgDir = join(home, ".cursor-local-automations");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, "automations.yaml"),
        ["settings:", "  pipelineHaltDiscovery: true", ""].join("\n"),
        "utf8"
      );

      vi.resetModules();
      vi.doMock("node:os", async () => {
        const actual =
          await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => home };
      });
      process.env.LCA_PIPELINE_HALT_DISCOVERY = "0";
      const { loadSettings } = await import(
        "../packages/daemon/src/config/settings.ts"
      );
      expect(loadSettings().pipelineHaltDiscovery).toBe(false);

      delete process.env.LCA_PIPELINE_HALT_DISCOVERY;
      vi.resetModules();
      vi.doMock("node:os", async () => {
        const actual =
          await vi.importActual<typeof import("node:os")>("node:os");
        return { ...actual, homedir: () => home };
      });
      const { loadSettings: loadSettings2 } = await import(
        "../packages/daemon/src/config/settings.ts"
      );
      expect(loadSettings2().pipelineHaltDiscovery).toBe(true);
    } finally {
      delete process.env.LCA_PIPELINE_HALT_DISCOVERY;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
