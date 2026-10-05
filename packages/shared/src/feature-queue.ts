import { classifyFinalGateStopReason } from "./pipeline-final-gate-outcome.js";

export type FeatureQueueLineageRun = {
  configKey: string;
  status: string;
  chainStopRequestedAt: string | null;
  chainStopReason: string | null;
  createdAt: string;
};

export type FeatureQueueClassifyOutcome = "done" | "failed" | "running";

const NON_TERMINAL_STATUSES = new Set([
  "queued",
  "running",
  "needs_input",
  "paused",
]);

function isNonTerminalStatus(status: string): boolean {
  return NON_TERMINAL_STATUSES.has(status);
}

function isTerminalStatus(status: string): boolean {
  return !isNonTerminalStatus(status);
}

function completedFinalGate(
  lineage: ReadonlyArray<FeatureQueueLineageRun>,
  terminalConfigKey: string
): FeatureQueueLineageRun | undefined {
  return lineage.find(
    (run) => run.configKey === terminalConfigKey && run.status === "completed"
  );
}

function newestCompletedRun(
  lineage: ReadonlyArray<FeatureQueueLineageRun>
): FeatureQueueLineageRun | undefined {
  for (let i = lineage.length - 1; i >= 0; i -= 1) {
    const run = lineage[i]!;
    if (run.status === "completed") {
      return run;
    }
  }
  return undefined;
}

/**
 * Classify queue outcomes from complete lineage evidence rather than terminal
 * worker status alone. Ordered per PRD FR2: live runs, final gate, failed runs,
 * halted terminal lineage, transition gaps, fallback running.
 */
export function classifyFeatureQueueOutcome(
  lineage: ReadonlyArray<FeatureQueueLineageRun>,
  terminalConfigKey: string
): FeatureQueueClassifyOutcome {
  if (lineage.some((run) => isNonTerminalStatus(run.status))) {
    return "running";
  }

  const finalGate = completedFinalGate(lineage, terminalConfigKey);
  if (finalGate) {
    const gateOutcome = classifyFinalGateStopReason(finalGate.chainStopReason);
    return gateOutcome === "complete" ? "done" : "failed";
  }

  if (
    lineage.some((run) => run.status === "failed" || run.status === "cancelled")
  ) {
    return "failed";
  }

  if (
    lineage.length > 0 &&
    lineage.every((run) => isTerminalStatus(run.status))
  ) {
    const newestCompleted = newestCompletedRun(lineage);
    if (newestCompleted?.chainStopRequestedAt) {
      const reason = newestCompleted.chainStopReason?.trim() ?? "";
      if (reason.startsWith("complete:")) {
        return "running";
      }
      return "failed";
    }
  }

  return "running";
}

/** One-line doctor summary for a failed queue entry. */
export function featureQueueFailureDetail(
  lineage: ReadonlyArray<FeatureQueueLineageRun>,
  terminalConfigKey: string
): string {
  if (classifyFeatureQueueOutcome(lineage, terminalConfigKey) !== "failed") {
    return "";
  }

  const finalGate = completedFinalGate(lineage, terminalConfigKey);
  if (finalGate) {
    const gateOutcome = classifyFinalGateStopReason(finalGate.chainStopReason);
    if (gateOutcome === "blocked") {
      const reason = finalGate.chainStopReason?.trim() ?? "";
      return reason.length > 0
        ? `final-gate blocked: ${reason}`
        : "final-gate blocked";
    }
    return "final-gate missing explicit complete stop reason";
  }

  const failures = lineage.filter(
    (run) => run.status === "failed" || run.status === "cancelled"
  );
  if (failures.length > 0) {
    const nonTerminal = failures.filter(
      (run) => run.configKey !== terminalConfigKey
    );
    const pick =
      nonTerminal.length > 0
        ? nonTerminal[nonTerminal.length - 1]!
        : failures[failures.length - 1]!;
    return `${pick.configKey} ${pick.status}`;
  }

  const newestCompleted = newestCompletedRun(lineage);
  if (newestCompleted?.chainStopRequestedAt) {
    const reason = newestCompleted.chainStopReason?.trim() ?? "";
    if (!reason.startsWith("complete:")) {
      return reason.length > 0
        ? `${newestCompleted.configKey} halted: ${reason}`
        : `${newestCompleted.configKey} halted`;
    }
  }

  return "pipeline did not reach final gate";
}
