/**
 * Pure post-terminal halt recovery classifier (b43 Phase 1).
 * Synchronous, side-effect free — no store, settings, logging, or escalation I/O.
 */

import {
  chainRunContextSchema,
  type PipelineHaltRecoveryDecision,
  type PipelineHaltRecoveryDeclineCode,
  type RunEscalationRefusal,
} from "@lca/shared";
import type { EscalationEligibilityResult, RunRow } from "./store.js";

/** Durable event fact supplied by the Phase 2 assembler. */
export type AutoEscalationEventFact = {
  seq: number;
  event_type: string;
  /** Serialized JSON payload (may be malformed). */
  payload: string;
};

/**
 * Prior `run.pipeline-escalated` fact under a chain root.
 * Only `actor: "daemon"` spends budget / advances a rung.
 */
export type AutoEscalationLineageFact = {
  chainRootRunId: string;
  chainDepth: number;
  actor: string;
};

/** Kill-switch and lineage cap consumed by the classifier (defaults live in Phase 2). */
export type AutoEscalationPolicy = {
  enabled: boolean;
  /** Positive integer; non-positive declines as `budget-spent`. */
  maxPerPipeline: number;
};

export type AutoEscalationInput = {
  run: RunRow;
  /** Worker identity already derived from the automation config key. */
  workerKey: string | null;
  events: readonly AutoEscalationEventFact[];
  lineage: readonly AutoEscalationLineageFact[];
  policy: AutoEscalationPolicy;
  /**
   * Eligibility for the ladder-selected `retry` or `skip` action.
   * Ignored when the ladder yields no action. Store-owned refusals are returned
   * unchanged.
   */
  selectedActionEligibility: EscalationEligibilityResult;
};

const SAFE_HALT_REASON = "status-mismatch";
const SAFE_FAILURE_REASON = "sdk_error";
const SUBSTANTIVE_EVENT_TYPES = new Set(["assistant", "tool_call"]);

/** Per-worker automatic action ladder (1-based rungs). */
const WORKER_LADDER: Readonly<
  Record<string, ReadonlyArray<"retry" | "skip">>
> = {
  "plan-phase": ["retry"],
  implement: ["retry"],
  // review owns phase closeout — skip would advance with the row still In Progress.
  review: ["retry"],
  "docs-commit": ["skip"],
};

function decline(
  code: PipelineHaltRecoveryDeclineCode,
  detail: string,
  observedReason?: string
): PipelineHaltRecoveryDecision {
  if (observedReason !== undefined) {
    return { action: "none", code, detail, observedReason };
  }
  return { action: "none", code, detail };
}

function parsePayload(payload: string): unknown | undefined {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function reasonFromPayload(parsed: unknown): string | undefined {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "reason" in parsed &&
    typeof (parsed as { reason: unknown }).reason === "string"
  ) {
    return (parsed as { reason: string }).reason;
  }
  return undefined;
}

/** Latest matching event by `seq` without mutating or sorting the input. */
function latestByType(
  events: readonly AutoEscalationEventFact[],
  eventType: string
): AutoEscalationEventFact | undefined {
  let best: AutoEscalationEventFact | undefined;
  for (const event of events) {
    if (event.event_type !== eventType) continue;
    if (best === undefined || event.seq > best.seq) {
      best = event;
    }
  }
  return best;
}

function hasSubstantiveActivityBefore(
  events: readonly AutoEscalationEventFact[],
  errorSeq: number
): boolean {
  for (const event of events) {
    if (event.seq >= errorSeq) continue;
    if (SUBSTANTIVE_EVENT_TYPES.has(event.event_type)) {
      return true;
    }
  }
  return false;
}

function hasParseableChainContext(row: RunRow): boolean {
  if (row.chain_context_json == null || row.chain_context_json.trim() === "") {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.chain_context_json);
  } catch {
    return false;
  }
  return chainRunContextSchema.safeParse(parsed).success;
}

function isContextAwarePipeline(row: RunRow): boolean {
  return (
    row.chain_root_run_id != null &&
    row.chain_depth != null &&
    row.chain_max_depth != null &&
    hasParseableChainContext(row)
  );
}

/**
 * Count same-root daemon lineage facts and the rung at the run's current depth.
 * Operator and foreign-root facts are ignored for both budget and rung.
 */
export function interpretLineage(
  lineage: readonly AutoEscalationLineageFact[],
  chainRootRunId: string,
  chainDepth: number
): { daemonCount: number; rung: number } {
  let daemonCount = 0;
  let sameDepthDaemonCount = 0;
  for (const fact of lineage) {
    if (fact.actor !== "daemon") continue;
    if (fact.chainRootRunId !== chainRootRunId) continue;
    daemonCount += 1;
    if (fact.chainDepth === chainDepth) {
      sameDepthDaemonCount += 1;
    }
  }
  return { daemonCount, rung: sameDepthDaemonCount + 1 };
}

