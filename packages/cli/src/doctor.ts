import type {
  ArchitectResolutionSource,
  Automation,
  ChatEvent,
  ChatSession,
  ChatSnapshot,
  ChainRunContext,
  FeatureQueueEntry,
  FeatureQueueEntryState,
  GatekeeperResolutionSource,
  ImplementFullyLoopMode,
  PipelineHaltDiscoveryActionOutcome,
  PipelineHaltDiscoveryFailureStage,
  PipelineHaltDiscoverySkipCode,
  Run,
  RunEscalationAction,
  Workspace,
} from "@lca/shared";
import {
  comparePipelineRunOrder,
  describePipelineWaveStep,
  PIPELINE_HALT_DISCOVERY_ACTION_OUTCOMES,
  PIPELINE_HALT_DISCOVERY_FAILURE_STAGES,
  PIPELINE_HALT_DISCOVERY_SKIP_CODES,
  PIPELINE_SKELETON_FALLBACK_ROLE,
  PIPELINE_SKELETON_ROLE,
  PIPELINE_TERMINAL_FALLBACK_ROLE,
  PIPELINE_TERMINAL_ROLE,
  pipelineSummaryFromContext,
  resolveRoleSelectionWithFallback,
  RUN_ESCALATION_ACTIONS,
} from "@lca/shared";
import { DaemonError, type RunSnapshot } from "./client.js";

const HALT_DISCOVERY_TRIGGER_KIND = "halt-discovery";

/** Mirrors `isAuthError` in packages/daemon/src/index.ts, plus daemon log wording. */
export const AUTH_ERROR_RE =
  /unauthenticated|ERROR_NOT_LOGGED_IN|not logged in|auth expired/i;

export const DOCTOR_KEY_EVENTS = new Set([
  "run.error",
  "run.finished",
  "run.resumed",
  "run.revived",
  "run.retained.fallback",
  "run.retry.scheduled",
  "run.reconciled",
  "run.stalled",
  "run.chained",
  "run.chain-skipped",
  "run.chain-control",
  "run.pipeline-escalated",
  "run.pipeline-halt-unrecovered",
  "run.pipeline-halt-discovery-requested",
  "run.pipeline-halt-discovery-skipped",
  "run.pipeline-halt-discovery-failed",
  "run.pipeline-halt-discovery-action-result",
  "run.pipeline-resumed",
  "run.pipeline-fanout",
  "run.pipeline-track-completed",
  "run.pipeline-join-ready",
  "run.pipeline-integration-enqueued",
  "run.pipeline-final-gate-enqueued",
  "run.pipeline-feature-review-enqueued",
  "run.pipeline-wave-finalized",
  "run.pipeline-wave-blocked",
  "run.pipeline-wave-recovered",
  "run.pipeline-wave-cleanup",
]);

export type DoctorPipelineEscalation = {
  action: "retry" | "skip" | "abort";
  actor: "daemon" | "operator";
  childRunId: string | null;
  recoveryDetail: string | null;
};

export type DoctorPipelineHaltUnrecovered = {
  code: string;
  detail: string;
};

export type DoctorHaltDiscoveryRequested = {
  code: string;
  recoveryCode: string;
  recoveryDetail: string;
};

export type DoctorHaltDiscoverySkipped = {
  code: PipelineHaltDiscoverySkipCode;
  detail: string;
};

export type DoctorHaltDiscoveryFailed = {
  stage: PipelineHaltDiscoveryFailureStage;
  code: string;
  detail: string;
  advisoryRunId: string | null;
};

export type DoctorHaltDiscoveryActionResult = {
  sourceRunId: string;
  advisoryRunId: string;
  action: RunEscalationAction;
  outcome: PipelineHaltDiscoveryActionOutcome;
  code: string | null;
  childRunId: string | null;
  detail: string | null;
};

export const CHAT_DOCTOR_KEY_EVENTS = new Set([
  "chat.error",
  "chat.finished",
  "chat.resumed",
  "chat.revived",
  "chat.resume.retry",
  "chat.reconciled",
]);

/** Max lineage rows printed by `lca doctor` before truncation is stated. */
export const DOCTOR_LINEAGE_CAP = 24;

/** Age after which a pipeline `needs_input` is flagged in health mode. */
export const DOCTOR_NEEDS_INPUT_AGE_MS = 30 * 60 * 1000;

export type DoctorTarget =
  | { kind: "run"; snapshot: RunSnapshot }
  | { kind: "chat"; snapshot: ChatSnapshot };

export type DoctorResult =
  | { kind: "run"; verdict: string }
  | { kind: "chat"; verdict: string };

/** Minimal client surface for doctor target resolution (mockable in tests). */
export type DoctorLookupClient = {
  getRun(runId: string): Promise<RunSnapshot>;
  getChat(chatId: string): Promise<ChatSnapshot>;
  listRuns(limit?: number): Promise<Run[]>;
  listWorkspaces(): Promise<Workspace[]>;
  listWorkspaceChats(workspaceId: string): Promise<ChatSession[]>;
};

export type PipelineTransitionClaim =
  | "chained"
  | "escalated"
  | "halted-and-escalatable"
  | "open";

export type PipelineDoctorFacts = {
  featureId: string | null;
  featureSlug: string | null;
  pipelineId: string | null;
  stepLabel: string | null;
  cycle: number | null;
  stepInCycle: number | null;
  workerKey: string | null;
  depth: number | null;
  effectiveBudget: number | null;
  budgetOverrideInForce: boolean;
  rootRunId: string;
  isRoot: boolean;
  stopRequestedAt: string | null;
  stopReason: string | null;
  transitionClaim: PipelineTransitionClaim;
  contextUnavailable: boolean;
  depthUnavailable: boolean;
  automationUnavailable: boolean;
  roleNames: string[];
  gatekeeperModelId: string | null;
  gatekeeperSource: GatekeeperResolutionSource | null;
  architectModelId: string | null;
  architectSource: ArchitectResolutionSource | null;
  waveOrdinal: number | null;
  trackOrdinal: number | null;
  phaseRef: string | null;
  waveStatus: string | null;
  trackStatus: string | null;
  barrierProgress: string | null;
  integrationRunId: string | null;
  blockedCode: string | null;
  blockedDetail: string | null;
  branchName: string | null;
  headCommit: string | null;
  baseCommit: string | null;
  cleanupRequired: boolean;
  waveRecoveryCommand: string | null;
  loopMode: ImplementFullyLoopMode | null;
};

export type PipelineLineageEntry = {
  id: string;
  depth: number | null;
  stepLabel: string;
  status: Run["status"];
  isCurrent: boolean;
};

export type PipelineHealthSummary = {
  activeCount: number;
  pausedCount: number;
  halted: Array<{ featureId: string; runId: string }>;
  staleNeedsInput: Array<{ featureId: string; runId: string; ageMs: number }>;
  needsInputAgeMs: number;
  runningTracks: Array<{
    featureId: string;
    runId: string;
    waveOrdinal: number;
    trackOrdinal: number;
    phaseRef: string;
  }>;
  barrierWaits: Array<{
    featureId: string;
    waveId: string;
    waveOrdinal: number;
    completed: number;
    total: number;
  }>;
  blockedWaves: Array<{
    featureId: string;
    waveId: string;
    waveOrdinal: number;
    code: string | null;
  }>;
  cleanupRequired: Array<{ featureId: string; waveId: string; waveOrdinal: number }>;
};

function parseUnknownPayload(payloadRaw: string): unknown {
  try {
    return JSON.parse(payloadRaw) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readStringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function parseEscalationAction(
  value: unknown
): "retry" | "skip" | "abort" | undefined {
  if (value === "retry" || value === "skip" || value === "abort") {
    return value;
  }
  return undefined;
}

/**
 * Latest valid `run.pipeline-escalated`. Daemon only when actor is exactly
 * `"daemon"`; missing/legacy actor is labeled operator.
 */
export function latestPipelineEscalation(
  events: RunSnapshot["events"]
): DoctorPipelineEscalation | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "run.pipeline-escalated") continue;
    const record = asRecord(parseUnknownPayload(ev.payload));
    if (!record) continue;
    const action = parseEscalationAction(record.action);
    if (!action) continue;
    const actorRaw = readStringField(record, "actor");
    const actor = actorRaw === "daemon" ? "daemon" : "operator";
    const childRaw = record.childRunId;
    const childRunId =
      typeof childRaw === "string" && childRaw.length > 0 ? childRaw : null;
    const recoveryDetail = readStringField(record, "recoveryDetail") ?? null;
    return { action, actor, childRunId, recoveryDetail };
  }
  return undefined;
}

