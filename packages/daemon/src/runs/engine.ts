import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CursorAgentError } from "@cursor/sdk";
import type { SDKMessage } from "@cursor/sdk";
import {
  HALT_DISCOVERY_INPUT_KIND,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  KickoffError,
  RUN_ESCALATION_ACTIONS,
  chainMaxDepthSchema,
  chainRunContextSchema,
  legacyModelFromSelection,
  modelSelectionFromLegacy,
  normalizeImplementFullyChainVariables,
  normalizeModelSelection,
  parsePromptReferences,
  workerKeyFromConfigKey,
  type AttachmentRef,
  type ChainControlRequest,
  type ChainControlResponse,
  type ChainRunContext,
  type InputRequestMetadata,
  type ModelSelection,
  type PipelineHaltDiscoveryActionResultPayload,
  type RunEscalationRequest,
  type RunStatus,
} from "@lca/shared";
import {
  escalateRun as performEscalation,
  type EscalateResult,
  type EscalationCallContext,
} from "./escalation.js";
import {
  buildActionResultPayload,
  operatorBriefingReason,
  parseEscalationActionAnswer,
  pendingIsHaltDiscoveryBriefing,
  resolveHaltDiscoveryBriefingAuthority,
  isParkedAuthoritativeHaltDiscoveryBriefing,
} from "./halt-discovery-operator-bridge.js";
import {
  HaltDiscoveryPromotionError,
  promoteHaltDiscoveryAdvisory,
  type HaltDiscoveryPromotionResult,
} from "./halt-discovery-promotion.js";
import { parseInputMetadataJson } from "../input/store.js";
import type { ChatEngine } from "../chats/engine.js";
import type { LcaDatabase } from "../db/index.js";
import { renderChainTemplate } from "./chain-template.js";
import { resolvePromptReferences } from "../artifacts/resolve.js";
import { scanWorkspaceArtifacts } from "../artifacts/scan.js";
import {
  type ResumeRetryPolicy,
  isAuthResumeError,
  resolveResumeRetryPolicy,
  resumeWithRetry,
} from "../executor/resume-retry.js";
import type {
  ActiveRun,
  AutomationsIoToolName,
  Executor,
  OperatorMessage,
} from "../executor/types.js";
import { mapSdkResultStatus } from "../executor/types.js";
import { HALT_DISCOVERY_TRIGGER_KIND } from "../pipelines/halt-discovery.js";
import { AttachmentStore } from "../attachments/store.js";
import { removeAttachmentOwnerDir } from "../attachments/storage.js";
import {
  buildOperatorMessage,
  operatorMessageFromQueued,
  resolveOperatorAttachments,
  serializeAttachmentRefs,
} from "../attachments/resolve.js";
import {
  extractNeedsInputFromMessage,
  extractRunIdFromMessage,
} from "../executor/sdk-local.js";
import type { InputHub } from "../input/hub.js";
import { rowToInputRequest } from "../input/store.js";
import { buildRevivePrimer } from "../handoff/continuePrompt.js";
import { synthesizeTranscript } from "../handoff/transcript.js";
import { resolveModelSelection } from "../models/resolve.js";
import { selectionFromStored } from "../models/selection-persist.js";
import type { DaemonEventSink } from "../events.js";
import { pipelineWorktreesDir } from "../git/worktrees.js";
import {
  buildImplementFullyRunMetadata,
  generateRunMetadata,
} from "./auto-metadata.js";
import {
  extractImplementFullyHandoff,
  isImplementFullyContext,
} from "./pipeline-handoff.js";
import { assertTransition } from "./state-machine.js";
import { buildPauseResumePrompt } from "./pause-resume-prompt.js";
import type { PipelineWaveCoordinator } from "./pipeline-wave-coordinator.js";
import type { PipelineWaveStore } from "./pipeline-wave-store.js";
import { RunStore, type RunRow } from "./store.js";
import type { PhaseCompletionDetails } from "../notify/notifier.js";

