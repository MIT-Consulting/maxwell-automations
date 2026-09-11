import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext, RunStatus } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  HALT_DISCOVERY_INPUT_KIND,
  RUN_ESCALATION_ACTIONS,
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
import {
  InputStore,
  parseInputMetadataJson,
} from "../packages/daemon/src/input/store.ts";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
  HALT_DISCOVERY_WORKERS,
} from "../packages/daemon/src/pipelines/halt-discovery.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import {
  HALT_DISCOVERY_PACKET_MAX_BYTES,
} from "../packages/daemon/src/runs/halt-discovery-briefing.ts";
import {
  orchestrateHaltDiscoveryAdvisory,
  reconcileHaltDiscoveryAdvisoryTerminal,
} from "../packages/daemon/src/runs/halt-discovery-orchestrator.ts";
import { presentCompletedHaltDiscoveryAdvisory } from "../packages/daemon/src/runs/halt-discovery-presentation.ts";
import type { PipelineWaveCoordinator } from "../packages/daemon/src/runs/pipeline-wave-coordinator.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b44",
    featureSlug: "b44-halt-discovery-agent",
    featureDir: "docs/roadmap/done/b44-halt-discovery-agent",
    featureIndex: "docs/roadmap/done/b44-halt-discovery-agent/00-index.md",
    idea: "halt discovery presentation",
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
  insertAutomation(db, {
    id: "ws::docs",
    configKey: "generated:docs-commit",
    name: "Docs",
    prompt: "Docs {{featureId}}",
    modelRole: "docs",
  });
}

type Env = {
  root: string;
  workspace: string;
  db: Db;
  store: RunStore;
  engine: RunEngine;
  events: DaemonEventBus;
  inputHub: InputHub;
  inputStore: InputStore;
  chainRunner: ChainRunner;
  notifyCalls: Array<{ runId: string; question: string }>;
  resumeCalls: number;
  waveHookCalls: Array<{ runId: string; status: RunStatus }>;
};

function createEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "lca-b44-presentation-"));
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
  const inputStore = new InputStore(db);
  const env: Env = {
    root,
    workspace,
    db,
    store,
    engine: null as unknown as RunEngine,
    events,
    inputHub: null as unknown as InputHub,
    inputStore,
    chainRunner: null as unknown as ChainRunner,
    notifyCalls: [],
    resumeCalls: 0,
    waveHookCalls: [],
  };

  const executor = stubExecutor();
  const originalResume = executor.resume;
  executor.resume = async (...args) => {
    env.resumeCalls += 1;
    return originalResume.apply(executor, args);
  };

  env.inputHub = new InputHub(inputStore, {
    onNeedsInput: () => {},
    onAnswered: () => {},
    onNotify: (runId, question) => {
      env.notifyCalls.push({ runId, question });
    },
  });

  env.engine = new RunEngine(db, {
    apiKey: "test-key",
    executor,
    events,
    inputHub: env.inputHub,
    maxConcurrentRuns: 4,
  });

  const waveCoordinator = {
    handleTerminalHook: async (runId: string, status: RunStatus) => {
      env.waveHookCalls.push({ runId, status });
      return { handled: false };
    },
  } as unknown as PipelineWaveCoordinator;

  env.chainRunner = new ChainRunner({
    store,
    engine: env.engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: LOOKBACK_MS,
    pipelineAutoEscalate: true,
    pipelineHaltDiscovery: true,
    waveCoordinator,
    orchestrateHaltDiscoveryAdvisory: (sourceRunId) =>
      orchestrateHaltDiscoveryAdvisory({
        store,
        engine: env.engine,
        provisionWorkers: (workspaceId, workers) =>
          provisionGeneratedWorkers(db, workspaceId, [...workers], {
            prune: false,
          }),
        onLog: () => {},
        sourceRunId,
      }),
    reconcileHaltDiscoveryAdvisoryTerminal: (advisoryRunId, status) =>
      reconcileHaltDiscoveryAdvisoryTerminal({
        store,
        onLog: () => {},
        advisoryRunId,
        status,
      }),
    presentCompletedHaltDiscoveryAdvisory: (advisoryRunId) =>
      presentCompletedHaltDiscoveryAdvisory({
        store,
        inputHub: env.inputHub,
        onLog: () => {},
        advisoryRunId,
      }),
  });

  return env;
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function seedFailedHalt(
  store: RunStore,
  db: Db,
  opts: {
    id: string;
    depth?: number;
    maxDepth?: number;
    rootId?: string;
  }
): void {
  const id = opts.id;
  const rootId = opts.rootId ?? "root-1";
  store.insertRun({
    id,
    automationId: "ws::review",
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: "Review prompt stored",
    chainContext: CONTEXT,
    chainRootRunId: rootId,
    chainDepth: opts.depth ?? 2,
    chainMaxDepth: opts.maxDepth ?? 9,
  });
  store.setStatus(id, "failed");
  const endedAt = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  db.prepare(`UPDATE runs SET ended_at = ? WHERE id = ?`).run(endedAt, id);
  store.appendEvent(id, "run.error", {
    reason: "auth_failed",
    sdkStatus: "error",
  });
}

