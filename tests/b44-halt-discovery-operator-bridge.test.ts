import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext, RunStatus } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  HALT_DISCOVERY_INPUT_KIND,
  RUN_ESCALATION_ACTIONS,
  type RunEscalationAction,
} from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { provisionGeneratedWorkers } from "../packages/daemon/src/config/generated-workers.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
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
  orchestrateHaltDiscoveryAdvisory,
  reconcileHaltDiscoveryAdvisoryTerminal,
} from "../packages/daemon/src/runs/halt-discovery-orchestrator.ts";
import { isParkedAuthoritativeHaltDiscoveryBriefing } from "../packages/daemon/src/runs/halt-discovery-operator-bridge.ts";
import { presentCompletedHaltDiscoveryAdvisory } from "../packages/daemon/src/runs/halt-discovery-presentation.ts";
import type { PipelineWaveCoordinator } from "../packages/daemon/src/runs/pipeline-wave-coordinator.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b44",
    featureSlug: "b44-halt-discovery-agent",
    featureDir: "docs/roadmap/done/b44-halt-discovery-agent",
    featureIndex: "docs/roadmap/done/b44-halt-discovery-agent/00-index.md",
    idea: "halt discovery operator bridge",
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

function stubExecutor(opts?: {
  onResume?: (runId: string) => void;
  followUpMessages?: string[];
}): Executor {
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
    resume: async (params) => {
      opts?.onResume?.(params.runId);
      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: params.agentId,
        sdkRunId: params.sdkRunId,
        async *stream() {},
        wait: async () => ({ status: "finished", result: "ok" }) as never,
        cancel: async () => {},
        dispose: async () => {},
        sendFollowUp: async (message: string) => {
          opts?.followUpMessages?.push(message);
          return {
            kind: "sdk-local",
            agentId: params.agentId,
            sdkRunId: params.sdkRunId,
            async *stream() {},
            wait: async () => ({ status: "finished", result: "ok" }) as never,
            cancel: async () => {},
            dispose: async () => {},
          };
        },
      };
      return activeRun;
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
  resumeCalls: string[];
  followUpMessages: string[];
  pendingAnswers: string[];
};

function createEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "lca-b44-op-bridge-"));
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
    resumeCalls: [],
    followUpMessages: [],
    pendingAnswers: [],
  };

  const executor = stubExecutor({
    onResume: (runId) => env.resumeCalls.push(runId),
    followUpMessages: env.followUpMessages,
  });

  env.inputHub = new InputHub(inputStore, {
    onNeedsInput: (runId) => {
      const row = store.getRun(runId);
      if (row?.status === "running") {
        store.setStatus(runId, "needs_input");
      }
    },
    onAnswered: (runId, request) => {
      const meta = parseInputMetadataJson(request.metadata_json);
      if (meta?.kind === HALT_DISCOVERY_INPUT_KIND) {
        return;
      }
      const row = store.getRun(runId);
      if (row?.status === "needs_input") {
        store.setStatus(runId, "running");
      }
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
    handleTerminalHook: async () => ({ handled: false }),
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
    prompt?: string;
  }
): void {
  const id = opts.id;
  const rootId = opts.rootId ?? "root-1";
  store.insertRun({
    id,
    automationId: "ws::review",
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: opts.prompt ?? "Review prompt stored",
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
    agentId?: string;
    sdkRunId?: string;
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
  if (opts.agentId && opts.sdkRunId) {
    env.store.setAgentIds(opts.childId, opts.agentId, opts.sdkRunId);
  }
}

function fence(body: string): string {
  return `\`\`\`text\n${body.trimEnd()}\n\`\`\``;
}

function validPacket(recommendation: string = "retry"): string {
  const lines = [
    "lca-halt-discovery",
    "version: 1",
    "summary: Diagnosis summary",
    "likely-cause: Likely cause one-liner",
    "partial-work: partial",
    "evidence:",
    "- run abc failed with sdk_error",
    `recommendation: ${recommendation}`,
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

async function presentBriefing(
  env: Env,
  opts: {
    sourceId: string;
    advisoryId: string;
    recommendation?: string;
    agentId?: string;
    sdkRunId?: string;
  }
): Promise<void> {
  seedFailedHalt(env.store, env.db, { id: opts.sourceId });
  appendRequested(env.store, opts.sourceId);
  seedAdvisoryChild(env, {
    sourceId: opts.sourceId,
    childId: opts.advisoryId,
    agentId: opts.agentId,
    sdkRunId: opts.sdkRunId,
  });
  appendFinishedResult(
    env.store,
    opts.advisoryId,
    validPacket(opts.recommendation ?? "retry")
  );
  await env.chainRunner.handleTerminal(opts.advisoryId, "completed");
  expect(env.store.getRun(opts.advisoryId)?.status).toBe("needs_input");
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

function sourceAuthoritySnapshot(db: Db, id: string) {
  return db
    .prepare(
      `SELECT status, chain_handled_at, chain_stop_requested_at,
              chain_max_depth, chain_max_depth_override, chain_depth,
              chain_root_run_id, parent_run_id
       FROM runs WHERE id = ?`
    )
    .get(id);
}

describe("b44 halt-discovery operator action bridge", () => {
  it.each(RUN_ESCALATION_ACTIONS)(
    "answers %s once as operator, closes advisory, no follow-up",
    async (action: RunEscalationAction) => {
      const env = createEnv();
      try {
        await presentBriefing(env, {
          sourceId: `src-${action}`,
          advisoryId: `adv-${action}`,
          recommendation: action === "abort" ? "retry" : action,
        });

        await env.engine.submitAnswer(`adv-${action}`, action);

        const advisory = env.store.getRun(`adv-${action}`);
        expect(advisory?.status).toBe("completed");
        const cards = env.inputHub.listForRun(`adv-${action}`);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.status).toBe("answered");
        expect(cards[0]!.answer).toBe(action);

        const escalated = eventsOfType(
          env.db,
          `src-${action}`,
          "run.pipeline-escalated"
        );
        expect(escalated).toHaveLength(1);
        expect(escalated[0]).toMatchObject({
          action,
          actor: "operator",
        });

        const results = eventsOfType(
          env.db,
          `adv-${action}`,
          "run.pipeline-halt-discovery-action-result"
        );
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          sourceRunId: `src-${action}`,
          advisoryRunId: `adv-${action}`,
          action,
          outcome: "acted",
        });
        if (action === "abort") {
          expect(results[0]!.childRunId).toBeUndefined();
          expect(
            env.store.getRun(`src-${action}`)?.chain_stop_requested_at
          ).toBeTruthy();
        } else {
          expect(typeof results[0]!.childRunId).toBe("string");
        }

        expect(env.followUpMessages).toHaveLength(0);
        expect(env.inputHub.hasActiveWaiter(`adv-${action}`)).toBe(false);
      } finally {
        await destroyEnv(env);
      }
    }
  );

  it("records refusal and closes when direct escalation already claimed", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-race",
        advisoryId: "adv-race",
      });
      const before = sourceAuthoritySnapshot(env.db, "src-race");

      const direct = await env.engine.escalateRun(
        "src-race",
        { action: "retry", reason: "operator direct" },
        { actor: "operator" }
      );
      expect(direct.ok).toBe(true);
      const winnerHandled = env.store.getRun("src-race")?.chain_handled_at;
      expect(winnerHandled).toBeTruthy();

      await env.engine.submitAnswer("adv-race", "skip");

      expect(env.store.getRun("adv-race")?.status).toBe("completed");
      const results = eventsOfType(
        env.db,
        "adv-race",
        "run.pipeline-halt-discovery-action-result"
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: "refused",
        code: "already-chained",
        action: "skip",
      });

      const escalated = eventsOfType(
        env.db,
        "src-race",
        "run.pipeline-escalated"
      );
      expect(escalated).toHaveLength(1);
      expect(escalated[0]).toMatchObject({
        action: "retry",
        actor: "operator",
      });
      expect(env.store.getRun("src-race")?.chain_handled_at).toBe(winnerHandled);
      expect(sourceAuthoritySnapshot(env.db, "src-race")).toMatchObject({
        chain_handled_at: winnerHandled,
        status: before.status,
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("duplicate and concurrent answers cannot act twice", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-dup",
        advisoryId: "adv-dup",
      });

      const [first, second] = await Promise.allSettled([
        env.engine.submitAnswer("adv-dup", "retry"),
        env.engine.submitAnswer("adv-dup", "retry"),
      ]);
      const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
      const rejected = [first, second].filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      await expect(env.engine.submitAnswer("adv-dup", "retry")).rejects.toThrow(
        /not awaiting input|No pending input request/
      );

      const results = eventsOfType(
        env.db,
        "adv-dup",
        "run.pipeline-halt-discovery-action-result"
      );
      expect(results).toHaveLength(1);
      const escalated = eventsOfType(
        env.db,
        "src-dup",
        "run.pipeline-escalated"
      );
      expect(escalated).toHaveLength(1);
      expect(env.store.getRun("adv-dup")?.status).toBe("completed");
    } finally {
      await destroyEnv(env);
    }
  });

  it("rejects non-authoritative duplicate and wrong-kind without escalating", async () => {
    const env = createEnv();
    try {
      seedFailedHalt(env.store, env.db, { id: "src-auth" });
      appendRequested(env.store, "src-auth");
      seedAdvisoryChild(env, {
        sourceId: "src-auth",
        childId: "adv-auth",
        createdAt: "2026-01-01 00:00:00",
      });
      seedAdvisoryChild(env, {
        sourceId: "src-auth",
        childId: "adv-dup-child",
        createdAt: "2026-01-01 00:00:01",
      });
      env.store.setStatus("adv-dup-child", "needs_input");
      env.inputHub.presentWithoutWait("adv-dup-child", "stale card", {
        kind: HALT_DISCOVERY_INPUT_KIND,
        choices: [
          { id: "retry", label: "Retry" },
          { id: "skip", label: "Skip" },
          { id: "abort", label: "Abort" },
        ],
        recommendedChoiceId: "retry",
      });

      await expect(
        env.engine.submitAnswer("adv-dup-child", "retry")
      ).rejects.toThrow(/not authoritative/);
      expect(
        eventsOfType(env.db, "src-auth", "run.pipeline-escalated")
      ).toHaveLength(0);

      // Wrong-kind pending on a normal needs_input run uses the generic path.
      env.store.insertRun({
        id: "generic-run",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "generic",
      });
      env.store.setStatus("generic-run", "needs_input");
      const asked = env.inputStore.insertPending("generic-run", "Pick?", {
        kind: "approval",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "abort", label: "Abort" },
        ],
      });
      expect(asked.status).toBe("pending");
      await env.engine.submitAnswer("generic-run", "approve");
      expect(env.store.getRun("generic-run")?.status).toBe("running");
      expect(
        eventsOfType(env.db, "generic-run", "run.pipeline-halt-discovery-action-result")
      ).toHaveLength(0);

      // Malformed metadata degrades to absent metadata → generic path.
      env.store.insertRun({
        id: "malformed-run",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "malformed",
      });
      env.store.setStatus("malformed-run", "needs_input");
      const malformed = env.inputStore.insertPending("malformed-run", "Pick?");
      env.db
        .prepare(`UPDATE input_requests SET metadata_json = ? WHERE id = ?`)
        .run("{not-json", malformed.id);
      await env.engine.submitAnswer("malformed-run", "retry");
      expect(env.store.getRun("malformed-run")?.status).toBe("running");
      expect(
        eventsOfType(
          env.db,
          "malformed-run",
          "run.pipeline-halt-discovery-action-result"
        )
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("records internal-failure and closes when escalation throws", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-boom",
        advisoryId: "adv-boom",
      });
      const before = sourceAuthoritySnapshot(env.db, "src-boom");

      vi.spyOn(env.engine, "escalateRun").mockRejectedValueOnce(
        new Error("injected effect failure")
      );

      await env.engine.submitAnswer("adv-boom", "retry");

      expect(env.store.getRun("adv-boom")?.status).toBe("completed");
      const results = eventsOfType(
        env.db,
        "adv-boom",
        "run.pipeline-halt-discovery-action-result"
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: "internal-failure",
        code: "effect-stage-error",
        action: "retry",
      });
      expect(String(results[0]!.detail)).toMatch(/injected effect failure/);
      expect(sourceAuthoritySnapshot(env.db, "src-boom")).toEqual(before);
      expect(
        eventsOfType(env.db, "src-boom", "run.pipeline-escalated")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("parks authoritative briefing on resume but keeps diagnosis and generic needs_input", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-park",
        advisoryId: "adv-park",
        agentId: "agent-park",
        sdkRunId: "sdk-park",
      });
      expect(env.store.getRun("adv-park")?.agent_id).toBe("agent-park");

      // Separate source: running halt-discovery diagnosis (no pending briefing).
      seedFailedHalt(env.store, env.db, { id: "src-diag" });
      appendRequested(env.store, "src-diag");
      seedAdvisoryChild(env, {
        sourceId: "src-diag",
        childId: "adv-running",
        status: "running",
        agentId: "agent-running",
        sdkRunId: "sdk-running",
      });

      env.store.insertRun({
        id: "generic-ni",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "generic needs input",
      });
      env.store.setStatus("generic-ni", "needs_input");
      env.store.setAgentIds("generic-ni", "agent-generic", "sdk-generic");
      env.inputStore.insertPending("generic-ni", "Continue?");

      expect(
        isParkedAuthoritativeHaltDiscoveryBriefing(
          env.store,
          env.inputHub,
          "adv-park"
        )
      ).toBe(true);
      expect(
        isParkedAuthoritativeHaltDiscoveryBriefing(
          env.store,
          env.inputHub,
          "adv-running"
        )
      ).toBe(false);
      expect(
        isParkedAuthoritativeHaltDiscoveryBriefing(
          env.store,
          env.inputHub,
          "generic-ni"
        )
      ).toBe(false);

      const resumable = env.store.listResumableRuns().map((r) => r.id);
      expect(resumable).toEqual(
        expect.arrayContaining(["adv-park", "adv-running", "generic-ni"])
      );
      const selected = resumable.filter(
        (id) =>
          !isParkedAuthoritativeHaltDiscoveryBriefing(
            env.store,
            env.inputHub,
            id
          )
      );
      expect(selected.sort()).toEqual(["adv-running", "generic-ni"].sort());

      // Live engine path: park skip + running diagnosis still re-attaches.
      // Leave generic needs_input out of listResumableRuns for this call so
      // shutdown is not blocked on an unanswered resumed ask.
      env.db
        .prepare(`UPDATE runs SET agent_id = NULL, sdk_run_id = NULL WHERE id = ?`)
        .run("generic-ni");
      env.resumeCalls.length = 0;
      await env.engine.resumeInterruptedRuns();
      await new Promise((r) => setTimeout(r, 30));
      expect(env.resumeCalls).not.toContain("adv-park");
      expect(env.resumeCalls).toContain("adv-running");
      expect(env.store.getRun("adv-park")?.status).toBe("needs_input");
      expect(
        env.inputHub.getPendingQuestion("adv-park")?.status
      ).toBe("pending");
    } finally {
      await destroyEnv(env);
    }
  });

  it("awaits HTTP answer for halt-discovery and preserves generic answer body", async () => {
    const env = createEnv();
    const chatEngine = new ChatEngine(env.db, {
      apiKey: "test",
      executor: stubExecutor(),
      events: env.events,
    });
    const port = await freeListenPort();
    const triggers = new TriggerManager(env.db, env.engine, { port });
    const http = await startHttpServer({
      engine: env.engine,
      chatEngine,
      store: new DashboardStore(env.db),
      db: env.db,
      events: env.events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      triggers,
    });

    try {
      await presentBriefing(env, {
        sourceId: "src-http",
        advisoryId: "adv-http",
      });

      const res = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent("adv-http")}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "skip" }),
        }
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(env.store.getRun("adv-http")?.status).toBe("completed");
      expect(
        eventsOfType(env.db, "adv-http", "run.pipeline-halt-discovery-action-result")
      ).toHaveLength(1);

      // Generic free-form answer still returns { ok: true }.
      env.store.insertRun({
        id: "http-generic",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "generic",
      });
      env.store.setStatus("http-generic", "needs_input");
      env.inputStore.insertPending("http-generic", "Thoughts?");
      const generic = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent("http-generic")}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "ship it" }),
        }
      );
      expect(generic.status).toBe(200);
      expect(await generic.json()).toEqual({ ok: true });
      expect(env.store.getRun("http-generic")?.status).toBe("running");
    } finally {
      await http.close();
      await chatEngine.shutdown();
      await destroyEnv(env);
    }
  });

  it("generic structured and free-form answers keep waiter / follow-up behavior", async () => {
    const env = createEnv();
    try {
      env.store.insertRun({
        id: "waiter-run",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "ask",
      });
      env.store.setStatus("waiter-run", "running");

      const answerPromise = env.inputHub.ask("waiter-run", "Which?", {
        kind: "approval",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "abort", label: "Abort" },
        ],
        recommendedChoiceId: "approve",
      });
      expect(env.store.getRun("waiter-run")?.status).toBe("needs_input");

      await expect(
        env.engine.submitAnswer("waiter-run", "Approve")
      ).rejects.toThrow(/declared choice ids/);
      await env.engine.submitAnswer("waiter-run", "approve");
      await expect(answerPromise).resolves.toBe("approve");
      expect(env.store.getRun("waiter-run")?.status).toBe("running");

      // No-waiter free-form → pendingAnswers for later delivery.
      env.store.insertRun({
        id: "pending-run",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "pending",
      });
      env.store.setStatus("pending-run", "needs_input");
      env.inputStore.insertPending("pending-run", "Free form?");
      await env.engine.submitAnswer("pending-run", "later please");
      expect(env.store.getRun("pending-run")?.status).toBe("running");
      const internals = env.engine as unknown as {
        pendingAnswers: Map<string, string>;
      };
      expect(internals.pendingAnswers.get("pending-run")).toBe("later please");
    } finally {
      await destroyEnv(env);
    }
  });
});
