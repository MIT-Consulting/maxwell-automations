import {
  comparePipelineRunOrder,
  describePipelineStep,
  formatPipelineWaveChipLabel,
  formatWaveTrackProgress,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  latestWaveSummaryInRuns,
  waveOperatorActionGates,
  type Run,
  type RunPipelineSummary,
  type RunPipelineWaveSummary,
  type RunStatus,
} from "@lca/shared";
import { formatElapsed } from "./helpers";

/** Re-export for LogsModal and other dashboard consumers. */
export { comparePipelineRunOrder };

export type PipelineGroup = {
  /** Shared `chainRootRunId`. */
  rootRunId: string;
  /** First non-null `Run.pipeline` in the group. */
  summary: RunPipelineSummary | null;
  /** Most recent wave summary in the group, when parallel waves are active. */
  waveSummary: RunPipelineWaveSummary | null;
  maxDepthSeen: number | null;
  /** `chainMaxDepthOverride ?? chainMaxDepth` from the deepest run. */
  budget: number | null;
  runs: Run[];
};

export type ColumnRunLayout = {
  groups: PipelineGroup[];
  ungrouped: Run[];
};

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** Status priority for an in-flight pipeline (most operator-relevant first). */
const GROUP_STATUS_PRIORITY: readonly RunStatus[] = [
  "needs_input",
  "paused",
  "running",
  "queued",
  "failed",
  "cancelled",
  "completed",
];

export function isPipelineGroupActive(runs: readonly Run[]): boolean {
  return runs.some((r) => !TERMINAL_STATUSES.has(r.status));
}

/**
 * Frontier of a pipeline's run tree: runs that are not themselves the
 * `parentRunId` of another run in the group. A failed step that was
 * retried (or skipped) is superseded by its child and drops out here, so a
 * stale `failed` row doesn't outlive the retry that resolved it. Falls back
 * to all runs if nothing qualifies (should not happen outside malformed
 * data).
 */
export function effectivePipelineGroupRuns(
  runs: readonly Run[]
): readonly Run[] {
  if (runs.length === 0) return runs;
  const parentIds = new Set<string>();
  for (const run of runs) {
    if (run.parentRunId) parentIds.add(run.parentRunId);
  }
  const leaves = runs.filter((r) => !parentIds.has(r.id));
  return leaves.length > 0 ? leaves : runs;
}

/**
 * Aggregate implement-fully / pipeline group state from member runs.
 * Prefers the most actionable in-flight status; otherwise the worst terminal.
 * Only considers the current frontier of each branch (see
 * `effectivePipelineGroupRuns`) so a failure that was retried to completion
 * reads as `completed`, not `failed`.
 */
export function pipelineGroupStatus(runs: readonly Run[]): RunStatus | null {
  if (runs.length === 0) return null;
  const effective = effectivePipelineGroupRuns(runs);
  const present = new Set(effective.map((r) => r.status));
  for (const status of GROUP_STATUS_PRIORITY) {
    if (present.has(status)) return status;
  }
  return effective[0]!.status;
}

/**
 * Wall-clock span for the group: earliest start/create → latest end (or now
 * while still active). Parallel tracks do not double-count.
 */
export function pipelineGroupAggregateElapsed(
  runs: readonly Run[],
  now: number
): string {
  if (runs.length === 0) return "—";
  let startAt: string | null = null;
  let endAt: string | null = null;
  let stillActive = false;

  for (const run of runs) {
    const start = run.startedAt ?? run.createdAt;
    if (startAt == null || start < startAt) startAt = start;
    if (!TERMINAL_STATUSES.has(run.status)) {
      stillActive = true;
      continue;
    }
    if (run.endedAt != null && (endAt == null || run.endedAt > endAt)) {
      endAt = run.endedAt;
    }
  }

  return formatElapsed(startAt, stillActive ? null : endAt, now);
}

