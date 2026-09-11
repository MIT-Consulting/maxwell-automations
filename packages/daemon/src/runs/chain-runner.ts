import type {
  ArchitectResolutionSource,
  ChainConfig,
  ChainRunContext,
  GatekeeperResolutionSource,
  ModelSelection,
  RunStatus,
} from "@lca/shared";
import {
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  KickoffError,
  normalizeImplementFullyChainVariables,
  PIPELINE_SKELETON_FALLBACK_ROLE,
  PIPELINE_SKELETON_ROLE,
  PIPELINE_TERMINAL_FALLBACK_ROLE,
  PIPELINE_TERMINAL_ROLE,
  resolveRoleSelectionWithFallback,
  workerKeyFromConfigKey,
} from "@lca/shared";
import { GENERATED_CONFIG_KEY_PREFIX } from "../config/generated-workers.js";
import type { DaemonEventBus } from "../events.js";
import type { RunEngine, TriggerRunOptions } from "./engine.js";
import {
  assertPromptWithinByteLimit,
  renderChainTemplate,
} from "./chain-template.js";
import {
  extractImplementFullyHandoff,
  handoffFallbackBody,
  isImplementFullyContext,
} from "./pipeline-handoff.js";
import {
  recoverPipelineHalt,
  type HaltRecoveryResult,
} from "./halt-recovery-runtime.js";
import {
  requestPipelineHaltDiscovery,
  type HaltDiscoveryTriggerResult,
} from "./halt-discovery-trigger.js";
import type {
  HaltDiscoveryOrchestrateResult,
  HaltDiscoveryTerminalReconcileResult,
} from "./halt-discovery-orchestrator.js";
import type { HaltDiscoveryPresentationResult } from "./halt-discovery-presentation.js";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
} from "../pipelines/halt-discovery.js";
import { resolveExecuteModeNext } from "../pipelines/implement-fully.js";
import type { PipelineWaveCoordinator } from "./pipeline-wave-coordinator.js";
import type { AutomationRow, RunRow, RunStore } from "./store.js";

const HALT_DISCOVERY_CONFIG_KEY =
  GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;

export type ChainRunnerOptions = {
  store: RunStore;
  engine: RunEngine;
  events: DaemonEventBus;
  onLog: (message: string) => void;
  maxDepth?: number;
  /** Boot-sweep lookback; `0` disables. Default 24h. */
  pipelineResumeLookbackMs?: number;
  /** Safe-halt auto-escalation. Default true. */
  pipelineAutoEscalate?: boolean;
  /** Max daemon escalations per lineage. Default 2. */
  pipelineAutoEscalateMaxPerPipeline?: number;
  /** Halt-discovery outbox after unrecovered declines. Default true. */
  pipelineHaltDiscovery?: boolean;
  waveCoordinator?: PipelineWaveCoordinator;
  /**
   * Fired only after a durable `acted` / `declined` recovery decision.
   * Must not throw into the recovery path — ChainRunner isolates sink errors.
   */
  onHaltRecoveryDecision?: (
    runId: string,
    result: HaltRecoveryResult
  ) => void;
  /**
   * Best-effort advisory enqueue after a durable discovery request.
   * Injected by the daemon composition root (Phase 8 core).
   */
  orchestrateHaltDiscoveryAdvisory?: (
    sourceRunId: string
  ) => Promise<HaltDiscoveryOrchestrateResult>;
  /**
   * Convert a terminal advisory into one source discovery-failed event.
   * Injected by the daemon composition root (Phase 9 reconciler).
   */
  reconcileHaltDiscoveryAdvisoryTerminal?: (
    advisoryRunId: string,
    status: RunStatus
  ) => HaltDiscoveryTerminalReconcileResult;
  /**
   * Present a completed authoritative advisory as a durable needs_input card.
   * Injected by the daemon composition root (Phase 11 presenter).
   */
  presentCompletedHaltDiscoveryAdvisory?: (
    advisoryRunId: string
  ) => HaltDiscoveryPresentationResult;
};

export function chainWhenMatches(
  status: RunStatus,
  when: ChainConfig["when"] | undefined
): boolean {
  const effective = when ?? "completed";
  if (effective === "always") {
    return status === "completed" || status === "failed";
  }
  if (effective === "failed") {
    return status === "failed";
  }
  return status === "completed";
}

export type PromptBuildResult =
  | { ok: true; promptOverride: string | undefined }
  | {
      ok: false;
      code: string;
      message: string;
      placeholder?: string;
    };

