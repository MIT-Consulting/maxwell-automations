import type {
  ChainRunContext,
  PipelineWaveCandidate,
  PipelineWaveControlResponse,
  PipelineWaveFanOutReason,
  PipelineWaveFanOutResponse,
  PipelineWaveOperatorAction,
  PipelineWaveOperatorRefusal,
  PipelineWaveOperatorResponse,
  RunStatus,
} from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_PIPELINE_ID,
  KickoffError,
  normalizeImplementFullyChainVariables,
  partitionWaveCandidates,
  pipelineSummaryFromContext,
  workerKeyFromConfigKey,
} from "@lca/shared";
import {
  addWorktree,
  deleteMergedBranch,
  getHeadCommit,
  isAncestor,
  isWorktreeClean,
  preflightMainCheckout,
  pruneWorktrees,
  removeWorktreeSafe,
  trackBranchName,
  trackWorktreePath,
  type GitPreflightResult,
} from "../git/worktrees.js";
import {
  assertPromptWithinByteLimit,
  renderChainTemplate,
} from "./chain-template.js";
import {
  readFinishedResultText,
  resolveChildModelRole,
} from "./chain-runner.js";
import type { RunEngine, TriggerRunOptions } from "./engine.js";
import { extractImplementFullyHandoff } from "./pipeline-handoff.js";
import {
  PipelineWaveStore,
  type PipelineTrackRow,
  type PipelineWaveRow,
  type WaveCleanupOutcome,
} from "./pipeline-wave-store.js";
import type { RunRow, RunStore } from "./store.js";

export const TRACK_SUMMARY_MAX_BYTES = 1024;
export const TRACK_AGGREGATE_MAX_BYTES = 8 * 1024;

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const PLAN_PHASE_REF = `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`;
const INTEGRATE_WAVE_REF = `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY}`;

const TRACK_TERMINAL_WORKER_KEY =
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS[IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length - 1]!;

/** Last loop worker or legacy docs-commit — both complete a parallel track. */
export function isTrackTerminalWorkerKey(
  workerKey: string | null | undefined
): boolean {
  return (
    workerKey === TRACK_TERMINAL_WORKER_KEY ||
    workerKey === IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY
  );
}

export type PipelineWaveCoordinatorOptions = {
  store: RunStore;
  waveStore: PipelineWaveStore;
  engine: RunEngine;
  onLog: (message: string) => void;
  maxConcurrentRuns: number;
  pipelineResumeLookbackMs: number;
};

export type TerminalHookResult = { handled: boolean };

function mapPreflightReason(
  result: Extract<GitPreflightResult, { ok: false }>
): PipelineWaveFanOutReason {
  switch (result.reason) {
    case "dirty-checkout":
    case "detached-head":
    case "unborn-head":
    case "missing-git":
    case "invalid-worktree-state":
      return result.reason;
    default:
      return "preflight-failed";
  }
}

/** Normalize implement-fully controls before track/integration template render. */
function normalizeWaveChainContext(context: ChainRunContext): ChainRunContext {
  return {
    ...context,
    variables: normalizeImplementFullyChainVariables(context.variables),
  };
}

/** Trusted daemon prompt block — never agent-authored. */
export function appendTrustedPromptBlock(
  basePrompt: string,
  blockName: string,
  lines: string[]
): string {
  const body = lines.map((line) => line.trimEnd()).join("\n");
  return `${basePrompt}

--- ${blockName} (trusted; do not edit) ---
${body}
--- end ${blockName} ---`;
}

export function trackContextBlock(input: {
  waveOrdinal: number;
  trackOrdinal: number;
  phaseRef: string;
  phaseFile: string;
}): string {
  return appendTrustedPromptBlock("", "lca-track-context", [
    "mode: parallel-track",
    `waveOrdinal: ${input.waveOrdinal}`,
    `trackOrdinal: ${input.trackOrdinal}`,
    `phaseRef: ${input.phaseRef}`,
    `phaseFile: ${input.phaseFile}`,
  ]).replace(/^\n+/, "");
}

export function integrationContextBlock(input: {
  waveId: string;
  waveOrdinal: number;
  baseCommit: string;
  tracks: PipelineTrackRow[];
}): string {
  const trackLines = input.tracks.flatMap((t) => [
    `- ordinal: ${t.ordinal}`,
    `  phaseRef: ${t.phase_ref}`,
    `  phaseFile: ${t.phase_file}`,
    `  branch: ${t.branch_name}`,
    `  tip: ${t.head_commit ?? "(unknown)"}`,
  ]);
  return appendTrustedPromptBlock("", "lca-integration-context", [
    `waveId: ${input.waveId}`,
    `waveOrdinal: ${input.waveOrdinal}`,
    `baseCommit: ${input.baseCommit}`,
    "tracks:",
    ...trackLines,
  ]).replace(/^\n+/, "");
}

function boundUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const budget = Math.max(0, maxBytes - ellipsisBytes);
  let out = text;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > budget) {
    out = out.slice(0, -1);
  }
  return `${out}${ellipsis}`;
}

/** One ordinal-ordered track outcome summary for integrate-wave. */
export function formatTrackOutcomeSummary(input: {
  track: PipelineTrackRow;
  summary: string | null;
  risks: string[] | null;
  downstreamEffects: string[] | null;
}): string {
  const lines = [
    `- ordinal: ${input.track.ordinal}`,
    `  phaseRef: ${input.track.phase_ref}`,
    `  phaseFile: ${input.track.phase_file}`,
    `  terminalRunId: ${input.track.terminal_run_id ?? "(unavailable)"}`,
  ];
  if (input.summary != null) {
    lines.push(`  summary: ${input.summary}`);
    const risks =
      input.risks && input.risks.length > 0 ? input.risks.join("; ") : "none";
    const effects =
      input.downstreamEffects && input.downstreamEffects.length > 0
        ? input.downstreamEffects.join("; ")
        : "none";
    lines.push(`  risks: ${risks}`);
    lines.push(`  downstream-effects: ${effects}`);
  } else {
    lines.push("  summary: (handoff unavailable)");
    lines.push("  risks: (unavailable)");
    lines.push("  downstream-effects: (unavailable)");
  }
  return boundUtf8(lines.join("\n"), TRACK_SUMMARY_MAX_BYTES);
}

