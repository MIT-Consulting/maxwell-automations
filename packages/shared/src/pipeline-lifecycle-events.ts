/**
 * Curated pipeline lifecycle vocabulary for doctor, halt discovery, and the
 * b81 cursor feed. Single source of truth — do not duplicate subsets locally.
 */

/** Union of doctor/diagnosis events plus input, pause, and b81 steering kinds. */
export const PIPELINE_LIFECYCLE_EVENTS = [
  "input.asked",
  "input.delivered",
  "run.cancelled",
  "run.chain-control",
  "run.chain-skipped",
  "run.chained",
  "run.error",
  "run.finished",
  "run.pause.resumed",
  "run.paused",
  "run.pipeline-directive",
  "run.pipeline-escalated",
  "run.pipeline-fanout",
  "run.pipeline-feature-review-enqueued",
  "run.pipeline-final-gate-enqueued",
  "run.pipeline-halt-discovery-action-result",
  "run.pipeline-halt-discovery-failed",
  "run.pipeline-halt-discovery-requested",
  "run.pipeline-halt-discovery-skipped",
  "run.pipeline-halt-unrecovered",
  "run.pipeline-integration-enqueued",
  "run.pipeline-join-ready",
  "run.pipeline-resumed",
  "run.pipeline-stop-requested",
  "run.pipeline-track-completed",
  "run.pipeline-wave-blocked",
  "run.pipeline-wave-cleanup",
  "run.pipeline-wave-finalized",
  "run.pipeline-wave-recovered",
  "run.reconciled",
  "run.resumed",
  "run.retained.fallback",
  "run.retry.scheduled",
  "run.revived",
  "run.stalled",
  "run.started",
] as const;

export type PipelineLifecycleEvent = (typeof PIPELINE_LIFECYCLE_EVENTS)[number];

/** Membership checks accept arbitrary persisted event_type strings. */
export const PIPELINE_LIFECYCLE_EVENT_SET: ReadonlySet<string> = new Set(
  PIPELINE_LIFECYCLE_EVENTS
);

/** Doctor key-event filter — alias of the shared lifecycle set. */
export const DOCTOR_KEY_EVENTS: ReadonlySet<string> =
  PIPELINE_LIFECYCLE_EVENT_SET;
