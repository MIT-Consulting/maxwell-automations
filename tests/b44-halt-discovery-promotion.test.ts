import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainRunContext, ChatSession, RunStatus } from "@lca/shared";
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
import {
  RunEngine,
  RunMessageError,
} from "../packages/daemon/src/runs/engine.ts";
import {
  orchestrateHaltDiscoveryAdvisory,
  reconcileHaltDiscoveryAdvisoryTerminal,
} from "../packages/daemon/src/runs/halt-discovery-orchestrator.ts";
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
    idea: "halt discovery promotion",
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
  disposeCalls?: string[];
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
        dispose: async () => {
          opts?.disposeCalls?.push(`spawn:${params.runId}`);
        },
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
        dispose: async () => {
          opts?.disposeCalls?.push(`resume:${params.runId}`);
        },
        sendFollowUp: async () => ({
          kind: "sdk-local",
          agentId: params.agentId,
          sdkRunId: params.sdkRunId,
          async *stream() {},
          wait: async () => ({ status: "finished", result: "ok" }) as never,
          cancel: async () => {},
          dispose: async () => {},
        }),
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
  chatEngine: ChatEngine;
  events: DaemonEventBus;
  inputHub: InputHub;
  inputStore: InputStore;
  chainRunner: ChainRunner;
  disposeCalls: string[];
};

function createEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "lca-b44-promo-"));
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
  const disposeCalls: string[] = [];
  const env: Env = {
    root,
    workspace,
    db,
    store,
    engine: null as unknown as RunEngine,
    chatEngine: null as unknown as ChatEngine,
    events,
    inputHub: null as unknown as InputHub,
    inputStore,
    chainRunner: null as unknown as ChainRunner,
    disposeCalls,
  };

  const executor = stubExecutor({ disposeCalls });

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
  env.chatEngine = new ChatEngine(db, {
    apiKey: "test-key",
    executor,
    events,
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
  await env.chatEngine.shutdown();
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
  store.appendEvent(advisoryId, "assistant", { text: "diagnosis notes" });
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
    agentId: opts.agentId ?? `agent-${opts.advisoryId}`,
    sdkRunId: opts.sdkRunId ?? `sdk-${opts.advisoryId}`,
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

function chatEventTypes(db: Db, chatId: string): string[] {
  return (
    db
      .prepare(
        `SELECT event_type FROM chat_events WHERE chat_id = ? ORDER BY seq`
      )
      .all(chatId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function chatCountForOrigin(db: Db, originRunId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM chat_sessions
       WHERE origin_run_id = ? AND archived_at IS NULL`
    )
    .get(originRunId) as { n: number };
  return row.n;
}

function seedRetained(env: Env, runId: string): { dispose: () => Promise<void> } {
  let disposed = false;
  const activeRun: ActiveRun = {
    kind: "sdk-local",
    agentId: `agent-${runId}`,
    sdkRunId: `sdk-${runId}`,
    async *stream() {},
    wait: async () => ({ status: "finished", result: "ok" }) as never,
    cancel: async () => {},
    dispose: async () => {
      disposed = true;
      env.disposeCalls.push(`retained:${runId}`);
    },
  };
  const internals = env.engine as unknown as {
    retainedRuns: Map<
      string,
      { activeRun: ActiveRun; runToken: string; retainedAt: number }
    >;
  };
  internals.retainedRuns.set(runId, {
    activeRun,
    runToken: "tok",
    retainedAt: Date.now(),
  });
  return {
    dispose: async () => {
      expect(disposed).toBe(true);
    },
  };
}

describe("b44 halt-discovery chat promotion", () => {
  it("promotes authoritative pending briefing into one linked chat", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-promo",
        advisoryId: "adv-promo",
        recommendation: "chat",
      });
      const sourceBefore = sourceAuthoritySnapshot(env.db, "src-promo");
      const pending = env.inputHub.getPendingQuestion("adv-promo");
      expect(pending?.status).toBe("pending");
      const retained = seedRetained(env, "adv-promo");

      const result = await env.engine.promoteHaltDiscoveryToChatIfApplicable(
        "adv-promo",
        env.chatEngine
      );
      expect(result?.kind).toBe("created");
      expect(result?.chat.origin_run_id).toBe("adv-promo");
      expect(result?.chat.agent_id).toBe("agent-adv-promo");
      expect(result?.chat.sdk_run_id).toBe("sdk-adv-promo");

      expect(env.store.getRun("adv-promo")?.status).toBe("completed");
      expect(env.inputHub.getPendingQuestion("adv-promo")).toBeUndefined();
      const cards = env.inputHub.listForRun("adv-promo");
      expect(cards).toHaveLength(1);
      expect(cards[0]!.status).toBe("cancelled");
      expect(cards[0]!.answer).toBeNull();

      const promoted = eventsOfType(
        env.db,
        "adv-promo",
        "run.pipeline-halt-discovery-promoted"
      );
      expect(promoted).toHaveLength(1);
      expect(promoted[0]).toMatchObject({
        sourceRunId: "src-promo",
        advisoryRunId: "adv-promo",
        chatId: result!.chat.id,
      });

      const types = chatEventTypes(env.db, result!.chat.id);
      expect(types[0]).toBe("chat.promoted_from_run");
      expect(types).toContain("run.started");
      expect(types).toContain("assistant");
      expect(types[types.length - 1]).toBe("chat.message");

      const promoPayload = JSON.parse(
        (
          env.db
            .prepare(
              `SELECT payload FROM chat_events
               WHERE chat_id = ? AND event_type = 'chat.promoted_from_run'`
            )
            .get(result!.chat.id) as { payload: string }
        ).payload
      ) as Record<string, unknown>;
      expect(promoPayload).toEqual({
        originRunId: "adv-promo",
        sourceRunId: "src-promo",
      });

      const seed = JSON.parse(
        (
          env.db
            .prepare(
              `SELECT payload FROM chat_events
               WHERE chat_id = ? AND event_type = 'chat.message'
               ORDER BY seq DESC LIMIT 1`
            )
            .get(result!.chat.id) as { payload: string }
        ).payload
      ) as { role: string; text: string };
      expect(seed.role).toBe("user");
      expect(seed.text).toContain("Halted source run: src-promo");
      expect(seed.text).toContain("Diagnosis summary");

      expect(sourceAuthoritySnapshot(env.db, "src-promo")).toEqual(sourceBefore);
      expect(
        eventsOfType(env.db, "src-promo", "run.pipeline-escalated")
      ).toHaveLength(0);
      expect(
        eventsOfType(
          env.db,
          "adv-promo",
          "run.pipeline-halt-discovery-action-result"
        )
      ).toHaveLength(0);

      await retained.dispose();
      expect(env.disposeCalls).toContain("retained:adv-promo");
    } finally {
      await destroyEnv(env);
    }
  });

  it("duplicate HTTP promotion returns one chat without reseeding", async () => {
    const env = createEnv();
    const port = await freeListenPort();
    const triggers = new TriggerManager(env.db, env.engine, { port });
    const http = await startHttpServer({
      engine: env.engine,
      chatEngine: env.chatEngine,
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
        sourceId: "src-dup",
        advisoryId: "adv-dup",
      });

      const first = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent("adv-dup")}/promote-to-chat`,
        { method: "POST" }
      );
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { chat: ChatSession };
      expect(firstBody.chat.originRunId).toBe("adv-dup");

      const second = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent("adv-dup")}/promote-to-chat`,
        { method: "POST" }
      );
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { chat: ChatSession };
      expect(secondBody.chat.id).toBe(firstBody.chat.id);
      expect(chatCountForOrigin(env.db, "adv-dup")).toBe(1);
      expect(
        eventsOfType(
          env.db,
          "adv-dup",
          "run.pipeline-halt-discovery-promoted"
        )
      ).toHaveLength(1);
      expect(
        chatEventTypes(env.db, firstBody.chat.id).filter(
          (t) => t === "chat.message"
        )
      ).toHaveLength(1);
    } finally {
      await http.close();
      await destroyEnv(env);
    }
  });

  it.each(RUN_ESCALATION_ACTIONS)(
    "promotion versus answer %s is first-claim-wins",
    async (action: RunEscalationAction) => {
      const env = createEnv();
      try {
        await presentBriefing(env, {
          sourceId: `src-race-${action}`,
          advisoryId: `adv-race-${action}`,
          recommendation: action === "abort" ? "retry" : action,
        });

        const [promoSettled, answerSettled] = await Promise.allSettled([
          env.engine.promoteHaltDiscoveryToChatIfApplicable(
            `adv-race-${action}`,
            env.chatEngine
          ),
          env.engine.submitAnswer(`adv-race-${action}`, action),
        ]);

        const promoOk = promoSettled.status === "fulfilled";
        const answerOk = answerSettled.status === "fulfilled";
        expect(promoOk !== answerOk).toBe(true);

        if (promoOk) {
          expect(promoSettled.value?.kind).toBe("created");
          expect(chatCountForOrigin(env.db, `adv-race-${action}`)).toBe(1);
          expect(
            eventsOfType(
              env.db,
              `adv-race-${action}`,
              "run.pipeline-halt-discovery-action-result"
            )
          ).toHaveLength(0);
          expect(
            eventsOfType(
              env.db,
              `src-race-${action}`,
              "run.pipeline-escalated"
            )
          ).toHaveLength(0);
          expect(
            env.inputHub.listForRun(`adv-race-${action}`)[0]!.status
          ).toBe("cancelled");
        } else {
          expect(chatCountForOrigin(env.db, `adv-race-${action}`)).toBe(0);
          expect(
            eventsOfType(
              env.db,
              `adv-race-${action}`,
              "run.pipeline-halt-discovery-promoted"
            )
          ).toHaveLength(0);
          expect(
            eventsOfType(
              env.db,
              `adv-race-${action}`,
              "run.pipeline-halt-discovery-action-result"
            )
          ).toHaveLength(1);
          expect(
            env.inputHub.listForRun(`adv-race-${action}`)[0]!.status
          ).toBe("answered");
        }
        expect(env.store.getRun(`adv-race-${action}`)?.status).toBe(
          "completed"
        );
      } finally {
        await destroyEnv(env);
      }
    }
  );

  it("answer-first then promotion conflicts with no chat", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-ans-first",
        advisoryId: "adv-ans-first",
      });
      await env.engine.submitAnswer("adv-ans-first", "skip");
      await expect(
        env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-ans-first",
          env.chatEngine
        )
      ).rejects.toThrow(RunMessageError);
      expect(chatCountForOrigin(env.db, "adv-ans-first")).toBe(0);
      expect(
        eventsOfType(
          env.db,
          "adv-ans-first",
          "run.pipeline-halt-discovery-promoted"
        )
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("promotion-first then answer fails without escalating", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-promo-first",
        advisoryId: "adv-promo-first",
      });
      const before = sourceAuthoritySnapshot(env.db, "src-promo-first");
      const result = await env.engine.promoteHaltDiscoveryToChatIfApplicable(
        "adv-promo-first",
        env.chatEngine
      );
      expect(result?.kind).toBe("created");
      await expect(
        env.engine.submitAnswer("adv-promo-first", "retry")
      ).rejects.toThrow(/not awaiting input|No pending input request/);
      expect(sourceAuthoritySnapshot(env.db, "src-promo-first")).toEqual(
        before
      );
      expect(
        eventsOfType(env.db, "src-promo-first", "run.pipeline-escalated")
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("forced transactional failure rolls back card, chat, event, and status", async () => {
    const env = createEnv();
    try {
      await presentBriefing(env, {
        sourceId: "src-rollback",
        advisoryId: "adv-rollback",
      });
      const beforeStatus = env.store.getRun("adv-rollback")?.status;
      const beforeCard = env.inputHub.getPendingQuestion("adv-rollback");
      expect(beforeCard?.status).toBe("pending");

      await expect(
        env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-rollback",
          env.chatEngine,
          {
            afterClaimHook: () => {
              throw new Error("forced promotion failure");
            },
          }
        )
      ).rejects.toThrow(/forced promotion failure/);

      expect(env.store.getRun("adv-rollback")?.status).toBe(beforeStatus);
      expect(env.inputHub.getPendingQuestion("adv-rollback")?.id).toBe(
        beforeCard!.id
      );
      expect(env.inputHub.getPendingQuestion("adv-rollback")?.status).toBe(
        "pending"
      );
      expect(chatCountForOrigin(env.db, "adv-rollback")).toBe(0);
      expect(
        eventsOfType(
          env.db,
          "adv-rollback",
          "run.pipeline-halt-discovery-promoted"
        )
      ).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("rejects ineligible advisories with no side effects", async () => {
    const env = createEnv();
    try {
      // Wrong-kind pending on a halt-discovery child (manual card).
      seedFailedHalt(env.store, env.db, { id: "src-wrong" });
      appendRequested(env.store, "src-wrong");
      seedAdvisoryChild(env, {
        sourceId: "src-wrong",
        childId: "adv-wrong-kind",
        status: "needs_input",
        agentId: "agent-wrong",
        sdkRunId: "sdk-wrong",
      });
      env.inputStore.insertPending("adv-wrong-kind", "generic?", {
        kind: "approval",
        choices: [{ id: "approve", label: "Approve" }],
      });
      await expect(
        env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-wrong-kind",
          env.chatEngine
        )
      ).rejects.toThrow(/not a halt-discovery briefing/);
      expect(chatCountForOrigin(env.db, "adv-wrong-kind")).toBe(0);

      // Generic needs_input — not applicable (null → HTTP falls through).
      env.store.insertRun({
        id: "generic-ni",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "generic",
      });
      env.store.setStatus("generic-ni", "needs_input");
      env.store.setAgentIds("generic-ni", "agent-g", "sdk-g");
      env.inputStore.insertPending("generic-ni", "Continue?");
      expect(
        await env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "generic-ni",
          env.chatEngine
        )
      ).toBeNull();

      // Superseded duplicate.
      seedFailedHalt(env.store, env.db, { id: "src-dup" });
      appendRequested(env.store, "src-dup");
      seedAdvisoryChild(env, {
        sourceId: "src-dup",
        childId: "adv-oldest",
        createdAt: "2026-01-01 00:00:00",
        agentId: "agent-old",
        sdkRunId: "sdk-old",
      });
      seedAdvisoryChild(env, {
        sourceId: "src-dup",
        childId: "adv-newer",
        createdAt: "2026-01-01 00:00:01",
        status: "needs_input",
        agentId: "agent-new",
        sdkRunId: "sdk-new",
      });
      env.inputHub.presentWithoutWait("adv-newer", "stale", {
        kind: HALT_DISCOVERY_INPUT_KIND,
        choices: [
          { id: "retry", label: "Retry" },
          { id: "skip", label: "Skip" },
          { id: "abort", label: "Abort" },
        ],
      });
      expect(
        await env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-newer",
          env.chatEngine
        )
      ).toBeNull();
      expect(chatCountForOrigin(env.db, "adv-newer")).toBe(0);

      // Missing session ids.
      await presentBriefing(env, {
        sourceId: "src-nosession",
        advisoryId: "adv-nosession",
      });
      env.db
        .prepare(
          `UPDATE runs SET agent_id = NULL, sdk_run_id = NULL WHERE id = ?`
        )
        .run("adv-nosession");
      await expect(
        env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-nosession",
          env.chatEngine
        )
      ).rejects.toThrow(/not resumable/);

      // Cloud agent.
      await presentBriefing(env, {
        sourceId: "src-cloud",
        advisoryId: "adv-cloud",
        agentId: "bc-cloud-1",
        sdkRunId: "sdk-cloud",
      });
      await expect(
        env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-cloud",
          env.chatEngine
        )
      ).rejects.toThrow(/not resumable/);

      // Terminal advisory without pending card.
      seedFailedHalt(env.store, env.db, { id: "src-term" });
      appendRequested(env.store, "src-term");
      seedAdvisoryChild(env, {
        sourceId: "src-term",
        childId: "adv-term",
        status: "failed",
        agentId: "agent-term",
        sdkRunId: "sdk-term",
      });
      await expect(
        env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-term",
          env.chatEngine
        )
      ).rejects.toThrow(/cannot be promoted while status is failed/);
      expect(chatCountForOrigin(env.db, "adv-term")).toBe(0);

      // Missing parent — not applicable.
      const autoId = ensureHaltDiscoveryAutomation(env);
      env.store.insertRun({
        id: "adv-orphan",
        automationId: autoId,
        workspaceId: "ws",
        triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
        prompt: "orphan",
      });
      env.store.setStatus("adv-orphan", "needs_input");
      env.store.setAgentIds("adv-orphan", "agent-orphan", "sdk-orphan");
      expect(
        await env.engine.promoteHaltDiscoveryToChatIfApplicable(
          "adv-orphan",
          env.chatEngine
        )
      ).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });

  it("preserves generic b28 terminal promotion and Input Hub answers", async () => {
    const env = createEnv();
    try {
      env.store.insertRun({
        id: "term-run",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "done",
      });
      env.store.setStatus("term-run", "completed");
      env.store.setAgentIds("term-run", "agent-term", "sdk-term");
      env.store.appendEvent("term-run", "assistant", { text: "prior" });

      const source = env.engine.prepareForPromotion("term-run");
      const chat = env.chatEngine.promoteFromRun({
        runId: "term-run",
        workspaceId: source.run.workspace_id,
        agentId: source.run.agent_id,
        sdkRunId: source.run.sdk_run_id,
        model: source.model,
        events: source.events,
      });
      expect(chat.origin_run_id).toBe("term-run");
      const promo = JSON.parse(
        (
          env.db
            .prepare(
              `SELECT payload FROM chat_events
               WHERE chat_id = ? AND event_type = 'chat.promoted_from_run'`
            )
            .get(chat.id) as { payload: string }
        ).payload
      ) as Record<string, unknown>;
      expect(promo).toEqual({ originRunId: "term-run" });
      expect(promo.sourceRunId).toBeUndefined();

      env.store.insertRun({
        id: "hub-run",
        automationId: "ws::review",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "ask",
      });
      env.store.setStatus("hub-run", "running");
      const answerPromise = env.inputHub.ask("hub-run", "Which?", {
        kind: "approval",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "abort", label: "Abort" },
        ],
      });
      await env.engine.submitAnswer("hub-run", "approve");
      await expect(answerPromise).resolves.toBe("approve");
      expect(env.store.getRun("hub-run")?.status).toBe("running");
    } finally {
      await destroyEnv(env);
    }
  });
});