/** SQLite `datetime('now')` is UTC without a zone suffix — parse as UTC. */
function sqliteTimestampToMs(value: string): number {
  const iso = value.includes("T")
    ? value.endsWith("Z")
      ? value
      : `${value}Z`
    : `${value.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

/** Wall-clock duration between two nullable SQLite timestamps; null when either is missing. */
function elapsedMsBetween(
  startedAt: string | null,
  endedAt: string | null
): number | null {
  if (startedAt == null || endedAt == null) return null;
  const startMs = sqliteTimestampToMs(startedAt);
  const endMs = sqliteTimestampToMs(endedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

/** Options for {@link RunEngine.triggerRun}. Named for call-site clarity. */
export type TriggerRunOptions = {
  /** Already-final prompt text; not templated again. */
  promptOverride?: string;
  parentRunId?: string | null;
  /** Canonical (or legacy string) per-run model override written atomically. */
  modelSelectionOverride?: ModelSelection | string | null;
  /** Immutable pipeline snapshot; null/omitted for legacy chains. */
  chainContext?: ChainRunContext | null;
  chainRootRunId?: string | null;
  chainDepth?: number | null;
  chainMaxDepth?: number | null;
  /**
   * Daemon-only parallel-wave identity. Never accepted from public POST /api/runs.
   * Null/omitted clears track isolation (main checkout / integration / coordinator).
   */
  pipelineWaveId?: string | null;
  pipelineTrackId?: string | null;
  executionCwd?: string | null;
};

/** Result of {@link RunEngine.applyChainControl}; never throws for expected failures. */
export type ApplyRunChainControlResult =
  | { ok: true; response: ChainControlResponse }
  | {
      ok: false;
      reason:
        | "not-found"
        | "terminal"
        | "rebudget-conflict"
        | "extend-conflict"
        | "no-budget-context"
        | "forbidden";
    };

export class TriggerRunValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerRunValidationError";
  }
}

export type RunEngineOptions = {
  apiKey: string;
  executor: Executor;
  inputHub: InputHub;
  events?: DaemonEventSink;
  onLog?: (message: string) => void;
  /** Max runs executing at once; excess runs stay `queued`. Default 3. */
  maxConcurrentRuns?: number;
  /** Events retained per run after it ends. Default 2000. */
  eventRetentionPerRun?: number;
  /** Hard cap on a single event payload in bytes. Default 64KB. */
  maxEventPayloadBytes?: number;
  /** Max time for `spawn()`/`resume()` to return before the attempt is treated as failed. Default 120s. */
  spawnTimeoutMs?: number;
  /** A `running` run with no new event for longer than this is considered stalled. Default 10m. */
  runStallTimeoutMs?: number;
  /** Total spawn attempts per run (1 = no retry). Default 3. */
  maxSpawnAttempts?: number;
  /** Base backoff before a retry; grows per attempt (capped). Default 5s. */
  retryBackoffMs?: number;
  /** Terminal give-up notification sink; never throws. */
  onRunFailed?: (runId: string, reason: RunFailureReason) => void;
  /** Successful settle notification sink; never throws. */
  onRunCompleted?: (runId: string) => void;
  /**
   * Enriched implement-fully phase-completed sink (backlog id, phase type,
   * timer, description); fires once run metadata is generated, superseding
   * the generic `onRunCompleted` toast for these runs. Never throws.
   */
  onImplementFullyPhaseCompleted?: (
    runId: string,
    details: PhaseCompletionDetails
  ) => void;
  /** Dead-login alert sink (toast + log); never throws. */
  onAuthExpired?: (kind: "run" | "chat", id: string, message: string) => void;
  /** Max idle time before a retained terminal session is disposed. Default 30m; 0 = never. */
  retainedSessionTtlMs?: number;
  /** Revive expired interactive sessions from their stored transcript. Default true. */
  sessionRevive?: boolean;
  /** Internal test seam for cold-resume retry policy. */
  resumeRetryPolicy?: Partial<ResumeRetryPolicy>;
};

export type RunFailureReason =
  | "spawn_timeout"
  | "spawn_error"
  | "orphaned_no_agent"
  | "agent_gone"
  | "stalled_idle"
  | "retries_exhausted"
  | "sdk_error";

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_EVENT_RETENTION = 2000;
const DEFAULT_SPAWN_TIMEOUT_MS = 120000;
const DEFAULT_RUN_STALL_TIMEOUT_MS = 600000;
const DEFAULT_MAX_SPAWN_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 5000;
const MIN_SPAWN_TIMEOUT_MS = 10000;
const MIN_RUN_STALL_TIMEOUT_MS = 60000;
const MIN_MAX_SPAWN_ATTEMPTS = 1;
const MIN_RETRY_BACKOFF_MS = 0;
const MIN_RETAINED_SESSION_TTL_MS = 60000;
const DEFAULT_RETAINED_SESSION_TTL_MS = 1_800_000;
const MAX_REFERENCE_EVENT_DETAILS = 20;

type RunContext = {
  cwd: string;
  /** Legacy base id; always equals `modelSelection.id`. */
  model: string;
  modelSelection: ModelSelection;
  prompt: string;
};
type RetainedRun = { activeRun: ActiveRun; runToken: string; retainedAt: number };

type RetainedFollowUpContext = {
  ctx: RunContext;
  resumable: ResumableRunRow;
  abort: AbortController;
  originalStatus: RunStatus;
};

type RetainedTurnResult =
  | { kind: "success"; activeRun: ActiveRun }
  | { kind: "fallback"; message: string; activeRun?: ActiveRun }
  | { kind: "turn_failed"; activeRun: ActiveRun; errMessage: string };

export type RunMessageErrorCode =
  | "not_found"
  | "busy"
  | "needs_input"
  | "not_resumable"
  | "context_missing"
  | "empty_message";

export class RunMessageError extends Error {
  constructor(
    readonly code: RunMessageErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RunMessageError";
  }
}

export class SpawnTimeoutError extends Error {
  constructor(
    readonly label: "spawn" | "resume",
    readonly timeoutMs: number
  ) {
    super(`${label} exceeded ${timeoutMs}ms`);
    this.name = "SpawnTimeoutError";
  }
}

/** Upper bound for linear spawn-retry backoff (base * attempt count). */
const MAX_RETRY_BACKOFF_MS = 60000;

type ResumableRunRow = RunRow & { agent_id: string; sdk_run_id: string };

export type RunPromotionSource = {
  run: ResumableRunRow;
  model: ModelSelection;
  events: Array<{
    event_type: string;
    payload: string;
    seq: number;
    created_at: string;
  }>;
};

type SpawnPromptResolution = {
  prompt: string;
  referencesEvent?: {
    resolved: number;
    unknown: number;
    unknownReferences: Array<{ kind: string; name: string; raw: string }>;
    unknownReferencesTruncated?: number;
    error?: string;
  };
};

export class RunEngine {
  private readonly db: LcaDatabase;
  private readonly store: RunStore;
  private readonly attachments: AttachmentStore;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pendingAnswers = new Map<string, string>();
  private readonly answerWaiters = new Map<string, (answer: string) => void>();
  private readonly retainedRuns = new Map<string, RetainedRun>();
  // Per-run secret minted at spawn, handed to that run's MCP child via env, and
  // required on `/ask` so an arbitrary local process can't inject questions.
  private readonly runTokens = new Map<string, string>();
  private readonly runTasks = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Suppress concurrent best-effort metadata generation for the same run. */
  private readonly metadataInFlight = new Set<string>();
  /** Interrupt message waiting for active stream teardown before follow-up. */
  private readonly pendingInterrupts = new Map<string, OperatorMessage>();
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private readonly maxConcurrentRuns: number;
  private readonly eventRetentionPerRun: number;
  private readonly spawnTimeoutMs: number;
  private readonly runStallTimeoutMs: number;
  private readonly maxSpawnAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly retainedSessionTtlMs: number;
  private readonly sessionRevive: boolean;
  private readonly resumeRetryPolicy: ResumeRetryPolicy;
  private shuttingDown = false;

  constructor(
    db: LcaDatabase,
    private readonly options: RunEngineOptions
  ) {
    this.db = db;
    this.maxConcurrentRuns = Math.max(
      1,
      options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT
    );
    this.eventRetentionPerRun =
      options.eventRetentionPerRun ?? DEFAULT_EVENT_RETENTION;
    this.spawnTimeoutMs = Math.max(
      MIN_SPAWN_TIMEOUT_MS,
      options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
    );
    this.runStallTimeoutMs = Math.max(
      MIN_RUN_STALL_TIMEOUT_MS,
      options.runStallTimeoutMs ?? DEFAULT_RUN_STALL_TIMEOUT_MS
    );
    this.maxSpawnAttempts = Math.max(
      MIN_MAX_SPAWN_ATTEMPTS,
      options.maxSpawnAttempts ?? DEFAULT_MAX_SPAWN_ATTEMPTS
    );
    this.retryBackoffMs = Math.max(
      MIN_RETRY_BACKOFF_MS,
      options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
    );
    const ttl = options.retainedSessionTtlMs ?? DEFAULT_RETAINED_SESSION_TTL_MS;
    this.retainedSessionTtlMs =
      ttl <= 0 ? 0 : Math.max(MIN_RETAINED_SESSION_TTL_MS, ttl);
    this.sessionRevive = options.sessionRevive ?? true;
    this.resumeRetryPolicy = resolveResumeRetryPolicy(options.resumeRetryPolicy);
    this.store = new RunStore(db, options.events, {
      maxEventPayloadBytes: options.maxEventPayloadBytes,
    });
    this.attachments = new AttachmentStore(db);
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  /**
   * Input-only automations-io profile for halt-discovery and research runs.
   * Halt-discovery keys off persisted trigger_kind; research keys off the run's
   * automation config_key — both survive resume after restart.
   */
  private automationsIoToolsForRun(
    runId: string
  ): readonly AutomationsIoToolName[] | undefined {
    const row = this.store.getRun(runId);
    if (row?.trigger_kind === HALT_DISCOVERY_TRIGGER_KIND) {
      return ["ask_user"] as const;
    }
    if (!row) return undefined;
    const automation = this.store.getAutomationByIdIncludingArchived(
      row.automation_id
    );
    if (!automation) return undefined;
    const workerKey = workerKeyFromConfigKey(automation.config_key);
    if (workerKey === IMPLEMENT_FULLY_RESEARCH_WORKER_KEY) {
      return ["ask_user"] as const;
    }
    return undefined;
  }

  private async resumeRunWithRetry(
    runId: string,
    make: () => Promise<ActiveRun>,
    signal: AbortSignal
  ): Promise<ActiveRun> {
    return resumeWithRetry({
      make,
      signal,
      policy: this.resumeRetryPolicy,
      onRetry: ({ attempt, maxAttempts, delayMs, message }) => {
        this.log(
          `Run ${runId}: resume failed (${message}); retrying attempt ${attempt + 1}/${maxAttempts} in ${delayMs}ms`
        );
        this.store.appendEvent(runId, "run.resume.retry", {
          attempt,
          maxAttempts,
          delayMs,
          message,
        });
      },
    });
  }

  private scheduleDeferred(delayMs: number, fn: () => void): void {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      try {
        fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Deferred task failed: ${message}`);
      }
    }, delayMs);
    handle.unref?.();
    this.timers.add(handle);
  }

  private transition(runId: string, from: RunStatus, to: RunStatus): void {
    assertTransition(from, to);
    this.store.setStatus(runId, to);
    this.log(`Run ${runId}: ${from} → ${to}`);
    if (to === "completed") {
      try {
        this.options.onRunCompleted?.(runId);
      } catch {
        // never let sink throw
      }
    }
    if (to === "completed" || to === "failed") {
      // Next timer turn so consumeAndFinalize can append run.finished first.
      this.scheduleDeferred(0, () => {
        if (this.shuttingDown) return;
        this.track(this.maybeGenerateRunMetadata(runId));
      });
    }
  }

  /** Track a background run task so shutdown can drain it before db.close(). */
  private track(task: Promise<void>): void {
    this.runTasks.add(task);
    void task.finally(() => this.runTasks.delete(task));
  }

  /**
   * Best-effort post-settlement title/summary. Never alters status, never retries,
   * and never emits run.error on failure.
   */
  private async maybeGenerateRunMetadata(runId: string): Promise<void> {
    if (this.shuttingDown || this.metadataInFlight.has(runId)) return;
    this.metadataInFlight.add(runId);
    try {
      const row = this.store.getRun(runId);
      if (!row) return;
      if (row.status !== "completed" && row.status !== "failed") return;
      if (row.title != null || row.summary != null) return;

      const automation = this.store.getAutomationByIdIncludingArchived(
        row.automation_id
      );
      if (!automation) return;
      const cwd = this.store.getWorkspacePath(row.workspace_id);
      if (!cwd) return;

      const events = this.store.listRunEvents(runId);
      const outcomeEvidence = extractRunOutcomeEvidence(events);
      const parsedContext = this.store.parseChainContext(row);
      const pipelineId =
        parsedContext?.ok === true &&
        typeof parsedContext.context.variables.pipelineId === "string"
          ? parsedContext.context.variables.pipelineId
          : null;
      const workerKey = workerKeyFromConfigKey(automation.config_key);
      const contextAware =
        parsedContext?.ok === true &&
        row.chain_depth != null &&
        row.chain_max_depth != null &&
        row.chain_root_run_id != null;

      let generated: { title: string; summary: string } | null = null;
      let implementFullyPhase: {
        workerKey: string;
        featureId: string | null;
      } | null = null;
      if (
        contextAware &&
        isImplementFullyContext(pipelineId) &&
        workerKey != null
      ) {
        // Fast path: never call Agent.prompt for generated implement-fully workers.
        const featureId =
          typeof parsedContext!.context.variables.featureId === "string"
            ? parsedContext!.context.variables.featureId
            : null;
        const extracted =
          row.status === "completed"
            ? extractImplementFullyHandoff(outcomeEvidence, {
                expectedWorker: workerKey,
              })
            : null;
        generated = buildImplementFullyRunMetadata({
          workerKey,
          featureId,
          status: row.status,
          packet: extracted?.ok ? extracted.packet : null,
          errorHint: row.status === "failed" ? outcomeEvidence : null,
        });
        implementFullyPhase = { workerKey, featureId };
      } else {
        // Abandon promptly when shutting down so a hung Agent.prompt cannot
        // stall engine.shutdown() / db.close().
        generated = await this.raceWhileAlive(
          generateRunMetadata({
            apiKey: this.options.apiKey,
            cwd,
            automationName: automation.name,
            status: row.status,
            prompt: row.prompt ?? automation.prompt,
            outcomeEvidence,
          })
        );
      }
      if (!generated || this.shuttingDown) return;

      if (!this.store.setRunMetadataIfEligible(runId, generated)) return;
      this.store.appendEvent(runId, "run.metadata", {
        title: generated.title,
        summary: generated.summary,
      });

      // Fires the richer phase-completed toast (backlog id, phase type, timer,
      // description) that `notifyOnRunCompleted` deferred to at settle time.
      if (implementFullyPhase && row.status === "completed") {
        try {
          this.options.onImplementFullyPhaseCompleted?.(runId, {
            featureId: implementFullyPhase.featureId ?? "feature",
            workerKey: implementFullyPhase.workerKey,
            description: generated.summary,
            elapsedMs: elapsedMsBetween(row.started_at, row.ended_at),
          });
        } catch {
          // never let sink throw
        }
      }
    } catch (err) {
      this.log(
        `Run ${runId}: metadata generation failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      this.metadataInFlight.delete(runId);
    }
  }

  /** Resolve with `work`, or `null` as soon as {@link shuttingDown} is set. */
  private raceWhileAlive<T>(work: Promise<T | null>): Promise<T | null> {
    if (this.shuttingDown) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        if (this.shuttingDown) {
          clearInterval(iv);
          resolve(null);
        }
      }, 25);
      iv.unref?.();
      work.then(
        (value) => {
          clearInterval(iv);
          resolve(value);
        },
        (err: unknown) => {
          clearInterval(iv);
          reject(err);
        }
      );
    });
  }

  async triggerRun(
    automationId: string,
    triggerKind = "manual",
    options?: TriggerRunOptions
  ): Promise<string> {
    const automation = this.store.getAutomation(automationId);
    if (!automation) {
      throw new Error(`Automation not found: ${automationId}`);
    }

    const cwd = this.store.getWorkspacePath(automation.workspace_id);
    if (!cwd) {
      throw new Error(
        `Workspace path missing for automation ${automationId} (global automations cannot run yet).`
      );
    }

    const runId = randomUUID();
    const parentRunId = options?.parentRunId ?? null;
    let chainContext = options?.chainContext ?? null;

    if (chainContext) {
      const parsedContext = chainRunContextSchema.safeParse(chainContext);
      if (!parsedContext.success) {
        throw new TriggerRunValidationError("invalid chain context");
      }
      try {
        chainContext = {
          ...parsedContext.data,
          variables: normalizeImplementFullyChainVariables(
            parsedContext.data.variables
          ),
        };
      } catch (err) {
        const detail =
          err instanceof KickoffError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        throw new TriggerRunValidationError(detail);
      }

      const parsedMaxDepth = chainMaxDepthSchema.safeParse(
        options?.chainMaxDepth
      );
      if (!parsedMaxDepth.success) {
        throw new TriggerRunValidationError(
          "chainMaxDepth must be an integer from 1 to 500"
        );
      }

      if (parentRunId) {
        const childDepth = options?.chainDepth;
        if (
          !options?.chainRootRunId ||
          childDepth == null ||
          !Number.isInteger(childDepth) ||
          childDepth < 1 ||
          childDepth > parsedMaxDepth.data
        ) {
          throw new TriggerRunValidationError(
            "context-aware child requires valid root id and transition depth"
          );
        }
      }
    } else if (
      options?.chainRootRunId != null ||
      options?.chainDepth != null ||
      options?.chainMaxDepth != null
    ) {
      throw new TriggerRunValidationError(
        "chain metadata requires a validated chain context"
      );
    }

    let prompt: string;
    if (options?.promptOverride !== undefined) {
      // Already-final text from git/command/chain callers — do not re-template.
      prompt = options.promptOverride;
    } else if (chainContext && !parentRunId) {
      const rendered = renderChainTemplate(
        automation.prompt,
        chainContext.variables
      );
      if (!rendered.ok) {
        throw new TriggerRunValidationError(
          `template-error: ${rendered.message}`
        );
      }
      prompt = rendered.text;
    } else {
      prompt = automation.prompt;
    }

    const isContextRoot = Boolean(chainContext) && !parentRunId;
    const chainRootRunId = isContextRoot
      ? runId
      : (options?.chainRootRunId ?? null);
    const chainDepth = isContextRoot ? 0 : (options?.chainDepth ?? null);
    const chainMaxDepth = options?.chainMaxDepth ?? null;

    this.store.insertRun({
      id: runId,
      automationId,
      workspaceId: automation.workspace_id,
      triggerKind,
      prompt,
      parentRunId,
      modelSelectionOverride: options?.modelSelectionOverride,
      chainRootRunId,
      chainDepth,
      chainMaxDepth,
      chainContext,
      pipelineWaveId: options?.pipelineWaveId ?? null,
      pipelineTrackId: options?.pipelineTrackId ?? null,
      executionCwd: options?.executionCwd ?? null,
    });

    // The run is enqueued (status `queued`); the pump starts it now if a slot is
    // free, otherwise it waits for a running run to finish.
    this.pumpQueue();

    return runId;
  }

  /**
   * Optional wave-store seam for execution_cwd validation. Set by the daemon
   * after constructing PipelineWaveStore; absent in legacy/unit harnesses.
   */
  private waveStore: PipelineWaveStore | null = null;

  /**
   * Optional wave coordinator for escalate-abort → wave abort. Set after
   * constructing PipelineWaveCoordinator; absent in legacy/unit harnesses.
   */
  private waveCoordinator: PipelineWaveCoordinator | null = null;

  setPipelineWaveStore(store: PipelineWaveStore | null): void {
    this.waveStore = store;
  }

  setPipelineWaveCoordinator(
    coordinator: PipelineWaveCoordinator | null
  ): void {
    this.waveCoordinator = coordinator;
  }

  /** Resolve cwd/model/prompt for a persisted run, reading the stored override. */
  private buildContext(runId: string): RunContext | undefined {
    const row = this.store.getRun(runId);
    if (!row) {
      return undefined;
    }
    const automation = this.store.getAutomationByIdIncludingArchived(
      row.automation_id
    );
    if (!automation) {
      return undefined;
    }
    const workspacePath = this.store.getWorkspacePath(row.workspace_id);
    if (!workspacePath) {
      return undefined;
    }

    let cwd = workspacePath;
    if (row.execution_cwd != null && row.execution_cwd.trim() !== "") {
      const validated = this.validateExecutionCwd(row);
      if (!validated.ok) {
        this.store.appendEvent(runId, "run.error", {
          message: validated.message,
          code: "execution_cwd_invalid",
        });
        if (row.pipeline_wave_id && this.waveStore) {
          this.waveStore.blockWave(
            row.pipeline_wave_id,
            "execution-cwd-invalid",
            validated.message
          );
          this.store.appendEvent(runId, "run.pipeline-wave-blocked", {
            waveId: row.pipeline_wave_id,
            code: "execution-cwd-invalid",
            detail: validated.message,
          });
        }
        return undefined;
      }
      cwd = validated.cwd;
    }

    const modelSelection = resolveModelSelection(
      selectionFromStored(row.model, row.model_params_json),
      selectionFromStored(automation.model, automation.model_params_json)
    );
    return {
      cwd,
      model: modelSelection.id,
      modelSelection,
      prompt: row.prompt ?? automation.prompt,
    };
  }

  private validateExecutionCwd(
    row: RunRow
  ): { ok: true; cwd: string } | { ok: false; message: string } {
    const raw = row.execution_cwd;
    if (raw == null || raw.trim() === "") {
      return { ok: false, message: "execution_cwd missing" };
    }
    if (!row.pipeline_track_id || !this.waveStore) {
      return {
        ok: false,
        message: "execution_cwd set without an active track row",
      };
    }
    const track = this.waveStore.getTrack(row.pipeline_track_id);
    if (!track) {
      return { ok: false, message: "pipeline track not found" };
    }

    const resolved = resolve(raw);
    const expected = resolve(track.worktree_path);
    if (resolved !== expected) {
      return {
        ok: false,
        message: "execution_cwd does not match track worktree path",
      };
    }
    const root = resolve(pipelineWorktreesDir());
    const rel = relative(root, resolved);
    if (
      rel === "" ||
      rel.startsWith(`..${sep}`) ||
      rel === ".." ||
      isAbsolute(rel)
    ) {
      return { ok: false, message: "execution_cwd escapes worktrees dir" };
    }
    if (!existsSync(resolved)) {
      return { ok: false, message: "execution_cwd worktree missing on disk" };
    }
    return { ok: true, cwd: resolved };
  }

  /** Set or clear per-run model override; emits `run.model` for dashboard sync. */
  setRunModel(runId: string, model: ModelSelection | string | null): boolean {
    const row = this.store.getRun(runId);
    if (!row) return false;
    this.store.setRunModel(runId, model);
    const selection =
      model === null
        ? null
        : typeof model === "string"
          ? modelSelectionFromLegacy(model)
          : normalizeModelSelection(model);
    this.store.appendEvent(runId, "run.model", {
      model: legacyModelFromSelection(selection),
      modelSelection: selection,
    });
    return true;
  }

  private assertResumableRun(row: RunRow): ResumableRunRow {
    if (!row.agent_id || !row.sdk_run_id || row.agent_id.startsWith("bc-")) {
      throw new RunMessageError(
        "not_resumable",
        `Run ${row.id} is not resumable`
      );
    }
    return row as ResumableRunRow;
  }

  /**
   * Start as many `queued` runs as there are free concurrency slots. Active runs
   * (running + paused on input) count against the cap. Called after every
   * trigger and whenever a run reaches a terminal state.
   */
  private pumpQueue(): void {
    if (this.shuttingDown) {
      return;
    }
    while (this.store.countActiveRuns() < this.maxConcurrentRuns) {
      const next = this.store.getOldestQueuedRun();
      if (!next) {
        return;
      }
      const ctx = this.buildContext(next.id);
      if (!ctx) {
        // Missing workspace/automation — fail it so it can't wedge the queue.
        this.store.appendEvent(next.id, "run.error", {
          message: "cannot start run: workspace or automation unavailable",
        });
        this.transition(next.id, "queued", "failed");
        continue;
      }
      // executeRun flips queued → running synchronously before its first await,
      // so the next countActiveRuns() in this loop already reflects this start.
      this.track(this.executeRun(next.id, ctx));
    }
  }

  /** Prune the event tail, drain one queued chat message, and fill freed slots. */
  private afterRunSettled(runId: string): void {
    const row = this.store.getRun(runId);
    const terminal =
      row?.status === "completed" ||
      row?.status === "failed" ||
      row?.status === "cancelled";
    if (!terminal) {
      return;
    }
    const pruned = this.store.pruneRunEvents(runId, this.eventRetentionPerRun);
    if (pruned > 0) {
      this.log(`Run ${runId}: pruned ${pruned} old event(s) past retention cap`);
    }
    if (
      row.status === "completed" ||
      row.status === "failed"
    ) {
      this.scheduleQueuedMessageDelivery(runId);
    }
    this.pumpQueue();
  }

  /** Verify the per-run MCP token. Throws when a token is registered and differs. */
  verifyRunToken(runId: string, token: string | undefined): void {
    const expected = this.runTokens.get(runId);
    if (expected && token !== expected) {
      throw new Error(`Run ${runId}: invalid or missing run token`);
    }
  }

  private recoverRun(
    runId: string,
    reason: RunFailureReason,
    opts?: { backoffMs?: number }
  ): void {
    const row = this.store.getRun(runId);
    if (!row) {
      return;
    }
    if (row.status !== "running" && row.status !== "needs_input") {
      return;
    }

    const attempts = this.store.countSpawnAttempts(runId);
    if (attempts < this.maxSpawnAttempts) {
      const delay = opts?.backoffMs ?? 0;
      this.store.appendEvent(runId, "run.retry.scheduled", {
        reason,
        attempt: attempts,
        delayMs: delay,
      });
      this.transition(runId, row.status, "queued");
      this.scheduleDeferred(delay, () => this.pumpQueue());
      this.log(
        `Run ${runId}: ${reason} — requeued for retry (attempt ${attempts + 1}/${this.maxSpawnAttempts}, in ${delay}ms)`
      );
      return;
    }

    this.store.appendEvent(runId, "run.error", {
      reason: "retries_exhausted",
      cause: reason,
      attempts,
    });
    this.transition(runId, row.status, "failed");
    try {
      this.options.onRunFailed?.(runId, reason);
    } catch {
      // never let sink throw
    }
    this.log(
      `Run ${runId}: ${reason} — giving up after ${attempts} attempt(s), marked failed`
    );
    this.scheduleDeferred(0, () => this.pumpQueue());
  }

  /** SQLite `datetime('now')` is UTC without a zone suffix — parse as UTC. */
  private parseHeartbeatMs(updatedAt: string): number {
    return sqliteTimestampToMs(updatedAt);
  }

  private teardownStalledRun(runId: string): void {
    this.inFlight.get(runId)?.abort();
    const handle = this.activeRuns.get(runId);
    if (handle) {
      void handle.dispose().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Run ${runId}: dispose after stall failed: ${message}`);
      });
      this.activeRuns.delete(runId);
    }
    this.inFlight.delete(runId);
  }

  /** One watchdog pass; callable from tests without waiting on the interval timer. */
  runStallSweep(): void {
    for (const { id, updated_at } of this.store.listStallCandidates()) {
      try {
        const heartbeatMs = this.parseHeartbeatMs(updated_at);
        if (Number.isNaN(heartbeatMs)) {
          continue;
        }
        const idleMs = Date.now() - heartbeatMs;
        if (idleMs <= this.runStallTimeoutMs) {
          continue;
        }

        this.store.appendEvent(id, "run.stalled", {
          idleMs,
          thresholdMs: this.runStallTimeoutMs,
        });
        this.log(
          `Run ${id}: stalled — no activity for ${idleMs}ms (threshold ${this.runStallTimeoutMs}ms)`
        );
        this.teardownStalledRun(id);
        this.recoverRun(id, "stalled_idle", { backoffMs: this.retryBackoffMs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Run stall sweep: failed for ${id}: ${message}`);
      }
    }
  }

  /** Dispose retained sessions idle longer than `retainedSessionTtlMs`. */
  retainedSessionSweep(): void {
    const ttl = this.retainedSessionTtlMs;
    if (ttl <= 0) {
      return;
    }

    const now = Date.now();
    for (const [runId, entry] of this.retainedRuns) {
      const idleMs = now - entry.retainedAt;
      if (idleMs < ttl) {
        continue;
      }

      this.retainedRuns.delete(runId);
      this.runTokens.delete(runId);
      void entry.activeRun.dispose().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Run ${runId}: retained session dispose failed: ${message}`);
      });
      this.log(
        `Run ${runId}: retained session expired after ${idleMs}ms; disposed`
      );
    }
  }

  startWatchdog(): void {
    if (this.watchdogTimer !== undefined) {
      return;
    }
    const intervalMs = Math.max(
      5000,
      Math.min(30000, Math.floor(this.runStallTimeoutMs / 4))
    );
    this.watchdogTimer = setInterval(() => {
      this.runStallSweep();
      this.retainedSessionSweep();
    }, intervalMs);
    this.watchdogTimer.unref?.();
    this.log(
      `Stall watchdog armed (interval ${intervalMs}ms, threshold ${this.runStallTimeoutMs}ms)`
    );
  }

  stopWatchdog(): void {
    if (this.watchdogTimer === undefined) {
      return;
    }
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  private reconcileOrphanedRuns(): number {
    const orphans = this.store.listOrphanedActiveRuns();
    for (const row of orphans) {
      this.store.appendEvent(row.id, "run.reconciled", {
        priorStatus: row.status,
        reason: "orphaned_no_agent",
      });
      this.recoverRun(row.id, "orphaned_no_agent");
    }
    return orphans.length;
  }

  async cancelRun(runId: string): Promise<void> {
    const row = this.store.getRun(runId);
    if (!row) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (row.status === "queued") {
      this.store.cancelAllPendingQueuedMessages(runId);
      this.transition(runId, "queued", "cancelled");
      return;
    }

    if (row.status !== "running" && row.status !== "needs_input") {
      throw new Error(`Run ${runId} cannot be cancelled from status ${row.status}`);
    }

    this.pendingInterrupts.delete(runId);
    this.options.inputHub.cancelWaitersForRun(runId);
    this.store.cancelAllPendingQueuedMessages(runId);
    const controller = this.inFlight.get(runId);
    controller?.abort();
    const activeRun = this.activeRuns.get(runId);
    if (activeRun) {
      void activeRun.cancel().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Run ${runId}: SDK cancel failed: ${message}`);
      });
    }
    this.transition(runId, row.status, "cancelled");
  }

  /**
   * Remove finished runs from SQLite and drop any in-memory handles (including
   * retained local SDK sessions kept for interactive follow-up).
   */
  async purgeRuns(runIds: string[]): Promise<string[]> {
    const terminal: RunStatus[] = ["completed", "failed", "cancelled"];
    const terminalIds: string[] = [];

    for (const runId of runIds) {
      const row = this.store.getRun(runId);
      if (!row || !terminal.includes(row.status)) {
        continue;
      }
      terminalIds.push(runId);

      this.options.inputHub.cancelWaitersForRun(runId);

      const controller = this.inFlight.get(runId);
      controller?.abort();
      this.inFlight.delete(runId);

      const activeRun = this.activeRuns.get(runId);
      if (activeRun) {
        await activeRun.dispose();
        this.activeRuns.delete(runId);
      }

      const retained = this.retainedRuns.get(runId);
      if (retained) {
        await retained.activeRun.dispose();
        this.retainedRuns.delete(runId);
      }

      this.runTokens.delete(runId);
      this.pendingAnswers.delete(runId);
      this.answerWaiters.delete(runId);
    }

    const deleted = this.store.deleteTerminalRuns(terminalIds);
    for (const runId of deleted) {
      try {
        removeAttachmentOwnerDir("run", runId);
      } catch (err) {
        this.log(
          `Run ${runId}: attachment dir cleanup failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    this.options.events?.emitRunsDeleted?.(deleted);
    return deleted;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopWatchdog();

    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();

    for (const controller of this.inFlight.values()) {
      controller.abort();
    }

    const handles = [...this.activeRuns.values()];
    const retainedHandles = [...this.retainedRuns.values()].map(
      (retained) => retained.activeRun
    );

    // Cancel streams, then wait for in-flight run tasks to settle so no late
    // event/status write can race the caller's db.close().
    await Promise.allSettled(handles.map((activeRun) => activeRun.cancel()));
    await Promise.allSettled([...this.runTasks]);
    await Promise.allSettled(
      [...handles, ...retainedHandles].map((activeRun) => activeRun.dispose())
    );

    this.activeRuns.clear();
    this.retainedRuns.clear();
    this.inFlight.clear();
    this.runTokens.clear();
  }

  /**
   * Operator answer from dashboard / CLI / HTTP (not MCP-internal).
   * Halt-discovery briefing cards escalate the source once, then close the
   * advisory without delivering to MCP/SDK waiters or follow-up.
   */
  async submitAnswer(runId: string, answer: string): Promise<void> {
    const row = this.store.getRun(runId);
    if (!row) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (row.status !== "needs_input") {
      throw new Error(`Run ${runId} is not awaiting input (status=${row.status})`);
    }

    if (pendingIsHaltDiscoveryBriefing(this.options.inputHub, runId)) {
      await this.submitHaltDiscoveryBriefingAnswer(runId, answer);
      return;
    }

    const hadMcpWaiter = this.options.inputHub.hasActiveWaiter(runId);
    this.options.inputHub.submitAnswer(runId, answer);

    if (hadMcpWaiter) {
      this.store.appendEvent(runId, "input.delivered", { answer });
    } else {
      const waiter = this.answerWaiters.get(runId);
      if (waiter) {
        waiter(answer);
        this.answerWaiters.delete(runId);
        return;
      }
      if (this.activeRuns.has(runId)) {
        this.track(this.deliverAnswerFollowUp(runId, answer));
      } else {
        this.pendingAnswers.set(runId, answer);
      }
    }
  }

  /**
   * Persist a halt-discovery choice once, escalate the source as operator, and
   * close the advisory. Never queues follow-up or resumes the diagnosis agent.
   */
  private async submitHaltDiscoveryBriefingAnswer(
    runId: string,
    answer: string
  ): Promise<void> {
    const authority = resolveHaltDiscoveryBriefingAuthority(this.store, runId);
    if (!authority.ok) {
      throw new Error(
        `Run ${runId}: halt-discovery briefing is not authoritative (${authority.reason})`
      );
    }

    const pending = this.options.inputHub.getPendingQuestion(runId);
    if (!pending) {
      throw new Error(`No pending input request for run ${runId}`);
    }
    const meta = parseInputMetadataJson(pending.metadata_json);
    if (meta?.kind !== HALT_DISCOVERY_INPUT_KIND) {
      throw new Error(
        `Run ${runId}: pending input is not a halt-discovery briefing`
      );
    }

    const action = parseEscalationActionAnswer(answer);
    if (!action) {
      throw new Error(
        `Answer must be one of the declared choice ids (${RUN_ESCALATION_ACTIONS.join(", ")}); got "${answer}"`
      );
    }
    const choiceIds = new Set((meta.choices ?? []).map((c) => c.id));
    if (!choiceIds.has(action)) {
      throw new Error(
        `Answer must be one of the declared choice ids (${[...choiceIds].join(", ")}); got "${answer}"`
      );
    }

    // Durable compare-and-set gate; subsequent HTTP delivery fails here first.
    this.options.inputHub.submitAnswer(runId, answer);

    const reason = operatorBriefingReason(action);
    let payload: PipelineHaltDiscoveryActionResultPayload;
    try {
      const result = await this.escalateRun(
        authority.sourceRunId,
        { action, reason },
        { actor: "operator" }
      );
      if (result.ok) {
        payload = buildActionResultPayload({
          sourceRunId: authority.sourceRunId,
          advisoryRunId: authority.advisoryRunId,
          action,
          outcome: "acted",
          childRunId: result.response.childRunId ?? undefined,
        });
      } else {
        payload = buildActionResultPayload({
          sourceRunId: authority.sourceRunId,
          advisoryRunId: authority.advisoryRunId,
          action,
          outcome: "refused",
          code: result.reason,
          detail: result.message,
        });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.log(
        `Halt discovery action effect failed for advisory ${runId} (source ${authority.sourceRunId}): ${text}`
      );
      payload = buildActionResultPayload({
        sourceRunId: authority.sourceRunId,
        advisoryRunId: authority.advisoryRunId,
        action,
        outcome: "internal-failure",
        code: "effect-stage-error",
        detail: text,
      });
    }

    this.store.appendEvent(
      runId,
      "run.pipeline-halt-discovery-action-result",
      payload
    );

    const after = this.store.getRun(runId);
    if (after?.status === "needs_input") {
      this.transition(runId, "needs_input", "completed");
    }
  }

  async queueMessage(
    runId: string,
    text: string,
    attachmentRefs?: AttachmentRef[]
  ): Promise<string> {
    const attachments = resolveOperatorAttachments(
      this.attachments,
      "run",
      runId,
      attachmentRefs
    );
    if (!text.trim() && attachments.length === 0) {
      throw new RunMessageError("empty_message", "message is required");
    }

    const row = this.store.getRun(runId);
    if (!row) {
      throw new RunMessageError("not_found", `Run not found: ${runId}`);
    }
    if (row.status === "needs_input") {
      throw new RunMessageError(
        "needs_input",
        `Run ${runId} is awaiting input; use the answer endpoint`
      );
    }
    if (row.status === "queued") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} is busy (status=${row.status})`
      );
    }
    if (row.status === "paused") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} is paused; send a message directly to steer while paused`
      );
    }
    if (row.status !== "running") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} cannot queue messages in status ${row.status}; use sendMessage for terminal runs`
      );
    }

    const trimmed = text.trim();
    const refs = attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      kind: a.kind,
    }));
    const queuedMessageId = this.store.enqueueQueuedMessage(
      runId,
      trimmed,
      serializeAttachmentRefs(refs)
    );
    this.store.appendEvent(runId, "run.message.queued", {
      role: "user",
      text: trimmed,
      queuedMessageId,
      ...(refs.length > 0 ? { attachments: refs } : {}),
    });
    return queuedMessageId;
  }

  async interruptRun(
    runId: string,
    text: string,
    attachmentRefs?: AttachmentRef[]
  ): Promise<void> {
    const attachments = resolveOperatorAttachments(
      this.attachments,
      "run",
      runId,
      attachmentRefs
    );
    if (!text.trim() && attachments.length === 0) {
      throw new RunMessageError("empty_message", "message is required");
    }

    const row = this.store.getRun(runId);
    if (!row) {
      throw new RunMessageError("not_found", `Run not found: ${runId}`);
    }
    if (row.status === "queued") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} is busy (status=${row.status})`
      );
    }
    if (row.status === "needs_input") {
      throw new RunMessageError(
        "needs_input",
        `Run ${runId} is awaiting input; use the answer endpoint`
      );
    }

    const trimmed = text.trim();
    const refs = attachments.map((a) => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      kind: a.kind,
    }));
    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      await this.sendMessage(runId, trimmed, attachmentRefs);
      return;
    }

    if (row.status !== "running") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} cannot be interrupted from status ${row.status}`
      );
    }

    this.store.appendEvent(runId, "run.interrupted", {
      role: "user",
      text: trimmed,
      ...(refs.length > 0 ? { attachments: refs } : {}),
    });
    this.pendingInterrupts.set(
      runId,
      buildOperatorMessage(trimmed, attachments)
    );

    this.options.inputHub.cancelWaitersForRun(runId);
    const controller = this.inFlight.get(runId);
    controller?.abort();
    const activeRun = this.activeRuns.get(runId);
    if (activeRun) {
      void activeRun.cancel().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Run ${runId}: SDK cancel during interrupt failed: ${message}`);
      });
    } else if (!this.inFlight.has(runId)) {
      this.maybeStartPendingInterrupt(runId);
    }
  }

  async pauseRun(runId: string): Promise<void> {
    const row = this.store.getRun(runId);
    if (!row) {
      throw new RunMessageError("not_found", `Run not found: ${runId}`);
    }
    if (row.status === "needs_input") {
      throw new RunMessageError(
        "needs_input",
        "answer or cancel; pause is not available"
      );
    }
    if (row.status !== "running") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} cannot be paused from status ${row.status}`
      );
    }

    this.store.appendEvent(runId, "run.paused", { reason: "operator" });
    this.pendingInterrupts.delete(runId);
    this.options.inputHub.cancelWaitersForRun(runId);
    const controller = this.inFlight.get(runId);
    controller?.abort();
    const activeRun = this.activeRuns.get(runId);
    if (activeRun) {
      void activeRun.cancel().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Run ${runId}: SDK cancel during pause failed: ${message}`);
      });
    }
    this.transition(runId, "running", "paused");
  }

  async resumeRun(runId: string, note?: string): Promise<void> {
    const row = this.store.getRun(runId);
    if (!row) {
      throw new RunMessageError("not_found", `Run not found: ${runId}`);
    }
    if (row.status !== "paused") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} cannot be resumed from status ${row.status}`
      );
    }

    const parsedContext = this.store.parseChainContext(row);
    const chainContext =
      parsedContext?.ok === true ? parsedContext.context : null;
    let prompt = buildPauseResumePrompt({ chainContext });
    const trimmedNote = note?.trim();
    if (trimmedNote) {
      prompt = `${prompt}\n\nOperator note:\n${trimmedNote}`;
    }

    this.store.appendEvent(runId, "run.pause.resumed", {});
    this.startFollowUp(runId, prompt, row);
  }

  async sendMessage(
    runId: string,
    text: string,
    attachmentRefs?: AttachmentRef[]
  ): Promise<void> {
    const attachments = resolveOperatorAttachments(
      this.attachments,
      "run",
      runId,
      attachmentRefs
    );
    if (!text.trim() && attachments.length === 0) {
      throw new RunMessageError("empty_message", "message is required");
    }

    const row = this.store.getRun(runId);
    if (!row) {
      throw new RunMessageError("not_found", `Run not found: ${runId}`);
    }
    if (row.status === "running" || row.status === "queued") {
      throw new RunMessageError(
        "busy",
        `Run ${runId} is busy (status=${row.status})`
      );
    }
    if (row.status === "needs_input") {
      throw new RunMessageError(
        "needs_input",
        `Run ${runId} is awaiting input; use the answer endpoint`
      );
    }

    this.startFollowUp(
      runId,
      buildOperatorMessage(text.trim(), attachments),
      row,
      row.status === "paused" ? { keepPaused: true } : undefined
    );
  }

  /**
   * Resume or retained-session follow-up after validation. Synchronous up to the
   * tracked task launch (like the original `sendMessage`) so event ordering and
   * caller timing are preserved.
   */
  private startFollowUp(
    runId: string,
    message: string | OperatorMessage,
    rowOverride?: RunRow,
    options?: { keepPaused?: boolean }
  ): void {
    const row = rowOverride ?? this.store.getRun(runId);
    if (!row) {
      throw new RunMessageError("not_found", `Run not found: ${runId}`);
    }

    const operatorMessage =
      typeof message === "string"
        ? buildOperatorMessage(message, [])
        : message;
    const text = operatorMessage.text;
    const attachmentMeta = (operatorMessage.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      kind: a.kind,
    }));

    const resumable = this.assertResumableRun(row);
    const ctx = this.buildContext(runId);
    if (!ctx) {
      throw new RunMessageError(
        "context_missing",
        `Run ${runId} cannot be resumed: workspace or automation unavailable`
      );
    }

    const { text: resolvedText, referencesEvent } =
      this.resolveOperatorMessageReferences(runId, ctx.cwd, text);
    const deliverMessage = buildOperatorMessage(
      resolvedText,
      operatorMessage.attachments ?? []
    );

    const seq = this.store.appendEvent(runId, "run.message", {
      role: "user",
      text,
      ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
    });
    if (attachmentMeta.length > 0) {
      this.attachments.associateWithMessageSeq(
        "run",
        runId,
        attachmentMeta.map((a) => a.id),
        seq
      );
    }
    if (referencesEvent) {
      this.store.appendEvent(runId, "run.references", referencesEvent);
    }
    if (resumable.status !== "running" && !options?.keepPaused) {
      this.transition(runId, resumable.status, "running");
    }

    const originalStatus = row.status;
    const abort = new AbortController();
    this.inFlight.set(runId, abort);

    const retained = this.retainedRuns.get(runId);
    const runToken = retained?.runToken ?? randomUUID();
    this.runTokens.set(runId, runToken);

    if (retained) {
      this.retainedRuns.delete(runId);
      this.track(
        this.sendRetainedMessage(runId, retained.activeRun, deliverMessage, {
          ctx,
          resumable,
          abort,
          originalStatus,
        })
      );
    } else {
      this.track(
        this.resumeWithMessage(
          runId,
          ctx,
          resumable,
          deliverMessage,
          abort,
          runToken,
          originalStatus
        )
      );
    }
  }

  private scheduleQueuedMessageDelivery(runId: string): void {
    this.scheduleDeferred(0, () => {
      this.deliverNextQueuedMessage(runId);
    });
  }

  private deliverNextQueuedMessage(runId: string): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.inFlight.has(runId) || this.activeRuns.has(runId)) {
      return;
    }

    const row = this.store.getRun(runId);
    if (
      !row ||
      row.status === "cancelled" ||
      (row.status !== "completed" && row.status !== "failed")
    ) {
      return;
    }

    try {
      this.assertResumableRun(row);
    } catch {
      return;
    }

    const pending = this.store.getOldestPendingQueuedMessage(runId);
    if (!pending) {
      return;
    }

    try {
      const operatorMessage = operatorMessageFromQueued(
        this.attachments,
        "run",
        runId,
        pending.message,
        pending.attachments_json
      );
      this.startFollowUp(runId, operatorMessage, row);
      this.store.markQueuedMessageDelivered(pending.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Run ${runId}: queued message delivery failed: ${message}`);
      this.store.appendEvent(runId, "run.error", {
        message,
        queuedMessageId: pending.id,
        phase: "queued_delivery",
      });
    }
  }

  /** Start interrupt follow-up once the active stream has released in-memory state. */
  private maybeStartPendingInterrupt(runId: string): boolean {
    const interruptMessage = this.pendingInterrupts.get(runId);
    if (!interruptMessage) {
      return false;
    }
    this.pendingInterrupts.delete(runId);
    this.scheduleDeferred(0, () => {
      const row = this.store.getRun(runId);
      if (!row || row.status === "cancelled") {
        return;
      }
      try {
        this.startFollowUp(runId, interruptMessage, row);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Run ${runId}: interrupt follow-up failed: ${message}`);
        this.store.appendEvent(runId, "run.error", {
          message,
          phase: "interrupt_follow_up",
        });
      }
    });
    return true;
  }

  /**
   * Blocking ask used by automations-io MCP over HTTP. `token` is the per-run
   * secret minted at spawn; it must match when a token is registered for the run.
   */
  async askAndWait(
    runId: string,
    question: string,
    token?: string,
    metadata?: InputRequestMetadata | null
  ): Promise<string> {
    const row = this.store.getRun(runId);
    if (!row) {
      throw new Error(`Run not found: ${runId}`);
    }
    this.verifyRunToken(runId, token);
    if (row.status !== "running") {
      throw new Error(
        `Run ${runId} cannot accept ask_user in status ${row.status}`
      );
    }

    const payload: Record<string, unknown> = { question };
    if (metadata != null) {
      payload.metadata = metadata;
    }
    this.store.appendEvent(runId, "input.asked", payload);
    return this.options.inputHub.ask(runId, question, metadata);
  }

  /**
   * Run-scoped stop / re-budget / additive extension. Verifies the per-run MCP
   * token, then delegates persistence to {@link RunStore.applyChainControl}.
   * Emits `run.chain-control` only when a decision was newly written (identical
   * repeats are silent no-ops).
   */
  applyChainControl(
    runId: string,
    request: ChainControlRequest,
    token?: string
  ): ApplyRunChainControlResult {
    try {
      this.verifyRunToken(runId, token);
    } catch {
      return { ok: false, reason: "forbidden" };
    }

    const before = this.store.getRun(runId);
    const result = this.store.applyChainControl(runId, request);
    if (!result.ok) {
      return result;
    }

    const wroteStop =
      request.stop !== undefined &&
      (before == null || before.chain_stop_requested_at == null) &&
      result.response.stopRequested;
    const wroteRebudget =
      request.rebudget !== undefined &&
      (before == null || before.chain_max_depth_override == null) &&
      result.response.maxDepthOverride != null;
    // First acceptance always emits (including clamped zero-growth); identical
    // retries leave the pre-existing override and stay silent.
    const wroteExtend =
      request.extendBudget !== undefined &&
      (before == null || before.chain_max_depth_override == null) &&
      result.response.budgetExtension != null;

    if (wroteStop || wroteRebudget || wroteExtend) {
      const payload: Record<string, unknown> = {};
      if (wroteStop && request.stop) {
        payload.stop = true;
        payload.reason = request.stop.reason;
      }
      if (wroteRebudget && request.rebudget) {
        payload.rebudget = true;
        payload.maxDepth = request.rebudget.maxDepth;
      }
      if (wroteExtend && result.response.budgetExtension) {
        const ext = result.response.budgetExtension;
        payload.extendBudget = true;
        payload.previousEffectiveMaxDepth = ext.previousEffectiveMaxDepth;
        payload.requestedTransitions = ext.requestedTransitions;
        payload.appliedTransitions = ext.appliedTransitions;
        payload.effectiveMaxDepth = result.response.effectiveMaxDepth;
        payload.clamped = ext.clamped;
      }
      this.store.appendEvent(runId, "run.chain-control", payload);
      const parts: string[] = [];
      if (wroteStop) {
        parts.push("stop");
      }
      if (wroteRebudget) {
        parts.push(`rebudget=${request.rebudget!.maxDepth}`);
      }
      if (wroteExtend && result.response.budgetExtension) {
        const ext = result.response.budgetExtension;
        parts.push(
          `extend=+${ext.requestedTransitions}→${ext.appliedTransitions}` +
            (ext.clamped ? " (clamped)" : "")
        );
      }
      this.log(`Run ${runId}: chain-control ${parts.join(", ")}`);
    }

    return { ok: true, response: result.response };
  }

  /**
   * Operator or daemon escalation (retry / skip / abort). Not gated by run token.
   * Optional call context is runtime-only (defaults to operator).
   */
  escalateRun(
    runId: string,
    request: RunEscalationRequest,
    callContext?: EscalationCallContext
  ): Promise<EscalateResult> {
    const coordinator = this.waveCoordinator;
    return performEscalation(
      {
        store: this.store,
        engine: this,
        onLog: (message) => this.log(message),
        abortTrackWave: coordinator
          ? (id, reason) => coordinator.abortWaveForTrackRun(id, reason)
          : undefined,
      },
      runId,
      request,
      callContext
    );
  }

  async resumeInterruptedRuns(): Promise<void> {
    const rows = this.store.listResumableRuns();

    // Re-attach runs that were active (running / needs_input) when the daemon
    // last stopped. These already hold a concurrency slot, so they bypass the
    // queue gate; the pump below then backfills any runs left `queued`.
    for (const row of rows) {
      // Parked halt-discovery briefing hosts are not interrupted agent sessions.
      if (
        isParkedAuthoritativeHaltDiscoveryBriefing(
          this.store,
          this.options.inputHub,
          row.id
        )
      ) {
        this.log(
          `Leaving parked halt-discovery briefing ${row.id} without re-attach`
        );
        continue;
      }

      const ctx = this.buildContext(row.id);
      if (!ctx || !row.agent_id || !row.sdk_run_id) {
        continue;
      }

      this.log(
        `Re-attaching run ${row.id} (agent ${row.agent_id}, sdk run ${row.sdk_run_id})`
      );

      this.track(
        this.executeRun(row.id, ctx, {
          resume: {
            agentId: row.agent_id,
            sdkRunId: row.sdk_run_id,
          },
        })
      );
    }

    const reconciled = this.reconcileOrphanedRuns();
    if (reconciled > 0) {
      this.log(`Reconciled ${reconciled} orphaned run(s) with no agent`);
    }

    // Runs that crashed while still `queued` never started an agent; start them
    // now (respecting the concurrency cap). Orphans requeued above are picked up
    // here too.
    this.pumpQueue();
  }

  getRun(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) {
      return undefined;
    }
    return {
      run,
      events: this.store.listRunEvents(runId),
      inputRequests: this.options.inputHub
        .listForRun(runId)
        .map((row) => rowToInputRequest(row)),
    };
  }

  listSteerCandidateRunsForWorkspace(workspaceId: string) {
    return this.store.listSteerCandidateRunsForWorkspace(workspaceId);
  }

  /** Validate a terminal resumable run and gather data for chat promotion. */
  prepareForPromotion(runId: string): RunPromotionSource {
    const row = this.store.getRun(runId);
    if (!row) {
      throw new RunMessageError("not_found", `Run not found: ${runId}`);
    }
    const terminal =
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled";
    if (!terminal) {
      throw new RunMessageError(
        "busy",
        `Run ${runId} cannot be promoted while status is ${row.status}`
      );
    }
    const resumable = this.assertResumableRun(row);
    const ctx = this.buildContext(runId);
    if (!ctx) {
      throw new RunMessageError(
        "context_missing",
        `Run ${runId}: workspace or automation unavailable`
      );
    }
    return {
      run: resumable,
      model: ctx.modelSelection,
      events: this.store.listRunEvents(runId),
    };
  }

  /**
   * Promote an authoritative halt-discovery advisory briefing into a workspace
   * chat. Returns null when the run is not a halt-discovery advisory (generic
   * b28 promotion should proceed). Releases the retained run session after a
   * successful create or idempotent reuse.
   */
  async promoteHaltDiscoveryToChatIfApplicable(
    runId: string,
    chatEngine: ChatEngine,
    options?: { afterClaimHook?: () => void }
  ): Promise<HaltDiscoveryPromotionResult | null> {
    const authority = resolveHaltDiscoveryBriefingAuthority(this.store, runId);
    if (!authority.ok) {
      return null;
    }

    const existing = chatEngine
      .getChatStore()
      .findActiveByOriginRunId(authority.advisoryRunId);
    if (existing) {
      await this.releaseRetainedRun(runId);
      return { kind: "existing", chat: existing };
    }

    const ctx = this.buildContext(runId);
    if (!ctx) {
      throw new RunMessageError(
        "context_missing",
        `Run ${runId}: workspace or automation unavailable`
      );
    }

    let result: HaltDiscoveryPromotionResult | null;
    try {
      result = promoteHaltDiscoveryAdvisory({
        db: this.db,
        store: this.store,
        inputHub: this.options.inputHub,
        chatEngine,
        advisoryRunId: runId,
        model: ctx.modelSelection,
        assertResumable: (row) => {
          try {
            return this.assertResumableRun(row);
          } catch (err) {
            if (err instanceof RunMessageError) {
              throw new HaltDiscoveryPromotionError(
                err.code === "not_resumable" ||
                  err.code === "not_found" ||
                  err.code === "context_missing" ||
                  err.code === "busy"
                  ? err.code
                  : "busy",
                err.message
              );
            }
            throw err;
          }
        },
        afterClaimHook: options?.afterClaimHook,
      });
    } catch (err) {
      if (err instanceof HaltDiscoveryPromotionError) {
        const code: RunMessageErrorCode =
          err.code === "conflict" ? "busy" : err.code;
        throw new RunMessageError(code, err.message);
      }
      throw err;
    }

    if (!result) {
      return null;
    }

    await this.releaseRetainedRun(runId);
    if (result.kind === "created") {
      this.log(
        `Run ${runId}: needs_input → completed (halt-discovery chat promotion)`
      );
    }
    return result;
  }

  /** Drop the in-memory retained SDK session so chat owns the agent exclusively. */
  async releaseRetainedRun(runId: string): Promise<void> {
    try {
      const retained = this.retainedRuns.get(runId);
      if (retained) {
        await retained.activeRun.dispose();
        this.retainedRuns.delete(runId);
      }
      this.runTokens.delete(runId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Run ${runId}: releaseRetainedRun failed: ${message}`);
    }
  }

  private async deliverAnswerFollowUp(
    runId: string,
    answer: string
  ): Promise<void> {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun?.sendFollowUp) {
      this.log(
        `Run ${runId}: answer recorded but no active agent to deliver follow-up`
      );
      return;
    }

    const ctx = this.buildContext(runId);
    if (!ctx) {
      this.log(
        `Run ${runId}: answer recorded but no active agent to deliver follow-up`
      );
      return;
    }

    try {
      const next = await this.sendFollowUpAndFinalize(
        runId,
        activeRun,
        `Operator answer (resume after pause): ${answer}`,
        ctx.modelSelection,
        {
          missingFollowUpMessage: "Executor cannot deliver operator answer",
          deliveredEvent: { type: "input.delivered", payload: { answer } },
        }
      );
      await this.cleanupRunAfterTask(runId, next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Run ${runId}: follow-up delivery failed: ${message}`);
      this.store.appendEvent(runId, "run.error", { message });
      const current = this.store.getRun(runId);
      if (
        current &&
        (current.status === "running" ||
          current.status === "needs_input" ||
          current.status === "paused")
      ) {
        this.transition(runId, current.status, "failed");
      }
      // Always release slot accounting on the failure path (matching the prior
      // unconditional cleanup), even if the run somehow isn't terminal.
      await this.cleanupRunAfterTask(runId, this.activeRuns.get(runId), {
        alwaysRelease: true,
      });
    }
  }

  private async sendRetainedMessage(
    runId: string,
    activeRun: ActiveRun,
    message: OperatorMessage,
    followUp: RetainedFollowUpContext
  ): Promise<void> {
    this.activeRuns.set(runId, activeRun);
    const ctx = this.buildContext(runId);
    this.store.appendEvent(runId, "run.resumed", {
      interactive: true,
      retained: true,
      agentId: activeRun.agentId,
      sdkRunId: activeRun.sdkRunId,
      ...(ctx ? { model: ctx.model, modelSelection: ctx.modelSelection } : {}),
    });

    const delivery = await this.runRetainedTurn(
      runId,
      activeRun,
      message,
      followUp.ctx.modelSelection,
      followUp.abort.signal
    );

    if (delivery.kind === "fallback") {
      this.activeRuns.delete(runId);
      for (const handle of new Set(
        [activeRun, delivery.activeRun].filter((h): h is ActiveRun => Boolean(h))
      )) {
        try {
          await handle.dispose();
        } catch {
          /* ignore */
        }
      }

      if (followUp.abort.signal.aborted) {
        const current = this.store.getRun(runId);
        if (
          current &&
          (current.status === "running" ||
            current.status === "needs_input" ||
            current.status === "paused") &&
          current.status !== followUp.originalStatus
        ) {
          this.transition(runId, current.status, followUp.originalStatus);
        }
        this.inFlight.delete(runId);
        return;
      }

      this.store.appendEvent(runId, "run.retained.fallback", {
        message: delivery.message,
      });
      this.log(
        `Run ${runId}: retained session unusable; falling back to cold resume`
      );

      const freshToken = randomUUID();
      this.runTokens.set(runId, freshToken);
      await this.resumeWithMessage(
        runId,
        followUp.ctx,
        followUp.resumable,
        message,
        followUp.abort,
        freshToken,
        followUp.originalStatus
      );
      return;
    }

    if (delivery.kind === "turn_failed") {
      this.log(
        `Run ${runId}: retained interactive message failed: ${delivery.errMessage}`
      );
      this.store.appendEvent(runId, "run.error", { message: delivery.errMessage });
      const current = this.store.getRun(runId);
      if (
        current &&
        (current.status === "running" ||
          current.status === "needs_input" ||
          current.status === "paused")
      ) {
        this.transition(runId, current.status, "failed");
      }
      await this.cleanupRunAfterTask(runId, delivery.activeRun, {
        alwaysRelease: true,
      });
      return;
    }

    await this.cleanupRunAfterTask(runId, delivery.activeRun);
  }

  private appendPausedTurnSettled(
    runId: string,
    sdkStatus: string,
    result: unknown
  ): void {
    this.store.appendEvent(runId, "run.paused.turn.settled", {
      sdkStatus,
      result: result ?? null,
    });
  }

  private async runRetainedTurn(
    runId: string,
    activeRun: ActiveRun,
    message: OperatorMessage,
    model: ModelSelection,
    signal: AbortSignal
  ): Promise<RetainedTurnResult> {
    if (!activeRun.sendFollowUp) {
      return {
        kind: "fallback",
        message: "Executor cannot deliver interactive message",
      };
    }

    let next: ActiveRun;
    try {
      next = await activeRun.sendFollowUp(message, model);
      this.activeRuns.set(runId, next);
      this.store.setAgentIds(runId, next.agentId, next.sdkRunId);
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      return { kind: "fallback", message: errMessage };
    }

    const output = { meaningful: false };
    try {
      await this.consumeStreamWithMeaningfulOutput(runId, next, signal, output);

      if (signal.aborted) {
        return { kind: "success", activeRun: next };
      }

      const result = await next.wait();
      const current = this.store.getRun(runId);
      if (
        !current ||
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ) {
        return { kind: "success", activeRun: next };
      }

      if (result.status === "error" && !output.meaningful) {
        return {
          kind: "fallback",
          message: "sdk error with no output",
          activeRun: next,
        };
      }

      if (current.status === "paused") {
        this.appendPausedTurnSettled(runId, result.status, result.result);
        return { kind: "success", activeRun: next };
      }

      const terminal = mapSdkResultStatus(result.status);
      if (current.status === "running" || current.status === "needs_input") {
        this.transition(runId, current.status, terminal);
      }
      this.store.appendEvent(runId, "run.finished", {
        sdkStatus: result.status,
        result: result.result ?? null,
      });

      return { kind: "success", activeRun: next };
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      if (!output.meaningful) {
        return { kind: "fallback", message: errMessage, activeRun: next };
      }
      return { kind: "turn_failed", activeRun: next, errMessage };
    }
  }

  private async consumeStreamWithMeaningfulOutput(
    runId: string,
    activeRun: ActiveRun,
    signal: AbortSignal,
    output: { meaningful: boolean }
  ): Promise<void> {
    const sentinelTasks = new Set<Promise<void>>();

    for await (const message of activeRun.stream()) {
      if (signal.aborted) {
        await activeRun.cancel();
        return;
      }

      if (message.type !== "status") {
        output.meaningful = true;
      }

      const sdkRunId = extractRunIdFromMessage(message);
      if (sdkRunId) {
        const row = this.store.getRun(runId);
        if (row && !row.sdk_run_id) {
          this.store.setAgentIds(runId, activeRun.agentId, sdkRunId);
        }
      }

      this.store.appendEvent(runId, message.type, message as SDKMessage);

      const sentinelQuestion = extractNeedsInputFromMessage(message);
      if (sentinelQuestion) {
        const task = this.handleSentinelAsk(runId, sentinelQuestion);
        sentinelTasks.add(task);
        void task.finally(() => sentinelTasks.delete(task));
      }
    }

    await Promise.allSettled(sentinelTasks);
  }

  private async reviveWithMessage(
    runId: string,
    ctx: RunContext,
    resume: ResumableRunRow,
    message: OperatorMessage,
    abort: AbortController
  ): Promise<"handled" | "spawn_failed" | "aborted"> {
    if (abort.signal.aborted) return "aborted";

    const transcript = synthesizeTranscript(this.store.listRunEvents(runId));
    const primer = buildRevivePrimer({
      transcript,
      newMessage: message.text,
    });
    this.log(`Run ${runId}: session gone; reviving with transcript primer`);

    const runToken = randomUUID();
    this.runTokens.set(runId, runToken);
    let fresh: ActiveRun;
    try {
      fresh = await this.spawnWithTimeout("spawn", () =>
        this.options.executor.spawn({
          apiKey: this.options.apiKey,
          cwd: ctx.cwd,
          model: ctx.modelSelection,
          prompt: {
            text: primer.text,
            attachments: message.attachments,
          },
          runId,
          runToken,
          automationsIoTools: this.automationsIoToolsForRun(runId),
        })
      );
    } catch {
      return abort.signal.aborted ? "aborted" : "spawn_failed";
    }

    if (abort.signal.aborted) {
      await fresh.dispose().catch(() => {});
      return "aborted";
    }

    this.activeRuns.set(runId, fresh);
    this.store.setAgentIds(runId, fresh.agentId, fresh.sdkRunId);
    this.store.appendEvent(runId, "run.revived", {
      previousAgentId: resume.agent_id,
      previousSdkRunId: resume.sdk_run_id,
      agentId: fresh.agentId,
      sdkRunId: fresh.sdkRunId,
      model: ctx.model,
      modelSelection: ctx.modelSelection,
      transcriptMessages: primer.transcriptMessages,
      truncated: primer.truncated,
    });
    try {
      await this.consumeAndFinalize(runId, fresh, abort.signal);
    } catch (err) {
      // The revive spawn succeeded, so this is a genuine mid-stream failure of
      // the revived run — handle it exactly like any other run error instead of
      // degrading to the stale outcome.
      if (abort.signal.aborted) {
        return "aborted";
      }
      const errMessage = err instanceof Error ? err.message : String(err);
      this.log(`Run ${runId}: revived run error: ${errMessage}`);
      this.store.appendEvent(runId, "run.error", { message: errMessage });
      const current = this.store.getRun(runId);
      if (
        current &&
        (current.status === "running" ||
          current.status === "needs_input" ||
          current.status === "paused")
      ) {
        this.transition(runId, current.status, "failed");
      }
    }
    return "handled";
  }

  private async resumeWithMessage(
    runId: string,
    ctx: RunContext,
    resume: ResumableRunRow,
    message: OperatorMessage,
    abort: AbortController,
    runToken: string,
    originalStatus: RunStatus
  ): Promise<void> {
    let activeRun: ActiveRun | undefined;

    try {
      activeRun = await this.resumeRunWithRetry(
        runId,
        () =>
          this.options.executor.resume({
            apiKey: this.options.apiKey,
            cwd: ctx.cwd,
            model: ctx.modelSelection,
            prompt: ctx.prompt,
            runId,
            runToken,
            agentId: resume.agent_id,
            sdkRunId: resume.sdk_run_id,
            automationsIoTools: this.automationsIoToolsForRun(runId),
          }),
        abort.signal
      );

      this.activeRuns.set(runId, activeRun);
      this.store.setAgentIds(runId, activeRun.agentId, activeRun.sdkRunId);
      this.store.appendEvent(runId, "run.resumed", {
        interactive: true,
        agentId: activeRun.agentId,
        sdkRunId: activeRun.sdkRunId,
        model: ctx.model,
        modelSelection: ctx.modelSelection,
      });

      activeRun = await this.sendFollowUpAndFinalize(
        runId,
        activeRun,
        message,
        ctx.modelSelection,
        {
          missingFollowUpMessage: "Executor cannot deliver interactive message",
        }
      );
    } catch (err) {
      if (abort.signal.aborted) {
        const current = this.store.getRun(runId);
        if (
          current &&
          (current.status === "running" ||
            current.status === "needs_input" ||
            current.status === "paused") &&
          current.status !== originalStatus
        ) {
          this.transition(runId, current.status, originalStatus);
        }
        return;
      }

      const errMessage =
        err instanceof CursorAgentError
          ? `startup failed: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);

      if (isAuthResumeError(err)) {
        this.log(
          `Run ${runId}: cold resume failed auth (auth_expired); run restored to ${originalStatus}`
        );
        this.store.appendEvent(runId, "run.error", {
          message: errMessage,
          reason: "auth_expired",
        });
        const current = this.store.getRun(runId);
        if (
          current &&
          (current.status === "running" ||
            current.status === "needs_input" ||
            current.status === "paused") &&
          current.status !== originalStatus
        ) {
          this.transition(runId, current.status, originalStatus);
        }
        this.options.onAuthExpired?.("run", runId, errMessage);
        return;
      }

      const stale = /not found/i.test(errMessage);
      if (stale && this.sessionRevive) {
        const revived = await this.reviveWithMessage(
          runId,
          ctx,
          resume,
          message,
          abort
        );
        if (revived === "handled" || revived === "aborted") {
          if (revived === "aborted") {
            const current = this.store.getRun(runId);
            if (
              current &&
              (current.status === "running" ||
                current.status === "needs_input" ||
                current.status === "paused") &&
              current.status !== originalStatus
            ) {
              this.transition(runId, current.status, originalStatus);
            }
          }
          return;
        }
        this.log(
          `Run ${runId}: local agent session expired — follow-up dropped, restored to ${originalStatus} (stale)`
        );
        this.store.appendEvent(runId, "run.error", {
          message: errMessage,
          stale: true,
          reviveFailed: true,
        });
        const current = this.store.getRun(runId);
        if (
          current &&
          (current.status === "running" ||
            current.status === "needs_input" ||
            current.status === "paused") &&
          current.status !== originalStatus
        ) {
          this.transition(runId, current.status, originalStatus);
        }
        return;
      }
      this.log(
        stale
          ? `Run ${runId}: local agent session expired — follow-up dropped, restored to ${originalStatus} (stale)`
          : `Run ${runId}: interactive message failed: ${errMessage}`
      );
      this.store.appendEvent(runId, "run.error", { message: errMessage, stale });

      const current = this.store.getRun(runId);
      if (
        current &&
        (current.status === "running" ||
          current.status === "needs_input" ||
          current.status === "paused")
      ) {
        // An interactive follow-up runs against an already-terminal run. If the
        // local SDK session has expired (stale), the prior conversation history
        // is intact — restore the run to its original terminal status instead
        // of corrupting a completed run into `failed`. Genuine errors still fail.
        // Sticky paused turns keep status `paused`; skip no-op restore so we
        // never assert an illegal paused → paused edge.
        const target = stale ? originalStatus : "failed";
        if (current.status !== target) {
          this.transition(runId, current.status, target);
        }
      }
    } finally {
      await this.cleanupRunAfterTask(runId, this.activeRuns.get(runId) ?? activeRun, {
        alwaysRelease: true,
      });
    }
  }

  private async sendFollowUpAndFinalize(
    runId: string,
    activeRun: ActiveRun,
    message: string | OperatorMessage,
    model: ModelSelection,
    options: {
      missingFollowUpMessage: string;
      deliveredEvent?: { type: string; payload: unknown };
    }
  ): Promise<ActiveRun | undefined> {
    if (!activeRun.sendFollowUp) {
      throw new Error(options.missingFollowUpMessage);
    }

    const next = await activeRun.sendFollowUp(message, model);
    this.activeRuns.set(runId, next);
    this.store.setAgentIds(runId, next.agentId, next.sdkRunId);
    if (options.deliveredEvent) {
      this.store.appendEvent(
        runId,
        options.deliveredEvent.type,
        options.deliveredEvent.payload
      );
    }

    const abort = this.inFlight.get(runId);
    if (!abort) {
      this.log(`Run ${runId}: follow-up delivered without active run controller`);
      return next;
    }

    await this.consumeAndFinalize(runId, next, abort.signal);
    return next;
  }

  private canRetainRunSession(
    row: RunRow | undefined,
    activeRun: ActiveRun | undefined,
    runToken: string | undefined
  ): row is ResumableRunRow {
    const retainableStatus =
      row?.status === "completed" ||
      row?.status === "failed" ||
      row?.status === "cancelled" ||
      row?.status === "paused";
    return Boolean(
      retainableStatus &&
        activeRun?.sendFollowUp &&
        runToken &&
        row?.agent_id &&
        row?.sdk_run_id &&
        !row.agent_id.startsWith("bc-")
    );
  }

  private async cleanupRunAfterTask(
    runId: string,
    activeRun?: ActiveRun,
    options: { alwaysRelease?: boolean } = {}
  ): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const finalRow = this.store.getRun(runId);
    const terminal =
      finalRow?.status === "completed" ||
      finalRow?.status === "failed" ||
      finalRow?.status === "cancelled";
    const paused = finalRow?.status === "paused";

    const runToken = this.runTokens.get(runId);
    const retained = this.canRetainRunSession(finalRow, activeRun, runToken);

    if (activeRun && retained && runToken) {
      this.retainedRuns.set(runId, {
        activeRun,
        runToken,
        retainedAt: Date.now(),
      });
    } else if (activeRun && (terminal || paused)) {
      await activeRun.dispose();
    }

    if (options.alwaysRelease || terminal || paused) {
      this.activeRuns.delete(runId);
      this.inFlight.delete(runId);
      if (!retained) {
        this.runTokens.delete(runId);
      }
    }

    this.settleOrResumeInterrupt(runId, terminal);
  }

  /**
   * After a run task releases its in-memory active state, either resume a
   * pending interrupt follow-up (takes priority over queued drain) or run the
   * normal terminal settle. A no-op interrupt check preserves prior ordering.
   */
  private settleOrResumeInterrupt(runId: string, terminal: boolean): void {
    if (this.maybeStartPendingInterrupt(runId)) {
      // The interrupt re-resumes this run; only backfill other queued runs.
      this.pumpQueue();
      return;
    }
    if (terminal) {
      this.afterRunSettled(runId);
    }
  }

  private waitForOperatorAnswer(runId: string): Promise<string> {
    const queued = this.pendingAnswers.get(runId);
    if (queued) {
      this.pendingAnswers.delete(runId);
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.answerWaiters.set(runId, resolve);
    });
  }

  private async spawnWithTimeout(
    label: "spawn" | "resume",
    make: () => Promise<ActiveRun>
  ): Promise<ActiveRun> {
    const ms = this.spawnTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spawnPromise = make();

    try {
      return await Promise.race([
        spawnPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SpawnTimeoutError(label, ms)), ms);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      if (err instanceof SpawnTimeoutError) {
        void spawnPromise
          .then((run) => run.dispose())
          .catch(() => {});
      }
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private resolveReferencesInText(
    runId: string,
    cwd: string,
    text: string,
    failureLogLabel: string
  ): SpawnPromptResolution {
    const references = parsePromptReferences(text);
    if (references.length === 0) {
      return { prompt: text };
    }

    try {
      const artifacts = scanWorkspaceArtifacts(cwd);
      const result = resolvePromptReferences(text, artifacts);
      const referencesEvent = this.buildReferencesEvent(result);

      if (referencesEvent.unknownReferences.length > 0) {
        this.log(
          `Run ${runId}: unresolved prompt reference(s): ${referencesEvent.unknownReferences
            .map((reference) => reference.raw)
            .join(", ")}`
        );
      }

      return { prompt: result.prompt, referencesEvent };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(
        `Run ${runId}: ${failureLogLabel} reference resolution failed: ${message}`
      );
      return {
        prompt: text,
        referencesEvent: {
          resolved: 0,
          unknown: references.length,
          unknownReferences: [],
          error: message,
        },
      };
    }
  }

  private buildReferencesEvent(
    result: ReturnType<typeof resolvePromptReferences>
  ): NonNullable<SpawnPromptResolution["referencesEvent"]> {
    const unknownReferences = result.unknown
      .slice(0, MAX_REFERENCE_EVENT_DETAILS)
      .map((reference) => ({
        kind: reference.kind,
        name: reference.name,
        raw: reference.raw,
      }));

    return {
      resolved: result.resolved.length,
      unknown: result.unknown.length,
      unknownReferences,
      unknownReferencesTruncated:
        result.unknown.length > unknownReferences.length
          ? result.unknown.length - unknownReferences.length
          : 0,
    };
  }

  private resolveSpawnPrompt(
    runId: string,
    ctx: RunContext
  ): SpawnPromptResolution {
    return this.resolveReferencesInText(
      runId,
      ctx.cwd,
      ctx.prompt,
      "prompt"
    );
  }

  private resolveOperatorMessageReferences(
    runId: string,
    cwd: string,
    text: string
  ): {
    text: string;
    referencesEvent?: SpawnPromptResolution["referencesEvent"];
  } {
    const resolution = this.resolveReferencesInText(
      runId,
      cwd,
      text,
      "operator message"
    );
    return {
      text: resolution.prompt,
      referencesEvent: resolution.referencesEvent,
    };
  }

  private async executeNeedsInputResume(
    runId: string,
    ctx: RunContext,
    resume: { agentId: string; sdkRunId: string },
    abort: AbortController,
    runToken: string
  ): Promise<void> {
    let activeRun = await this.resumeRunWithRetry(
      runId,
      () =>
        this.options.executor.resume({
          apiKey: this.options.apiKey,
          cwd: ctx.cwd,
          model: ctx.modelSelection,
          prompt: ctx.prompt,
          runId,
          runToken,
          agentId: resume.agentId,
          sdkRunId: resume.sdkRunId,
          automationsIoTools: this.automationsIoToolsForRun(runId),
        }),
      abort.signal
    );

    this.activeRuns.set(runId, activeRun);
    this.store.setAgentIds(runId, activeRun.agentId, activeRun.sdkRunId);
    this.store.appendEvent(runId, "run.resumed", {
      needsInput: true,
      agentId: activeRun.agentId,
      sdkRunId: activeRun.sdkRunId,
      model: ctx.model,
      modelSelection: ctx.modelSelection,
    });

    const pending = this.options.inputHub.getPendingQuestion(runId);
    if (pending) {
      const answer = await this.waitForOperatorAnswer(runId);
      if (!activeRun.sendFollowUp) {
        throw new Error("Executor cannot deliver operator answer");
      }
      activeRun = await activeRun.sendFollowUp(
        `Operator answer (resume after pause): ${answer}`,
        ctx.modelSelection
      );
      this.activeRuns.set(runId, activeRun);
      this.store.setAgentIds(runId, activeRun.agentId, activeRun.sdkRunId);
      this.store.appendEvent(runId, "input.delivered", { answer });
    }

    await this.consumeAndFinalize(runId, activeRun, abort.signal);
  }

  private async executeRun(
    runId: string,
    ctx: RunContext,
    opts?: { resume?: { agentId: string; sdkRunId: string } }
  ): Promise<void> {
    const row = this.store.getRun(runId);
    if (!row) {
      return;
    }

    // A run cancelled (or otherwise finalized) during the `queued` window must
    // never spawn an agent. Resumes legitimately re-enter from non-running
    // states (e.g. needs_input), so they are exempt from this guard.
    if (
      !opts?.resume &&
      (row.status === "cancelled" ||
        row.status === "completed" ||
        row.status === "failed")
    ) {
      this.log(`Run ${runId}: ${row.status} before spawn — not starting agent`);
      return;
    }

    if (row.status === "queued") {
      this.transition(runId, "queued", "running");
    }

    const abort = new AbortController();
    this.inFlight.set(runId, abort);

    // Mint a fresh per-run token (also for resumes — the MCP child is new) so
    // only this run's spawned agent can answer its own `ask_user` calls.
    const runToken = randomUUID();
    this.runTokens.set(runId, runToken);

    let activeRun: import("../executor/types.js").ActiveRun | undefined;
    let recovery: { reason: RunFailureReason } | undefined;

    try {
      if (opts?.resume && row.status === "needs_input") {
        await this.executeNeedsInputResume(runId, ctx, opts.resume, abort, runToken);
        return;
      }

      let spawnPrompt = ctx.prompt;
      let referencesEvent: SpawnPromptResolution["referencesEvent"];

      if (!opts?.resume) {
        const spawnResolution = this.resolveSpawnPrompt(runId, ctx);
        spawnPrompt = spawnResolution.prompt;
        referencesEvent = spawnResolution.referencesEvent;
      }

      if (!opts?.resume) {
        this.store.appendEvent(runId, "run.spawn.attempt", {
          attempt: this.store.countSpawnAttempts(runId),
        });
      }

      activeRun = opts?.resume
        ? await this.resumeRunWithRetry(
            runId,
            () =>
              this.spawnWithTimeout("resume", () =>
                this.options.executor.resume({
                  apiKey: this.options.apiKey,
                  cwd: ctx.cwd,
                  model: ctx.modelSelection,
                  prompt: ctx.prompt,
                  runId,
                  runToken,
                  agentId: opts.resume!.agentId,
                  sdkRunId: opts.resume!.sdkRunId,
                  automationsIoTools: this.automationsIoToolsForRun(runId),
                })
              ),
            abort.signal
          )
        : await this.spawnWithTimeout("spawn", () =>
            this.options.executor.spawn({
              apiKey: this.options.apiKey,
              cwd: ctx.cwd,
              model: ctx.modelSelection,
              prompt: spawnPrompt,
              runId,
              runToken,
              automationsIoTools: this.automationsIoToolsForRun(runId),
            })
          );

      this.activeRuns.set(runId, activeRun);
      this.store.setAgentIds(runId, activeRun.agentId, activeRun.sdkRunId);
      this.store.appendEvent(runId, "run.started", {
        agentId: activeRun.agentId,
        sdkRunId: activeRun.sdkRunId,
        resumed: Boolean(opts?.resume),
        model: ctx.model,
        modelSelection: ctx.modelSelection,
      });

      if (referencesEvent) {
        this.store.appendEvent(runId, "run.references", referencesEvent);
      }

      const queuedAnswer = this.pendingAnswers.get(runId);
      if (queuedAnswer) {
        this.pendingAnswers.delete(runId);
        if (!activeRun.sendFollowUp) {
          throw new Error("Executor cannot deliver operator answer");
        }
        activeRun = await activeRun.sendFollowUp(
          `Operator answer (resume after pause): ${queuedAnswer}`,
          ctx.modelSelection
        );
        this.activeRuns.set(runId, activeRun);
        this.store.setAgentIds(runId, activeRun.agentId, activeRun.sdkRunId);
        this.store.appendEvent(runId, "input.delivered", {
          answer: queuedAnswer,
        });
      }

      await this.consumeAndFinalize(runId, activeRun, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) {
        return;
      }

      const message =
        err instanceof CursorAgentError
          ? `startup failed: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);

      const stale = /not found/i.test(message);
      const authExpired = isAuthResumeError(err);
      const freshSpawnFailure = !opts?.resume && activeRun === undefined;

      if (freshSpawnFailure) {
        const reason: RunFailureReason =
          err instanceof SpawnTimeoutError ? "spawn_timeout" : "spawn_error";
        recovery = { reason };
        this.log(`Run ${runId}: ${reason} — ${message}`);
        this.store.appendEvent(runId, "run.error", {
          message,
          reason: authExpired ? "auth_expired" : reason,
          stale,
        });
        if (authExpired) {
          this.options.onAuthExpired?.("run", runId, message);
        }
      } else {
        this.log(
          stale
            ? `Run ${runId}: local agent session gone — marked failed (stale)`
            : authExpired
              ? `Run ${runId}: cold resume failed auth (auth_expired) — ${message}`
              : `Run ${runId} error: ${message}`
        );
        this.store.appendEvent(runId, "run.error", {
          message,
          stale,
          ...(authExpired ? { reason: "auth_expired" } : {}),
        });
        if (authExpired) {
          this.options.onAuthExpired?.("run", runId, message);
        }

        const current = this.store.getRun(runId);
        if (
          current &&
          (current.status === "running" ||
            current.status === "needs_input" ||
            current.status === "paused")
        ) {
          this.transition(runId, current.status, "failed");
        }
      }
    } finally {
      // During shutdown, the drain owns cancellation and disposal of handles;
      // leave activeRuns/inFlight intact so shutdown() can reach them.
      if (!this.shuttingDown) {
        this.inFlight.delete(runId);
        this.activeRuns.delete(runId);
        if (activeRun) {
          const finalRow = this.store.getRun(runId);
          const terminal =
            finalRow?.status === "completed" ||
            finalRow?.status === "failed" ||
            finalRow?.status === "cancelled";
          const paused = finalRow?.status === "paused";
          const retained = this.canRetainRunSession(finalRow, activeRun, runToken);
          if (retained) {
            this.retainedRuns.set(runId, {
              activeRun,
              runToken,
              retainedAt: Date.now(),
            });
          } else if (terminal || paused) {
            await activeRun.dispose();
          }
          if (!retained) {
            this.runTokens.delete(runId);
          }
        } else {
          this.runTokens.delete(runId);
        }
        // Prune the event tail and start any queued runs now that a slot freed.
        // Skipped while needs_input (the run hasn't actually returned here yet).
        // An interrupt leaves the run `running`; resume its follow-up here once
        // the in-memory active state above has been released.
        const settledRow = this.store.getRun(runId);
        const settledTerminal =
          settledRow?.status === "completed" ||
          settledRow?.status === "failed" ||
          settledRow?.status === "cancelled";
        this.settleOrResumeInterrupt(runId, settledTerminal);

        if (recovery) {
          const attemptCount = this.store.countSpawnAttempts(runId);
          const backoffMs = Math.min(
            MAX_RETRY_BACKOFF_MS,
            this.retryBackoffMs * Math.max(1, attemptCount)
          );
          this.recoverRun(runId, recovery.reason, { backoffMs });
        }
      }
    }
  }

  private async consumeStream(
    runId: string,
    activeRun: import("../executor/types.js").ActiveRun,
    signal: AbortSignal
  ): Promise<void> {
    const sentinelTasks = new Set<Promise<void>>();

    for await (const message of activeRun.stream()) {
      if (signal.aborted) {
        await activeRun.cancel();
        return;
      }

      const sdkRunId = extractRunIdFromMessage(message);
      if (sdkRunId) {
        const row = this.store.getRun(runId);
        if (row && !row.sdk_run_id) {
          this.store.setAgentIds(runId, activeRun.agentId, sdkRunId);
        }
      }

      this.store.appendEvent(runId, message.type, message as SDKMessage);

      const sentinelQuestion = extractNeedsInputFromMessage(message);
      if (sentinelQuestion) {
        const task = this.handleSentinelAsk(runId, sentinelQuestion);
        sentinelTasks.add(task);
        void task.finally(() => sentinelTasks.delete(task));
      }
    }

    await Promise.allSettled(sentinelTasks);
  }

  private async consumeAndFinalize(
    runId: string,
    activeRun: import("../executor/types.js").ActiveRun,
    signal: AbortSignal
  ): Promise<void> {
    await this.consumeStream(runId, activeRun, signal);

    if (signal.aborted) {
      return;
    }

    const result = await activeRun.wait();
    const current = this.store.getRun(runId);
    if (
      !current ||
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "cancelled"
    ) {
      return;
    }

    if (current.status === "paused") {
      this.appendPausedTurnSettled(runId, result.status, result.result);
      return;
    }

    const terminal = mapSdkResultStatus(result.status);
    if (current.status === "running" || current.status === "needs_input") {
      this.transition(runId, current.status, terminal);
    }

    if (terminal === "failed") {
      const alreadyHasError = this.store
        .listRunEvents(runId)
        .some((e) => e.event_type === "run.error");
      if (!alreadyHasError) {
        const sdkMessage =
          typeof result.result === "string" && result.result.trim().length > 0
            ? result.result
            : undefined;
        this.store.appendEvent(runId, "run.error", {
          reason: "sdk_error",
          sdkStatus: result.status,
          ...(sdkMessage !== undefined ? { message: sdkMessage } : {}),
        });
        try {
          this.options.onRunFailed?.(runId, "sdk_error");
        } catch {
          // never let sink throw
        }
      }
    }

    this.store.appendEvent(runId, "run.finished", {
      sdkStatus: result.status,
      result: result.result ?? null,
    });
  }

  private async handleSentinelAsk(
    runId: string,
    question: string
  ): Promise<void> {
    const row = this.store.getRun(runId);
    if (!row || row.status === "cancelled") {
      return;
    }
    if (this.options.inputHub.getPendingQuestion(runId)) {
      return;
    }

    try {
      // The sentinel text came from the run's own stream that the daemon is
      // consuming, so it is as trusted as the run's registered token. Pass that
      // token through (the external `/ask` HTTP route supplies it from a header;
      // this internal call must supply it too or the token guard would reject).
      await this.askAndWait(runId, question, this.runTokens.get(runId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Run ${runId}: sentinel ask failed: ${message}`);
    }
  }
}

/** Prefer finished.result; else newest run.error message/reason/cause. */
function extractRunOutcomeEvidence(
  events: Array<{ event_type: string; payload: string }>
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event_type !== "run.finished") continue;
    try {
      const parsed = JSON.parse(event.payload) as { result?: unknown };
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        return parsed.result.trim();
      }
    } catch {
      /* ignore */
    }
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event_type !== "run.error") continue;
    try {
      const parsed = JSON.parse(event.payload) as {
        message?: unknown;
        reason?: unknown;
        cause?: unknown;
      };
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
      if (typeof parsed.reason === "string" && parsed.reason.trim()) {
        return parsed.reason.trim();
      }
      if (typeof parsed.cause === "string" && parsed.cause.trim()) {
        return parsed.cause.trim();
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}
