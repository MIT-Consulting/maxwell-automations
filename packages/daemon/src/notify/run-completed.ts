import {
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  workerKeyFromConfigKey,
} from "@lca/shared";
import type { AutomationRow, ParsedChainContext, RunRow } from "../runs/store.js";
import { isImplementFullyContext } from "../runs/pipeline-handoff.js";

export type RunCompletedNotifier = {
  runCompleted(runId: string, label?: string): void;
  pipelineComplete(runId: string, label?: string): void;
};

export type NotifyOnRunCompletedDeps = {
  getRun: (runId: string) => RunRow | undefined;
  getAutomation: (automationId: string) => AutomationRow | undefined;
  /**
   * Chain-context parser (`RunStore.parseChainContext`). Lets this decide
   * whether an implement-fully worker's richer phase-completed toast (fired
   * later, once metadata is generated) will supersede the generic one here.
   * Optional; omitting it just keeps the generic toast for every run.
   */
  parseChainContext?: (row: RunRow) => ParsedChainContext | null;
  notifier: RunCompletedNotifier;
};

function resolveCompletedLabel(
  automation: AutomationRow | undefined
): string | undefined {
  const name = automation?.name?.trim();
  if (name && name.length > 0) {
    return name;
  }
  const workerKey = workerKeyFromConfigKey(automation?.config_key);
  if (workerKey && workerKey.length > 0) {
    return workerKey;
  }
  return undefined;
}

function isFinalGateWorker(automation: AutomationRow | undefined): boolean {
  return (
    workerKeyFromConfigKey(automation?.config_key) ===
    IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
  );
}

/**
 * True when this completed run is a context-aware implement-fully worker
 * whose richer phase-completed toast (backlog id, phase type, timer,
 * description) will be fired separately once run metadata is generated.
 * The generic `runCompleted` toast is skipped in that case so the operator
 * never sees two toasts for the same phase.
 */
function isDeferredToPhaseNotification(
  run: RunRow,
  automation: AutomationRow | undefined,
  parseChainContext?: (row: RunRow) => ParsedChainContext | null
): boolean {
  const contextAware =
    run.chain_depth != null &&
    run.chain_max_depth != null &&
    run.chain_root_run_id != null;
  if (!contextAware) return false;

  const workerKey = workerKeyFromConfigKey(automation?.config_key);
  if (!workerKey) return false;

  const parsed = parseChainContext?.(run) ?? null;
  const pipelineId =
    parsed?.ok === true && typeof parsed.context.variables.pipelineId === "string"
      ? parsed.context.variables.pipelineId
      : null;
  return isImplementFullyContext(pipelineId);
}

/** Fire quiet/loud completed notifications for a settled run; never throws. */
export function notifyOnRunCompleted(
  runId: string,
  deps: NotifyOnRunCompletedDeps
): void {
  try {
    const run = deps.getRun(runId);
    if (!run) {
      return;
    }

    const automation = deps.getAutomation(run.automation_id);
    const label = resolveCompletedLabel(automation);

    const deferred = isDeferredToPhaseNotification(
      run,
      automation,
      deps.parseChainContext
    );

    if (!deferred) {
      try {
        deps.notifier.runCompleted(runId, label);
      } catch {
        // never let sink throw
      }
    }

    if (automation && isFinalGateWorker(automation)) {
      try {
        deps.notifier.pipelineComplete(runId, label);
      } catch {
        // never let sink throw
      }
    }
  } catch {
    // never throw into engine settle path
  }
}
