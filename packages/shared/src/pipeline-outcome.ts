import { classifyFinalGateStopReason } from "./pipeline-final-gate-outcome.js";

export type PipelineOutcome =
  | "running"
  | "green"
  | "blocked"
  | "deadlock"
  | "aborted"
  | "failed";

export type PipelineOutcomeRun = {
  status: string;
  configKey: string;
  chainStopRequestedAt: string | null;
  chainStopReason: string | null;
  chainHandledAt: string | null;
  createdAt: string;
};

export type PipelineOutcomeEvent = {
  eventType: string;
  payload: string;
};

export type ClassifyPipelineOutcomeInput = {
  runs: readonly PipelineOutcomeRun[];
  /** Config key for the final-gate worker, e.g. `generated:final-gate`. */
  finalGateConfigKey: string;
  events?: readonly PipelineOutcomeEvent[];
};

const NON_TERMINAL_STATUSES = new Set([
  "queued",
  "running",
  "needs_input",
  "paused",
]);

function isNonTerminalStatus(status: string): boolean {
  return NON_TERMINAL_STATUSES.has(status);
}

function trimmedStopReason(
  stopReason: string | null | undefined
): string {
  return stopReason?.trim() ?? "";
}

function outcomeFromStopReasonPrefix(
  stopReason: string | null | undefined
): PipelineOutcome | null {
  const trimmed = trimmedStopReason(stopReason);
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("complete:")) {
    return "green";
  }
  if (trimmed.startsWith("deadlock:")) {
    return "deadlock";
  }
  if (trimmed.startsWith("blocked:")) {
    return "blocked";
  }
  if (trimmed.startsWith("aborted:")) {
    return "aborted";
  }
  return null;
}

function finalGateOutcome(
  stopReason: string | null | undefined
): PipelineOutcome {
  const prefixOutcome = outcomeFromStopReasonPrefix(stopReason);
  if (prefixOutcome != null) {
    return prefixOutcome;
  }
  const gateOutcome = classifyFinalGateStopReason(stopReason);
  if (gateOutcome === "complete") {
    return "green";
  }
  if (gateOutcome === "blocked") {
    return "blocked";
  }
  return "failed";
}

function hasAbortEscalation(
  events: readonly PipelineOutcomeEvent[]
): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.eventType !== "run.pipeline-escalated") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(event.payload);
      if (
        typeof parsed === "object" &&
        parsed != null &&
        !Array.isArray(parsed) &&
        (parsed as { action?: unknown }).action === "abort"
      ) {
        return true;
      }
    } catch {
      // ignore malformed payloads
    }
    return false;
  }
  return false;
}

function completedFinalGate(
  runs: readonly PipelineOutcomeRun[],
  finalGateConfigKey: string
): PipelineOutcomeRun | undefined {
  return runs.find(
    (run) =>
      run.configKey === finalGateConfigKey && run.status === "completed"
  );
}

/**
 * Classify pipeline outcome from persisted run rows (and optional lifecycle
 * events for abort escalation). Terminal lineages without explicit green fail
 * closed to `failed`; recoverability is represented separately on `halt`.
 */
export function classifyPipelineOutcome(
  input: ClassifyPipelineOutcomeInput
): PipelineOutcome {
  const { runs, finalGateConfigKey, events = [] } = input;

  if (runs.some((run) => isNonTerminalStatus(run.status))) {
    return "running";
  }

  const finalGate = completedFinalGate(runs, finalGateConfigKey);
  if (finalGate) {
    return finalGateOutcome(finalGate.chainStopReason);
  }

  for (const run of runs) {
    const prefixOutcome = outcomeFromStopReasonPrefix(run.chainStopReason);
    if (prefixOutcome === "aborted") {
      return "aborted";
    }
  }

  if (hasAbortEscalation(events)) {
    return "aborted";
  }

  for (const run of runs) {
    const prefixOutcome = outcomeFromStopReasonPrefix(run.chainStopReason);
    if (prefixOutcome === "deadlock" || prefixOutcome === "blocked") {
      return prefixOutcome;
    }
  }

  if (
    runs.some(
      (run) => run.status === "failed" || run.status === "cancelled"
    )
  ) {
    return "failed";
  }

  if (runs.length > 0) {
    return "failed";
  }

  return "running";
}