/** Latest valid `run.pipeline-halt-unrecovered` with code + detail strings. */
export function latestPipelineHaltUnrecovered(
  events: RunSnapshot["events"]
): DoctorPipelineHaltUnrecovered | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "run.pipeline-halt-unrecovered") continue;
    const record = asRecord(parseUnknownPayload(ev.payload));
    if (!record) continue;
    const code = readStringField(record, "code");
    const detail = readStringField(record, "detail");
    if (!code || !detail) continue;
    return { code, detail };
  }
  return undefined;
}

function diagnoseDaemonRecovery(
  escalation: DoctorPipelineEscalation
): string | undefined {
  if (escalation.actor !== "daemon") return undefined;
  if (escalation.action !== "retry" && escalation.action !== "skip") {
    return undefined;
  }
  const childPart =
    escalation.childRunId != null
      ? ` → child ${escalation.childRunId.slice(0, 8)}`
      : "";
  const detailPart =
    escalation.recoveryDetail != null && escalation.recoveryDetail.length > 0
      ? ` (${escalation.recoveryDetail})`
      : "";
  return (
    `Automatically recovered with ${escalation.action}${childPart}${detailPart}. ` +
    `No operator action needed.`
  );
}

/** Escalations that are not automatic recovery keep their actor's label. */
function diagnoseManualEscalation(
  escalation: DoctorPipelineEscalation
): string {
  const childPart =
    escalation.childRunId != null
      ? ` → child ${escalation.childRunId.slice(0, 8)}`
      : "";
  const who = escalation.actor === "daemon" ? "Daemon" : "Operator";
  return `${who} escalated with ${escalation.action}${childPart}.`;
}

function diagnoseUnrecoveredHalt(
  runId: string,
  unrecovered: DoctorPipelineHaltUnrecovered,
  events: RunSnapshot["events"] = []
): string {
  const discoveryNote = formatSourceDiscoveryNote(events);
  return (
    `Pipeline halt unrecovered (${unrecovered.code}: ${unrecovered.detail}).` +
    `${discoveryNote} ` +
    `Escalate with retry (same depth/prompt/context), skip (advance with an operator notice), ` +
    `or abort (end the pipeline with a reason): ` +
    `lca escalate ${runId} retry|skip|abort [--reason <text>]`
  );
}

function parseSkipCode(
  value: unknown
): PipelineHaltDiscoverySkipCode | undefined {
  if (
    typeof value === "string" &&
    (PIPELINE_HALT_DISCOVERY_SKIP_CODES as readonly string[]).includes(value)
  ) {
    return value as PipelineHaltDiscoverySkipCode;
  }
  return undefined;
}

function parseFailureStage(
  value: unknown
): PipelineHaltDiscoveryFailureStage | undefined {
  if (
    typeof value === "string" &&
    (PIPELINE_HALT_DISCOVERY_FAILURE_STAGES as readonly string[]).includes(value)
  ) {
    return value as PipelineHaltDiscoveryFailureStage;
  }
  return undefined;
}

function parseDiscoveryAction(
  value: unknown
): RunEscalationAction | undefined {
  if (
    typeof value === "string" &&
    (RUN_ESCALATION_ACTIONS as readonly string[]).includes(value)
  ) {
    return value as RunEscalationAction;
  }
  return undefined;
}

function parseDiscoveryOutcome(
  value: unknown
): PipelineHaltDiscoveryActionOutcome | undefined {
  if (
    typeof value === "string" &&
    (PIPELINE_HALT_DISCOVERY_ACTION_OUTCOMES as readonly string[]).includes(
      value
    )
  ) {
    return value as PipelineHaltDiscoveryActionOutcome;
  }
  return undefined;
}

export function parseHaltDiscoveryRequested(
  payloadRaw: string
): DoctorHaltDiscoveryRequested | undefined {
  const record = asRecord(parseUnknownPayload(payloadRaw));
  if (!record) return undefined;
  const code = readStringField(record, "code");
  const recoveryCode = readStringField(record, "recoveryCode");
  const recoveryDetail = readStringField(record, "recoveryDetail");
  if (!code || !recoveryCode || !recoveryDetail) return undefined;
  return { code, recoveryCode, recoveryDetail };
}

export function parseHaltDiscoverySkipped(
  payloadRaw: string
): DoctorHaltDiscoverySkipped | undefined {
  const record = asRecord(parseUnknownPayload(payloadRaw));
  if (!record) return undefined;
  const code = parseSkipCode(record.code);
  const detail = readStringField(record, "detail");
  if (!code || !detail) return undefined;
  return { code, detail };
}

export function parseHaltDiscoveryFailed(
  payloadRaw: string
): DoctorHaltDiscoveryFailed | undefined {
  const record = asRecord(parseUnknownPayload(payloadRaw));
  if (!record) return undefined;
  const stage = parseFailureStage(record.stage);
  const code = readStringField(record, "code");
  const detail = readStringField(record, "detail");
  if (!stage || !code || !detail) return undefined;
  const advisoryRaw = readStringField(record, "advisoryRunId");
  return {
    stage,
    code,
    detail,
    advisoryRunId: advisoryRaw ?? null,
  };
}

export function parseHaltDiscoveryActionResult(
  payloadRaw: string
): DoctorHaltDiscoveryActionResult | undefined {
  const record = asRecord(parseUnknownPayload(payloadRaw));
  if (!record) return undefined;
  const sourceRunId = readStringField(record, "sourceRunId");
  const advisoryRunId = readStringField(record, "advisoryRunId");
  const action = parseDiscoveryAction(record.action);
  const outcome = parseDiscoveryOutcome(record.outcome);
  if (!sourceRunId || !advisoryRunId || !action || !outcome) return undefined;
  const childRaw = readStringField(record, "childRunId");
  return {
    sourceRunId,
    advisoryRunId,
    action,
    outcome,
    code: readStringField(record, "code") ?? null,
    childRunId: childRaw ?? null,
    detail: readStringField(record, "detail") ?? null,
  };
}

function latestHaltDiscoveryRequested(
  events: RunSnapshot["events"]
): DoctorHaltDiscoveryRequested | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "run.pipeline-halt-discovery-requested") continue;
    const parsed = parseHaltDiscoveryRequested(ev.payload);
    if (parsed) return parsed;
  }
  return undefined;
}

function latestHaltDiscoverySkipped(
  events: RunSnapshot["events"]
): DoctorHaltDiscoverySkipped | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "run.pipeline-halt-discovery-skipped") continue;
    const parsed = parseHaltDiscoverySkipped(ev.payload);
    if (parsed) return parsed;
  }
  return undefined;
}

function latestHaltDiscoveryFailed(
  events: RunSnapshot["events"]
): DoctorHaltDiscoveryFailed | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "run.pipeline-halt-discovery-failed") continue;
    const parsed = parseHaltDiscoveryFailed(ev.payload);
    if (parsed) return parsed;
  }
  return undefined;
}

function latestHaltDiscoveryActionResult(
  events: RunSnapshot["events"]
): DoctorHaltDiscoveryActionResult | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "run.pipeline-halt-discovery-action-result") continue;
    const parsed = parseHaltDiscoveryActionResult(ev.payload);
    if (parsed) return parsed;
  }
  return undefined;
}

/** Concise source-side discovery context for unrecovered halt verdicts. */
function formatSourceDiscoveryNote(
  events: RunSnapshot["events"]
): string {
  const failed = latestHaltDiscoveryFailed(events);
  if (failed) {
    const advisory =
      failed.advisoryRunId != null
        ? ` via advisory ${failed.advisoryRunId.slice(0, 8)}`
        : "";
    return ` Halt discovery failed (${failed.stage}/${failed.code}: ${failed.detail})${advisory}.`;
  }
  const skipped = latestHaltDiscoverySkipped(events);
  if (skipped) {
    return ` Halt discovery skipped (${skipped.code}: ${skipped.detail}) — best-effort only, not a new halt.`;
  }
  const requested = latestHaltDiscoveryRequested(events);
  if (requested) {
    return ` Halt discovery requested (${requested.recoveryCode}).`;
  }
  return "";
}