/** Index visible runs by `chainRootRunId` for whole-pipeline header stats. */
export function indexRunsByPipelineRoot(
  runs: readonly Run[]
): Map<string, Run[]> {
  const map = new Map<string, Run[]>();
  for (const run of runs) {
    const root = run.chainRootRunId;
    if (root == null || root === "") continue;
    const bucket = map.get(root);
    if (bucket) bucket.push(run);
    else map.set(root, [run]);
  }
  return map;
}

/**
 * Default expanded root: newest active **pipeline** (using whole-root members
 * when provided), else newest group overall. Groups are assumed newest-first.
 */
export function defaultExpandedPipelineRootId(
  groups: readonly PipelineGroup[],
  runsByRoot?: ReadonlyMap<string, readonly Run[]>
): string | null {
  if (groups.length === 0) return null;
  const membersFor = (group: PipelineGroup): readonly Run[] =>
    runsByRoot?.get(group.rootRunId) ?? group.runs;
  const active = groups.find((g) => isPipelineGroupActive(membersFor(g)));
  return (active ?? groups[0]!).rootRunId;
}

export function formatPipelineGroupStatus(status: RunStatus): string {
  switch (status) {
    case "needs_input":
      return "needs input";
    case "paused":
      return "paused";
    default:
      return status;
  }
}

