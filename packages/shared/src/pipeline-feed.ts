/**
 * Cursor feed contracts and compact payload projection for b81 pipeline watch.
 */

/** `--until` reasons accepted by `max watch`. */
export const PIPELINE_WATCH_UNTIL_REASONS = [
  "green",
  "needs_input",
  "halted",
  "blocked",
  "deadlock",
  "aborted",
  "failed",
  "paused",
  "step",
] as const;

export type PipelineWatchUntilReason =
  (typeof PIPELINE_WATCH_UNTIL_REASONS)[number];

export const PIPELINE_WATCH_UNTIL_REASON_SET: ReadonlySet<string> = new Set(
  PIPELINE_WATCH_UNTIL_REASONS
);

/** Compact, allowlisted event payload — never transcript/prompt/result bodies. */
export type PipelineFeedEventPayload = Record<
  string,
  string | number | boolean | null
>;

export type PipelineFeedEvent = {
  /** Global `run_events.id` cursor. */
  id: number;
  runId: string;
  kind: string;
  at: string;
  payload: PipelineFeedEventPayload;
};

const FEED_PAYLOAD_TEXT_CAP = 240;

function capText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length <= FEED_PAYLOAD_TEXT_CAP) return trimmed;
  return trimmed.slice(0, FEED_PAYLOAD_TEXT_CAP);
}

function putCapped(
  summary: PipelineFeedEventPayload,
  key: string,
  value: unknown
): void {
  const text = capText(value);
  if (text == null) return;
  summary[key] = text;
  if (typeof value === "string" && value.trim().length > FEED_PAYLOAD_TEXT_CAP) {
    summary[`${key}Truncated`] = true;
  }
}

function parsePayloadObject(payloadJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed === "object" && parsed != null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* malformed */
  }
  return null;
}

/** Project a persisted lifecycle payload to a compact, allowlisted delta. */
export function projectPipelineFeedPayload(
  eventType: string,
  payloadJson: string
): PipelineFeedEventPayload {
  const record = parsePayloadObject(payloadJson);
  if (record == null) {
    return { parse: "malformed-json" };
  }

  const summary: PipelineFeedEventPayload = {};

  if (eventType === "run.error") {
    putCapped(summary, "message", record.message);
    putCapped(summary, "reason", record.reason);
    putCapped(summary, "cause", record.cause);
    putCapped(summary, "sdkStatus", record.sdkStatus);
    return summary;
  }

  if (eventType === "run.finished") {
    putCapped(summary, "sdkStatus", record.sdkStatus);
    if (typeof record.result === "string" && record.result.trim()) {
      summary.resultPresent = true;
    }
    return summary;
  }

  if (eventType === "input.asked") {
    if (typeof record.question === "string" && record.question.trim()) {
      summary.questionPresent = true;
    }
    putCapped(summary, "kind", record.kind);
    return summary;
  }

  if (eventType === "input.delivered") {
    putCapped(summary, "kind", record.kind);
    putCapped(summary, "actorId", record.actorId);
    return summary;
  }

  if (eventType === "run.pipeline-directive") {
    putCapped(summary, "kind", record.kind);
    putCapped(summary, "directiveId", record.directiveId);
    putCapped(summary, "actorId", record.actorId);
    return summary;
  }

  if (eventType === "run.pipeline-stop-requested") {
    putCapped(summary, "frontierRunId", record.frontierRunId);
    putCapped(summary, "stopReason", record.stopReason);
    putCapped(summary, "actorId", record.actorId);
    return summary;
  }

  if (eventType === "run.pipeline-escalated") {
    putCapped(summary, "action", record.action);
    putCapped(summary, "actor", record.actor);
    putCapped(summary, "actorId", record.actorId);
    if (record.childRunId === null) {
      summary.childRunId = null;
    } else {
      putCapped(summary, "childRunId", record.childRunId);
    }
    putCapped(summary, "recoveryDetail", record.recoveryDetail);
    putCapped(summary, "reason", record.reason);
    return summary;
  }

  if (eventType === "run.cancelled") {
    putCapped(summary, "reason", record.reason);
    putCapped(summary, "actorId", record.actorId);
    return summary;
  }

  if (
    eventType === "run.pipeline-halt-unrecovered" ||
    eventType === "run.pipeline-halt-discovery-requested" ||
    eventType === "run.pipeline-halt-discovery-skipped" ||
    eventType === "run.pipeline-halt-discovery-failed"
  ) {
    putCapped(summary, "code", record.code);
    putCapped(summary, "recoveryCode", record.recoveryCode);
    putCapped(summary, "detail", record.detail);
    putCapped(summary, "recoveryDetail", record.recoveryDetail);
    putCapped(summary, "observedReason", record.observedReason);
    putCapped(summary, "stage", record.stage);
    putCapped(summary, "action", record.action);
    return summary;
  }

  if (eventType === "run.chain-skipped" || eventType === "run.chained") {
    putCapped(summary, "reason", record.reason);
    putCapped(summary, "next", record.next);
    putCapped(summary, "status", record.status);
    return summary;
  }

  for (const key of [
    "reason",
    "code",
    "detail",
    "action",
    "actor",
    "actorId",
    "status",
    "stage",
  ] as const) {
    putCapped(summary, key, record[key]);
  }
  return summary;
}

/** Fixed exit codes for `max watch --until` (frozen in b81). */
export function exitCodeForWatchUntilReason(
  reason: PipelineWatchUntilReason | "timeout" | null
): number {
  switch (reason) {
    case "green":
    case "step":
    case "paused":
      return 0;
    case "needs_input":
      return 10;
    case "halted":
      return 11;
    case "blocked":
    case "deadlock":
      return 12;
    case "aborted":
    case "failed":
      return 13;
    case "timeout":
      return 14;
    default:
      return 0;
  }
}

export type PipelineWatchSnapshotSignals = {
  outcome: string;
  waiting: { kind: string | null } | null;
  halt: { recoveryCommand: string | null } | null;
  current: { status: string } | null;
};

/** Map a hydrated snapshot to a watch `--until` reason, if any. */
export function watchUntilReasonFromSnapshot(
  snapshot: PipelineWatchSnapshotSignals
): PipelineWatchUntilReason | null {
  if (snapshot.waiting != null) {
    return "needs_input";
  }
  if (snapshot.current?.status === "paused") {
    return "paused";
  }
  if (snapshot.halt != null) {
    return "halted";
  }
  switch (snapshot.outcome) {
    case "green":
      return "green";
    case "blocked":
      return "blocked";
    case "deadlock":
      return "deadlock";
    case "aborted":
      return "aborted";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/** Map a lifecycle feed event to a watch `--until` reason, if any. */
export function watchUntilReasonFromFeedEvent(
  event: Pick<PipelineFeedEvent, "kind">
): PipelineWatchUntilReason | null {
  switch (event.kind) {
    case "input.asked":
      return "needs_input";
    case "run.paused":
      return "paused";
    case "run.chained":
    case "run.finished":
      return "step";
    default:
      return null;
  }
}