/**
 * Advisory verdicts that outrank generic run diagnosis: a parked briefing card
 * and a recorded operator action result.
 */
function diagnoseHaltDiscoveryAdvisory(snapshot: RunSnapshot): string | undefined {
  const { run, events } = snapshot;
  if (run.trigger_kind !== HALT_DISCOVERY_TRIGGER_KIND) return undefined;

  const parent = haltDiscoveryAdvisoryParent(run);
  const actionResult = latestHaltDiscoveryActionResult(events);

  if (run.status === "needs_input" && parent) {
    return (
      `Halt-discovery briefing awaiting operator choice (no timeout) for source ${parent.slice(0, 8)}. ` +
      `Answer the card with an exact choice id, or escalate the source directly: ` +
      `lca escalate ${parent} retry|skip|abort [--reason <text>]`
    );
  }

  if (actionResult) {
    const sourceShort = actionResult.sourceRunId.slice(0, 8);
    if (actionResult.outcome === "acted") {
      const childPart =
        actionResult.childRunId != null
          ? ` → child ${actionResult.childRunId.slice(0, 8)}`
          : "";
      return (
        `Halt-discovery advisory recorded acted ${actionResult.action}${childPart} on source ${sourceShort}. ` +
        `Do not infer further source success from advisory status alone.`
      );
    }
    if (actionResult.outcome === "refused") {
      const codePart =
        actionResult.code != null ? ` (${actionResult.code})` : "";
      return (
        `Halt-discovery advisory recorded refused ${actionResult.action}${codePart} for source ${sourceShort}. ` +
        `Source may still need direct escalation: lca escalate ${actionResult.sourceRunId} retry|skip|abort [--reason <text>]`
      );
    }
    const codePart =
      actionResult.code != null ? ` (${actionResult.code})` : "";
    return (
      `Halt-discovery advisory recorded internal-failure applying ${actionResult.action}${codePart} for source ${sourceShort}. ` +
      `Escalate the source directly if still halted: lca escalate ${actionResult.sourceRunId} retry|skip|abort [--reason <text>]`
    );
  }

  return undefined;
}

function haltDiscoveryAdvisoryParent(run: RunSnapshot["run"]): string | null {
  return typeof run.parent_run_id === "string" && run.parent_run_id.length > 0
    ? run.parent_run_id
    : null;
}

/**
 * Advisory context for a halt-discovery run with no card, action result, or
 * failure evidence of its own. Runs late so a real reason (auth expired, stale
 * session, spawn error) still wins the verdict.
 */
function describeHaltDiscoveryAdvisoryStatus(
  run: RunSnapshot["run"]
): string | undefined {
  if (run.trigger_kind !== HALT_DISCOVERY_TRIGGER_KIND) return undefined;
  const parent = haltDiscoveryAdvisoryParent(run);
  if (!parent) return undefined;
  return (
    `Halt-discovery advisory for source ${parent.slice(0, 8)} is ${run.status}. ` +
    `Escalate the source directly if still halted: lca escalate ${parent} retry|skip|abort [--reason <text>]`
  );
}

/**
 * One-line form of a b43 recovery event. `undefined` for any other event type
 * and for malformed payloads, so callers can keep their generic rendering.
 */
export function summarizeRecoveryEvent(
  eventType: string,
  payloadRaw: string
): string | undefined {
  const asEvents = [{ seq: 0, event_type: eventType, payload: payloadRaw }];
  if (eventType === "run.pipeline-escalated") {
    const escalation = latestPipelineEscalation(asEvents);
    if (!escalation) return undefined;
    const childPart =
      escalation.childRunId != null
        ? ` → ${escalation.childRunId.slice(0, 8)}`
        : "";
    return `${eventType}: ${escalation.actor} ${escalation.action}${childPart}`;
  }
  if (eventType === "run.pipeline-halt-unrecovered") {
    const unrecovered = latestPipelineHaltUnrecovered(asEvents);
    if (!unrecovered) return undefined;
    return `${eventType}: ${unrecovered.code} — ${unrecovered.detail}`;
  }
  return undefined;
}

/**
 * One-line form of a b44 discovery lifecycle event. `undefined` for other types
 * or malformed payloads (callers keep generic rendering).
 */
export function summarizeDiscoveryEvent(
  eventType: string,
  payloadRaw: string
): string | undefined {
  if (eventType === "run.pipeline-halt-discovery-requested") {
    const requested = parseHaltDiscoveryRequested(payloadRaw);
    if (!requested) return undefined;
    return `${eventType}: ${requested.code} (${requested.recoveryCode}) — ${requested.recoveryDetail}`;
  }
  if (eventType === "run.pipeline-halt-discovery-skipped") {
    const skipped = parseHaltDiscoverySkipped(payloadRaw);
    if (!skipped) return undefined;
    return `${eventType}: ${skipped.code} — ${skipped.detail}`;
  }
  if (eventType === "run.pipeline-halt-discovery-failed") {
    const failed = parseHaltDiscoveryFailed(payloadRaw);
    if (!failed) return undefined;
    const advisory =
      failed.advisoryRunId != null
        ? ` (advisory ${failed.advisoryRunId.slice(0, 8)})`
        : "";
    return `${eventType}: ${failed.stage}/${failed.code} — ${failed.detail}${advisory}`;
  }
  if (eventType === "run.pipeline-halt-discovery-action-result") {
    const result = parseHaltDiscoveryActionResult(payloadRaw);
    if (!result) return undefined;
    const source = result.sourceRunId.slice(0, 8);
    if (result.outcome === "acted") {
      const childPart =
        result.childRunId != null
          ? ` → ${result.childRunId.slice(0, 8)}`
          : "";
      return `${eventType}: acted ${result.action}${childPart} (source ${source})`;
    }
    if (result.outcome === "refused") {
      const codePart = result.code != null ? ` ${result.code}` : "";
      return `${eventType}: refused ${result.action}${codePart} (source ${source})`;
    }
    const codePart = result.code != null ? ` ${result.code}` : "";
    return `${eventType}: internal-failure ${result.action}${codePart} (source ${source})`;
  }
  return undefined;
}

export function summarizeEvent(eventType: string, payloadRaw: string): string {
  const recovery = summarizeRecoveryEvent(eventType, payloadRaw);
  if (recovery !== undefined) return recovery;
  const discovery = summarizeDiscoveryEvent(eventType, payloadRaw);
  if (discovery !== undefined) return discovery;

  let payload: Record<string, unknown> | undefined;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    payload = undefined;
  }
  if (payload) {
    if (typeof payload.question === "string") return `asking: ${payload.question}`;
    if (typeof payload.answer === "string") return `${eventType}: ${payload.answer}`;
    if (typeof payload.message === "string") return `${eventType}: ${payload.message}`;
    if (typeof payload.text === "string") return `${eventType}: ${payload.text}`;
  }
  return eventType;
}

export function parseEventPayload(
  payloadRaw: string
): Record<string, unknown> | undefined {
  return asRecord(parseUnknownPayload(payloadRaw));
}

function evidenceSuffix(opts: {
  hadRetry?: boolean;
  reconciled?: boolean;
}): string {
  const bits: string[] = [];
  if (opts.hadRetry) bits.push("resume retry evidence present");
  if (opts.reconciled) bits.push("reconciliation evidence present");
  return bits.length > 0 ? ` (${bits.join("; ")})` : "";
}

function latestChainSkipped(
  events: RunSnapshot["events"]
): { reason: string; detail?: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.event_type !== "run.chain-skipped") continue;
    const payload = parseEventPayload(ev.payload);
    if (typeof payload?.reason !== "string") continue;
    return {
      reason: payload.reason,
      detail:
        typeof payload.detail === "string"
          ? payload.detail
          : typeof payload.chain_stop_reason === "string"
            ? payload.chain_stop_reason
            : undefined,
    };
  }
  return undefined;
}

