export type FinalGateOutcome = "complete" | "blocked" | "other";

/** Classify final-gate chain stop reason for loud notify routing and b81 outcome. */
export function classifyFinalGateStopReason(
  stopReason: string | null | undefined
): FinalGateOutcome {
  const trimmed = stopReason?.trim() ?? "";
  if (trimmed.length === 0) {
    return "other";
  }
  if (trimmed.startsWith("complete:")) {
    return "complete";
  }
  if (trimmed.startsWith("blocked:") || trimmed.startsWith("deadlock:")) {
    return "blocked";
  }
  return "other";
}
