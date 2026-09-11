export type FeatureQueueLineageRun = {
  configKey: string;
  status: string;
};

/** Done only when the terminal worker completed in the lineage. */
export function classifyFeatureQueueOutcome(
  lineage: ReadonlyArray<FeatureQueueLineageRun>,
  terminalConfigKey: string
): "done" | "failed" {
  for (const run of lineage) {
    if (
      run.configKey === terminalConfigKey &&
      run.status === "completed"
    ) {
      return "done";
    }
  }
  return "failed";
}

/** One-line doctor summary for a failed queue entry. */
export function featureQueueFailureDetail(
  lineage: ReadonlyArray<FeatureQueueLineageRun>,
  terminalConfigKey: string
): string {
  if (classifyFeatureQueueOutcome(lineage, terminalConfigKey) === "done") {
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