function agentStopPrefix(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (
    reason.startsWith("complete:") ||
    reason.startsWith("deadlock:") ||
    reason.startsWith("blocked:")
  );
}

function diagnosePipelineSkip(
  snapshot: RunSnapshot,
  skip: { reason: string; detail?: string }
): string | undefined {
  const runId = snapshot.run.id;
  if (skip.reason === "status-mismatch") {
    return (
      `Pipeline halted here (status-mismatch) — the step failed and no successor was enqueued. ` +
      `Escalate with retry (same depth/prompt/context), skip (advance with an operator notice), ` +
      `or abort (end the pipeline with a reason): ` +
      `lca escalate ${runId} retry|skip|abort [--reason <text>]`
    );
  }
  if (skip.reason === "max-depth") {
    return (
      "Pipeline transition budget exhausted (max-depth). Re-budget through the planner " +
      "(plan-skeleton / chain_control maxDepth) — there is no operator flag to raise the cap. " +
      "If the root stayed at maxDepth: 1, plan-skeleton never re-budgeted."
    );
  }
  if (skip.reason === "stopped") {
    const detail =
      skip.detail ??
      snapshot.run.chain_stop_reason ??
      "(no stop reason recorded)";
    if (detail.startsWith("complete:")) {
      return (
        `Pipeline agent reported complete (${detail}). The daemon hands off to a ` +
        `final-gate run for the single full root pass — not an operator abort. ` +
        `Start a fresh kickoff if you need another pass after the gate finishes.`
      );
    }
    if (agentStopPrefix(detail)) {
      return (
        `Pipeline stopped by the agent (${detail}). This is a terminal outcome of the loop, ` +
        `not an operator abort. Start a fresh kickoff if you need another pass.`
      );
    }
    return (
      `Pipeline aborted by the operator (${detail}). The lineage will not continue. ` +
      `Start a fresh kickoff if you need another pass.`
    );
  }
  return undefined;
}

export function diagnoseRun(
  snapshot: RunSnapshot,
  correlatedLines: string[]
): string {
  const { run, events } = snapshot;
  const advisoryVerdict = diagnoseHaltDiscoveryAdvisory(snapshot);
  if (advisoryVerdict) return advisoryVerdict;

  if (run.status === "paused") {
    return (
      "Run is paused by an operator — steering messages are allowed; use " +
      "`lca resume <runId> [note…]` to continue the automation. b43/b44 recovery " +
      "and stall sweep are suppressed while paused."
    );
  }

  const errorEvents = events.filter((e) => e.event_type === "run.error");
  const revived = events.some((e) => e.event_type === "run.revived");
  const errorEvent = errorEvents.at(-1);
  if (errorEvent) {
    const payload = parseEventPayload(errorEvent.payload);
    if (payload?.reason === "auth_expired") {
      const msg =
        typeof payload.message === "string"
          ? payload.message
          : "Cursor authentication failed";
      return (
        "Cursor auth expired — the login/API key is dead. Fix: refresh " +
        "CURSOR_API_KEY in ~/.cursor-local-automations/.env or run cursor-agent login. " +
        "lca restart will not fix this. The run's conversation is preserved " +
        `(status restored). SDK: ${msg}`
      );
    }

    // Durable recovery decisions beat the generic status-mismatch halt copy.
    const escalation = latestPipelineEscalation(events);
    if (escalation) {
      const daemonVerdict = diagnoseDaemonRecovery(escalation);
      if (daemonVerdict) return daemonVerdict;
      return diagnoseManualEscalation(escalation);
    }
    const unrecovered = latestPipelineHaltUnrecovered(events);
    if (unrecovered) {
      return diagnoseUnrecoveredHalt(run.id, unrecovered, events);
    }

    // Pipeline halt reasons are more actionable than a bare sdk_error / reason string.
    const skip = latestChainSkipped(events);
    if (skip) {
      const pipelineVerdict = diagnosePipelineSkip(snapshot, skip);
      if (pipelineVerdict) return pipelineVerdict;
    }

    if (payload?.reason !== undefined) {
      let msg = `failed: ${String(payload.reason)}`;
      if (payload.cause !== undefined) msg += ` (cause: ${String(payload.cause)})`;
      if (payload.attempts !== undefined) {
        msg += ` (attempts: ${String(payload.attempts)})`;
      }
      return msg;
    }
    if (typeof payload?.message === "string") {
      if (payload.stale === true && payload.reviveFailed === true) {
        return (
          "Session expired and the automatic revive spawn failed " +
          `(${payload.message}). Fix: re-trigger the automation as a fresh run. ` +
          "The sessionRevive setting / LCA_SESSION_REVIVE env var controls the revive tier."
        );
      }
      if (payload.stale === true && revived) {
        return (
          "Session had expired; the run was revived onto a fresh agent from " +
          "the stored transcript (self-healed; no action needed)."
        );
      }
      let msg = `failed: ${payload.message}`;
      if (payload.stale === true) {
        msg +=
          ". Stale agent session — fix: lca restart or re-trigger as a fresh run.";
      }
      return msg;
    }
  }

  const escalationOnly = latestPipelineEscalation(events);
  if (escalationOnly) {
    const daemonVerdict = diagnoseDaemonRecovery(escalationOnly);
    if (daemonVerdict) return daemonVerdict;
    return diagnoseManualEscalation(escalationOnly);
  }
  const unrecoveredOnly = latestPipelineHaltUnrecovered(events);
  if (unrecoveredOnly) {
    return diagnoseUnrecoveredHalt(run.id, unrecoveredOnly, events);
  }

  const skipOnly = latestChainSkipped(events);
  if (skipOnly) {
    const pipelineVerdict = diagnosePipelineSkip(snapshot, skipOnly);
    if (pipelineVerdict) return pipelineVerdict;
  }

  if (revived) {
    return (
      "Session had expired; the run was revived onto a fresh agent from the " +
      "stored transcript (self-healed; no action needed)."
    );
  }

  const finishedEvent = [...events]
    .reverse()
    .find((e) => e.event_type === "run.finished");
  const finishedPayload = finishedEvent
    ? parseEventPayload(finishedEvent.payload)
    : undefined;

  if (
    run.status === "failed" &&
    finishedPayload?.sdkStatus === "error" &&
    errorEvents.length === 0
  ) {
    const authLine = correlatedLines.find((l) => AUTH_ERROR_RE.test(l));
    if (authLine) {
      const hadFallback = events.some(
        (e) => e.event_type === "run.retained.fallback"
      );
      return (
        "Auth not-logged-in on resume — often a stale retained in-memory session " +
        "(b20+ self-heals via cold resume when possible). " +
        (hadFallback
          ? "This run attempted run.retained.fallback — check whether a later cold resume succeeded. "
          : "") +
        "Re-authenticate only if run.error shows auth_expired or brand-new runs also fail auth. " +
        `Log: ${authLine.trim()}`
      );
    }
    return "SDK returned error with no captured reason; see the correlated log window above.";
  }

  const advisoryStatus = describeHaltDiscoveryAdvisoryStatus(run);
  if (advisoryStatus) return advisoryStatus;

  if (run.status === "completed") {
    return `completed OK (${events.length} events).`;
  }

  const last = events.at(-1);
  const lastSummary = last
    ? summarizeEvent(last.event_type, last.payload)
    : "(no events)";
  return `${run.status}: last event — ${lastSummary}`;
}

function laterTerminalChatError(
  events: ChatEvent[],
  afterSeq: number
): ChatEvent | undefined {
  return events
    .filter((e) => e.eventType === "chat.error" && e.seq > afterSeq)
    .at(-1);
}