function newestCreatedAt(runs: Run[]): string {
  let newest = runs[0]!.createdAt;
  for (let i = 1; i < runs.length; i++) {
    const at = runs[i]!.createdAt;
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Group column runs by pipeline root. A null root stays ungrouped (input order).
 * A single-run pipeline is still a group — the header is how the operator learns
 * a lone card is a pipeline step.
 */
export function layoutColumnRuns(runs: Run[]): ColumnRunLayout {
  const ungrouped: Run[] = [];
  const byRoot = new Map<string, Run[]>();
  const rootOrder: string[] = [];

  for (const run of runs) {
    const root = run.chainRootRunId;
    if (root == null || root === "") {
      ungrouped.push(run);
      continue;
    }
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = [];
      byRoot.set(root, bucket);
      rootOrder.push(root);
    }
    bucket.push(run);
  }

  const groups: PipelineGroup[] = rootOrder.map((rootRunId) => {
    const members = byRoot.get(rootRunId)!;
    const ordered = [...members].sort(comparePipelineRunOrder);

    let summary: RunPipelineSummary | null = null;
    let maxDepthSeen: number | null = null;
    let budget: number | null = null;
    let deepestDepth = Number.NEGATIVE_INFINITY;

    for (const run of ordered) {
      if (summary == null && run.pipeline != null) {
        summary = run.pipeline;
      }
      const depth = run.chainDepth;
      if (typeof depth === "number") {
        if (maxDepthSeen == null || depth > maxDepthSeen) {
          maxDepthSeen = depth;
        }
        if (depth >= deepestDepth) {
          deepestDepth = depth;
          budget = effectiveChainBudget(run);
        }
      }
    }

    return {
      rootRunId,
      summary,
      waveSummary: latestWaveSummaryInRuns(ordered),
      maxDepthSeen,
      budget,
      runs: ordered,
    };
  });

  groups.sort(
    (a, b) => newestCreatedAt(b.runs).localeCompare(newestCreatedAt(a.runs))
  );

  return { groups, ungrouped };
}

/** Terminal pipeline run whose successor decision was never claimed. */
export function isHaltedPipelineRun(run: Run): boolean {
  if (run.status !== "failed" && run.status !== "cancelled") return false;
  if (run.pipeline == null) return false;
  return run.chainHandledAt == null;
}

/**
 * Chip label for a pipeline run. Never returns undefined/null/NaN.
 * Parallel tracks use wave/phase labels instead of fabricated cycles.
 */
export function formatPipelineChipLabel(
  featureId: string,
  configKey: string | null | undefined,
  chainDepth: number | null | undefined,
  waveMeta?: {
    waveOrdinal?: number | null;
    trackOrdinal?: number | null;
    phaseRef?: string | null;
  }
): string {
  if (
    waveMeta &&
    (waveMeta.waveOrdinal != null ||
      waveMeta.trackOrdinal != null ||
      waveMeta.phaseRef != null)
  ) {
    return formatPipelineWaveChipLabel({
      featureId,
      configKey,
      chainDepth,
      waveOrdinal: waveMeta.waveOrdinal,
      trackOrdinal: waveMeta.trackOrdinal,
      phaseRef: waveMeta.phaseRef,
    });
  }

  const safeFeature =
    typeof featureId === "string" && featureId.length > 0 ? featureId : "?";
  const desc = describePipelineStep(configKey, chainDepth);
  if (desc.workerKey == null || desc.workerKey === "") {
    return safeFeature;
  }
  // Unknown / legacy non-loop keys stay feature-only; named off-cycle preludes
  // (entry + research) must still render their worker key.
  if (
    desc.workerKey !== IMPLEMENT_FULLY_ENTRY_WORKER_KEY &&
    desc.workerKey !== IMPLEMENT_FULLY_RESEARCH_WORKER_KEY &&
    desc.stepInCycle == null
  ) {
    return safeFeature;
  }
  if (desc.cycle != null && Number.isFinite(desc.cycle)) {
    return `${safeFeature} · ${desc.workerKey} · ${desc.cycle}`;
  }
  return `${safeFeature} · ${desc.workerKey}`;
}

export function pipelineChipLabelForRun(
  run: Run,
  configKey: string | null | undefined
): string {
  const featureId = run.pipeline?.featureId ?? "?";
  return formatPipelineChipLabel(featureId, configKey, run.chainDepth, {
    waveOrdinal: run.pipelineWave?.ordinal ?? null,
    trackOrdinal: run.pipelineTrack?.ordinal ?? null,
    phaseRef: run.pipelineTrack?.phaseRef ?? null,
  });
}

export { formatWaveTrackProgress, waveOperatorActionGates };

export function effectiveChainBudget(run: Run): number | null {
  const override = run.chainMaxDepthOverride;
  if (typeof override === "number") return override;
  const max = run.chainMaxDepth;
  return typeof max === "number" ? max : null;
}

/** Client-side escalation gating titles — same codes as 05b refusals. */
export const ESCALATION_DISABLE_TITLES = {
  "root-run": "Cannot retry the pipeline root; start a fresh kickoff instead",
  "budget-exhausted": "Pipeline budget exhausted; cannot skip further",
  "no-successor": "No configured successor to skip to",
  "not-halted": "Run is not a halted pipeline step",
} as const;

export type EscalationActionGate = {
  enabled: boolean;
  title?: string;
};

export function escalationActionGates(
  run: Run,
  hasSuccessor: boolean
): {
  retry: EscalationActionGate;
  skip: EscalationActionGate;
  abort: EscalationActionGate;
} {
  if (!isHaltedPipelineRun(run)) {
    const gate = {
      enabled: false,
      title: ESCALATION_DISABLE_TITLES["not-halted"],
    };
    return { retry: gate, skip: gate, abort: gate };
  }

  const depth = run.chainDepth ?? 0;
  const budget = effectiveChainBudget(run);

  const retry: EscalationActionGate =
    depth === 0
      ? { enabled: false, title: ESCALATION_DISABLE_TITLES["root-run"] }
      : { enabled: true };

  let skip: EscalationActionGate = { enabled: true };
  if (budget != null && depth >= budget) {
    skip = {
      enabled: false,
      title: ESCALATION_DISABLE_TITLES["budget-exhausted"],
    };
  } else if (!hasSuccessor) {
    skip = {
      enabled: false,
      title: ESCALATION_DISABLE_TITLES["no-successor"],
    };
  }

  return { retry, skip, abort: { enabled: true } };
}

/** Stable successor list keyed by parent run id (supports fan-out). */
export function buildSuccessorMap(runs: readonly Run[]): Map<string, Run[]> {
  const map = new Map<string, Run[]>();
  for (const run of runs) {
    if (!run.parentRunId) continue;
    const list = map.get(run.parentRunId) ?? [];
    list.push(run);
    map.set(run.parentRunId, list);
  }
  for (const [parentId, children] of map) {
    map.set(
      parentId,
      [...children].sort(comparePipelineRunOrder)
    );
  }
  return map;
}