export function formatTrackOutcomeAggregate(
  summaries: string[]
): string {
  const header = "track-outcomes:";
  let body = summaries.join("\n");
  const full = `${header}\n${body}`;
  if (Buffer.byteLength(full, "utf8") <= TRACK_AGGREGATE_MAX_BYTES) {
    return full;
  }
  // Drop trailing track summaries until under budget; never drop the header.
  const kept: string[] = [];
  for (const summary of summaries) {
    const candidate = `${header}\n${[...kept, summary].join("\n")}`;
    if (Buffer.byteLength(candidate, "utf8") > TRACK_AGGREGATE_MAX_BYTES) {
      break;
    }
    kept.push(summary);
  }
  const truncatedNote =
    kept.length < summaries.length
      ? `\n- (truncated ${summaries.length - kept.length} later track outcome(s))`
      : "";
  return boundUtf8(
    `${header}\n${kept.join("\n")}${truncatedNote}`,
    TRACK_AGGREGATE_MAX_BYTES
  );
}

export class PipelineWaveCoordinator {
  private readonly store: RunStore;
  private readonly waveStore: PipelineWaveStore;
  private readonly engine: RunEngine;
  private readonly onLog: (message: string) => void;
  private readonly maxConcurrentRuns: number;
  private readonly pipelineResumeLookbackMs: number;

  constructor(options: PipelineWaveCoordinatorOptions) {
    this.store = options.store;
    this.waveStore = options.waveStore;
    this.engine = options.engine;
    this.onLog = options.onLog;
    this.maxConcurrentRuns = options.maxConcurrentRuns;
    this.pipelineResumeLookbackMs = options.pipelineResumeLookbackMs;
  }

  /**
   * Daemon-owned track assignment for chained track children.
   * Never derived from an agent handoff packet.
   */
  trustedTrackContextFor(trackId: string): string | null {
    const track = this.waveStore.getTrack(trackId);
    if (!track) return null;
    const wave = this.waveStore.getWave(track.wave_id);
    if (!wave) return null;
    return trackContextBlock({
      waveOrdinal: wave.ordinal,
      trackOrdinal: track.ordinal,
      phaseRef: track.phase_ref,
      phaseFile: track.phase_file,
    });
  }

