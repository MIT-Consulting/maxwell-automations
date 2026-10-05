/**
 * Pure pipeline snapshot projection for doctor, daemon HTTP, and watch CLI.
 * State and outcome come from run rows; events enrich activity/cursor only.
 */

import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  type ImplementFullyApprovalPolicy,
  type ImplementFullyLoopMode,
  type ImplementFullyPlanningDepth,
  type ImplementFullyPlanningProfileId,
} from "./types/api.js";
import type { ChainRunContext } from "./types/config.js";
import type { InputRequestMetadata, RunStatus } from "./types/entities.js";
import {
  classifyPipelineOutcome,
  type PipelineOutcome,
} from "./pipeline-outcome.js";
import { pipelineSummaryFromContext } from "./pipeline-run.js";
import {
  comparePipelineRunOrder,
  describePipelineWaveStep,
  formatWaveTrackProgress,
  latestWaveSummaryInRuns,
  type RunPipelineTrackSummary,
  type RunPipelineWaveSummary,
} from "./pipeline-wave.js";
import { resolveSteerTargetRunId } from "./resolve-steer-target.js";

const HALT_DISCOVERY_TRIGGER_KIND = "halt-discovery";
const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export type PipelineSnapshotPhase = {
  n: number;
  of: number | null;
};

export type PipelineSnapshotCurrent = {
  runId: string;
  workerKey: string | null;
  modelRole: string | null;
  modelId: string | null;
  status: RunStatus;
  startedAt: string | null;
  elapsedMs: number;
  lastActivityAt: string | null;
  lastActivity: string | null;
};

export type PipelineSnapshotStep = {
  runId: string;
  depth: number | null;
  workerKey: string | null;
  stepLabel: string;
  cycle: number | null;
  stepInCycle: number | null;
  modelRole: string | null;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  waveOrdinal: number | null;
  trackOrdinal: number | null;
  phaseRef: string | null;
  trackStatus: string | null;
};

export type PipelineSnapshotTotals = {
  elapsedMs: number;
  depth: number | null;
  effectiveBudget: number | null;
};

export type PipelineSnapshotWaves = {
  summary: RunPipelineWaveSummary | null;
  label: string | null;
};

export type PipelineSnapshotWaiting = {
  inputRequestId: string;
  runId: string;
  kind: string | null;
  question: string;
  createdAt: string;
};

export type PipelineSnapshotHalt = {
  runId: string;
  code: string | null;
  detail: string | null;
  recoveryCommand: string | null;
};

export type PipelineSnapshot = {
  featureId: string;
  featureSlug: string | null;
  pipelineId: string | null;
  workspaceId: string;
  rootRunId: string;
  contextUnavailable: boolean;
  stopRequestedAt: string | null;
  stopReason: string | null;
  budgetOverrideInForce: boolean;
  loopMode: ImplementFullyLoopMode | null;
  planningProfile: ImplementFullyPlanningProfileId | null;
  roleModelProfileId: string | null;
  current: PipelineSnapshotCurrent | null;
  steps: PipelineSnapshotStep[];
  totals: PipelineSnapshotTotals;
  phase: PipelineSnapshotPhase | null;
  waves: PipelineSnapshotWaves;
  waiting: PipelineSnapshotWaiting | null;
  halt: PipelineSnapshotHalt | null;
  outcome: PipelineOutcome;
  cursor: number | null;
};

