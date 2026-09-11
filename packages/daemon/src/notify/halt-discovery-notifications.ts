import type {
  PipelineHaltDiscoveryActionOutcome,
  PipelineHaltDiscoveryFailureStage,
  RunEscalationAction,
  WsServerMessage,
} from "@lca/shared";
import {
  HALT_DISCOVERY_INPUT_KIND,
  PIPELINE_HALT_DISCOVERY_ACTION_OUTCOMES,
  PIPELINE_HALT_DISCOVERY_FAILURE_STAGES,
  RUN_ESCALATION_ACTIONS,
} from "@lca/shared";
import type { DaemonEventBus } from "../events.js";
import type { InputRequestRow } from "../input/store.js";
import { parseInputMetadataJson } from "../input/store.js";

/** Narrow notifier surface used by discovery toast dispatch. */
export type HaltDiscoveryNotifierSink = {
  haltDiscoveryRecommendationReady(
    advisoryRunId: string,
    sourceRunId: string
  ): void;
  haltDiscoveryFailed(
    sourceRunId: string,
    stage: string,
    code: string,
    detail: string
  ): void;
  haltDiscoveryActionResult(input: {
    advisoryRunId: string;
    sourceRunId: string;
    action: "retry" | "skip" | "abort";
    outcome: "acted" | "refused" | "internal-failure";
    code?: string;
    childRunId?: string;
  }): void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function parseAction(
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

function parseOutcome(
  value: unknown
): PipelineHaltDiscoveryActionOutcome | undefined {
  if (
    typeof value === "string" &&
    (PIPELINE_HALT_DISCOVERY_ACTION_OUTCOMES as readonly string[]).includes(value)
  ) {
    return value as PipelineHaltDiscoveryActionOutcome;
  }
  return undefined;
}

/**
 * Recommendation-ready toast when a fresh halt-discovery briefing was just
 * persisted. Returns true when the discovery-specific path handled the notify.
 */
export function notifyHaltDiscoveryBriefingIfApplicable(opts: {
  runId: string;
  question: string;
  getPending: (runId: string) => InputRequestRow | undefined;
  getParentRunId: (runId: string) => string | null | undefined;
  notifier: HaltDiscoveryNotifierSink;
  onLog?: (message: string) => void;
}): boolean {
  try {
    const pending = opts.getPending(opts.runId);
    const meta = parseInputMetadataJson(pending?.metadata_json);
    if (meta?.kind !== HALT_DISCOVERY_INPUT_KIND) {
      return false;
    }
    const parentRunId = opts.getParentRunId(opts.runId);
    if (parentRunId == null || parentRunId.length === 0) {
      return false;
    }
    opts.onLog?.(
      `Run ${opts.runId} halt-discovery briefing ready (source ${parentRunId}): ${opts.question.slice(0, 120)}`
    );
    opts.notifier.haltDiscoveryRecommendationReady(opts.runId, parentRunId);
    return true;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    opts.onLog?.(
      `Halt discovery briefing notify failed for run ${opts.runId}: ${text}`
    );
    return false;
  }
}

/**
 * Parse and dispatch a fresh discovery failed / action-result bus event.
 * Requested/skipped and malformed payloads are silent. Returns true when a
 * toast was attempted.
 */
export function dispatchHaltDiscoveryRunEvent(opts: {
  runId: string;
  eventType: string;
  payload: string;
  notifier: HaltDiscoveryNotifierSink;
  onLog?: (message: string) => void;
}): boolean {
  try {
    if (opts.eventType === "run.pipeline-halt-discovery-failed") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(opts.payload) as unknown;
      } catch {
        return false;
      }
      const record = asRecord(parsed);
      if (!record) return false;
      const stage = parseFailureStage(record.stage);
      const code = readString(record, "code");
      const detail = readString(record, "detail");
      if (!stage || !code || !detail) return false;
      opts.notifier.haltDiscoveryFailed(opts.runId, stage, code, detail);
      return true;
    }

    if (opts.eventType === "run.pipeline-halt-discovery-action-result") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(opts.payload) as unknown;
      } catch {
        return false;
      }
      const record = asRecord(parsed);
      if (!record) return false;
      const action = parseAction(record.action);
      const outcome = parseOutcome(record.outcome);
      const sourceRunId = readString(record, "sourceRunId");
      const advisoryRunId =
        readString(record, "advisoryRunId") ?? opts.runId;
      if (!action || !outcome || !sourceRunId) return false;
      opts.notifier.haltDiscoveryActionResult({
        advisoryRunId,
        sourceRunId,
        action,
        outcome,
        code: readString(record, "code"),
        childRunId: readString(record, "childRunId"),
      });
      return true;
    }

    return false;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    opts.onLog?.(
      `Halt discovery event notify failed for run ${opts.runId}: ${text}`
    );
    return false;
  }
}

/** Subscribe to fresh run_event bus messages for discovery toast dispatch. */
export function subscribeHaltDiscoveryNotifications(opts: {
  events: DaemonEventBus;
  notifier: HaltDiscoveryNotifierSink;
  onLog?: (message: string) => void;
}): () => void {
  return opts.events.subscribe((message: WsServerMessage) => {
    if (message.type !== "run_event") return;
    dispatchHaltDiscoveryRunEvent({
      runId: message.runId,
      eventType: message.event.eventType,
      payload: message.event.payload,
      notifier: opts.notifier,
      onLog: opts.onLog,
    });
  });
}