  async fanOut(
    coordinatorRunId: string,
    candidates: PipelineWaveCandidate[]
  ): Promise<PipelineWaveFanOutResponse> {
    const auth = this.authorizeCoordinator(coordinatorRunId);
    if (!auth.ok) {
      return this.fallbackResponse(auth.reason, candidates, null);
    }

    const { row, context, summary } = auth;
    const { accepted, deferred } = partitionWaveCandidates(
      candidates,
      this.maxConcurrentRuns
    );

    if (accepted.length < 2) {
      const reason: PipelineWaveFanOutReason =
        this.maxConcurrentRuns < 2
          ? "max-concurrent-one"
          : "insufficient-candidates";
      return this.fallbackResponse(reason, accepted, deferred);
    }

    const repoPath = this.store.getWorkspacePath(row.workspace_id);
    if (!repoPath) {
      return this.fallbackResponse("preflight-failed", accepted, deferred);
    }

    const preflight = await preflightMainCheckout(repoPath);
    if (!preflight.ok) {
      return this.fallbackResponse(
        mapPreflightReason(preflight),
        accepted,
        deferred
      );
    }

    const existing = this.waveStore.getWaveByCoordinator(coordinatorRunId);
    if (existing) {
      return {
        outcome: "parallel",
        reason: "parallel",
        waveId: existing.id,
        accepted: this.waveStore.trackCandidates(existing.id),
        deferred,
      };
    }

    const waveOrdinal = this.waveStore.nextWaveOrdinal(row.chain_root_run_id!);
    const trackInputs = accepted.map((candidate, index) => {
      const trackOrdinal = index + 1;
      const identity = {
        featureSlug: summary.featureSlug,
        rootRunId: row.chain_root_run_id!,
        waveOrdinal,
        trackOrdinal,
      };
      return {
        phaseRef: candidate.phaseRef,
        phaseFile: candidate.phaseFile,
        branchName: trackBranchName(identity),
        worktreePath: trackWorktreePath(identity),
        ordinal: trackOrdinal,
      };
    });

    const { wave, tracks, created } = this.waveStore.createWaveIdempotent({
      rootRunId: row.chain_root_run_id!,
      coordinatorRunId,
      workspaceId: row.workspace_id,
      ordinal: waveOrdinal,
      baseCommit: preflight.headCommit,
      tracks: trackInputs,
    });

    if (created) {
      try {
        for (const track of tracks) {
          await addWorktree({
            repoPath,
            worktreePath: track.worktree_path,
            branchName: track.branch_name,
            startPoint: preflight.headCommit,
          });
        }
        this.waveStore.markWaveRunning(wave.id);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.waveStore.blockWave(wave.id, "worktree-provision-failed", detail);
        this.store.appendEvent(coordinatorRunId, "run.pipeline-wave-blocked", {
          waveId: wave.id,
          code: "worktree-provision-failed",
          detail,
        });
        this.onLog(
          `Wave ${wave.id}: worktree provisioning failed — ${detail}`
        );
        return this.fallbackResponse("invalid-worktree-state", accepted, deferred);
      }
    }

    const plannerTargetId = this.store.resolveChainTarget(
      row.workspace_id,
      PLAN_PHASE_REF
    );
    if (!plannerTargetId) {
      this.waveStore.blockWave(wave.id, "unresolved-planner", PLAN_PHASE_REF);
      return this.fallbackResponse("preflight-failed", accepted, deferred);
    }
    const plannerAutomation = this.store.getAutomation(plannerTargetId);
    if (!plannerAutomation) {
      this.waveStore.blockWave(wave.id, "unresolved-planner", PLAN_PHASE_REF);
      return this.fallbackResponse("preflight-failed", accepted, deferred);
    }

    const coordinatorDepth = row.chain_depth ?? 0;
    const maxDepth =
      row.chain_max_depth_override ?? row.chain_max_depth ?? 0;
    const renderedPlanner = renderChainTemplate(
      plannerAutomation.prompt,
      context.variables
    );
    if (!renderedPlanner.ok) {
      this.waveStore.blockWave(
        wave.id,
        "template-error",
        renderedPlanner.message
      );
      return this.fallbackResponse("preflight-failed", accepted, deferred);
    }

    const { modelSelectionOverride } = resolveChildModelRole(
      true,
      context,
      plannerAutomation,
      (msg) => this.onLog(msg)
    );

    for (const track of tracks) {
      if (track.planner_run_id != null) {
        continue;
      }
      const promptOverride = `${renderedPlanner.text}

${trackContextBlock({
  waveOrdinal: wave.ordinal,
  trackOrdinal: track.ordinal,
  phaseRef: track.phase_ref,
  phaseFile: track.phase_file,
})}`;
      const limited = assertPromptWithinByteLimit(promptOverride);
      if (!limited.ok) {
        this.waveStore.blockWave(wave.id, "template-error", limited.message);
        return this.fallbackResponse("preflight-failed", accepted, deferred);
      }

      const triggerOptions: TriggerRunOptions = {
        parentRunId: coordinatorRunId,
        promptOverride,
        chainContext: context,
        chainRootRunId: row.chain_root_run_id!,
        chainDepth: coordinatorDepth + 1,
        chainMaxDepth: maxDepth,
        pipelineWaveId: wave.id,
        pipelineTrackId: track.id,
        executionCwd: track.worktree_path,
      };
      if (modelSelectionOverride !== undefined) {
        triggerOptions.modelSelectionOverride = modelSelectionOverride;
      }

      let plannerRunId: string;
      try {
        plannerRunId = await this.engine.triggerRun(
          plannerTargetId,
          "chain",
          triggerOptions
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.onLog(
          `Wave ${wave.id}: failed to enqueue track ${track.ordinal} planner: ${detail}`
        );
        continue;
      }
      this.waveStore.assignTrackPlanner(track.id, plannerRunId);
    }

    if (!this.store.claimChainHandled(coordinatorRunId)) {
      const raced = this.waveStore.getWaveByCoordinator(coordinatorRunId);
      return {
        outcome: "parallel",
        reason: "parallel",
        waveId: raced?.id ?? wave.id,
        accepted,
        deferred,
      };
    }

    this.store.appendEvent(coordinatorRunId, "run.pipeline-fanout", {
      waveId: wave.id,
      waveOrdinal: wave.ordinal,
      acceptedCount: accepted.length,
      deferredCount: deferred.length,
      trackIds: tracks.map((t) => t.id),
    });
    this.onLog(
      `Wave fan-out ${wave.id} from coordinator ${coordinatorRunId} (${accepted.length} track(s))`
    );

    return {
      outcome: "parallel",
      reason: "parallel",
      waveId: wave.id,
      accepted,
      deferred,
    };
  }

  async handleTerminalHook(
    runId: string,
    status: RunStatus
  ): Promise<TerminalHookResult> {
    const row = this.store.getRun(runId);
    if (!row) {
      return { handled: false };
    }

    const automation = this.store.getAutomationByIdIncludingArchived(
      row.automation_id
    );
    const workerKey = workerKeyFromConfigKey(automation?.config_key);

    if (
      status === "completed" &&
      isTrackTerminalWorkerKey(workerKey) &&
      row.pipeline_track_id
    ) {
      return this.handleTrackTerminal(runId, row);
    }

    if (workerKey === IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY) {
      return this.handleIntegrationTerminal(runId, row, status);
    }

    if (
      row.pipeline_track_id &&
      (status === "failed" || status === "cancelled")
    ) {
      return this.handleTrackFailure(runId, row, status);
    }

    return { handled: false };
  }

  async finalize(runId: string): Promise<
    | { ok: true; response: PipelineWaveControlResponse }
    | { ok: false; reason: string }
  > {
    const row = this.store.getRun(runId);
    if (!row?.pipeline_wave_id) {
      return { ok: false, reason: "not-found" };
    }
    const wave = this.waveStore.getWave(row.pipeline_wave_id);
    if (!wave) {
      return { ok: false, reason: "not-found" };
    }
    if (wave.integration_run_id !== runId) {
      return { ok: false, reason: "not-integration-run" };
    }

    const repoPath = this.store.getWorkspacePath(row.workspace_id);
    if (!repoPath) {
      return { ok: false, reason: "no-workspace" };
    }

    const preflight = await preflightMainCheckout(repoPath);
    if (!preflight.ok) {
      return { ok: false, reason: preflight.reason };
    }

    const tracks = this.waveStore.listTracks(wave.id);
    const mainHead = preflight.headCommit;
    for (const track of tracks) {
      if (!track.head_commit) {
        return { ok: false, reason: "track-tip-missing" };
      }
      const merged = await isAncestor({
        cwd: repoPath,
        ancestor: track.head_commit,
        descendant: mainHead,
      });
      if (!merged) {
        return { ok: false, reason: "track-tip-not-merged" };
      }
    }

    if (!this.waveStore.finalizeWave(wave.id)) {
      const current = this.waveStore.getWave(wave.id);
      if (current?.finalized_at != null) {
        return {
          ok: true,
          response: {
            action: "finalize",
            waveId: wave.id,
            status: current.status,
          },
        };
      }
      return { ok: false, reason: "finalize-rejected" };
    }

    const cleanup = await this.cleanupWaveWorktrees(wave, repoPath, mainHead);
    this.waveStore.recordCleanup(wave.id, cleanup);

    this.store.appendEvent(runId, "run.pipeline-wave-finalized", {
      waveId: wave.id,
      waveOrdinal: wave.ordinal,
    });
    if (
      cleanup.removedWorktrees.length > 0 ||
      cleanup.deletedBranches.length > 0 ||
      cleanup.retained.length > 0
    ) {
      this.store.appendEvent(runId, "run.pipeline-wave-cleanup", {
        waveId: wave.id,
        ...cleanup,
      });
    }
    this.onLog(`Wave ${wave.id} finalized from integration run ${runId}`);

    const finalized = this.waveStore.getWave(wave.id)!;
    return {
      ok: true,
      response: {
        action: "finalize",
        waveId: wave.id,
        status: finalized.status,
      },
    };
  }

  async block(
    runId: string,
    reason: string
  ): Promise<
    | { ok: true; response: PipelineWaveControlResponse }
    | { ok: false; reason: string }
  > {
    const row = this.store.getRun(runId);
    if (!row?.pipeline_wave_id) {
      return { ok: false, reason: "not-found" };
    }
    const wave = this.waveStore.getWave(row.pipeline_wave_id);
    if (!wave) {
      return { ok: false, reason: "not-found" };
    }

    if (!this.waveStore.blockWave(wave.id, "integration-blocked", reason)) {
      const current = this.waveStore.getWave(wave.id);
      if (current?.status === "blocked") {
        return {
          ok: true,
          response: {
            action: "block",
            waveId: wave.id,
            status: "blocked",
          },
        };
      }
      return { ok: false, reason: "block-rejected" };
    }

    this.store.appendEvent(runId, "run.pipeline-wave-blocked", {
      waveId: wave.id,
      code: "integration-blocked",
      detail: reason,
    });
    this.onLog(`Wave ${wave.id} blocked from integration run ${runId}: ${reason}`);

    return {
      ok: true,
      response: {
        action: "block",
        waveId: wave.id,
        status: "blocked",
      },
    };
  }

  async operatorAction(
    waveId: string,
    input: { action: PipelineWaveOperatorAction; reason?: string }
  ): Promise<
    | { ok: true; response: PipelineWaveOperatorResponse }
    | { ok: false; reason: PipelineWaveOperatorRefusal }
  > {
    const wave = this.waveStore.getWave(waveId);
    if (!wave) {
      return { ok: false, reason: "not-found" };
    }

    if (input.action === "abort") {
      return this.operatorAbort(wave, input.reason);
    }

    return this.operatorRetryIntegration(wave);
  }

  async resumeWaves(nowMs = Date.now()): Promise<number> {
    if (this.pipelineResumeLookbackMs <= 0) {
      return 0;
    }

    let repaired = 0;
    const waves = this.waveStore.listResumableWaves(
      this.pipelineResumeLookbackMs,
      nowMs
    );

    for (const wave of waves) {
      try {
        if (await this.resumeProvisioningWave(wave)) {
          repaired += 1;
          continue;
        }
        if (await this.resumeMissedTrackTerminals(wave)) {
          repaired += 1;
        }
        if (await this.resumeReadyJoin(wave)) {
          repaired += 1;
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.onLog(`Wave resume failed for ${wave.id}: ${text}`);
      }
    }

    const finalized = this.waveStore.listFinalizedWithoutSuccessor(
      this.pipelineResumeLookbackMs,
      nowMs
    );
    for (const wave of finalized) {
      if (!wave.integration_run_id) {
        continue;
      }
      try {
        const integration = this.store.getRun(wave.integration_run_id);
        if (
          integration?.status === "completed" &&
          integration.chain_handled_at == null
        ) {
          this.store.appendEvent(integration.id, "run.pipeline-wave-recovered", {
            waveId: wave.id,
            reason: "finalized-successor",
          });
          await this.handleIntegrationTerminal(
            integration.id,
            integration,
            "completed"
          );
          repaired += 1;
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.onLog(
          `Wave resume (finalized successor) failed for ${wave.id}: ${text}`
        );
      }
    }

    if (repaired > 0) {
      this.onLog(`Pipeline wave resume: repaired ${repaired} action(s)`);
    }
    return repaired;
  }

  private fallbackResponse(
    reason: PipelineWaveFanOutReason,
    accepted: PipelineWaveCandidate[],
    deferred: PipelineWaveCandidate[] | null
  ): PipelineWaveFanOutResponse {
    const allDeferred =
      deferred ??
      partitionWaveCandidates(accepted, this.maxConcurrentRuns).deferred;
    return {
      outcome: "sequential-fallback",
      reason,
      waveId: null,
      accepted,
      deferred: allDeferred,
    };
  }

  private authorizeCoordinator(runId: string):
    | {
        ok: true;
        row: RunRow;
        context: ChainRunContext;
        summary: { featureSlug: string };
      }
    | { ok: false; reason: PipelineWaveFanOutReason } {
    const row = this.store.getRun(runId);
    if (!row) {
      return { ok: false, reason: "not-found" };
    }
    if (TERMINAL_STATUSES.has(row.status)) {
      return { ok: false, reason: "terminal" };
    }
    if (row.pipeline_track_id) {
      return { ok: false, reason: "already-tracked" };
    }

    const automation = this.store.getAutomationByIdIncludingArchived(
      row.automation_id
    );
    if (!automation || automation.config_key !== PLAN_PHASE_REF) {
      return { ok: false, reason: "not-coordinator" };
    }

    const parsed = this.store.parseChainContext(row);
    if (
      !parsed?.ok ||
      row.chain_depth == null ||
      row.chain_root_run_id == null
    ) {
      return { ok: false, reason: "not-pipeline" };
    }

    const summary = pipelineSummaryFromContext(parsed.context);
    if (!summary || summary.pipelineId !== IMPLEMENT_FULLY_PIPELINE_ID) {
      return { ok: false, reason: "not-pipeline" };
    }

    let context: ChainRunContext;
    try {
      context = normalizeWaveChainContext(parsed.context);
    } catch (err) {
      const detail =
        err instanceof KickoffError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.onLog(
        `Wave authorize: invalid chain variables on ${runId}: ${detail}`
      );
      return { ok: false, reason: "preflight-failed" };
    }

    return {
      ok: true,
      row,
      context,
      summary,
    };
  }

  private async handleTrackTerminal(
    runId: string,
    row: RunRow
  ): Promise<TerminalHookResult> {
    const track = this.waveStore.getTrack(row.pipeline_track_id!);
    if (!track) {
      return { handled: false };
    }
    const wave = this.waveStore.getWave(track.wave_id);
    if (!wave) {
      return { handled: false };
    }

    const terminalAutomation = this.store.getAutomationByIdIncludingArchived(
      row.automation_id
    );
    const terminalWorkerKey =
      workerKeyFromConfigKey(terminalAutomation?.config_key) ?? "track-terminal";

    const clean = await isWorktreeClean(track.worktree_path);
    if (!clean) {
      this.waveStore.blockWave(
        wave.id,
        "dirty-track-worktree",
        `track ${track.ordinal} worktree is dirty after ${terminalWorkerKey}`
      );
      this.store.appendEvent(runId, "run.pipeline-wave-blocked", {
        waveId: wave.id,
        code: "dirty-track-worktree",
        trackId: track.id,
      });
      if (this.store.claimChainHandled(runId)) {
        return { handled: true };
      }
      return { handled: true };
    }

    let headCommit: string;
    try {
      headCommit = await getHeadCommit(track.worktree_path);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.waveStore.blockWave(wave.id, "head-read-failed", detail);
      if (this.store.claimChainHandled(runId)) {
        return { handled: true };
      }
      return { handled: true };
    }

    const repoPath = this.store.getWorkspacePath(row.workspace_id);
    if (!repoPath) {
      return { handled: false };
    }

    const descended = await isAncestor({
      cwd: repoPath,
      ancestor: wave.base_commit,
      descendant: headCommit,
    });
    if (!descended) {
      this.waveStore.blockWave(
        wave.id,
        "invalid-track-tip",
        `track ${track.ordinal} tip is not descended from wave base`
      );
      this.store.appendEvent(runId, "run.pipeline-wave-blocked", {
        waveId: wave.id,
        code: "invalid-track-tip",
        trackId: track.id,
      });
      if (this.store.claimChainHandled(runId)) {
        return { handled: true };
      }
      return { handled: true };
    }

    const completion = this.waveStore.completeTrack(
      track.id,
      runId,
      headCommit
    );
    if (!completion.ok) {
      this.onLog(
        `Track ${track.id} ${terminalWorkerKey} terminal rejected: ${completion.reason}`
      );
      if (this.store.claimChainHandled(runId)) {
        return { handled: true };
      }
      return { handled: true };
    }

    if (completion.newlyCompleted) {
      this.store.appendEvent(runId, "run.pipeline-track-completed", {
        waveId: wave.id,
        trackId: track.id,
        trackOrdinal: track.ordinal,
        headCommit,
      });
    }

    if (!this.store.claimChainHandled(runId)) {
      return { handled: true };
    }

    await this.tryEnqueueIntegration(wave.id);
    return { handled: true };
  }

  private async handleIntegrationTerminal(
    runId: string,
    row: RunRow,
    status: RunStatus
  ): Promise<TerminalHookResult> {
    const waveId = row.pipeline_wave_id;
    if (!waveId) {
      return { handled: false };
    }
    const wave = this.waveStore.getWave(waveId);
    if (!wave) {
      return { handled: false };
    }

    if (status === "completed" && wave.finalized_at != null) {
      return { handled: false };
    }

    const detail =
      status === "completed"
        ? "integration completed without wave finalization"
        : `integration ${status}`;

    this.waveStore.blockWave(wave.id, "integration-incomplete", detail);
    this.store.appendEvent(runId, "run.pipeline-wave-blocked", {
      waveId: wave.id,
      code: "integration-incomplete",
      detail,
    });

    if (!this.store.claimChainHandled(runId)) {
      return { handled: true };
    }

    this.onLog(
      `Integration run ${runId} blocked wave ${wave.id}: ${detail}`
    );
    return { handled: true };
  }

  /**
   * Abort a wave because a track-scoped run failed or was operator-aborted.
   * Idempotent: already-aborted waves still stop any remaining non-terminal siblings.
   * Does not claim `chain_handled_at` (callers own that) and never force-deletes
   * dirty/unmerged worktrees.
   */
  async abortWaveForTrackRun(
    runId: string,
    reason: string
  ): Promise<{ ok: boolean; waveId?: string }> {
    const row = this.store.getRun(runId);
    if (!row?.pipeline_track_id) {
      return { ok: false };
    }
    const track = this.waveStore.getTrack(row.pipeline_track_id);
    if (!track) {
      return { ok: false };
    }
    const wave = this.waveStore.getWave(track.wave_id);
    if (!wave) {
      return { ok: false };
    }
    if (wave.status === "completed" && wave.finalized_at != null) {
      return { ok: false, waveId: wave.id };
    }

    const detail = reason;
    const alreadyAborted = wave.status === "aborted";
    this.waveStore.abortWave(wave.id, detail);
    if (!alreadyAborted) {
      this.store.appendEvent(runId, "run.pipeline-wave-blocked", {
        waveId: wave.id,
        code: "track-aborted",
        detail,
      });
      this.onLog(`Wave ${wave.id} aborted from track run ${runId}: ${detail}`);
    }
    await this.stopWaveSiblings(wave.id, runId, detail);
    return { ok: true, waveId: wave.id };
  }

  private async handleTrackFailure(
    runId: string,
    row: RunRow,
    status: RunStatus
  ): Promise<TerminalHookResult> {
    const track = this.waveStore.getTrack(row.pipeline_track_id!);
    if (!track) {
      return { handled: false };
    }
    const wave = this.waveStore.getWave(track.wave_id);
    if (!wave || wave.status === "aborted" || wave.status === "completed") {
      return { handled: false };
    }

    const detail = `track ${track.ordinal} run ${runId} ${status}`;
    await this.abortWaveForTrackRun(runId, detail);

    if (!this.store.claimChainHandled(runId)) {
      return { handled: true };
    }

    this.onLog(`Wave ${wave.id} aborted due to track failure on ${runId}`);
    return { handled: true };
  }

  private async tryEnqueueIntegration(waveId: string): Promise<boolean> {
    const wave = this.waveStore.getWave(waveId);
    if (!wave) {
      return false;
    }

    if (!this.waveStore.allTracksComplete(waveId)) {
      return false;
    }

    if (!this.waveStore.claimJoin(waveId)) {
      return false;
    }

    this.store.appendEvent(wave.coordinator_run_id, "run.pipeline-join-ready", {
      waveId,
      waveOrdinal: wave.ordinal,
    });

    const coordinator = this.store.getRun(wave.coordinator_run_id);
    if (!coordinator) {
      return false;
    }

    const parsed = this.store.parseChainContext(coordinator);
    if (!parsed?.ok || coordinator.chain_depth == null) {
      return false;
    }

    let waveContext: ChainRunContext;
    try {
      waveContext = normalizeWaveChainContext(parsed.context);
    } catch (err) {
      const detail =
        err instanceof KickoffError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.waveStore.blockWave(wave.id, "template-error", detail);
      return false;
    }

    const integrationTargetId = this.store.resolveChainTarget(
      wave.workspace_id,
      INTEGRATE_WAVE_REF
    );
    if (!integrationTargetId) {
      this.waveStore.blockWave(
        waveId,
        "unresolved-integration",
        INTEGRATE_WAVE_REF
      );
      return false;
    }
    const integrationAutomation = this.store.getAutomation(integrationTargetId);
    if (!integrationAutomation) {
      this.waveStore.blockWave(
        waveId,
        "unresolved-integration",
        INTEGRATE_WAVE_REF
      );
      return false;
    }

    const tracks = this.waveStore.listTracks(waveId);
    const rendered = renderChainTemplate(
      integrationAutomation.prompt,
      waveContext.variables
    );
    if (!rendered.ok) {
      this.waveStore.blockWave(wave.id, "template-error", rendered.message);
      return false;
    }

    const trackSummaries = tracks.map((track) => {
      let summary: string | null = null;
      let risks: string[] | null = null;
      let downstreamEffects: string[] | null = null;
      if (track.terminal_run_id) {
        try {
          const resultText = readFinishedResultText(
            this.store,
            track.terminal_run_id
          );
          const terminalRun = this.store.getRun(track.terminal_run_id);
          const terminalAutomation = terminalRun
            ? this.store.getAutomationByIdIncludingArchived(
                terminalRun.automation_id
              )
            : undefined;
          const terminalWorkerKey = workerKeyFromConfigKey(
            terminalAutomation?.config_key
          );
          const handoffOptions: {
            expectedPipeline: typeof IMPLEMENT_FULLY_PIPELINE_ID;
            expectedWorker?: string;
          } = {
            expectedPipeline: IMPLEMENT_FULLY_PIPELINE_ID,
          };
          if (terminalWorkerKey) {
            handoffOptions.expectedWorker = terminalWorkerKey;
          }
          const extracted = extractImplementFullyHandoff(
            resultText,
            handoffOptions
          );
          if (extracted.ok) {
            summary = extracted.packet.summary;
            risks = extracted.packet.risks;
            downstreamEffects = extracted.packet["downstream-effects"];
          }
        } catch {
          // leave unavailable markers
        }
      }
      return formatTrackOutcomeSummary({
        track,
        summary,
        risks,
        downstreamEffects,
      });
    });

    const integrationTrusted = integrationContextBlock({
      waveId: wave.id,
      waveOrdinal: wave.ordinal,
      baseCommit: wave.base_commit,
      tracks,
    });
    const outcomeAggregate = formatTrackOutcomeAggregate(trackSummaries);
    // Branch/tip/base facts stay in lca-integration-context; summaries are additive.
    const promptOverride = `${rendered.text}

${integrationTrusted}

${appendTrustedPromptBlock("", "lca-track-outcomes", [
  outcomeAggregate,
]).replace(/^\n+/, "")}`;

    const limited = assertPromptWithinByteLimit(promptOverride);
    if (!limited.ok) {
      this.waveStore.blockWave(wave.id, "template-error", limited.message);
      return false;
    }

    const { modelSelectionOverride } = resolveChildModelRole(
      true,
      waveContext,
      integrationAutomation,
      (msg) => this.onLog(msg)
    );

    const maxDepth =
      coordinator.chain_max_depth_override ?? coordinator.chain_max_depth ?? 0;
    // Track planner … track terminal (loop length), then integration (+1).
    const integrationChainDepth =
      coordinator.chain_depth + IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length + 1;
    const triggerOptions: TriggerRunOptions = {
      parentRunId: wave.coordinator_run_id,
      promptOverride,
      chainContext: waveContext,
      chainRootRunId: wave.root_run_id,
      chainDepth: integrationChainDepth,
      chainMaxDepth: maxDepth,
      pipelineWaveId: wave.id,
      pipelineTrackId: null,
      executionCwd: null,
    };
    if (modelSelectionOverride !== undefined) {
      triggerOptions.modelSelectionOverride = modelSelectionOverride;
    }

    let integrationRunId: string;
    try {
      integrationRunId = await this.engine.triggerRun(
        integrationTargetId,
        "chain",
        triggerOptions
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.waveStore.blockWave(waveId, "integration-enqueue-failed", detail);
      return false;
    }

    this.waveStore.assignIntegrationRun(waveId, integrationRunId);
    this.store.appendEvent(wave.coordinator_run_id, "run.pipeline-integration-enqueued", {
      waveId,
      integrationRunId,
      waveOrdinal: wave.ordinal,
    });
    this.onLog(
      `Wave ${waveId}: integration run ${integrationRunId} enqueued`
    );
    return true;
  }

  private async stopWaveSiblings(
    waveId: string,
    exceptRunId: string,
    reason: string
  ): Promise<void> {
    const runs = this.store.listRunsForPipelineWave(waveId);
    for (const sibling of runs) {
      if (sibling.id === exceptRunId) {
        continue;
      }
      if (TERMINAL_STATUSES.has(sibling.status)) {
        continue;
      }
      if (sibling.status === "queued") {
        try {
          await this.engine.cancelRun(sibling.id);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.onLog(`Wave ${waveId}: cancel queued ${sibling.id} failed: ${text}`);
        }
        continue;
      }
      if (
        sibling.status === "running" ||
        sibling.status === "needs_input"
      ) {
        this.store.applyChainControl(sibling.id, {
          stop: { reason: `wave-sibling-stop: ${reason}` },
        });
        try {
          await this.engine.cancelRun(sibling.id);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.onLog(`Wave ${waveId}: stop active ${sibling.id} failed: ${text}`);
        }
      }
    }
  }

  private async cleanupWaveWorktrees(
    wave: PipelineWaveRow,
    repoPath: string,
    intoCommit: string
  ): Promise<WaveCleanupOutcome> {
    const tracks = this.waveStore.listTracks(wave.id);
    const outcome: WaveCleanupOutcome = {
      removedWorktrees: [],
      deletedBranches: [],
      retained: [],
    };

    for (const track of tracks) {
      const removed = await removeWorktreeSafe({
        repoPath,
        worktreePath: track.worktree_path,
        forceCleanOnly: true,
      });
      if (removed.removed) {
        outcome.removedWorktrees.push(track.worktree_path);
      } else {
        outcome.retained.push({
          branch: track.branch_name,
          worktreePath: track.worktree_path,
          reason: removed.reason ?? "not-removed",
        });
      }

      const branch = await deleteMergedBranch({
        repoPath,
        branchName: track.branch_name,
        intoCommit,
      });
      if (branch.deleted) {
        outcome.deletedBranches.push(track.branch_name);
      } else if (branch.reason && branch.reason !== "unmerged") {
        outcome.retained.push({
          branch: track.branch_name,
          worktreePath: track.worktree_path,
          reason: branch.reason,
        });
      }
    }

    await pruneWorktrees(repoPath);
    return outcome;
  }

  private async operatorAbort(
    wave: PipelineWaveRow,
    reason: string | undefined
  ): Promise<
    | { ok: true; response: PipelineWaveOperatorResponse }
    | { ok: false; reason: PipelineWaveOperatorRefusal }
  > {
    if (wave.status === "aborted") {
      return {
        ok: true,
        response: {
          action: "abort",
          waveId: wave.id,
          status: "aborted",
          integrationRunId: null,
        },
      };
    }
    if (wave.status === "completed" && wave.finalized_at != null) {
      return { ok: false, reason: "not-eligible" };
    }

    const detail = reason?.trim() || "operator abort";
    this.waveStore.abortWave(wave.id, detail);

    const repoPath = this.store.getWorkspacePath(wave.workspace_id);
    const retained: Array<{
      branch: string;
      worktreePath: string;
      reason: string;
    }> = [];
    if (repoPath) {
      const tracks = this.waveStore.listTracks(wave.id);
      for (const track of tracks) {
        const removed = await removeWorktreeSafe({
          repoPath,
          worktreePath: track.worktree_path,
          forceCleanOnly: true,
        });
        if (!removed.removed) {
          retained.push({
            branch: track.branch_name,
            worktreePath: track.worktree_path,
            reason: removed.reason ?? "retained",
          });
        }
      }
      this.waveStore.recordCleanup(wave.id, {
        removedWorktrees: [],
        deletedBranches: [],
        retained,
      });
    }

    await this.stopWaveSiblings(wave.id, "", detail);

    const current = this.waveStore.getWave(wave.id)!;
    return {
      ok: true,
      response: {
        action: "abort",
        waveId: wave.id,
        status: current.status,
        integrationRunId: null,
        retained: retained.length > 0 ? retained : undefined,
      },
    };
  }

  private async operatorRetryIntegration(
    wave: PipelineWaveRow
  ): Promise<
    | { ok: true; response: PipelineWaveOperatorResponse }
    | { ok: false; reason: PipelineWaveOperatorRefusal }
  > {
    if (wave.status !== "blocked") {
      return { ok: false, reason: "not-blocked" };
    }
    if (!this.waveStore.allTracksComplete(wave.id)) {
      return { ok: false, reason: "tracks-incomplete" };
    }
    if (wave.finalized_at != null) {
      return { ok: false, reason: "not-eligible" };
    }

    if (wave.integration_run_id) {
      const active = this.store.getRun(wave.integration_run_id);
      if (
        active &&
        (active.status === "queued" ||
          active.status === "running" ||
          active.status === "needs_input")
      ) {
        return { ok: false, reason: "integration-active" };
      }
    }

    const repoPath = this.store.getWorkspacePath(wave.workspace_id);
    if (!repoPath) {
      return { ok: false, reason: "not-eligible" };
    }
    const preflight = await preflightMainCheckout(repoPath);
    if (!preflight.ok) {
      return { ok: false, reason: "dirty-checkout" };
    }

    if (!this.waveStore.prepareIntegrationRetry(wave.id)) {
      return { ok: false, reason: "not-eligible" };
    }

    const enqueued = await this.tryEnqueueIntegration(wave.id);
    if (!enqueued) {
      return { ok: false, reason: "not-eligible" };
    }

    const current = this.waveStore.getWave(wave.id)!;
    return {
      ok: true,
      response: {
        action: "retry-integration",
        waveId: wave.id,
        status: current.status,
        integrationRunId: current.integration_run_id,
      },
    };
  }

  private async resumeProvisioningWave(wave: PipelineWaveRow): Promise<boolean> {
    if (wave.status !== "provisioning" && wave.status !== "running") {
      return false;
    }

    const coordinator = this.store.getRun(wave.coordinator_run_id);
    if (!coordinator) {
      return false;
    }

    const repoPath = this.store.getWorkspacePath(wave.workspace_id);
    if (!repoPath) {
      return false;
    }

    let repaired = false;
    const tracks = this.waveStore.listTracks(wave.id);
    for (const track of tracks) {
      if (track.planner_run_id != null) {
        continue;
      }
      try {
        await addWorktree({
          repoPath,
          worktreePath: track.worktree_path,
          branchName: track.branch_name,
          startPoint: wave.base_commit,
        });
        repaired = true;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (!detail.includes("already exists")) {
          this.onLog(
            `Wave resume: worktree add failed for track ${track.id}: ${detail}`
          );
          continue;
        }
      }
    }

    if (wave.status === "provisioning") {
      this.waveStore.markWaveRunning(wave.id);
    }

    const parsed = this.store.parseChainContext(coordinator);
    if (!parsed?.ok || coordinator.chain_depth == null) {
      return repaired;
    }

    let waveContext: ChainRunContext;
    try {
      waveContext = normalizeWaveChainContext(parsed.context);
    } catch (err) {
      const detail =
        err instanceof KickoffError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.onLog(
        `Wave resume: invalid chain variables on ${wave.coordinator_run_id}: ${detail}`
      );
      return repaired;
    }

    const plannerTargetId = this.store.resolveChainTarget(
      wave.workspace_id,
      PLAN_PHASE_REF
    );
    const plannerAutomation = plannerTargetId
      ? this.store.getAutomation(plannerTargetId)
      : undefined;
    if (!plannerTargetId || !plannerAutomation) {
      return repaired;
    }

    const rendered = renderChainTemplate(
      plannerAutomation.prompt,
      waveContext.variables
    );
    if (!rendered.ok) {
      return repaired;
    }

    const { modelSelectionOverride } = resolveChildModelRole(
      true,
      waveContext,
      plannerAutomation,
      (msg) => this.onLog(msg)
    );
    const maxDepth =
      coordinator.chain_max_depth_override ?? coordinator.chain_max_depth ?? 0;

    for (const track of tracks) {
      if (track.planner_run_id != null) {
        continue;
      }
      const promptOverride = `${rendered.text}

${trackContextBlock({
  waveOrdinal: wave.ordinal,
  trackOrdinal: track.ordinal,
  phaseRef: track.phase_ref,
  phaseFile: track.phase_file,
})}`;
      const limited = assertPromptWithinByteLimit(promptOverride);
      if (!limited.ok) {
        this.waveStore.blockWave(wave.id, "template-error", limited.message);
        return repaired;
      }

      const triggerOptions: TriggerRunOptions = {
        parentRunId: wave.coordinator_run_id,
        promptOverride,
        chainContext: waveContext,
        chainRootRunId: wave.root_run_id,
        chainDepth: coordinator.chain_depth + 1,
        chainMaxDepth: maxDepth,
        pipelineWaveId: wave.id,
        pipelineTrackId: track.id,
        executionCwd: track.worktree_path,
      };
      if (modelSelectionOverride !== undefined) {
        triggerOptions.modelSelectionOverride = modelSelectionOverride;
      }

      try {
        const plannerRunId = await this.engine.triggerRun(
          plannerTargetId,
          "chain",
          triggerOptions
        );
        this.waveStore.assignTrackPlanner(track.id, plannerRunId);
        this.store.appendEvent(wave.coordinator_run_id, "run.pipeline-wave-recovered", {
          waveId: wave.id,
          reason: "provisioning-planner",
          trackId: track.id,
          plannerRunId,
        });
        repaired = true;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.onLog(
          `Wave resume: planner enqueue failed for track ${track.id}: ${text}`
        );
      }
    }

    return repaired;
  }

  private async resumeMissedTrackTerminals(
    wave: PipelineWaveRow
  ): Promise<boolean> {
    const runs = this.store.listRunsForPipelineWave(wave.id);
    let repaired = false;

    for (const run of runs) {
      if (run.status !== "completed" || run.chain_handled_at != null) {
        continue;
      }
      const automation = this.store.getAutomationByIdIncludingArchived(
        run.automation_id
      );
      const workerKey = workerKeyFromConfigKey(automation?.config_key);
      if (!isTrackTerminalWorkerKey(workerKey) || !run.pipeline_track_id) {
        continue;
      }
      this.store.appendEvent(run.id, "run.pipeline-wave-recovered", {
        waveId: wave.id,
        reason: "missed-track-terminal",
      });
      const hook = await this.handleTrackTerminal(run.id, run);
      if (hook.handled) {
        repaired = true;
      }
    }

    return repaired;
  }

  private async resumeReadyJoin(wave: PipelineWaveRow): Promise<boolean> {
    if (wave.join_claimed_at != null || wave.integration_run_id != null) {
      return false;
    }
    if (!this.waveStore.allTracksComplete(wave.id)) {
      return false;
    }

    this.store.appendEvent(wave.coordinator_run_id, "run.pipeline-wave-recovered", {
      waveId: wave.id,
      reason: "ready-join",
    });
    return this.tryEnqueueIntegration(wave.id);
  }
}