export function resolveChildModelRole(
  contextAware: boolean,
  chainContext: ChainRunContext | null,
  target: AutomationRow,
  onLog: (message: string) => void
): {
  modelRole: string | null;
  modelRoleResolved: boolean;
  modelSelectionOverride: ModelSelection | undefined;
  gatekeeperSource: GatekeeperResolutionSource | null;
  architectSource: ArchitectResolutionSource | null;
} {
  const modelRole =
    target.model_role && target.model_role.length > 0
      ? target.model_role
      : null;

  if (!contextAware || !chainContext || !modelRole) {
    return {
      modelRole,
      modelRoleResolved: false,
      modelSelectionOverride: undefined,
      gatekeeperSource: null,
      architectSource: null,
    };
  }

  if (modelRole === PIPELINE_TERMINAL_ROLE) {
    const resolved = resolveRoleSelectionWithFallback(
      chainContext.roleModels,
      PIPELINE_TERMINAL_ROLE,
      PIPELINE_TERMINAL_FALLBACK_ROLE
    );
    if (resolved) {
      if (resolved.source === "reviewer-fallback") {
        onLog(
          `Chain role "${modelRole}" on target ${target.id} missing from pipeline roleModels; falling back to reviewer selection`
        );
      }
      return {
        modelRole,
        modelRoleResolved: true,
        modelSelectionOverride: resolved.selection,
        gatekeeperSource: resolved.source as GatekeeperResolutionSource,
        architectSource: null,
      };
    }
    onLog(
      `Chain role "${modelRole}" on target ${target.id} not found in pipeline roleModels; using target automation model`
    );
    return {
      modelRole,
      modelRoleResolved: false,
      modelSelectionOverride: undefined,
      gatekeeperSource: null,
      architectSource: null,
    };
  }

  if (modelRole === PIPELINE_SKELETON_ROLE) {
    const resolved = resolveRoleSelectionWithFallback(
      chainContext.roleModels,
      PIPELINE_SKELETON_ROLE,
      PIPELINE_SKELETON_FALLBACK_ROLE
    );
    if (resolved) {
      if (resolved.source === "planner-fallback") {
        onLog(
          `Chain role "${modelRole}" on target ${target.id} missing from pipeline roleModels; falling back to planner selection`
        );
      }
      return {
        modelRole,
        modelRoleResolved: true,
        modelSelectionOverride: resolved.selection,
        gatekeeperSource: null,
        architectSource: resolved.source as ArchitectResolutionSource,
      };
    }
    onLog(
      `Chain role "${modelRole}" on target ${target.id} not found in pipeline roleModels; using target automation model`
    );
    return {
      modelRole,
      modelRoleResolved: false,
      modelSelectionOverride: undefined,
      gatekeeperSource: null,
      architectSource: null,
    };
  }

  if (Object.hasOwn(chainContext.roleModels, modelRole)) {
    const selection = chainContext.roleModels[modelRole]!;
    return {
      modelRole,
      modelRoleResolved: true,
      modelSelectionOverride: selection,
      gatekeeperSource: null,
      architectSource: null,
    };
  }

  onLog(
    `Chain role "${modelRole}" on target ${target.id} not found in pipeline roleModels; using target automation model`
  );
  return {
    modelRole,
    modelRoleResolved: false,
    modelSelectionOverride: undefined,
    gatekeeperSource: null,
    architectSource: null,
  };
}

export function readFinishedResultText(
  store: RunStore,
  sourceRunId: string
): string | null {
  const events = store.listRunEvents(sourceRunId);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.event_type !== "run.finished") {
      continue;
    }
    const payload = JSON.parse(event.payload) as { result?: string | null };
    return payload.result ?? null;
  }
  return null;
}

export function buildChainedPromptOverride(
  store: RunStore,
  sourceRunId: string,
  status: RunStatus,
  sourceAutomationName: string,
  target: AutomationRow,
  passResult: boolean,
  chainContext: ChainRunContext | null,
  onLog: (message: string) => void,
  options?: {
    sourceWorkerKey?: string | null;
  }
): PromptBuildResult {
  let basePrompt = target.prompt;
  if (chainContext) {
    const rendered = renderChainTemplate(target.prompt, chainContext.variables);
    if (!rendered.ok) {
      return {
        ok: false,
        code: rendered.code,
        message: rendered.message,
        placeholder: rendered.placeholder,
      };
    }
    basePrompt = rendered.text;
  }

  if (!passResult) {
    // Context-aware children still need the rendered target prompt persisted.
    return {
      ok: true,
      promptOverride: chainContext ? basePrompt : undefined,
    };
  }

  let resultText: string | null = null;
  try {
    resultText = readFinishedResultText(store, sourceRunId);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    onLog(
      `Chain passResult: could not read run.finished for ${sourceRunId}: ${text}`
    );
    return {
      ok: true,
      promptOverride: chainContext ? basePrompt : undefined,
    };
  }

  const pipelineId =
    typeof chainContext?.variables.pipelineId === "string"
      ? chainContext.variables.pipelineId
      : null;
  const implementFully = isImplementFullyContext(pipelineId);

  let body: string;
  if (implementFully) {
    const extracted = extractImplementFullyHandoff(resultText, {
      expectedWorker: options?.sourceWorkerKey,
      expectedPipeline: IMPLEMENT_FULLY_PIPELINE_ID,
    });
    if (extracted.ok) {
      body = extracted.packet.rawFenced;
    } else {
      onLog(
        `Chain passResult: implement-fully handoff refused (${extracted.code}) for ${sourceRunId}: ${extracted.detail}`
      );
      body = handoffFallbackBody(sourceRunId, extracted.code);
    }
  } else {
    body =
      resultText && resultText.trim().length > 0
        ? resultText
        : "(no result text)";
  }

  const composed = `${basePrompt}

--- chained from ${sourceAutomationName} (run ${sourceRunId}, status ${status}) ---
${body}`;

  const limited = assertPromptWithinByteLimit(composed);
  if (!limited.ok) {
    return {
      ok: false,
      code: limited.code,
      message: limited.message,
    };
  }

  return {
    ok: true,
    promptOverride: composed,
  };
}

