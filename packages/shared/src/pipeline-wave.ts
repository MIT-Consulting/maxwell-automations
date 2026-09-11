/**
 * Pure helpers for parallel-wave identity, labels, and candidate validation.
 * Never throws on absent legacy metadata.
 */

import {
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  type PipelineTrackStatus,
  type PipelineWaveCandidate,
  type PipelineWaveStatus,
} from "./types/api.js";
import {
  describePipelineStep,
  workerKeyFromConfigKey,
  type PipelineStepDescriptor,
} from "./pipeline-run.js";

/** Board-safe wave summary on list/detail run reads. */
export type RunPipelineWaveSummary = {
  id: string;
  ordinal: number;
  status: PipelineWaveStatus;
  trackCount: number;
  completedTrackCount: number;
  joinClaimed: boolean;
  finalized: boolean;
  blockedCode: string | null;
  cleanupRequired: boolean;
};

/** Board-safe track summary on list/detail run reads. */
export type RunPipelineTrackSummary = {
  id: string;
  ordinal: number;
  status: PipelineTrackStatus;
  phaseRef: string;
  phaseFile: string;
};

/** Doctor/detail-only wave fields — never on the board list payload. */
export type RunPipelineWaveDoctorDetail = RunPipelineWaveSummary & {
  baseCommit: string | null;
  integrationRunId: string | null;
  blockedDetail: string | null;
};

/** Doctor/detail-only track fields — never on the board list payload. */
export type RunPipelineTrackDoctorDetail = RunPipelineTrackSummary & {
  branchName: string;
  headCommit: string | null;
  blockedDetail: string | null;
};

/** Minimal run shape for shared lineage / board ordering. */
export type PipelineRunOrderInput = {
  chainDepth?: number | null;
  createdAt: string;
  pipelineWave?: RunPipelineWaveSummary | null;
  pipelineTrack?: RunPipelineTrackSummary | null;
};

export const PIPELINE_WAVE_PHASE_REF_MAX = 64;
export const PIPELINE_WAVE_CANDIDATE_MIN = 2;
export const PIPELINE_WAVE_CANDIDATE_MAX = 64;

/**
 * Validate a relative markdown phase path under featureDir.
 * Rejects absolute paths, backslashes, empty/`.`/`..` segments, NUL, and non-`.md`.
 */
export function isValidPipelinePhaseFile(phaseFile: string): boolean {
  if (typeof phaseFile !== "string" || phaseFile.length === 0) return false;
  if (phaseFile.includes("\0")) return false;
  if (phaseFile.includes("\\")) return false;
  if (phaseFile.startsWith("/") || /^[A-Za-z]:/.test(phaseFile)) return false;
  if (!phaseFile.endsWith(".md")) return false;
  const segments = phaseFile.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Normalize and validate a phase ref; returns null when invalid. */
export function normalizePipelinePhaseRef(phaseRef: string): string | null {
  if (typeof phaseRef !== "string") return null;
  const trimmed = phaseRef.trim();
  if (trimmed.length === 0 || trimmed.length > PIPELINE_WAVE_PHASE_REF_MAX) {
    return null;
  }
  return trimmed;
}

/** Sort candidates in stable tracker-submission order (input order preserved). */
export function sortWaveCandidates(
  candidates: readonly PipelineWaveCandidate[]
): PipelineWaveCandidate[] {
  return candidates.map((c) => ({
    phaseRef: c.phaseRef,
    phaseFile: c.phaseFile,
  }));
}

/**
 * Split accepted vs deferred by maxConcurrentRuns while preserving order.
 * When maxConcurrent < 2, all candidates are deferred (sequential fallback).
 */
export function partitionWaveCandidates(
  candidates: readonly PipelineWaveCandidate[],
  maxConcurrentRuns: number
): { accepted: PipelineWaveCandidate[]; deferred: PipelineWaveCandidate[] } {
  const ordered = sortWaveCandidates(candidates);
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 2) {
    return { accepted: [], deferred: ordered };
  }
  return {
    accepted: ordered.slice(0, maxConcurrentRuns),
    deferred: ordered.slice(maxConcurrentRuns),
  };
}

export type PipelineWaveStepDescriptor = PipelineStepDescriptor & {
  /** Present when the run is on a parallel track or is the integration worker. */
  waveOrdinal: number | null;
  trackOrdinal: number | null;
  phaseRef: string | null;
};

/**
 * Label a run for board/doctor. Parallel tracks use wave/track/phase instead of
 * fabricating a sequential cycle from duplicate depths. Legacy sequential runs
 * keep `describePipelineStep` behavior.
 */