function appendRequested(store: RunStore, runId: string): void {
  store.appendEvent(runId, "run.pipeline-halt-unrecovered", {
    action: "none",
    code: "not-safe-class",
    detail: "Classifier declined auto-escalation",
    observedReason: "auth_failed",
  });
  store.appendEvent(runId, "run.pipeline-halt-discovery-requested", {
    code: "unrecovered-halt",
    recoveryCode: "not-safe-class",
    recoveryDetail: "Classifier declined auto-escalation",
    observedReason: "auth_failed",
  });
}

function ensureHaltDiscoveryAutomation(env: Env): string {
  const plan = provisionGeneratedWorkers(env.db, "ws", [
    ...HALT_DISCOVERY_WORKERS,
  ], { prune: false });
  expect(plan.applied).toBe(true);
  return automationId("ws", HALT_DISCOVERY_CONFIG_KEY);
}

function seedAdvisoryChild(
  env: Env,
  opts: {
    sourceId: string;
    childId: string;
    status?: RunStatus;
    createdAt?: string;
  }
): void {
  const autoId = ensureHaltDiscoveryAutomation(env);
  env.store.insertRun({
    id: opts.childId,
    automationId: autoId,
    workspaceId: "ws",
    triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
    prompt: "seeded advisory",
    parentRunId: opts.sourceId,
    chainContext: CONTEXT,
    chainRootRunId: "root-1",
    chainDepth: 2,
    chainMaxDepth: 9,
  });
  env.store.setStatus(opts.childId, opts.status ?? "completed");
  if (opts.createdAt) {
    env.db
      .prepare(`UPDATE runs SET created_at = ? WHERE id = ?`)
      .run(opts.createdAt, opts.childId);
  }
}

function fence(body: string): string {
  return `\`\`\`text\n${body.trimEnd()}\n\`\`\``;
}

function validPacket(overrides?: {
  recommendation?: string;
  summary?: string;
}): string {
  const lines = [
    "lca-halt-discovery",
    "version: 1",
    `summary: ${overrides?.summary ?? "Diagnosis summary"}`,
    "likely-cause: Likely cause one-liner",
    "partial-work: partial",
    "evidence:",
    "- run abc failed with sdk_error",
    `recommendation: ${overrides?.recommendation ?? "retry"}`,
    "alternatives:",
    "- none",
    "confidence: medium",
    "operator-notes: Uncertainty noted",
  ];
  return fence(lines.join("\n"));
}

function appendFinishedResult(
  store: RunStore,
  advisoryId: string,
  result: string
): void {
  store.appendEvent(advisoryId, "run.started", {});
  store.appendEvent(advisoryId, "run.finished", { result });
}