export class ChainRunner {
  private readonly store: RunStore;
  private readonly engine: RunEngine;
  private readonly events: DaemonEventBus;
  private readonly onLog: (message: string) => void;
  private readonly maxDepth: number;
  private readonly pipelineResumeLookbackMs: number;
  private readonly pipelineAutoEscalate: boolean;
  private readonly pipelineAutoEscalateMaxPerPipeline: number;
  private readonly pipelineHaltDiscovery: boolean;
  private readonly waveCoordinator: PipelineWaveCoordinator | undefined;
  private readonly onHaltRecoveryDecision:
    | ((runId: string, result: HaltRecoveryResult) => void)
    | undefined;
  private readonly orchestrateHaltDiscoveryAdvisory:
    | ((sourceRunId: string) => Promise<HaltDiscoveryOrchestrateResult>)
    | undefined;
  private readonly reconcileHaltDiscoveryAdvisoryTerminal:
    | ((
        advisoryRunId: string,
        status: RunStatus
      ) => HaltDiscoveryTerminalReconcileResult)
    | undefined;
  private readonly presentCompletedHaltDiscoveryAdvisory:
    | ((advisoryRunId: string) => HaltDiscoveryPresentationResult)
    | undefined;
  private readonly haltRecoveryInFlight = new Set<string>();
  private readonly haltDiscoveryInFlight = new Set<string>();
  /** Per-source advisory-spawn guard; distinct from the Phase 1 request guard. */
  private readonly haltDiscoveryAdvisoryInFlight = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: ChainRunnerOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.events = options.events;
    this.onLog = options.onLog;
    this.maxDepth = options.maxDepth ?? 20;
    this.pipelineResumeLookbackMs =
      options.pipelineResumeLookbackMs ?? 86_400_000;
    this.pipelineAutoEscalate = options.pipelineAutoEscalate ?? true;
    this.pipelineAutoEscalateMaxPerPipeline =
      options.pipelineAutoEscalateMaxPerPipeline ?? 2;
    this.pipelineHaltDiscovery = options.pipelineHaltDiscovery ?? true;
    this.waveCoordinator = options.waveCoordinator;
    this.onHaltRecoveryDecision = options.onHaltRecoveryDecision;
    this.orchestrateHaltDiscoveryAdvisory =
      options.orchestrateHaltDiscoveryAdvisory;
    this.reconcileHaltDiscoveryAdvisoryTerminal =
      options.reconcileHaltDiscoveryAdvisoryTerminal;
    this.presentCompletedHaltDiscoveryAdvisory =
      options.presentCompletedHaltDiscoveryAdvisory;
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.events.subscribe((message) => {
      if (message.type !== "run_status") {
        return;
      }
      if (message.status === "cancelled") {
        const row = this.store.getRun(message.runId);
        if (!row || !this.isAuthoritativeHaltDiscoveryAdvisory(row)) {
          return;
        }
      } else if (
        message.status !== "completed" &&
        message.status !== "failed"
      ) {
        return;
      }
      queueMicrotask(() => {
        void this.handleTerminal(message.runId, message.status).catch((err) => {
          const text = err instanceof Error ? err.message : String(err);
          this.onLog(`Chain runner error for run ${message.runId}: ${text}`);
        });
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Replay missed completed→successor transitions after a daemon restart.
   * Non-blocking callers should catch; one failed candidate must not abort the rest.
   */
  async resumeMissedTransitions(nowMs = Date.now()): Promise<number> {
    const candidates = this.store.listPipelineResumeCandidates(
      this.pipelineResumeLookbackMs,
      nowMs
    );
    let resumed = 0;
    for (const row of candidates) {
      try {
        const depth = row.chain_depth;
        const maxDepth =
          row.chain_max_depth_override ?? row.chain_max_depth;
        this.store.appendEvent(row.id, "run.pipeline-resumed", {
          reason: "missed-transition",
          depth,
          maxDepth,
        });
        this.onLog(
          `Pipeline resume: replaying missed transition for run ${row.id}`
        );
        await this.handleTerminal(row.id, "completed");
        resumed += 1;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.onLog(
          `Pipeline resume: failed for run ${row.id}: ${text}`
        );
      }
    }
    if (resumed > 0 || candidates.length > 0) {
      this.onLog(
        `Pipeline resume: replayed ${resumed} missed transition(s) (${candidates.length} candidate(s))`
      );
    }
    return resumed;
  }

  /**
   * Startup pass for failed context-aware halts missed across downtime.
   * Does not call handleTerminal or re-append halt evidence.
   */
  async resumeFailedHaltRecovery(nowMs = Date.now()): Promise<number> {
    const candidates = this.store.listPipelineHaltRecoveryCandidates(
      this.pipelineResumeLookbackMs,
      nowMs
    );
    let recovered = 0;
    for (const row of candidates) {
      try {
        const result = await this.tryRecoverPipelineHalt(row.id);
        if (result.kind === "acted") {
          recovered += 1;
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.onLog(
          `Pipeline halt recovery: failed for run ${row.id}: ${text}`
        );
      }
    }
    if (recovered > 0 || candidates.length > 0) {
      this.onLog(
        `Pipeline halt recovery: recovered ${recovered} halt(s) (${candidates.length} candidate(s))`
      );
    }
    return recovered;
  }

  /**
   * Startup pass for unrecovered halts whose discovery request was missed.
   * Runs after failed-halt recovery; does not call handleTerminal or enqueue
   * advisory children (see {@link resumeHaltDiscoveryAdvisories}).
   */
  async resumeHaltDiscovery(nowMs = Date.now()): Promise<number> {
    const candidates = this.store.listPipelineHaltDiscoveryCandidates(
      this.pipelineResumeLookbackMs,
      nowMs
    );
    let requested = 0;
    for (const row of candidates) {
      try {
        const result = this.tryRequestHaltDiscovery(row.id);
        if (result.kind === "requested") {
          requested += 1;
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.onLog(
          `Pipeline halt discovery: failed for run ${row.id}: ${text}`
        );
      }
    }
    if (requested > 0 || candidates.length > 0) {
      this.onLog(
        `Pipeline halt discovery: requested ${requested} discovery(ies) (${candidates.length} candidate(s))`
      );
    }
    return requested;
  }

  /**
   * Startup pass for unresolved discovery requests (missing or terminal
   * advisory children). Runs after {@link resumeHaltDiscovery}; never respawns
   * an existing child.
   */
  async resumeHaltDiscoveryAdvisories(nowMs = Date.now()): Promise<number> {
    const candidates =
      this.store.listUnresolvedHaltDiscoveryAdvisoryCandidates(
        this.pipelineResumeLookbackMs,
        nowMs
      );
    let enqueued = 0;
    for (const row of candidates) {
      try {
        const child = this.store.findHaltDiscoveryAdvisoryChild(row.id);
        if (!child) {
          const result = await this.tryOrchestrateHaltDiscoveryAdvisory(
            row.id
          );
          if (result?.kind === "enqueued") {
            enqueued += 1;
          }
        } else if (
          child.status === "failed" ||
          child.status === "cancelled"
        ) {
          this.tryReconcileHaltDiscoveryAdvisoryTerminal(
            child.id,
            child.status
          );
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.onLog(
          `Pipeline halt discovery advisory: failed for run ${row.id}: ${text}`
        );
      }
    }
    if (enqueued > 0 || candidates.length > 0) {
      this.onLog(
        `Pipeline halt discovery advisory: enqueued ${enqueued} (replayed ${candidates.length} candidate(s))`
      );
    }
    return enqueued;
  }

  /** Shared live/startup entry with per-run in-flight guard. */
  private async tryRecoverPipelineHalt(
    runId: string
  ): Promise<HaltRecoveryResult> {
    if (this.haltRecoveryInFlight.has(runId)) {
      this.onLog(
        `Pipeline halt recovery: skipped in-flight duplicate for run ${runId}`
      );
      return {
        kind: "already-resolved" as const,
        detail: "in-flight",
      };
    }
    this.haltRecoveryInFlight.add(runId);
    try {
      const result = await recoverPipelineHalt(
        {
          store: this.store,
          engine: this.engine,
          policy: {
            enabled: this.pipelineAutoEscalate,
            maxPerPipeline: this.pipelineAutoEscalateMaxPerPipeline,
          },
          onLog: this.onLog,
        },
        runId
      );
      if (result.kind === "declined") {
        try {
          const discovery = this.tryRequestHaltDiscovery(runId);
          if (discovery.kind === "requested") {
            try {
              await this.tryOrchestrateHaltDiscoveryAdvisory(runId);
            } catch (err) {
              const text = err instanceof Error ? err.message : String(err);
              this.onLog(
                `Pipeline halt discovery advisory enqueue failed for run ${runId}: ${text}`
              );
            }
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.onLog(
            `Pipeline halt discovery trigger failed for run ${runId}: ${text}`
          );
        }
      }
      if (result.kind === "acted" || result.kind === "declined") {
        try {
          this.onHaltRecoveryDecision?.(runId, result);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.onLog(
            `Pipeline halt recovery notify failed for run ${runId}: ${text}`
          );
        }
      }
      return result;
    } finally {
      this.haltRecoveryInFlight.delete(runId);
    }
  }

  /** Per-source discovery guard; always clears in finally. */
  private tryRequestHaltDiscovery(
    runId: string
  ): HaltDiscoveryTriggerResult {
    if (this.haltDiscoveryInFlight.has(runId)) {
      this.onLog(
        `Pipeline halt discovery: skipped in-flight duplicate for run ${runId}`
      );
      return { kind: "already-recorded" };
    }
    this.haltDiscoveryInFlight.add(runId);
    try {
      return requestPipelineHaltDiscovery(
        this.store,
        runId,
        this.pipelineHaltDiscovery,
        this.onLog
      );
    } finally {
      this.haltDiscoveryInFlight.delete(runId);
    }
  }

  /**
   * Per-source advisory-spawn guard. Separate from the Phase 1 request guard;
   * always clears in finally.
   */
  private async tryOrchestrateHaltDiscoveryAdvisory(
    sourceRunId: string
  ): Promise<HaltDiscoveryOrchestrateResult | undefined> {
    if (!this.orchestrateHaltDiscoveryAdvisory) {
      return undefined;
    }
    if (this.haltDiscoveryAdvisoryInFlight.has(sourceRunId)) {
      this.onLog(
        `Pipeline halt discovery advisory: skipped in-flight duplicate for run ${sourceRunId}`
      );
      return { kind: "no-longer-actionable", reason: "in-flight" };
    }
    this.haltDiscoveryAdvisoryInFlight.add(sourceRunId);
    try {
      return await this.orchestrateHaltDiscoveryAdvisory(sourceRunId);
    } finally {
      this.haltDiscoveryAdvisoryInFlight.delete(sourceRunId);
    }
  }

  private tryReconcileHaltDiscoveryAdvisoryTerminal(
    advisoryRunId: string,
    status: RunStatus
  ): HaltDiscoveryTerminalReconcileResult | undefined {
    if (!this.reconcileHaltDiscoveryAdvisoryTerminal) {
      return undefined;
    }
    try {
      return this.reconcileHaltDiscoveryAdvisoryTerminal(
        advisoryRunId,
        status
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.onLog(
        `Pipeline halt discovery advisory reconcile failed for run ${advisoryRunId}: ${text}`
      );
      return undefined;
    }
  }

  private tryPresentCompletedHaltDiscoveryAdvisory(
    advisoryRunId: string
  ): HaltDiscoveryPresentationResult | undefined {
    if (!this.presentCompletedHaltDiscoveryAdvisory) {
      return undefined;
    }
    try {
      return this.presentCompletedHaltDiscoveryAdvisory(advisoryRunId);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.onLog(
        `Pipeline halt discovery briefing presentation failed for run ${advisoryRunId}: ${text}`
      );
      return undefined;
    }
  }

  /** Halt-discovery trigger + generated worker identity (any child). */
  private isHaltDiscoveryAdvisoryWorker(row: RunRow): boolean {
    if (row.trigger_kind !== HALT_DISCOVERY_TRIGGER_KIND) {
      return false;
    }
    const automation = this.store.getAutomationByIdIncludingArchived(
      row.automation_id
    );
    return automation?.config_key === HALT_DISCOVERY_CONFIG_KEY;
  }

  /**
   * Oldest matching halt-discovery child with generated worker identity.
   * Superseded later duplicates are never authoritative.
   */
  private isAuthoritativeHaltDiscoveryAdvisory(row: RunRow): boolean {
    if (!this.isHaltDiscoveryAdvisoryWorker(row)) {
      return false;
    }
    const parentRunId = row.parent_run_id;
    if (parentRunId == null || parentRunId === "") {
      return false;
    }
    const authoritative =
      this.store.findHaltDiscoveryAdvisoryChild(parentRunId);
    return authoritative?.id === row.id;
  }

  async handleTerminal(
    runId: string,
    status: RunStatus
  ): Promise<void> {
    try {
      const row = this.store.getRun(runId);
      if (!row) {
        return;
      }

      // Any advisory child bypasses wave/chain/b43. Only the authoritative
      // (oldest) child may reconcile failures or present a completed briefing.
      if (this.isHaltDiscoveryAdvisoryWorker(row)) {
        if (
          this.isAuthoritativeHaltDiscoveryAdvisory(row) &&
          (status === "failed" || status === "cancelled")
        ) {
          this.tryReconcileHaltDiscoveryAdvisoryTerminal(runId, status);
        } else if (
          this.isAuthoritativeHaltDiscoveryAdvisory(row) &&
          status === "completed" &&
          row.status === "completed"
        ) {
          this.tryPresentCompletedHaltDiscoveryAdvisory(runId);
        }
        return;
      }

      if (this.waveCoordinator) {
        const hook = await this.waveCoordinator.handleTerminalHook(
          runId,
          status
        );
        if (hook.handled) {
          return;
        }
      }

      const automation = this.store.getAutomationByIdIncludingArchived(
        row.automation_id
      );
      if (!automation?.chain_json) {
        return;
      }

      let chain: ChainConfig;
      try {
        chain = JSON.parse(automation.chain_json) as ChainConfig;
      } catch {
        this.onLog(`Chain runner: invalid chain_json on automation ${automation.id}`);
        return;
      }

      if (!chain.next) {
        return;
      }

      if (!chainWhenMatches(status, chain.when)) {
        const parsedContext = this.store.parseChainContext(row);
        const contextAware =
          parsedContext?.ok === true &&
          row.chain_depth != null &&
          row.chain_max_depth != null &&
          row.chain_root_run_id != null;
        const payload: Record<string, unknown> = {
          reason: "status-mismatch",
          next: chain.next,
          status,
          when: chain.when ?? "completed",
        };
        if (contextAware) {
          payload.depth = row.chain_depth;
          payload.maxDepth =
            row.chain_max_depth_override ?? row.chain_max_depth;
        }
        this.store.appendEvent(runId, "run.chain-skipped", payload);
        this.onLog(
          `Chain skipped for run ${runId}: status-mismatch (status=${status}, when=${chain.when ?? "completed"})`
        );
        if (status === "failed" && contextAware) {
          await this.tryRecoverPipelineHalt(runId);
        }
        return;
      }

      // Feature-end terminal: plan-phase `complete:` → final-gate (normal) or
      // feature-level review (execute). Evaluated before the stopped early-return.
      if (await this.tryEnqueueFeatureEndTerminal(row, automation, status)) {
        return;
      }

      // Execute feature-level review → final-gate (not the static review → plan-phase edge).
      if (
        await this.tryEnqueueFinalGateFromFeatureReview(row, automation, status)
      ) {
        return;
      }

      if (row.chain_stop_requested_at) {
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "stopped",
          next: chain.next,
          detail: row.chain_stop_reason,
        });
        this.onLog(
          `Chain skipped for run ${runId}: stopped${
            row.chain_stop_reason ? ` (${row.chain_stop_reason})` : ""
          }`
        );
        return;
      }

      const parsedContext = this.store.parseChainContext(row);
      const contextAware =
        parsedContext?.ok === true &&
        row.chain_depth != null &&
        row.chain_max_depth != null &&
        row.chain_root_run_id != null;

      if (parsedContext && !parsedContext.ok) {
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "template-error",
          next: chain.next,
          detail: "unusable persisted chain context",
          depth: row.chain_depth,
          maxDepth: row.chain_max_depth,
        });
        this.onLog(
          `Chain skipped for run ${runId}: unusable persisted chain context`
        );
        return;
      }

      if (parsedContext?.ok === true && !contextAware) {
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "template-error",
          next: chain.next,
          detail: "incomplete persisted chain metadata",
          depth: row.chain_depth,
          maxDepth: row.chain_max_depth,
        });
        this.onLog(
          `Chain skipped for run ${runId}: incomplete persisted chain metadata`
        );
        return;
      }

      let depth: number;
      let maxDepth: number;
      let chainContext: ChainRunContext | null = null;
      let chainRootRunId: string | null = null;

      if (contextAware && parsedContext?.ok) {
        depth = row.chain_depth!;
        maxDepth = row.chain_max_depth_override ?? row.chain_max_depth!;
        try {
          chainContext = {
            ...parsedContext.context,
            variables: normalizeImplementFullyChainVariables(
              parsedContext.context.variables
            ),
          };
        } catch (err) {
          const detail =
            err instanceof KickoffError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          this.store.appendEvent(runId, "run.chain-skipped", {
            reason: "template-error",
            next: chain.next,
            detail,
            depth: row.chain_depth,
            maxDepth: row.chain_max_depth_override ?? row.chain_max_depth,
          });
          this.onLog(
            `Chain skipped for run ${runId}: invalid chain variables (${detail})`
          );
          return;
        }
        chainRootRunId = row.chain_root_run_id!;
      } else {
        depth = this.store.chainDepth(runId);
        maxDepth = this.maxDepth;
      }

      const sourceWorkerKey = workerKeyFromConfigKey(automation.config_key);
      let chainNext = chain.next;
      if (contextAware && chainContext) {
        chainNext = resolveExecuteModeNext({
          sourceWorkerKey,
          chainNext: chain.next,
          variables: chainContext.variables,
        });
      }

      if (depth >= maxDepth) {
        const skipPayload: Record<string, unknown> = {
          reason: "max-depth",
          depth,
          maxDepth,
          next: chainNext,
        };
        if (contextAware && row.chain_max_depth_override != null) {
          skipPayload.maxDepthOverride = row.chain_max_depth_override;
        }
        this.store.appendEvent(runId, "run.chain-skipped", skipPayload);
        this.onLog(
          `Chain skipped for run ${runId}: max depth (${depth} >= ${maxDepth})`
        );
        return;
      }

      const targetId = this.store.resolveChainTarget(row.workspace_id, chainNext);
      if (!targetId) {
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "unresolved",
          next: chainNext,
          depth,
          maxDepth,
        });
        this.onLog(
          `Chain skipped for run ${runId}: unresolved next "${chainNext}"`
        );
        return;
      }

      const target = this.store.getAutomation(targetId);
      if (!target) {
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "unresolved",
          next: chainNext,
          targetAutomationId: targetId,
          depth,
          maxDepth,
        });
        this.onLog(
          `Chain skipped for run ${runId}: unresolved next "${chainNext}" (target row missing)`
        );
        return;
      }

      const targetWorkerKey = workerKeyFromConfigKey(target.config_key);
      const clearsTrackIsolation =
        sourceWorkerKey === IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY &&
        targetWorkerKey === "plan-phase";

      const promptBuilt = buildChainedPromptOverride(
        this.store,
        runId,
        status,
        automation.name,
        target,
        chain.passResult === true,
        chainContext,
        this.onLog,
        { sourceWorkerKey }
      );

      if (!promptBuilt.ok) {
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "template-error",
          next: chainNext,
          targetAutomationId: targetId,
          code: promptBuilt.code,
          detail: promptBuilt.message,
          placeholder: promptBuilt.placeholder,
          depth,
          maxDepth,
        });
        this.onLog(
          `Chain skipped for run ${runId}: template-error (${promptBuilt.code})`
        );
        return;
      }

      let promptOverride = promptBuilt.promptOverride;
      if (
        promptOverride != null &&
        !clearsTrackIsolation &&
        row.pipeline_track_id &&
        this.waveCoordinator
      ) {
        const trackBlock = this.waveCoordinator.trustedTrackContextFor(
          row.pipeline_track_id
        );
        if (trackBlock) {
          promptOverride = `${promptOverride}\n\n${trackBlock}`;
          const limited = assertPromptWithinByteLimit(promptOverride);
          if (!limited.ok) {
            this.store.appendEvent(runId, "run.chain-skipped", {
              reason: "template-error",
              next: chainNext,
              targetAutomationId: targetId,
              code: limited.code,
              detail: limited.message,
              depth,
              maxDepth,
            });
            this.onLog(
              `Chain skipped for run ${runId}: template-error (${limited.code})`
            );
            return;
          }
        }
      }

      const { modelRole, modelRoleResolved, modelSelectionOverride } =
        resolveChildModelRole(contextAware, chainContext, target, (msg) =>
          this.onLog(msg)
        );

      if (!this.store.claimChainHandled(runId)) {
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "already-chained",
          next: chainNext,
          targetAutomationId: targetId,
        });
        this.onLog(
          `Chain skipped for run ${runId}: already-chained (${chainNext})`
        );
        return;
      }

      const triggerOptions: TriggerRunOptions = {
        parentRunId: runId,
        promptOverride,
        chainContext,
        chainRootRunId,
        chainDepth: contextAware ? depth + 1 : null,
        chainMaxDepth: contextAware ? maxDepth : null,
        pipelineWaveId: clearsTrackIsolation ? null : row.pipeline_wave_id,
        pipelineTrackId: clearsTrackIsolation ? null : row.pipeline_track_id,
        executionCwd: clearsTrackIsolation ? null : row.execution_cwd,
      };
      if (modelSelectionOverride !== undefined) {
        triggerOptions.modelSelectionOverride = modelSelectionOverride;
      }

      let childRunId: string;
      try {
        childRunId = await this.engine.triggerRun(
          targetId,
          "chain",
          triggerOptions
        );
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.store.appendEvent(runId, "run.chain-skipped", {
          reason: "enqueue-failed",
          next: chainNext,
          targetAutomationId: targetId,
          detail: text,
        });
        this.onLog(
          `Chain skipped for run ${runId}: enqueue-failed (${text})`
        );
        return;
      }

      const chainedPayload: Record<string, unknown> = {
        childRunId,
        targetAutomationId: targetId,
        next: chainNext,
        when: chain.when ?? "completed",
        passedResult: chain.passResult === true,
        modelRole,
        modelRoleResolved,
      };
      if (chainNext !== chain.next) {
        chainedPayload.executeModeRemap = {
          from: chain.next,
          to: chainNext,
        };
      }
      this.store.appendEvent(runId, "run.chained", chainedPayload);
      this.onLog(
        `Chained ${runId} → run ${childRunId} (${chainNext})`
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.onLog(`Chain runner error for run ${runId}: ${text}`);
    }
  }

  /**
   * When main-coordinator `plan-phase` stops with `complete:`, enqueue the
   * terminal worker: `final-gate` (normal) or feature-level `review` (execute).
   * Depth-cap exempt. Returns true when handled (enqueued or already claimed).
   */
  private async tryEnqueueFeatureEndTerminal(
    row: RunRow,
    automation: AutomationRow,
    status: RunStatus
  ): Promise<boolean> {
    if (status !== "completed") {
      return false;
    }
    if (row.pipeline_track_id != null) {
      return false;
    }
    if (workerKeyFromConfigKey(automation.config_key) !== "plan-phase") {
      return false;
    }
    const stopReason = row.chain_stop_reason;
    if (stopReason == null || !stopReason.startsWith("complete:")) {
      return false;
    }

    const parsedContext = this.store.parseChainContext(row);
    const contextAware =
      parsedContext?.ok === true &&
      row.chain_depth != null &&
      row.chain_max_depth != null &&
      row.chain_root_run_id != null;
    if (!contextAware || parsedContext?.ok !== true) {
      return false;
    }
    const pipelineId = parsedContext.context.variables.pipelineId;
    if (typeof pipelineId !== "string" || !isImplementFullyContext(pipelineId)) {
      return false;
    }

    let chainContext: ChainRunContext;
    try {
      chainContext = {
        ...parsedContext.context,
        variables: normalizeImplementFullyChainVariables(
          parsedContext.context.variables
        ),
      };
    } catch {
      return false;
    }

    const loopMode = chainContext.variables.loopMode ?? "normal";
    if (loopMode === "execute") {
      return this.enqueueTerminalChildRun({
        parentRow: row,
        chainContext,
        targetWorkerKey: "review",
        eventType: "run.pipeline-feature-review-enqueued",
        stopReason,
        logLabel: "Feature review",
        resolveModelRole: (ctx, target) =>
          resolveChildModelRole(true, ctx, target, (msg) => this.onLog(msg)),
      });
    }

    return this.enqueueTerminalChildRun({
      parentRow: row,
      chainContext,
      targetWorkerKey: IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
      eventType: "run.pipeline-final-gate-enqueued",
      stopReason,
      logLabel: "Final gate",
      resolveModelRole: (ctx, target) =>
        resolveChildModelRole(true, ctx, target, (msg) => this.onLog(msg)),
    });
  }

  /**
   * When a completed run is the execute-mode feature-level review, enqueue
   * `final-gate` instead of following the static `review → plan-phase` edge.
   */
  private async tryEnqueueFinalGateFromFeatureReview(
    row: RunRow,
    automation: AutomationRow,
    status: RunStatus
  ): Promise<boolean> {
    if (status !== "completed") {
      return false;
    }
    if (row.pipeline_track_id != null) {
      return false;
    }
    if (workerKeyFromConfigKey(automation.config_key) !== "review") {
      return false;
    }
    if (row.chain_stop_requested_at) {
      return false;
    }
    if (!this.isFeatureLevelReviewRun(row)) {
      return false;
    }

    const parsedContext = this.store.parseChainContext(row);
    const contextAware =
      parsedContext?.ok === true &&
      row.chain_depth != null &&
      row.chain_max_depth != null &&
      row.chain_root_run_id != null;
    if (!contextAware || parsedContext?.ok !== true) {
      return false;
    }

    let chainContext: ChainRunContext;
    try {
      chainContext = {
        ...parsedContext.context,
        variables: normalizeImplementFullyChainVariables(
          parsedContext.context.variables
        ),
      };
    } catch {
      return false;
    }

    const stopReason = row.chain_stop_reason ?? "feature-review-complete";
    return this.enqueueTerminalChildRun({
      parentRow: row,
      chainContext,
      targetWorkerKey: IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
      eventType: "run.pipeline-final-gate-enqueued",
      stopReason,
      logLabel: "Final gate (post feature review)",
      resolveModelRole: (ctx, target) =>
        resolveChildModelRole(true, ctx, target, (msg) => this.onLog(msg)),
    });
  }

  /**
   * Durable, restart-safe: parent plan-phase `complete:` under execute, or the
   * parent event written when the feature review was enqueued.
   */
  private isFeatureLevelReviewRun(row: RunRow): boolean {
    const parentId = row.parent_run_id;
    if (parentId == null) {
      return false;
    }

    const events = this.store.listRunEvents(parentId);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.event_type !== "run.pipeline-feature-review-enqueued") {
        continue;
      }
      try {
        const payload = JSON.parse(ev.payload) as { childRunId?: string };
        return payload.childRunId === row.id;
      } catch {
        return false;
      }
    }

    const parent = this.store.getRun(parentId);
    if (!parent) {
      return false;
    }
    const parentAutomation = this.store.getAutomationByIdIncludingArchived(
      parent.automation_id
    );
    if (workerKeyFromConfigKey(parentAutomation?.config_key) !== "plan-phase") {
      return false;
    }
    if (
      parent.chain_stop_reason == null ||
      !parent.chain_stop_reason.startsWith("complete:")
    ) {
      return false;
    }

    const parsed = this.store.parseChainContext(row);
    if (parsed?.ok !== true) {
      return false;
    }
    try {
      const variables = normalizeImplementFullyChainVariables(
        parsed.context.variables
      );
      return variables.loopMode === "execute";
    } catch {
      return false;
    }
  }

  private async enqueueTerminalChildRun(args: {
    parentRow: RunRow;
    chainContext: ChainRunContext;
    targetWorkerKey: string;
    eventType: string;
    stopReason: string;
    logLabel: string;
    resolveModelRole: (
      chainContext: ChainRunContext,
      target: AutomationRow
    ) => ReturnType<typeof resolveChildModelRole>;
  }): Promise<boolean> {
    const {
      parentRow,
      chainContext,
      targetWorkerKey,
      eventType,
      stopReason,
      logLabel,
      resolveModelRole,
    } = args;

    const targetRef = `${GENERATED_CONFIG_KEY_PREFIX}${targetWorkerKey}`;
    const targetId = this.store.resolveChainTarget(
      parentRow.workspace_id,
      targetRef
    );
    if (!targetId) {
      this.store.appendEvent(parentRow.id, "run.chain-skipped", {
        reason: "template-error",
        next: targetRef,
        detail: `unresolved ${targetWorkerKey} target`,
      });
      return false;
    }

    const target = this.store.getAutomation(targetId);
    if (!target) {
      this.store.appendEvent(parentRow.id, "run.chain-skipped", {
        reason: "template-error",
        next: targetRef,
        detail: `${targetWorkerKey} automation missing`,
      });
      return false;
    }

    const rendered = renderChainTemplate(target.prompt, chainContext.variables);
    if (!rendered.ok) {
      this.store.appendEvent(parentRow.id, "run.chain-skipped", {
        reason: "template-error",
        next: targetRef,
        code: rendered.code,
        detail: rendered.message,
        placeholder: rendered.placeholder,
      });
      return false;
    }

    const limited = assertPromptWithinByteLimit(rendered.text);
    if (!limited.ok) {
      this.store.appendEvent(parentRow.id, "run.chain-skipped", {
        reason: "template-error",
        next: targetRef,
        code: limited.code,
        detail: limited.message,
      });
      return false;
    }

    const {
      modelSelectionOverride,
      modelRole,
      modelRoleResolved,
      gatekeeperSource,
    } = resolveModelRole(chainContext, target);

    if (!this.store.claimChainHandled(parentRow.id)) {
      return true;
    }

    const depth = parentRow.chain_depth!;
    const maxDepth =
      parentRow.chain_max_depth_override ?? parentRow.chain_max_depth!;
    const childDepth = depth + 1;
    const childMaxDepth = Math.max(maxDepth, childDepth);
    const triggerOptions: TriggerRunOptions = {
      parentRunId: parentRow.id,
      promptOverride: rendered.text,
      chainContext,
      chainRootRunId: parentRow.chain_root_run_id!,
      chainDepth: childDepth,
      chainMaxDepth: childMaxDepth,
      pipelineWaveId: null,
      pipelineTrackId: null,
      executionCwd: null,
    };
    if (modelSelectionOverride !== undefined) {
      triggerOptions.modelSelectionOverride = modelSelectionOverride;
    }

    let childRunId: string;
    try {
      childRunId = await this.engine.triggerRun(
        targetId,
        "chain",
        triggerOptions
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.store.appendEvent(parentRow.id, "run.chain-skipped", {
        reason: "enqueue-failed",
        next: targetRef,
        targetAutomationId: targetId,
        detail: text,
      });
      this.onLog(`${logLabel} enqueue failed for run ${parentRow.id}: ${text}`);
      return true;
    }

    const eventPayload: Record<string, unknown> = {
      childRunId,
      stopReason,
      modelRole,
      modelRoleResolved,
    };
    if (gatekeeperSource != null) {
      eventPayload.gatekeeperSource = gatekeeperSource;
    }
    this.store.appendEvent(parentRow.id, eventType, eventPayload);
    this.onLog(
      `${logLabel} enqueued for run ${parentRow.id} → ${childRunId} (${stopReason})`
    );
    return true;
  }
}