export function diagnoseChat(
  snapshot: ChatSnapshot,
  correlatedLines: string[]
): string {
  const { session, events } = snapshot;
  const errorEvents = events.filter((e) => e.eventType === "chat.error");
  const lastRevived = [...events]
    .reverse()
    .find((e) => e.eventType === "chat.revived");
  const reconciled = events.some((e) => e.eventType === "chat.reconciled");
  const hadRetry = events.some((e) => e.eventType === "chat.resume.retry");
  const evidence = evidenceSuffix({ hadRetry, reconciled });

  const effectiveError = lastRevived
    ? laterTerminalChatError(events, lastRevived.seq)
    : errorEvents.at(-1);

  if (effectiveError) {
    const payload = parseEventPayload(effectiveError.payload);
    if (payload?.reason === "auth_expired") {
      const msg =
        typeof payload.message === "string"
          ? payload.message
          : "Cursor authentication failed";
      return (
        "Cursor auth expired — the login/API key is dead. Fix: refresh " +
        "CURSOR_API_KEY in ~/.cursor-local-automations/.env or run cursor-agent login. " +
        "lca restart will not fix this. The chat conversation is preserved. " +
        `SDK: ${msg}${evidence}`
      );
    }
    if (payload?.stale === true && payload?.reviveFailed === true) {
      const detail =
        typeof payload.message === "string" ? payload.message : "revive failed";
      return (
        "Session expired and the automatic revive spawn failed " +
        `(${detail}). Fix: start a fresh chat or re-send after fixing the ` +
        "underlying spawn issue. The sessionRevive setting / LCA_SESSION_REVIVE " +
        `env var controls the revive tier.${evidence}`
      );
    }
    if (payload?.reason !== undefined) {
      let msg = `failed: ${String(payload.reason)}`;
      if (payload.cause !== undefined) msg += ` (cause: ${String(payload.cause)})`;
      if (payload.attempts !== undefined) {
        msg += ` (attempts: ${String(payload.attempts)})`;
      }
      return msg + evidence;
    }
    if (typeof payload?.message === "string") {
      let msg = `failed: ${payload.message}`;
      if (payload.stale === true) {
        msg +=
          ". Stale agent session — fix: lca restart or continue in a fresh chat.";
      }
      return msg + evidence;
    }
    return `chat.error (seq ${effectiveError.seq})${evidence}`;
  }

  if (lastRevived) {
    return (
      "Session had expired; the chat was revived onto a fresh agent from the " +
      "stored transcript (self-healed; no action needed)." +
      evidence
    );
  }

  const finishedEvent = [...events]
    .reverse()
    .find((e) => e.eventType === "chat.finished");
  const finishedPayload = finishedEvent
    ? parseEventPayload(finishedEvent.payload)
    : undefined;

  if (
    session.status === "error" &&
    finishedPayload?.sdkStatus === "error" &&
    errorEvents.length === 0
  ) {
    const authLine = correlatedLines.find((l) => AUTH_ERROR_RE.test(l));
    if (authLine) {
      return (
        "Auth not-logged-in on resume — often a stale retained in-memory session. " +
        "Re-authenticate only if chat.error shows auth_expired or brand-new chats also fail auth. " +
        `Log: ${authLine.trim()}${evidence}`
      );
    }
    return (
      "SDK returned error with no captured reason; see the correlated log window above." +
      evidence
    );
  }

  if (session.status === "idle") {
    return `idle OK (${events.length} events) — chat is usable.${evidence}`;
  }

  if (session.status === "error") {
    return `error: chat is in a failed state.${evidence}`;
  }

  const last = events.at(-1);
  const lastSummary = last
    ? summarizeEvent(last.eventType, last.payload)
    : "(no events)";
  return `${session.status}: last event — ${lastSummary}${evidence}`;
}

export function diagnose(target: DoctorTarget, correlatedLines: string[]): DoctorResult {
  if (target.kind === "run") {
    return { kind: "run", verdict: diagnoseRun(target.snapshot, correlatedLines) };
  }
  return { kind: "chat", verdict: diagnoseChat(target.snapshot, correlatedLines) };
}

/**
 * Parse persisted chain_context_json without throwing.
 * Returns null when absent; `{ corrupt: true }` when JSON/schema is unusable.
 */
export function parseDoctorChainContext(
  raw: string | null | undefined
):
  | { ok: true; context: ChainRunContext }
  | { ok: false; corrupt: true }
  | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, corrupt: true };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("variables" in parsed) ||
    typeof (parsed as { variables: unknown }).variables !== "object" ||
    (parsed as { variables: unknown }).variables === null
  ) {
    return { ok: false, corrupt: true };
  }
  return { ok: true, context: parsed as ChainRunContext };
}