function sourceAuthoritySnapshot(db: Db, id: string) {
  return db
    .prepare(
      `SELECT status, chain_handled_at, chain_stop_requested_at,
              chain_max_depth, chain_max_depth_override, chain_depth,
              chain_root_run_id, parent_run_id, pipeline_wave_id,
              pipeline_track_id
       FROM runs WHERE id = ?`
    )
    .get(id);
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

function haltDiscoveryCards(env: Env, advisoryId: string) {
  return env.inputHub.listForRun(advisoryId).filter((row) => {
    const meta = parseInputMetadataJson(row.metadata_json);
    return meta?.kind === HALT_DISCOVERY_INPUT_KIND;
  });
}

describe("b44 completed-advisory briefing lifecycle", () => {
  it("presents one pending card, reopens needs_input, and never waits or resumes", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-ok" });
      appendRequested(env.store, "src-ok");
      seedAdvisoryChild(env, { sourceId: "src-ok", childId: "adv-ok" });
      appendFinishedResult(env.store, "adv-ok", validPacket());

      const before = sourceAuthoritySnapshot(env.db, "src-ok");
      const endedBefore = (
        env.db
          .prepare(`SELECT ended_at FROM runs WHERE id = ?`)
          .get("adv-ok") as { ended_at: string | null }
      ).ended_at;

      await env.chainRunner.handleTerminal("adv-ok", "completed");

      const cards = haltDiscoveryCards(env, "adv-ok");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.status).toBe("pending");
      const meta = parseInputMetadataJson(cards[0]!.metadata_json);
      expect(meta?.kind).toBe(HALT_DISCOVERY_INPUT_KIND);
      expect(meta?.choices?.map((c) => c.id).sort()).toEqual(
        [...RUN_ESCALATION_ACTIONS].sort()
      );
      expect(meta?.recommendedChoiceId).toBe("retry");

      const advisory = env.store.getRun("adv-ok");
      expect(advisory?.status).toBe("needs_input");
      const endedAfter = (
        env.db
          .prepare(`SELECT ended_at FROM runs WHERE id = ?`)
          .get("adv-ok") as { ended_at: string | null }
      ).ended_at;
      expect(endedAfter).toBe(endedBefore);

      expect(env.inputHub.hasActiveWaiter("adv-ok")).toBe(false);
      expect(env.resumeCalls).toBe(0);
      expect(env.notifyCalls).toHaveLength(1);
      expect(env.waveHookCalls).toEqual([]);
      expect(sourceAuthoritySnapshot(env.db, "src-ok")).toEqual(before);
      expect(
        eventsOfType(env.db, "src-ok", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(0);
      expect(
        eventsOfType(env.db, "src-ok", "run.pipeline-escalated")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("duplicate terminal delivery creates at most one card and one reopen", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-dup" });
      appendRequested(env.store, "src-dup");
      seedAdvisoryChild(env, { sourceId: "src-dup", childId: "adv-dup" });
      appendFinishedResult(env.store, "adv-dup", validPacket());

      await env.chainRunner.handleTerminal("adv-dup", "completed");
      await env.chainRunner.handleTerminal("adv-dup", "completed");

      expect(haltDiscoveryCards(env, "adv-dup")).toHaveLength(1);
      expect(env.notifyCalls).toHaveLength(1);
      expect(env.store.getRun("adv-dup")?.status).toBe("needs_input");
      expect(
        eventsOfType(env.db, "src-dup", "run.pipeline-halt-discovery-failed")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("restart-style replay with pending card repairs missed reopen", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-repair" });
      appendRequested(env.store, "src-repair");
      seedAdvisoryChild(env, {
        sourceId: "src-repair",
        childId: "adv-repair",
      });
      appendFinishedResult(env.store, "adv-repair", validPacket());

      const presented = presentCompletedHaltDiscoveryAdvisory({
        store: env.store,
        inputHub: env.inputHub,
        onLog: () => {},
        advisoryRunId: "adv-repair",
      });
      expect(presented.kind).toBe("presented");

      // Simulate missed reopen: force completed while pending card remains.
      env.db
        .prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`)
        .run("adv-repair");
      expect(env.store.getRun("adv-repair")?.status).toBe("completed");
      expect(haltDiscoveryCards(env, "adv-repair")).toHaveLength(1);

      const notifyBefore = env.notifyCalls.length;
      await env.chainRunner.handleTerminal("adv-repair", "completed");

      expect(haltDiscoveryCards(env, "adv-repair")).toHaveLength(1);
      expect(env.store.getRun("adv-repair")?.status).toBe("needs_input");
      expect(env.notifyCalls.length).toBe(notifyBefore);
      expect(env.inputHub.hasActiveWaiter("adv-repair")).toBe(false);
    } finally {
      await destroyEnv(env);
    }
  });

  it("answered history is a no-op that does not reopen", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-ans" });
      appendRequested(env.store, "src-ans");
      seedAdvisoryChild(env, { sourceId: "src-ans", childId: "adv-ans" });
      appendFinishedResult(env.store, "adv-ans", validPacket());

      await env.chainRunner.handleTerminal("adv-ans", "completed");
      expect(env.store.getRun("adv-ans")?.status).toBe("needs_input");

      env.inputHub.submitAnswer("adv-ans", "retry");
      // Phase 12 owns post-answer status; leave completed for history replay.
      env.db
        .prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`)
        .run("adv-ans");

      const cardsBefore = haltDiscoveryCards(env, "adv-ans");
      expect(cardsBefore).toHaveLength(1);
      expect(cardsBefore[0]!.status).toBe("answered");

      await env.chainRunner.handleTerminal("adv-ans", "completed");

      expect(haltDiscoveryCards(env, "adv-ans")).toHaveLength(1);
      expect(env.store.getRun("adv-ans")?.status).toBe("completed");
      expect(env.notifyCalls).toHaveLength(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("cancelled history is a no-op that does not reopen", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-can" });
      appendRequested(env.store, "src-can");
      seedAdvisoryChild(env, { sourceId: "src-can", childId: "adv-can" });
      appendFinishedResult(env.store, "adv-can", validPacket());

      await env.chainRunner.handleTerminal("adv-can", "completed");
      env.inputStore.cancelPendingForRun("adv-can");
      env.db
        .prepare(`UPDATE runs SET status = 'completed' WHERE id = ?`)
        .run("adv-can");

      await env.chainRunner.handleTerminal("adv-can", "completed");

      const cards = haltDiscoveryCards(env, "adv-can");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.status).toBe("cancelled");
      expect(env.store.getRun("adv-can")?.status).toBe("completed");
    } finally {
      await destroyEnv(env);
    }
  });

  it("superseded duplicate child never presents", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-super" });
      appendRequested(env.store, "src-super");
      seedAdvisoryChild(env, {
        sourceId: "src-super",
        childId: "adv-old",
        createdAt: "2026-01-01 00:00:00",
      });
      seedAdvisoryChild(env, {
        sourceId: "src-super",
        childId: "adv-new",
        createdAt: "2026-01-02 00:00:00",
      });
      appendFinishedResult(env.store, "adv-new", validPacket());
      const before = sourceAuthoritySnapshot(env.db, "src-super");

      await env.chainRunner.handleTerminal("adv-new", "completed");

      expect(haltDiscoveryCards(env, "adv-new")).toHaveLength(0);
      expect(env.store.getRun("adv-new")?.status).toBe("completed");
      expect(env.notifyCalls).toHaveLength(0);
      expect(sourceAuthoritySnapshot(env.db, "src-super")).toEqual(before);
    } finally {
      await destroyEnv(env);
    }
  });

  it("choices mirror current source eligibility", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, {
        id: "src-elig",
        depth: 0,
        maxDepth: 9,
        rootId: "src-elig",
      });
      appendRequested(env.store, "src-elig");
      seedAdvisoryChild(env, { sourceId: "src-elig", childId: "adv-elig" });
      appendFinishedResult(
        env.store,
        "adv-elig",
        validPacket({ recommendation: "retry" })
      );

      // Root cannot retry; skip/abort still eligible for failed pipeline halt.
      expect(env.store.getEscalationEligibility("src-elig", "retry").ok).toBe(
        false
      );
      expect(env.store.getEscalationEligibility("src-elig", "skip").ok).toBe(
        true
      );
      expect(env.store.getEscalationEligibility("src-elig", "abort").ok).toBe(
        true
      );

      await env.chainRunner.handleTerminal("adv-elig", "completed");

      const cards = haltDiscoveryCards(env, "adv-elig");
      expect(cards).toHaveLength(1);
      const meta = parseInputMetadataJson(cards[0]!.metadata_json);
      expect(meta?.choices?.map((c) => c.id).sort()).toEqual(["abort", "skip"]);
      expect(meta?.recommendedChoiceId).toBeUndefined();
    } finally {
      await destroyEnv(env);
    }
  });

  it.each([
    {
      name: "missing result",
      result: null as string | null,
      code: "missing-result",
    },
    {
      name: "malformed packet",
      result: "no fence here",
      code: "missing",
    },
    {
      name: "oversized packet",
      // Size check runs before field validation; pad the fenced body past 4 KiB.
      result: fence(
        `lca-halt-discovery\nversion: 1\n${"z".repeat(HALT_DISCOVERY_PACKET_MAX_BYTES)}`
      ),
      code: "too-large",
    },
  ])(
    "refusal ($name) records one briefing failure and leaves authority",
    async ({ result, code }) => {
      const env = createEnv();
      try {
        seedFailedHalt(env.store, env.db, { id: "src-ref" });
        appendRequested(env.store, "src-ref");
        seedAdvisoryChild(env, { sourceId: "src-ref", childId: "adv-ref" });
        if (result != null) {
          appendFinishedResult(env.store, "adv-ref", result);
        } else {
          env.store.appendEvent("adv-ref", "run.started", {});
          env.store.appendEvent("adv-ref", "run.finished", { result: null });
        }
        const before = sourceAuthoritySnapshot(env.db, "src-ref");

        await env.chainRunner.handleTerminal("adv-ref", "completed");
        await env.chainRunner.handleTerminal("adv-ref", "completed");

        expect(haltDiscoveryCards(env, "adv-ref")).toHaveLength(0);
        expect(env.store.getRun("adv-ref")?.status).toBe("completed");
        expect(env.notifyCalls).toHaveLength(0);
        expect(sourceAuthoritySnapshot(env.db, "src-ref")).toEqual(before);

        const failures = eventsOfType(
          env.db,
          "src-ref",
          "run.pipeline-halt-discovery-failed"
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]!.stage).toBe("briefing");
        expect(failures[0]!.code).toBe(code);
        expect(failures[0]!.advisoryRunId).toBe("adv-ref");
        expect(
          Buffer.byteLength(String(failures[0]!.detail), "utf8")
        ).toBeLessThanOrEqual(4096);
      } finally {
        await destroyEnv(env);
      }
    }
  );

  it("presentation conflict records one briefing failure without reopen", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-conf" });
      appendRequested(env.store, "src-conf");
      seedAdvisoryChild(env, { sourceId: "src-conf", childId: "adv-conf" });
      appendFinishedResult(env.store, "adv-conf", validPacket());

      env.inputStore.insertPending("adv-conf", "unrelated pending", {
        kind: "other-kind",
      });
      const before = sourceAuthoritySnapshot(env.db, "src-conf");

      await env.chainRunner.handleTerminal("adv-conf", "completed");
      await env.chainRunner.handleTerminal("adv-conf", "completed");

      expect(haltDiscoveryCards(env, "adv-conf")).toHaveLength(0);
      expect(env.store.getRun("adv-conf")?.status).toBe("completed");
      expect(sourceAuthoritySnapshot(env.db, "src-conf")).toEqual(before);

      const failures = eventsOfType(
        env.db,
        "src-conf",
        "run.pipeline-halt-discovery-failed"
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]!.stage).toBe("briefing");
      expect(failures[0]!.code).toBe("presentation-conflict");
    } finally {
      await destroyEnv(env);
    }
  });

  it("reopenCompletedHaltDiscoveryAdvisoryForInput is completed-only and preserves ended_at", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-reopen" });
      seedAdvisoryChild(env, {
        sourceId: "src-reopen",
        childId: "adv-reopen",
        status: "completed",
      });
      const ended = (
        env.db
          .prepare(`SELECT ended_at FROM runs WHERE id = ?`)
          .get("adv-reopen") as { ended_at: string | null }
      ).ended_at;
      expect(ended).not.toBeNull();

      expect(
        env.store.reopenCompletedHaltDiscoveryAdvisoryForInput("adv-reopen")
      ).toBe(true);
      expect(env.store.getRun("adv-reopen")?.status).toBe("needs_input");
      expect(
        (
          env.db
            .prepare(`SELECT ended_at FROM runs WHERE id = ?`)
            .get("adv-reopen") as { ended_at: string | null }
        ).ended_at
      ).toBe(ended);

      expect(
        env.store.reopenCompletedHaltDiscoveryAdvisoryForInput("adv-reopen")
      ).toBe(false);

      env.store.setStatus("adv-reopen", "failed");
      expect(
        env.store.reopenCompletedHaltDiscoveryAdvisoryForInput("adv-reopen")
      ).toBe(false);
    } finally {
      await destroyEnv(env);
    }
  });
});