export type PipelineSnapshotRunInput = {
  id: string;
  automationId: string;
  workspaceId: string;
  status: RunStatus;
  parentRunId: string | null;
  chainRootRunId: string | null;
  chainDepth: number | null;
  chainMaxDepth: number | null;
  chainMaxDepthOverride: number | null;
  chainStopRequestedAt: string | null;
  chainStopReason: string | null;
  chainHandledAt: string | null;
  chainContext?: ChainRunContext | null;
  pipeline?: { featureId: string; featureSlug: string; pipelineId: string } | null;
  pipelineWave?: RunPipelineWaveSummary | null;
  pipelineTrack?: RunPipelineTrackSummary | null;
  triggerKind?: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

export type PipelineSnapshotAutomationInput = {
  id: string;
  configKey: string;
  modelRole?: string | null;
};

export type PipelineSnapshotEventInput = {
  id: number;
  runId: string;
  eventType: string;
  payload: string;
  createdAt: string;
};

export type PipelineSnapshotInputRequestInput = {
  id: string;
  runId: string;
  status: string;
  question: string;
  metadata?: InputRequestMetadata | null;
  createdAt: string;
};

export type BuildPipelineSnapshotInput = {
  rootRunId: string;
  runs: readonly PipelineSnapshotRunInput[];
  automations: readonly PipelineSnapshotAutomationInput[];
  events?: readonly PipelineSnapshotEventInput[];
  inputRequests?: readonly PipelineSnapshotInputRequestInput[];
  cursor?: number | null;
};

function parseNow(now: number | string): number {
  if (typeof now === "number") {
    return Number.isFinite(now) ? now : 0;
  }
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoToMs(iso: string | null | undefined): number | null {
  if (iso == null || iso.length === 0) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function durationMs(
  startedAt: string | null,
  endedAt: string | null,
  createdAt: string,
  status: RunStatus,
  nowMs: number
): number | null {
  const startMs = isoToMs(startedAt) ?? isoToMs(createdAt);
  if (startMs == null) {
    return null;
  }
  if (TERMINAL_STATUSES.has(status)) {
    const endMs = isoToMs(endedAt) ?? nowMs;
    return Math.max(0, endMs - startMs);
  }
  return Math.max(0, nowMs - startMs);
}

function effectiveBudgetForRun(run: PipelineSnapshotRunInput): number | null {
  if (typeof run.chainMaxDepthOverride === "number") {
    return run.chainMaxDepthOverride;
  }
  if (typeof run.chainMaxDepth === "number") {
    return run.chainMaxDepth;
  }
  return null;
}

function isHaltDiscoveryAdvisory(run: PipelineSnapshotRunInput): boolean {
  return run.triggerKind === HALT_DISCOVERY_TRIGGER_KIND;
}

function lineageRuns(
  runs: readonly PipelineSnapshotRunInput[],
  rootRunId: string
): PipelineSnapshotRunInput[] {
  return runs
    .filter(
      (run) =>
        run.id === rootRunId ||
        run.chainRootRunId === rootRunId
    )
    .filter((run) => !isHaltDiscoveryAdvisory(run));
}

function automationMap(
  automations: readonly PipelineSnapshotAutomationInput[]
): Map<string, PipelineSnapshotAutomationInput> {
  return new Map(automations.map((automation) => [automation.id, automation]));
}

function readStringVariable(
  context: ChainRunContext | null | undefined,
  key: string
): string | null {
  const value = context?.variables[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function planningProfileFromControls(
  planningDepth: ImplementFullyPlanningDepth,
  approvalPolicy: ImplementFullyApprovalPolicy
): ImplementFullyPlanningProfileId | null {
  const match = IMPLEMENT_FULLY_PLANNING_PROFILES.find(
    (profile) =>
      profile.planningDepth === planningDepth &&
      profile.approvalPolicy === approvalPolicy
  );
  return match?.id ?? null;
}

function readLoopMode(
  context: ChainRunContext | null | undefined
): ImplementFullyLoopMode | null {
  const raw = readStringVariable(context, "loopMode");
  return raw === "execute" || raw === "normal" ? raw : null;
}

function readPlanningProfile(
  context: ChainRunContext | null | undefined
): ImplementFullyPlanningProfileId | null {
  const depth = readStringVariable(context, "planningDepth");
  const approval = readStringVariable(context, "approvalPolicy");
  if (
    (depth === "jit" || depth === "full") &&
    (approval === "none" || approval === "before-implementation")
  ) {
    return planningProfileFromControls(depth, approval);
  }
  return null;
}

function aggregateElapsedMs(
  runs: readonly PipelineSnapshotRunInput[],
  nowMs: number
): number {
  if (runs.length === 0) {
    return 0;
  }
  let startMs: number | null = null;
  let endMs: number | null = null;
  let stillActive = false;

  for (const run of runs) {
    const start = isoToMs(run.startedAt) ?? isoToMs(run.createdAt);
    if (start != null && (startMs == null || start < startMs)) {
      startMs = start;
    }
    if (!TERMINAL_STATUSES.has(run.status)) {
      stillActive = true;
      continue;
    }
    const end = isoToMs(run.endedAt);
    if (end != null && (endMs == null || end > endMs)) {
      endMs = end;
    }
  }

  if (startMs == null) {
    return 0;
  }
  const end = stillActive ? nowMs : (endMs ?? nowMs);
  return Math.max(0, end - startMs);
}

function maxDepthSeen(runs: readonly PipelineSnapshotRunInput[]): number | null {
  let max: number | null = null;
  for (const run of runs) {
    if (typeof run.chainDepth === "number") {
      max = max == null ? run.chainDepth : Math.max(max, run.chainDepth);
    }
  }
  return max;
}

function deepestBudgetRun(
  runs: readonly PipelineSnapshotRunInput[]
): PipelineSnapshotRunInput | null {
  let best: PipelineSnapshotRunInput | null = null;
  for (const run of runs) {
    if (typeof run.chainDepth !== "number") {
      continue;
    }
    if (
      best == null ||
      run.chainDepth > (best.chainDepth ?? Number.NEGATIVE_INFINITY)
    ) {
      best = run;
    }
  }
  return best ?? runs[0] ?? null;
}

function derivePhase(
  lineage: readonly PipelineSnapshotRunInput[],
  automations: Map<string, PipelineSnapshotAutomationInput>
): PipelineSnapshotPhase | null {
  let planSkeletonCompleted = false;
  let completedPlanPhases = 0;

  for (const run of lineage) {
    const configKey = automations.get(run.automationId)?.configKey;
    const workerKey = configKey?.startsWith(GENERATED_CONFIG_KEY_PREFIX)
      ? configKey.slice(GENERATED_CONFIG_KEY_PREFIX.length)
      : null;
    if (workerKey === "plan-skeleton" && run.status === "completed") {
      planSkeletonCompleted = true;
    }
    if (workerKey === "plan-phase" && run.status === "completed") {
      completedPlanPhases += 1;
    }
  }

  if (!planSkeletonCompleted) {
    return null;
  }
  return {
    n: Math.max(1, completedPlanPhases + 1),
    of: null,
  };
}

function stepLabelFor(
  configKey: string | undefined,
  depth: number | null | undefined,
  waveMeta: {
    waveOrdinal?: number | null;
    trackOrdinal?: number | null;
    phaseRef?: string | null;
  }
): string {
  const desc = describePipelineWaveStep({
    configKey,
    chainDepth: depth,
    ...waveMeta,
  });
  if (desc.phaseRef != null && desc.waveOrdinal != null) {
    const track =
      desc.trackOrdinal != null ? ` track ${desc.trackOrdinal}` : "";
    return `${desc.phaseRef} (w${desc.waveOrdinal}${track})`;
  }
  if (desc.workerKey == null) return "(unknown step)";
  if (desc.cycle != null && desc.stepInCycle != null) {
    return `${desc.workerKey} (step ${desc.stepInCycle}, cycle ${desc.cycle})`;
  }
  if (desc.waveOrdinal != null && desc.workerKey === "integrate-wave") {
    return `integrate-wave (w${desc.waveOrdinal})`;
  }
  if (desc.workerKey === "final-gate") {
    return "final-gate (feature-end root pass)";
  }
  if (desc.workerKey === "research") {
    return "research (pre-planning prelude)";
  }
  return desc.workerKey;
}

function buildSteps(
  lineage: readonly PipelineSnapshotRunInput[],
  automations: Map<string, PipelineSnapshotAutomationInput>,
  nowMs: number
): PipelineSnapshotStep[] {
  const ordered = [...lineage].sort(comparePipelineRunOrder);
  return ordered.map((run) => {
    const automation = automations.get(run.automationId);
    const configKey = automation?.configKey;
    const waveMeta = {
      waveOrdinal: run.pipelineWave?.ordinal ?? null,
      trackOrdinal: run.pipelineTrack?.ordinal ?? null,
      phaseRef: run.pipelineTrack?.phaseRef ?? null,
    };
    const desc = describePipelineWaveStep({
      configKey,
      chainDepth: run.chainDepth,
      ...waveMeta,
    });
    return {
      runId: run.id,
      depth: run.chainDepth,
      workerKey: desc.workerKey,
      stepLabel: stepLabelFor(configKey, run.chainDepth, waveMeta),
      cycle: desc.cycle,
      stepInCycle: desc.stepInCycle,
      modelRole: automation?.modelRole ?? null,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: durationMs(
        run.startedAt,
        run.endedAt,
        run.createdAt,
        run.status,
        nowMs
      ),
      waveOrdinal: waveMeta.waveOrdinal,
      trackOrdinal: waveMeta.trackOrdinal,
      phaseRef: waveMeta.phaseRef,
      trackStatus: run.pipelineTrack?.status ?? null,
    };
  });
}

function latestActivityForRun(
  runId: string,
  events: readonly PipelineSnapshotEventInput[]
): { at: string; label: string } | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.runId !== runId) {
      continue;
    }
    return {
      at: event.createdAt,
      label: event.eventType,
    };
  }
  return null;
}

function buildCurrent(
  lineage: readonly PipelineSnapshotRunInput[],
  rootRunId: string,
  automations: Map<string, PipelineSnapshotAutomationInput>,
  events: readonly PipelineSnapshotEventInput[],
  nowMs: number
): PipelineSnapshotCurrent | null {
  const candidates = lineage.map((run) => ({
    id: run.id,
    status: run.status,
    parentRunId: run.parentRunId,
    chainRootRunId: run.chainRootRunId,
  }));

  const steerable = resolveSteerTargetRunId({
    attachedRunId: rootRunId,
    candidates,
  });

  let currentRun: PipelineSnapshotRunInput | undefined;
  if (steerable.kind === "resolved") {
    currentRun = lineage.find((run) => run.id === steerable.runId);
  }

  if (currentRun == null) {
    const waiting = lineage.find((run) => run.status === "needs_input");
    const paused = lineage.find((run) => run.status === "paused");
    currentRun = waiting ?? paused;
  }

  if (currentRun == null) {
    const ordered = [...lineage].sort(comparePipelineRunOrder);
    currentRun = ordered[ordered.length - 1];
  }

  if (currentRun == null) {
    return null;
  }

  const automation = automations.get(currentRun.automationId);
  const configKey = automation?.configKey;
  const waveMeta = {
    waveOrdinal: currentRun.pipelineWave?.ordinal ?? null,
    trackOrdinal: currentRun.pipelineTrack?.ordinal ?? null,
    phaseRef: currentRun.pipelineTrack?.phaseRef ?? null,
  };
  const desc = describePipelineWaveStep({
    configKey,
    chainDepth: currentRun.chainDepth,
    ...waveMeta,
  });
  const activity = latestActivityForRun(currentRun.id, events);

  return {
    runId: currentRun.id,
    workerKey: desc.workerKey,
    modelRole: automation?.modelRole ?? null,
    modelId: currentRun.model,
    status: currentRun.status,
    startedAt: currentRun.startedAt,
    elapsedMs:
      durationMs(
        currentRun.startedAt,
        currentRun.endedAt,
        currentRun.createdAt,
        currentRun.status,
        nowMs
      ) ?? 0,
    lastActivityAt: activity?.at ?? null,
    lastActivity: activity?.label ?? null,
  };
}

function findWaiting(
  lineage: readonly PipelineSnapshotRunInput[],
  inputRequests: readonly PipelineSnapshotInputRequestInput[]
): PipelineSnapshotWaiting | null {
  const lineageIds = new Set(lineage.map((run) => run.id));
  for (const request of inputRequests) {
    if (request.status !== "pending" || !lineageIds.has(request.runId)) {
      continue;
    }
    return {
      inputRequestId: request.id,
      runId: request.runId,
      kind: request.metadata?.kind ?? null,
      question: request.question,
      createdAt: request.createdAt,
    };
  }
  return null;
}

function isHaltedRun(run: PipelineSnapshotRunInput): boolean {
  return (
    (run.status === "failed" || run.status === "cancelled") &&
    run.chainHandledAt == null
  );
}

function buildHalt(
  lineage: readonly PipelineSnapshotRunInput[]
): PipelineSnapshotHalt | null {
  const halted = [...lineage]
    .filter(isHaltedRun)
    .sort(comparePipelineRunOrder)
    .pop();

  if (halted == null) {
    return null;
  }

  const shortId = halted.id.length <= 8 ? halted.id : halted.id.slice(0, 8);
  return {
    runId: halted.id,
    code: halted.status,
    detail: halted.chainStopReason,
    recoveryCommand: `lca escalate ${shortId} retry|skip|abort [--reason <text>]`,
  };
}

function maxCursor(
  events: readonly PipelineSnapshotEventInput[],
  explicit: number | null | undefined
): number | null {
  if (typeof explicit === "number") {
    return explicit;
  }
  let max: number | null = null;
  for (const event of events) {
    if (max == null || event.id > max) {
      max = event.id;
    }
  }
  return max;
}

/**
 * Build a deterministic pipeline snapshot from persisted facts. Pass injected
 * `now` so durations are testable; terminal step durations freeze at endedAt.
 */
export function buildPipelineSnapshot(
  input: BuildPipelineSnapshotInput,
  now: number | string
): PipelineSnapshot | null {
  const nowMs = parseNow(now);
  const events = input.events ?? [];
  const inputRequests = input.inputRequests ?? [];
  const automations = automationMap(input.automations);

  const rootRun = input.runs.find((run) => run.id === input.rootRunId);
  if (rootRun == null) {
    return null;
  }

  const lineage = lineageRuns(input.runs, input.rootRunId);
  if (lineage.length === 0) {
    return null;
  }

  const rootContext = rootRun.chainContext ?? null;
  const summary =
    pipelineSummaryFromContext(rootContext) ?? rootRun.pipeline ?? null;
  const featureId = summary?.featureId ?? "";
  const featureSlug = summary?.featureSlug ?? null;
  const pipelineId = summary?.pipelineId ?? null;
  const workspaceId = rootRun.workspaceId;
  const contextUnavailable =
    rootRun.chainContext === undefined &&
    rootRun.pipeline == null &&
    summary == null;

  const budgetRun = deepestBudgetRun(lineage);
  const budgetOverrideInForce =
    typeof budgetRun?.chainMaxDepthOverride === "number";
  const waveSummary = latestWaveSummaryInRuns(lineage);
  const waveLabel =
    waveSummary != null ? formatWaveTrackProgress(waveSummary) : null;

  const outcomeRuns = lineage.map((run) => ({
    status: run.status,
    configKey: automations.get(run.automationId)?.configKey ?? "",
    chainStopRequestedAt: run.chainStopRequestedAt,
    chainStopReason: run.chainStopReason,
    chainHandledAt: run.chainHandledAt,
    createdAt: run.createdAt,
  }));

  const finalGateConfigKey = `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY}`;

  return {
    featureId,
    featureSlug,
    pipelineId,
    workspaceId,
    rootRunId: input.rootRunId,
    contextUnavailable,
    stopRequestedAt: rootRun.chainStopRequestedAt,
    stopReason: rootRun.chainStopReason,
    budgetOverrideInForce,
    loopMode: readLoopMode(rootContext),
    planningProfile: readPlanningProfile(rootContext),
    roleModelProfileId: readStringVariable(rootContext, "roleModelProfileId"),
    current: buildCurrent(
      lineage,
      input.rootRunId,
      automations,
      events,
      nowMs
    ),
    steps: buildSteps(lineage, automations, nowMs),
    totals: {
      elapsedMs: aggregateElapsedMs(lineage, nowMs),
      depth: maxDepthSeen(lineage),
      effectiveBudget: budgetRun ? effectiveBudgetForRun(budgetRun) : null,
    },
    phase: derivePhase(lineage, automations),
    waves: { summary: waveSummary, label: waveLabel },
    waiting: findWaiting(lineage, inputRequests),
    halt: buildHalt(lineage),
    outcome: classifyPipelineOutcome({
      runs: outcomeRuns,
      finalGateConfigKey,
      events: events.map((event) => ({
        eventType: event.eventType,
        payload: event.payload,
      })),
    }),
    cursor: maxCursor(events, input.cursor),
  };
}