function stepLabelFor(
  configKey: string | null | undefined,
  depth: number | null | undefined,
  waveMeta?: {
    waveOrdinal?: number | null;
    trackOrdinal?: number | null;
    phaseRef?: string | null;
  }
): string {
  const desc = describePipelineWaveStep({
    configKey,
    chainDepth: depth,
    waveOrdinal: waveMeta?.waveOrdinal,
    trackOrdinal: waveMeta?.trackOrdinal,
    phaseRef: waveMeta?.phaseRef,
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

function transitionClaimFor(
  snapshot: RunSnapshot
): PipelineTransitionClaim {
  const { run, events } = snapshot;
  if (events.some((e) => e.event_type === "run.pipeline-escalated")) {
    return "escalated";
  }
  const halted =
    (run.status === "failed" || run.status === "cancelled") &&
    run.chain_handled_at == null &&
    run.chain_root_run_id != null;
  if (halted) {
    return "halted-and-escalatable";
  }
  if (
    events.some((e) => e.event_type === "run.chained") ||
    run.chain_handled_at != null
  ) {
    return "chained";
  }
  return "open";
}

/**
 * Derive pipeline facts for a doctor report. Returns null when the run is not
 * part of a pipeline (no chain_root_run_id). Never throws; never includes idea text.
 */
export function collectPipelineDoctorFacts(
  snapshot: RunSnapshot,
  automation: Automation | undefined
): PipelineDoctorFacts | null {
  const root = snapshot.run.chain_root_run_id;
  if (root == null || root === "") return null;

  const parsed = parseDoctorChainContext(snapshot.run.chain_context_json);
  const contextUnavailable = parsed != null && !parsed.ok;
  const summary =
    parsed?.ok === true ? pipelineSummaryFromContext(parsed.context) : null;

  const depth = snapshot.run.chain_depth;
  const depthUnavailable = depth == null;
  const override = snapshot.run.chain_max_depth_override;
  const baseMax = snapshot.run.chain_max_depth;
  const budgetOverrideInForce = override != null;
  const effectiveBudget = override ?? baseMax ?? null;

  const configKey = automation?.configKey;
  const automationUnavailable = automation == null;
  const waveSummary = snapshot.pipelineWave ?? null;
  const trackSummary = snapshot.pipelineTrack ?? null;
  const waveDetail = snapshot.pipelineWaveDetail ?? null;
  const trackDetail = snapshot.pipelineTrackDetail ?? null;
  const waveMeta = {
    waveOrdinal: waveSummary?.ordinal ?? null,
    trackOrdinal: trackSummary?.ordinal ?? null,
    phaseRef: trackSummary?.phaseRef ?? null,
  };
  const desc = describePipelineWaveStep({
    configKey,
    chainDepth: depth,
    ...waveMeta,
  });

  const roleNames: string[] = [];
  if (parsed?.ok === true && parsed.context.roleModels) {
    for (const [role, selection] of Object.entries(parsed.context.roleModels)) {
      const modelId =
        selection && typeof selection === "object" && "id" in selection
          ? String((selection as { id: unknown }).id)
          : "?";
      roleNames.push(`${role}=${modelId}`);
    }
  }

  let gatekeeperModelId: string | null = null;
  let gatekeeperSource: GatekeeperResolutionSource | null = null;
  if (
    desc.workerKey === "final-gate" &&
    parsed?.ok === true &&
    parsed.context.roleModels
  ) {
    const resolved = resolveRoleSelectionWithFallback(
      parsed.context.roleModels,
      PIPELINE_TERMINAL_ROLE,
      PIPELINE_TERMINAL_FALLBACK_ROLE
    );
    if (resolved) {
      gatekeeperModelId = resolved.selection.id;
      gatekeeperSource = resolved.source as GatekeeperResolutionSource;
    }
  }

  let architectModelId: string | null = null;
  let architectSource: ArchitectResolutionSource | null = null;
  if (
    desc.workerKey === "plan-skeleton" &&
    parsed?.ok === true &&
    parsed.context.roleModels
  ) {
    const resolved = resolveRoleSelectionWithFallback(
      parsed.context.roleModels,
      PIPELINE_SKELETON_ROLE,
      PIPELINE_SKELETON_FALLBACK_ROLE
    );
    if (resolved) {
      architectModelId = resolved.selection.id;
      architectSource = resolved.source as ArchitectResolutionSource;
    }
  }

  let barrierProgress: string | null = null;
  if (waveSummary) {
    barrierProgress = `${waveSummary.completedTrackCount}/${waveSummary.trackCount} tracks`;
    if (waveSummary.joinClaimed) {
      barrierProgress += ", join claimed";
    }
    if (waveSummary.finalized) {
      barrierProgress += ", finalized";
    }
  }

  const waveId = waveSummary?.id ?? snapshot.run.pipeline_wave_id ?? null;
  let waveRecoveryCommand: string | null = null;
  if (waveSummary?.status === "blocked" && waveId) {
    const shortId = waveId.slice(0, 8);
    waveRecoveryCommand = `lca wave ${shortId} retry  |  lca wave ${shortId} abort`;
  }

  let loopMode: ImplementFullyLoopMode | null = null;
  if (parsed?.ok === true) {
    try {
      const raw = parsed.context.variables.loopMode;
      if (raw === "execute") {
        loopMode = "execute";
      }
    } catch {
      // omit when context is unusable
    }
  }

  return {
    featureId: summary?.featureId ?? null,
    featureSlug: summary?.featureSlug ?? null,
    pipelineId: summary?.pipelineId ?? null,
    stepLabel: stepLabelFor(configKey, depth, waveMeta),
    cycle: desc.cycle,
    stepInCycle: desc.stepInCycle,
    workerKey: desc.workerKey,
    depth: depth ?? null,
    effectiveBudget,
    budgetOverrideInForce,
    rootRunId: root,
    isRoot: snapshot.run.id === root,
    stopRequestedAt: snapshot.run.chain_stop_requested_at ?? null,
    stopReason: snapshot.run.chain_stop_reason ?? null,
    transitionClaim: transitionClaimFor(snapshot),
    contextUnavailable,
    depthUnavailable,
    automationUnavailable,
    roleNames,
    gatekeeperModelId,
    gatekeeperSource,
    architectModelId,
    architectSource,
    waveOrdinal: waveSummary?.ordinal ?? null,
    trackOrdinal: trackSummary?.ordinal ?? null,
    phaseRef: trackSummary?.phaseRef ?? null,
    waveStatus: waveSummary?.status ?? null,
    trackStatus: trackSummary?.status ?? null,
    barrierProgress,
    integrationRunId: waveDetail?.integrationRunId ?? null,
    blockedCode: waveSummary?.blockedCode ?? waveDetail?.blockedCode ?? null,
    blockedDetail: waveDetail?.blockedDetail ?? null,
    branchName: trackDetail?.branchName ?? null,
    headCommit: trackDetail?.headCommit ?? null,
    baseCommit: waveDetail?.baseCommit ?? null,
    cleanupRequired: waveSummary?.cleanupRequired ?? false,
    waveRecoveryCommand,
    loopMode,
  };
}

/** Format the Pipeline block lines (without the "Pipeline" heading). */
export function formatPipelineBlockLines(facts: PipelineDoctorFacts): string[] {
  const lines: string[] = [];
  const feature =
    facts.featureId != null
      ? facts.featureSlug != null
        ? `${facts.featureId} (${facts.featureSlug})`
        : facts.featureId
      : facts.contextUnavailable
        ? "(context unavailable)"
        : "(unavailable)";
  lines.push(`  feature:    ${feature}`);
  lines.push(
    `  pipeline:   ${facts.pipelineId ?? (facts.contextUnavailable ? "(context unavailable)" : "(unavailable)")}`
  );
  lines.push(
    `  step:       ${
      facts.automationUnavailable
        ? "(automation unavailable)"
        : facts.stepLabel
    }`
  );
  const depthPart = facts.depthUnavailable
    ? "(unavailable)"
    : String(facts.depth);
  const budgetPart =
    facts.effectiveBudget != null
      ? String(facts.effectiveBudget)
      : "(unavailable)";
  const overrideNote = facts.budgetOverrideInForce
    ? " (override in force)"
    : "";
  lines.push(`  depth:      ${depthPart} / ${budgetPart}${overrideNote}`);
  lines.push(
    `  root:       ${facts.rootRunId}${facts.isRoot ? " (this run)" : ""}`
  );
  if (facts.stopRequestedAt) {
    lines.push(
      `  stop:       ${facts.stopReason ?? "(no reason)"} @ ${facts.stopRequestedAt}`
    );
  } else {
    lines.push(`  stop:       (none)`);
  }
  lines.push(`  transition: ${facts.transitionClaim}`);
  if (facts.roleNames.length > 0) {
    lines.push(`  roles:      ${facts.roleNames.join(", ")}`);
  }
  if (facts.loopMode === "execute") {
    lines.push(`  loop mode:  execute`);
  }
  if (facts.gatekeeperModelId != null) {
    const sourceLabel =
      facts.gatekeeperSource === "explicit"
        ? "explicit"
        : "reviewer fallback";
    lines.push(
      `  gate:       gatekeeper=${facts.gatekeeperModelId} (${sourceLabel})`
    );
  }
  if (facts.architectModelId != null) {
    const sourceLabel =
      facts.architectSource === "explicit"
        ? "explicit"
        : "planner fallback";
    lines.push(
      `  architect:  architect=${facts.architectModelId} (${sourceLabel})`
    );
  }
  if (facts.waveOrdinal != null) {
    lines.push(
      `  wave:       w${facts.waveOrdinal} ${facts.waveStatus ?? "(unknown)"}`
    );
  }
  if (facts.trackOrdinal != null || facts.phaseRef != null) {
    const trackPart =
      facts.trackOrdinal != null ? `t${facts.trackOrdinal}` : "(track ?)";
    const phasePart = facts.phaseRef ?? "(phase ?)";
    lines.push(
      `  track:      ${trackPart} ${phasePart}${facts.trackStatus ? ` (${facts.trackStatus})` : ""}`
    );
  }
  if (facts.barrierProgress) {
    lines.push(`  barrier:    ${facts.barrierProgress}`);
  }
  if (facts.integrationRunId) {
    lines.push(`  integrate:  ${facts.integrationRunId.slice(0, 8)}`);
  }
  if (facts.baseCommit) {
    lines.push(`  base:       ${facts.baseCommit.slice(0, 8)}`);
  }
  if (facts.branchName) {
    lines.push(`  branch:     ${facts.branchName}`);
  }
  if (facts.headCommit) {
    lines.push(`  tip:        ${facts.headCommit.slice(0, 8)}`);
  }
  if (facts.blockedCode || facts.blockedDetail) {
    lines.push(
      `  blocked:    ${facts.blockedCode ?? "(no code)"}${facts.blockedDetail ? ` — ${facts.blockedDetail}` : ""}`
    );
  }
  if (facts.cleanupRequired) {
    lines.push(`  cleanup:    required (retained branches/worktrees may remain)`);
  }
  if (facts.waveRecoveryCommand) {
    lines.push(`  recover:    ${facts.waveRecoveryCommand}`);
  }
  return lines;
}

/**
 * Build lineage entries for a pipeline from a listRuns window, depth-ordered,
 * with the current run marked. Caps at DOCTOR_LINEAGE_CAP.
 */
export function buildPipelineLineage(
  currentRunId: string,
  rootRunId: string,
  listed: Run[],
  automationById: Map<string, Automation>,
  cap = DOCTOR_LINEAGE_CAP
): { entries: PipelineLineageEntry[]; truncated: boolean; listedCount: number } {
  const peers = listed.filter((r) => r.chainRootRunId === rootRunId);
  peers.sort(comparePipelineRunOrder);
  const truncated = peers.length > cap;
  const slice = peers.slice(0, cap);
  const entries = slice.map((r) => {
    const auto = automationById.get(r.automationId);
    return {
      id: r.id,
      depth: r.chainDepth ?? null,
      stepLabel: stepLabelFor(auto?.configKey, r.chainDepth, {
        waveOrdinal: r.pipelineWave?.ordinal ?? null,
        trackOrdinal: r.pipelineTrack?.ordinal ?? null,
        phaseRef: r.pipelineTrack?.phaseRef ?? null,
      }),
      status: r.status,
      isCurrent: r.id === currentRunId,
    };
  });
  return { entries, truncated, listedCount: peers.length };
}

export function formatLineageBlockLines(
  lineage: ReturnType<typeof buildPipelineLineage>
): string[] {
  const lines: string[] = [];
  for (const e of lineage.entries) {
    const depth = e.depth != null ? `d${e.depth}` : "d?";
    const mark = e.isCurrent ? " ←" : "";
    lines.push(
      `  ${depth}  ${e.stepLabel}  ${e.status}  ${e.id.slice(0, 8)}${mark}`
    );
  }
  if (lineage.truncated) {
    lines.push(
      `  … showing ${lineage.entries.length} of ${lineage.listedCount} in the fetched window (older runs may be outside the list limit)`
    );
  } else if (lineage.listedCount === 0) {
    lines.push(
      `  (no peers in the fetched run window — older runs may be outside the list limit)`
    );
  }
  return lines;
}

function featureIdFromRun(run: Run): string {
  return run.pipeline?.featureId ?? run.chainRootRunId?.slice(0, 8) ?? "?";
}

function parseRunTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // SQLite UTC often looks like "YYYY-MM-DD HH:MM:SS"
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/** Health-mode pipeline summary from listRuns (no new endpoint). */
export function summarizePipelineHealth(
  runs: Run[],
  nowMs = Date.now(),
  needsInputAgeMs = DOCTOR_NEEDS_INPUT_AGE_MS
): PipelineHealthSummary {
  const activeStatuses = new Set([
    "queued",
    "running",
    "needs_input",
    "paused",
  ]);
  const activeCount = runs.filter(
    (r) => r.chainRootRunId != null && activeStatuses.has(r.status)
  ).length;
  const pausedCount = runs.filter(
    (r) => r.chainRootRunId != null && r.status === "paused"
  ).length;

  const halted: PipelineHealthSummary["halted"] = [];
  for (const r of runs) {
    if (r.pipeline == null) continue;
    if (r.status !== "failed" && r.status !== "cancelled") continue;
    if (r.chainHandledAt != null) continue;
    halted.push({ featureId: featureIdFromRun(r), runId: r.id });
  }

  const staleNeedsInput: PipelineHealthSummary["staleNeedsInput"] = [];
  for (const r of runs) {
    if (r.chainRootRunId == null || r.status !== "needs_input") continue;
    // Parked halt-discovery briefings are intentional no-timeout cards; keep
    // them in active counts but do not label them stale in bare health.
    if (r.triggerKind === HALT_DISCOVERY_TRIGGER_KIND) continue;
    const started =
      parseRunTimestamp(r.startedAt) ?? parseRunTimestamp(r.createdAt);
    if (started == null) continue;
    const ageMs = nowMs - started;
    if (ageMs >= needsInputAgeMs) {
      staleNeedsInput.push({
        featureId: featureIdFromRun(r),
        runId: r.id,
        ageMs,
      });
    }
  }

  const runningTracks: PipelineHealthSummary["runningTracks"] = [];
  const barrierWaits: PipelineHealthSummary["barrierWaits"] = [];
  const blockedWaves: PipelineHealthSummary["blockedWaves"] = [];
  const cleanupRequired: PipelineHealthSummary["cleanupRequired"] = [];
  const seenBarrier = new Set<string>();
  const seenBlocked = new Set<string>();
  const seenCleanup = new Set<string>();

  for (const r of runs) {
    const wave = r.pipelineWave;
    if (!wave) continue;
    const featureId = featureIdFromRun(r);

    if (
      r.pipelineTrack &&
      activeStatuses.has(r.status) &&
      (r.pipelineTrack.status === "running" ||
        r.pipelineTrack.status === "provisioning")
    ) {
      runningTracks.push({
        featureId,
        runId: r.id,
        waveOrdinal: wave.ordinal,
        trackOrdinal: r.pipelineTrack.ordinal,
        phaseRef: r.pipelineTrack.phaseRef,
      });
    }

    if (
      !seenBarrier.has(wave.id) &&
      wave.status === "running" &&
      wave.trackCount > 0 &&
      wave.completedTrackCount >= wave.trackCount &&
      !wave.joinClaimed
    ) {
      seenBarrier.add(wave.id);
      barrierWaits.push({
        featureId,
        waveId: wave.id,
        waveOrdinal: wave.ordinal,
        completed: wave.completedTrackCount,
        total: wave.trackCount,
      });
    }

    if (!seenBlocked.has(wave.id) && wave.status === "blocked") {
      seenBlocked.add(wave.id);
      blockedWaves.push({
        featureId,
        waveId: wave.id,
        waveOrdinal: wave.ordinal,
        code: wave.blockedCode,
      });
    }

    if (!seenCleanup.has(wave.id) && wave.cleanupRequired) {
      seenCleanup.add(wave.id);
      cleanupRequired.push({
        featureId,
        waveId: wave.id,
        waveOrdinal: wave.ordinal,
      });
    }
  }

  return {
    activeCount,
    pausedCount,
    halted,
    staleNeedsInput,
    needsInputAgeMs,
    runningTracks,
    barrierWaits,
    blockedWaves,
    cleanupRequired,
  };
}

export function formatPipelineHealthLines(
  summary: PipelineHealthSummary
): string[] {
  const lines: string[] = [];
  lines.push(
    `  active: ${summary.activeCount} non-terminal pipeline run(s)`
  );
  if (summary.pausedCount > 0) {
    lines.push(`  paused: ${summary.pausedCount} parked pipeline run(s)`);
  }
  if (summary.halted.length === 0) {
    lines.push(`  halted: (none)`);
  } else {
    for (const h of summary.halted.slice(0, 5)) {
      lines.push(
        `  halted: ${h.featureId}  ${h.runId.slice(0, 8)}  (lca escalate ${h.runId.slice(0, 8)} …)`
      );
    }
    if (summary.halted.length > 5) {
      lines.push(`  halted: … +${summary.halted.length - 5} more`);
    }
  }
  const ageMin = Math.round(summary.needsInputAgeMs / 60_000);
  if (summary.staleNeedsInput.length === 0) {
    lines.push(`  needs_input >${ageMin}m: (none)`);
  } else {
    for (const s of summary.staleNeedsInput.slice(0, 5)) {
      const mins = Math.round(s.ageMs / 60_000);
      lines.push(
        `  needs_input: ${s.featureId}  ${s.runId.slice(0, 8)}  (~${mins}m — unanswered; not stall-swept)`
      );
    }
    if (summary.staleNeedsInput.length > 5) {
      lines.push(
        `  needs_input: … +${summary.staleNeedsInput.length - 5} more`
      );
    }
  }

  if (summary.runningTracks.length === 0) {
    lines.push(`  tracks running: (none)`);
  } else {
    for (const t of summary.runningTracks.slice(0, 5)) {
      lines.push(
        `  tracks running: ${t.featureId} w${t.waveOrdinal} t${t.trackOrdinal} ${t.phaseRef}  ${t.runId.slice(0, 8)}`
      );
    }
    if (summary.runningTracks.length > 5) {
      lines.push(`  tracks running: … +${summary.runningTracks.length - 5} more`);
    }
  }

  if (summary.barrierWaits.length === 0) {
    lines.push(`  barrier wait: (none)`);
  } else {
    for (const b of summary.barrierWaits.slice(0, 5)) {
      lines.push(
        `  barrier wait: ${b.featureId} w${b.waveOrdinal} ${b.completed}/${b.total} tracks  ${b.waveId.slice(0, 8)}`
      );
    }
    if (summary.barrierWaits.length > 5) {
      lines.push(`  barrier wait: … +${summary.barrierWaits.length - 5} more`);
    }
  }

  if (summary.blockedWaves.length === 0) {
    lines.push(`  blocked waves: (none)`);
  } else {
    for (const b of summary.blockedWaves.slice(0, 5)) {
      const code = b.code ? ` (${b.code})` : "";
      lines.push(
        `  blocked waves: ${b.featureId} w${b.waveOrdinal}${code}  ${b.waveId.slice(0, 8)}  (lca wave ${b.waveId.slice(0, 8)} retry|abort)`
      );
    }
    if (summary.blockedWaves.length > 5) {
      lines.push(`  blocked waves: … +${summary.blockedWaves.length - 5} more`);
    }
  }

  if (summary.cleanupRequired.length === 0) {
    lines.push(`  cleanup required: (none)`);
  } else {
    for (const c of summary.cleanupRequired.slice(0, 5)) {
      lines.push(
        `  cleanup required: ${c.featureId} w${c.waveOrdinal}  ${c.waveId.slice(0, 8)}`
      );
    }
    if (summary.cleanupRequired.length > 5) {
      lines.push(
        `  cleanup required: … +${summary.cleanupRequired.length - 5} more`
      );
    }
  }

  return lines;
}

export type FeatureQueueSummary = {
  counts: Record<FeatureQueueEntryState, number>;
  running: { featureId: string; runId: string } | null;
  failed: Array<{ featureId: string; detail: string | null }>;
  blocked: Array<{ featureId: string; detail: string | null }>;
  nextEligibleFeatureId: string | null;
  isEmpty: boolean;
};

function newestEntryByFeatureId(
  entries: FeatureQueueEntry[],
  workspaceId: string,
  featureId: string
): FeatureQueueEntry | undefined {
  let best: FeatureQueueEntry | undefined;
  for (const entry of entries) {
    if (entry.workspaceId !== workspaceId || entry.featureId !== featureId) {
      continue;
    }
    if (!best || entry.position > best.position) {
      best = entry;
    }
  }
  return best;
}

function isQueueEntryEligible(
  entry: FeatureQueueEntry,
  entries: FeatureQueueEntry[]
): boolean {
  if (entry.state !== "queued") {
    return false;
  }
  for (const depId of entry.after) {
    const dep = newestEntryByFeatureId(entries, entry.workspaceId, depId);
    if (!dep || dep.state !== "done") {
      return false;
    }
  }
  return true;
}

function findNextEligibleFeatureId(
  entries: FeatureQueueEntry[]
): string | null {
  const byWorkspace = new Map<string, FeatureQueueEntry[]>();
  for (const entry of entries) {
    const list = byWorkspace.get(entry.workspaceId) ?? [];
    list.push(entry);
    byWorkspace.set(entry.workspaceId, list);
  }
  for (const workspaceEntries of byWorkspace.values()) {
    const queued = workspaceEntries
      .filter((e) => e.state === "queued")
      .sort((a, b) => a.position - b.position);
    const eligible = queued.find((entry) =>
      isQueueEntryEligible(entry, entries)
    );
    if (eligible) {
      return eligible.featureId;
    }
  }
  return null;
}

/** Health-mode queue summary from listFeatureQueue (no new endpoint). */
export function summarizeFeatureQueue(
  entries: FeatureQueueEntry[]
): FeatureQueueSummary {
  const counts: Record<FeatureQueueEntryState, number> = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const entry of entries) {
    counts[entry.state] += 1;
  }

  const runningEntry = entries.find((e) => e.state === "running");
  const running =
    runningEntry != null
      ? {
          featureId: runningEntry.featureId,
          runId: runningEntry.runId ?? "",
        }
      : null;

  const failed = entries
    .filter((e) => e.state === "failed")
    .map((e) => ({ featureId: e.featureId, detail: e.detail }));
  const blocked = entries
    .filter((e) => e.state === "blocked")
    .map((e) => ({ featureId: e.featureId, detail: e.detail }));

  const active = entries.filter(
    (e) => e.state !== "done" && e.state !== "cancelled"
  );

  return {
    counts,
    running,
    failed,
    blocked,
    nextEligibleFeatureId: findNextEligibleFeatureId(entries),
    isEmpty: active.length === 0,
  };
}

export function formatFeatureQueueLines(
  summary: FeatureQueueSummary
): string[] {
  if (summary.isEmpty) {
    return ["  (no queued features)"];
  }

  const lines: string[] = [];
  lines.push(
    `  queued: ${summary.counts.queued}  running: ${summary.counts.running}  ` +
      `done: ${summary.counts.done}  failed: ${summary.counts.failed}  ` +
      `blocked: ${summary.counts.blocked}  cancelled: ${summary.counts.cancelled}`
  );

  if (summary.running) {
    const shortRun = summary.running.runId
      ? summary.running.runId.slice(0, 8)
      : "—";
    lines.push(
      `  running: ${summary.running.featureId}  ${shortRun}`
    );
  } else {
    lines.push(`  running: (none)`);
  }

  if (summary.nextEligibleFeatureId) {
    lines.push(`  next: ${summary.nextEligibleFeatureId}`);
  } else {
    lines.push(`  next: (none)`);
  }

  if (summary.failed.length === 0) {
    lines.push(`  failed: (none)`);
  } else {
    for (const f of summary.failed.slice(0, 5)) {
      const detail = f.detail ? ` — ${f.detail}` : "";
      lines.push(`  failed: ${f.featureId}${detail}`);
    }
    if (summary.failed.length > 5) {
      lines.push(`  failed: … +${summary.failed.length - 5} more`);
    }
  }

  if (summary.blocked.length === 0) {
    lines.push(`  blocked: (none)`);
  } else {
    for (const b of summary.blocked.slice(0, 5)) {
      const detail = b.detail ? ` — ${b.detail}` : "";
      lines.push(`  blocked: ${b.featureId}${detail}`);
    }
    if (summary.blocked.length > 5) {
      lines.push(`  blocked: … +${summary.blocked.length - 5} more`);
    }
  }

  return lines;
}

async function tryExactRun(
  client: DoctorLookupClient,
  query: string
): Promise<RunSnapshot | undefined> {
  try {
    return await client.getRun(query);
  } catch {
    return undefined;
  }
}

async function tryExactChat(
  client: DoctorLookupClient,
  query: string
): Promise<ChatSnapshot | undefined> {
  try {
    return await client.getChat(query);
  } catch {
    return undefined;
  }
}

async function listActiveChatsForPrefix(
  client: DoctorLookupClient
): Promise<ChatSession[]> {
  let workspaces: Workspace[];
  try {
    workspaces = await client.listWorkspaces();
  } catch {
    return [];
  }
  const chats: ChatSession[] = [];
  for (const ws of workspaces) {
    try {
      const listed = await client.listWorkspaceChats(ws.id);
      chats.push(...listed);
    } catch {
      /* skip workspace list failures (e.g. 404) */
    }
  }
  return chats;
}

/**
 * Resolve a doctor query to a run or chat snapshot.
 * Exact IDs win; prefix matching runs with no min length, and active chats when
 * the query is at least 4 characters.
 */
export async function resolveDoctorTarget(
  client: DoctorLookupClient,
  query: string
): Promise<DoctorTarget> {
  const [exactRun, exactChat] = await Promise.all([
    tryExactRun(client, query),
    tryExactChat(client, query),
  ]);

  if (exactRun && exactChat) {
    throw new DaemonError(
      `Ambiguous id "${query}" matches both a run and a chat. Use a more specific id.`
    );
  }
  if (exactRun) return { kind: "run", snapshot: exactRun };
  if (exactChat) return { kind: "chat", snapshot: exactChat };

  const runs = await client.listRuns();
  const runMatches = runs.filter((r) => r.id.startsWith(query));

  const chatMatches: ChatSession[] = [];
  if (query.length >= 4) {
    const chats = await listActiveChatsForPrefix(client);
    chatMatches.push(...chats.filter((c) => c.id.startsWith(query)));
  }

  const total = runMatches.length + chatMatches.length;
  if (total === 0) {
    throw new DaemonError(`No run or chat matches "${query}".`);
  }
  if (total > 1) {
    throw new DaemonError(
      `Ambiguous id prefix "${query}" matches multiple runs/chats.`
    );
  }
  if (runMatches.length === 1) {
    const snapshot = await client.getRun(runMatches[0].id);
    return { kind: "run", snapshot };
  }
  const snapshot = await client.getChat(chatMatches[0].id);
  return { kind: "chat", snapshot };
}
