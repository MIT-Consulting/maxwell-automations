export type FeatureQueueLineageRun = {
  configKey: string;
  status: string;
};

export type FeatureQueueClassifyOutcome = "done" | "failed" | "running";

/**
 * Done only when the terminal worker completed. Failed only when a lineage
 * run actually failed or was cancelled. Incomplete successful lineage stays
 * running — the gap between a green worker and the next spawn is not a fail.
 */
export function classifyFeatureQueueOutcome(
  lineage: ReadonlyArray<FeatureQueueLineageRun>,
  terminalConfigKey: string
): FeatureQueueClassifyOutcome {
  for (const run of lineage) {
    if (
      run.configKey === terminalConfigKey &&
      run.status === "completed"
    ) {
      return "done";
    }
  }
  for (const run of lineage) {
    if (run.status === "failed" || run.status === "cancelled") {
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
  const failures = lineage.filter(
    (run) => run.status === "failed" || run.status === "cancelled"
  );
  if (failures.length === 0) {
    return "pipeline did not reach final gate";
  }
  const nonTerminal = failures.filter(
    (run) => run.configKey !== terminalConfigKey
  );
  const pick =
    nonTerminal.length > 0
      ? nonTerminal[nonTerminal.length - 1]!
      : failures[failures.length - 1]!;
  return `${pick.configKey} ${pick.status}`;
}
