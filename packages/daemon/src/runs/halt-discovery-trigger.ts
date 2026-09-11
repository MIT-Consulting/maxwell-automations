/**
 * Durable halt-discovery outbox trigger (b44 Phase 1).
 * Converts one unrecovered halt into exactly one requested or skipped lifecycle event.
 */

import {
  PIPELINE_HALT_DISCOVERY_EVENT_TYPES,
  PIPELINE_HALT_RECOVERY_NATIVE_DECLINE_CODES,
  type PipelineHaltDiscoveryRequestedPayload,
  type PipelineHaltDiscoverySkipCode,
  type PipelineHaltDiscoverySkippedPayload,
  type PipelineHaltRecoveryDeclineCode,
} from "@lca/shared";
import type { RunRow, RunStore } from "./store.js";

export type HaltDiscoveryTriggerResult =
  | { kind: "requested" }
  | {
      kind: "skipped";
      code: PipelineHaltDiscoverySkipCode;
      detail: string;
    }
  | { kind: "already-recorded" };

/** Runtime allowlist: native declines + current RunEscalationRefusal literals. */
const DECLINE_CODE_ALLOWLIST = new Set<string>([
  ...PIPELINE_HALT_RECOVERY_NATIVE_DECLINE_CODES,
  "not-found",
  "not-pipeline",
  "not-halted",
  "already-chained",
  "root-run",
  "no-successor",
  "budget-exhausted",
]);

const DISCOVERY_EVENT_TYPE_SET = new Set<string>(
  PIPELINE_HALT_DISCOVERY_EVENT_TYPES
);

type UnrecoveredTrigger = {
  recoveryCode: PipelineHaltRecoveryDeclineCode;
  recoveryDetail: string;
  observedReason?: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseUnrecoveredPayload(payloadJson: string): UnrecoveredTrigger | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== "none") {
    return null;
  }
  if (!isNonEmptyString(record.code) || !isNonEmptyString(record.detail)) {
    return null;
  }
  if (!DECLINE_CODE_ALLOWLIST.has(record.code)) {
    return null;
  }
  const trigger: UnrecoveredTrigger = {
    recoveryCode: record.code as PipelineHaltRecoveryDeclineCode,
    recoveryDetail: record.detail,
  };
  if (record.observedReason !== undefined) {
    if (!isNonEmptyString(record.observedReason)) {
      return null;
    }
    trigger.observedReason = record.observedReason;
  }
  return trigger;
}

function hasPriorDiscoveryLifecycle(
  events: ReadonlyArray<{ event_type: string }>
): boolean {
  return events.some((e) => DISCOVERY_EVENT_TYPE_SET.has(e.event_type));
}

function latestUnrecoveredPayload(
  events: ReadonlyArray<{ event_type: string; payload: string }>
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.event_type === "run.pipeline-halt-unrecovered") {
      return event.payload;
    }
  }
  return null;
}

function isContextAwarePipelineRun(run: RunRow, store: RunStore): boolean {
  if (
    run.chain_root_run_id == null ||
    run.chain_depth == null ||
    run.chain_max_depth == null
  ) {
    return false;
  }
  const parsed = store.parseChainContext(run);
  return parsed?.ok === true;
}

function appendSkipped(
  store: RunStore,
  runId: string,
  code: PipelineHaltDiscoverySkipCode,
  detail: string
): HaltDiscoveryTriggerResult {
  const payload: PipelineHaltDiscoverySkippedPayload = { code, detail };
  store.appendEvent(runId, "run.pipeline-halt-discovery-skipped", payload);
  return { kind: "skipped", code, detail };
}

/**
 * Evaluate one source run and append at most one discovery lifecycle event.
 * Synchronous; never claims the chain or spawns work.
 */
export function requestPipelineHaltDiscovery(
  store: RunStore,
  sourceRunId: string,
  enabled: boolean,
  onLog: (message: string) => void
): HaltDiscoveryTriggerResult {
  const run = store.getRun(sourceRunId);
  if (!run) {
    return { kind: "already-recorded" };
  }

  const events = store.listRunEvents(sourceRunId);
  if (hasPriorDiscoveryLifecycle(events)) {
    return { kind: "already-recorded" };
  }

  if (!enabled) {
    onLog(
      `Pipeline halt discovery skipped for run ${sourceRunId}: disabled`
    );
    return appendSkipped(
      store,
      sourceRunId,
      "disabled",
      "Halt discovery is disabled"
    );
  }

  if (run.pipeline_wave_id != null || run.pipeline_track_id != null) {
    onLog(
      `Pipeline halt discovery skipped for run ${sourceRunId}: wave-scoped`
    );
    return appendSkipped(
      store,
      sourceRunId,
      "wave-scoped",
      "Wave- or track-scoped runs are outside halt discovery"
    );
  }

  if (run.chain_handled_at != null || run.chain_stop_requested_at != null) {
    onLog(
      `Pipeline halt discovery skipped for run ${sourceRunId}: source-resolved`
    );
    return appendSkipped(
      store,
      sourceRunId,
      "source-resolved",
      "Source run is already claimed or stopped"
    );
  }

  if (run.status !== "failed" || !isContextAwarePipelineRun(run, store)) {
    onLog(
      `Pipeline halt discovery skipped for run ${sourceRunId}: ineligible-source`
    );
    return appendSkipped(
      store,
      sourceRunId,
      "ineligible-source",
      "Source is not a failed context-aware pipeline run"
    );
  }

  const unrecoveredJson = latestUnrecoveredPayload(events);
  if (unrecoveredJson == null) {
    onLog(
      `Pipeline halt discovery skipped for run ${sourceRunId}: invalid-trigger`
    );
    return appendSkipped(
      store,
      sourceRunId,
      "invalid-trigger",
      "Missing durable unrecovered halt decision"
    );
  }

  const trigger = parseUnrecoveredPayload(unrecoveredJson);
  if (trigger == null) {
    onLog(
      `Pipeline halt discovery skipped for run ${sourceRunId}: invalid-trigger`
    );
    return appendSkipped(
      store,
      sourceRunId,
      "invalid-trigger",
      "Malformed unrecovered halt decision payload"
    );
  }

  const payload: PipelineHaltDiscoveryRequestedPayload = {
    code: "unrecovered-halt",
    recoveryCode: trigger.recoveryCode,
    recoveryDetail: trigger.recoveryDetail,
  };
  if (trigger.observedReason !== undefined) {
    payload.observedReason = trigger.observedReason;
  }
  store.appendEvent(
    sourceRunId,
    "run.pipeline-halt-discovery-requested",
    payload
  );
  onLog(
    `Pipeline halt discovery requested for run ${sourceRunId}: ${trigger.recoveryCode}`
  );
  return { kind: "requested" };
}
