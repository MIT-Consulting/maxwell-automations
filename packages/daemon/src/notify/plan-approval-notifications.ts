import { isPlanApprovalShaped } from "../input/plan-approval-shape.js";
import type { InputRequestRow } from "../input/store.js";
import { parseInputMetadataJson } from "../input/store.js";

/** Narrow notifier surface used by plan-approval toast dispatch. */
export type PlanApprovalNotifierSink = {
  planApprovalRequired(runId: string, question: string): void;
};

/**
 * Dedicated plan-approval toast when a Guided approval gate was just persisted.
 * Returns true when the approval-specific path handled the notify.
 */
export function notifyPlanApprovalIfApplicable(opts: {
  runId: string;
  question: string;
  getPending: (runId: string) => InputRequestRow | undefined;
  notifier: PlanApprovalNotifierSink;
  onLog?: (message: string) => void;
}): boolean {
  try {
    const pending = opts.getPending(opts.runId);
    const meta = parseInputMetadataJson(pending?.metadata_json);
    if (!isPlanApprovalShaped(meta)) {
      return false;
    }
    opts.onLog?.(
      `Run ${opts.runId} plan approval required: ${opts.question.slice(0, 120)}`
    );
    opts.notifier.planApprovalRequired(opts.runId, opts.question);
    return true;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    opts.onLog?.(
      `Plan approval notify failed for run ${opts.runId}: ${text}`
    );
    return false;
  }
}