/**
 * Ladder action for a worker at a 1-based rung, or null when exhausted/unknown.
 * Exported so Phase 2 can resolve eligibility for the selected action first.
 */
export function ladderActionFor(
  workerKey: string | null,
  rung: number
): "retry" | "skip" | null {
  if (workerKey == null) return null;
  const steps = WORKER_LADDER[workerKey];
  if (steps == null || rung < 1) return null;
  return steps[rung - 1] ?? null;
}

function success(
  action: "retry" | "skip",
  detail: string
): PipelineHaltRecoveryDecision {
  return { action, code: "safe-class", detail };
}

/**
 * Classify whether a halted pipeline run is safe to auto-escalate.
 * Precedence: disabled → wave/track → structural → safe class → budget →
 * ladder → selected-action eligibility.
 */
export function classifyPipelineHaltRecovery(
  input: AutoEscalationInput
): PipelineHaltRecoveryDecision {
  const { run, workerKey, events, lineage, policy, selectedActionEligibility } =
    input;

  if (!policy.enabled) {
    return decline("disabled", "Pipeline auto-escalation is disabled");
  }

  if (run.pipeline_wave_id != null || run.pipeline_track_id != null) {
    return decline(
      "wave-scoped",
      "Wave- or track-scoped runs are not auto-recovered"
    );
  }

  if (!isContextAwarePipeline(run)) {
    return decline(
      "not-pipeline",
      "Run is not a context-aware pipeline run"
    );
  }

  if (run.chain_handled_at != null) {
    return decline(
      "already-chained",
      "Run already has a chain decision (escalation is one-shot)"
    );
  }

  // Root depth cannot be retried; surface the canonical refusal before ladder.
  if (run.chain_depth === 0) {
    return decline(
      "root-run",
      "Cannot retry the pipeline root; start a fresh kickoff instead"
    );
  }

  if (run.status !== "failed") {
    return decline(
      "not-safe-class",
      `Run status ${run.status} is not a recoverable failed halt`,
      run.status
    );
  }

  const chainSkipped = latestByType(events, "run.chain-skipped");
  if (chainSkipped === undefined) {
    return decline(
      "not-safe-class",
      "Missing run.chain-skipped halt evidence",
      "missing-chain-skipped"
    );
  }
  const haltParsed = parsePayload(chainSkipped.payload);
  if (haltParsed === undefined) {
    return decline(
      "not-safe-class",
      "Malformed run.chain-skipped payload",
      "malformed-chain-skipped"
    );
  }
  const haltReason = reasonFromPayload(haltParsed);
  if (haltReason !== SAFE_HALT_REASON) {
    return decline(
      "not-safe-class",
      `Halt reason ${haltReason ?? "(missing)"} is not in the safe allowlist`,
      haltReason ?? "missing-halt-reason"
    );
  }

  const runError = latestByType(events, "run.error");
  if (runError === undefined) {
    return decline(
      "not-safe-class",
      "Missing run.error failure evidence",
      "missing-run-error"
    );
  }
  const errorParsed = parsePayload(runError.payload);
  if (errorParsed === undefined) {
    return decline(
      "not-safe-class",
      "Malformed run.error payload",
      "malformed-run-error"
    );
  }
  const failureReason = reasonFromPayload(errorParsed);
  if (failureReason !== SAFE_FAILURE_REASON) {
    return decline(
      "not-safe-class",
      `Failure reason ${failureReason ?? "(missing)"} is not in the safe allowlist`,
      failureReason ?? "missing-failure-reason"
    );
  }

  if (!hasSubstantiveActivityBefore(events, runError.seq)) {
    return decline(
      "not-safe-class",
      "No substantive assistant/tool_call activity before the failure",
      "no-substantive-activity"
    );
  }

  const chainRootRunId = run.chain_root_run_id!;
  const chainDepth = run.chain_depth!;
  const { daemonCount, rung } = interpretLineage(
    lineage,
    chainRootRunId,
    chainDepth
  );

  if (
    !Number.isFinite(policy.maxPerPipeline) ||
    policy.maxPerPipeline <= 0 ||
    daemonCount >= policy.maxPerPipeline
  ) {
    return decline(
      "budget-spent",
      "Automatic escalation lineage budget is spent or non-positive"
    );
  }

  const ladderAction = ladderActionFor(workerKey, rung);
  if (ladderAction == null) {
    return decline(
      "ladder-exhausted",
      workerKey == null
        ? "Unknown worker has no auto-escalation ladder"
        : `Worker ${workerKey} has no auto-escalation action at rung ${rung}`
    );
  }

  if (!selectedActionEligibility.ok) {
    const reason: RunEscalationRefusal = selectedActionEligibility.reason;
    return decline(
      reason,
      `Selected action ${ladderAction} refused: ${reason}`
    );
  }

  return success(
    ladderAction,
    `Safe-class halt recovery: ${ladderAction} for ${workerKey ?? "worker"} at rung ${rung}`
  );
}