export function describePipelineWaveStep(input: {
  configKey: string | null | undefined;
  chainDepth: number | null | undefined;
  waveOrdinal?: number | null;
  trackOrdinal?: number | null;
  phaseRef?: string | null;
}): PipelineWaveStepDescriptor {
  const base = describePipelineStep(input.configKey, input.chainDepth);
  const workerKey = workerKeyFromConfigKey(input.configKey);
  const waveOrdinal =
    typeof input.waveOrdinal === "number" ? input.waveOrdinal : null;
  const trackOrdinal =
    typeof input.trackOrdinal === "number" ? input.trackOrdinal : null;
  const phaseRef =
    typeof input.phaseRef === "string" && input.phaseRef.length > 0
      ? input.phaseRef
      : null;

  // Terminal / off-cycle workers: never fabricate a sequential cycle.
  if (
    workerKey === IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY ||
    workerKey === IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
  ) {
    return {
      workerKey,
      stepInCycle: null,
      cycle: null,
      waveOrdinal,
      trackOrdinal: null,
      phaseRef: null,
    };
  }

  if (waveOrdinal == null && trackOrdinal == null && phaseRef == null) {
    return { ...base, waveOrdinal: null, trackOrdinal: null, phaseRef: null };
  }

  // Parallel track: suppress false cycle from shared depth.
  if (trackOrdinal != null || phaseRef != null) {
    return {
      workerKey: base.workerKey,
      stepInCycle: base.stepInCycle,
      cycle: null,
      waveOrdinal,
      trackOrdinal,
      phaseRef,
    };
  }

  return { ...base, waveOrdinal, trackOrdinal, phaseRef };
}

/** Compact chip label: `feature · phase · worker · wave` for tracks. */
export function formatPipelineWaveChipLabel(input: {
  featureId: string;
  configKey: string | null | undefined;
  chainDepth: number | null | undefined;
  waveOrdinal?: number | null;
  trackOrdinal?: number | null;
  phaseRef?: string | null;
}): string {
  const step = describePipelineWaveStep(input);
  const worker = step.workerKey ?? "worker";
  if (step.phaseRef != null && step.waveOrdinal != null) {
    return `${input.featureId} · ${step.phaseRef} · ${worker} · w${step.waveOrdinal}`;
  }
  if (step.workerKey === IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY) {
    const wave =
      step.waveOrdinal != null ? ` · w${step.waveOrdinal}` : "";
    return `${input.featureId} · integrate-wave${wave}`;
  }
  if (step.workerKey === IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY) {
    return `${input.featureId} · final-gate`;
  }
  const sequential = describePipelineStep(input.configKey, input.chainDepth);
  if (sequential.cycle != null && sequential.workerKey != null) {
    return `${input.featureId} · ${sequential.workerKey} · ${sequential.cycle}`;
  }
  if (sequential.workerKey != null) {
    return `${input.featureId} · ${sequential.workerKey}`;
  }
  return input.featureId;
}

/**
 * Order pipeline runs: wave ordinal, track ordinal, chain depth, then createdAt.
 * Sequential runs (no wave metadata) keep depth-then-time ordering.
 */
export function comparePipelineRunOrder(
  a: PipelineRunOrderInput,
  b: PipelineRunOrderInput
): number {
  const waveA = a.pipelineWave?.ordinal ?? Number.POSITIVE_INFINITY;
  const waveB = b.pipelineWave?.ordinal ?? Number.POSITIVE_INFINITY;
  if (waveA !== waveB) return waveA - waveB;

  const trackA = a.pipelineTrack?.ordinal ?? Number.POSITIVE_INFINITY;
  const trackB = b.pipelineTrack?.ordinal ?? Number.POSITIVE_INFINITY;
  if (trackA !== trackB) return trackA - trackB;

  const depthA = a.chainDepth ?? Number.POSITIVE_INFINITY;
  const depthB = b.chainDepth ?? Number.POSITIVE_INFINITY;
  if (depthA !== depthB) return depthA - depthB;

  return a.createdAt.localeCompare(b.createdAt);
}

/** Compact wave progress for group headers and doctor summaries. */
export function formatWaveTrackProgress(
  wave: RunPipelineWaveSummary
): string {
  const tracks = `${wave.completedTrackCount}/${wave.trackCount}`;
  if (wave.status === "integrating") {
    return `w${wave.ordinal} integrating · ${tracks} tracks`;
  }
  if (wave.status === "blocked") {
    const code = wave.blockedCode ? ` (${wave.blockedCode})` : "";
    return `w${wave.ordinal} blocked${code} · ${tracks} tracks`;
  }
  if (wave.finalized) {
    return `w${wave.ordinal} finalized · ${tracks} tracks`;
  }
  if (wave.joinClaimed) {
    return `w${wave.ordinal} join claimed · ${tracks} tracks`;
  }
  return `w${wave.ordinal} ${wave.status} · ${tracks} tracks`;
}

/** Pick the most recent wave summary visible in a pipeline group. */
export function latestWaveSummaryInRuns(
  runs: readonly PipelineRunOrderInput[]
): RunPipelineWaveSummary | null {
  let best: RunPipelineWaveSummary | null = null;
  for (const run of runs) {
    const wave = run.pipelineWave;
    if (!wave) continue;
    if (best == null || wave.ordinal > best.ordinal) {
      best = wave;
    }
  }
  return best;
}

/** Client-side operator wave action gates (server enforces eligibility). */
export function waveOperatorActionGates(
  wave: RunPipelineWaveSummary | null | undefined
): {
  retry: { enabled: boolean; title?: string };
  abort: { enabled: boolean; title?: string };
} {
  if (!wave || wave.status !== "blocked") {
    const title = wave ? "Wave is not blocked" : "No wave metadata";
    return {
      retry: { enabled: false, title },
      abort: { enabled: false, title },
    };
  }
  const tracksReady =
    wave.trackCount > 0 && wave.completedTrackCount >= wave.trackCount;
  return {
    retry: {
      enabled: tracksReady,
      title: tracksReady ? undefined : "Not all tracks complete",
    },
    abort: { enabled: true },
  };
}
