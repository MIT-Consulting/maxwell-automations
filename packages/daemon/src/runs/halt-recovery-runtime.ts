/**
 * I/O orchestrator for post-terminal pipeline halt auto-escalation (b43).
 * Assembles durable facts, classifies once, then executes or persists the decision.
 */

import {
  workerKeyFromConfigKey,
  type PipelineHaltRecoveryDeclineCode,
  type PipelineHaltRecoveryDecision,
} from "@lca/shared";
import {
  classifyPipelineHaltRecovery,
  interpretLineage,
  ladderActionFor,
  type AutoEscalationEventFact,
  type AutoEscalationLineageFact,
  type AutoEscalationPolicy,
} from "./auto-escalation.js";
import type { RunEngine } from "./engine.js";
import type { EscalationEligibilityResult, RunStore } from "./store.js";

export type HaltRecoveryResult =
  | {
      kind: "acted";
      action: "retry" | "skip";
      childRunId: string | null;
    }
  | {
      kind: "declined";
      code: PipelineHaltRecoveryDeclineCode;
      detail: string;
    }
  | { kind: "already-resolved"; detail: string };

export type HaltRecoveryRuntimeDeps = {
  store: RunStore;
  engine: RunEngine;
  policy: AutoEscalationPolicy;
  onLog: (message: string) => void;
};

const HARMLESS_ELIGIBILITY: EscalationEligibilityResult = {
  ok: false,
  reason: "not-halted",
};

function decodeLineageActor(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "actor" in parsed &&
      typeof (parsed as { actor: unknown }).actor === "string"
    ) {
      const actor = (parsed as { actor: string }).actor.trim();
      if (actor.length > 0) {
        return actor;
      }
    }
  } catch {
    // Malformed payloads never become daemon budget spenders.
  }
  return "unknown";
}

function hasDaemonEscalationOnRun(
  events: readonly AutoEscalationEventFact[]
): boolean {
  for (const event of events) {
    if (event.event_type !== "run.pipeline-escalated") continue;
    if (decodeLineageActor(event.payload) === "daemon") {
      return true;
    }
  }
  return false;
}

function hasUnrecoveredDecision(
  events: readonly AutoEscalationEventFact[]
): boolean {
  return events.some((e) => e.event_type === "run.pipeline-halt-unrecovered");
}

function unrecoveredPayload(
  decision: Extract<PipelineHaltRecoveryDecision, { action: "none" }>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action: "none",
    code: decision.code,
    detail: decision.detail,
  };
  if (decision.observedReason !== undefined) {
    payload.observedReason = decision.observedReason;
  }
  return payload;
}

function appendUnrecovered(
  store: RunStore,
  runId: string,
  decision: Extract<PipelineHaltRecoveryDecision, { action: "none" }>
): HaltRecoveryResult {
  store.appendEvent(
    runId,
    "run.pipeline-halt-unrecovered",
    unrecoveredPayload(decision)
  );
  return {
    kind: "declined",
    code: decision.code,
    detail: decision.detail,
  };
}

/**
 * Classify and optionally auto-escalate one halted pipeline run.
 * Throws from the escalation path are not converted into decline codes.
 */
export async function recoverPipelineHalt(
  deps: HaltRecoveryRuntimeDeps,
  runId: string
): Promise<HaltRecoveryResult> {
  const { store, engine, policy, onLog } = deps;

  const run = store.getRun(runId);
  if (!run) {
    return {
      kind: "already-resolved",
      detail: "run not found",
    };
  }

  if (run.chain_handled_at != null) {
    return {
      kind: "already-resolved",
      detail: "chain already claimed",
    };
  }

  const rawEvents = store.listRunEvents(runId);
  const events: AutoEscalationEventFact[] = rawEvents.map((e) => ({
    seq: e.seq,
    event_type: e.event_type,
    payload: e.payload,
  }));

  if (hasDaemonEscalationOnRun(events) || hasUnrecoveredDecision(events)) {
    return {
      kind: "already-resolved",
      detail: "prior automatic decision present",
    };
  }

  const automation = store.getAutomationByIdIncludingArchived(run.automation_id);
  const workerKey = automation
    ? workerKeyFromConfigKey(automation.config_key)
    : null;

  const chainRootRunId = run.chain_root_run_id;
  const lineage: AutoEscalationLineageFact[] =
    chainRootRunId == null
      ? []
      : store.listPipelineEscalationEvents(chainRootRunId).map((row) => ({
          chainRootRunId,
          chainDepth: row.chainDepth ?? -1,
          actor: decodeLineageActor(row.payload),
        }));

  const { rung } =
    chainRootRunId != null && run.chain_depth != null
      ? interpretLineage(lineage, chainRootRunId, run.chain_depth)
      : { rung: 1 };
  const ladderAction = ladderActionFor(workerKey, rung);
  const selectedActionEligibility: EscalationEligibilityResult =
    ladderAction == null
      ? HARMLESS_ELIGIBILITY
      : store.getEscalationEligibility(runId, ladderAction);

  const decision = classifyPipelineHaltRecovery({
    run,
    workerKey,
    events,
    lineage,
    policy,
    selectedActionEligibility,
  });

  if (decision.action === "none") {
    onLog(
      `Pipeline halt recovery declined for run ${runId}: ${decision.code} — ${decision.detail}`
    );
    return appendUnrecovered(store, runId, decision);
  }

  const result = await engine.escalateRun(
    runId,
    { action: decision.action, reason: decision.detail },
    { actor: "daemon", recoveryDecision: decision }
  );

  if (result.ok) {
    onLog(
      `Pipeline halt recovery ${decision.action} for run ${runId} → ${result.response.childRunId ?? "null"}`
    );
    return {
      kind: "acted",
      action: decision.action,
      childRunId: result.response.childRunId,
    };
  }

  if (result.reason === "already-chained") {
    const after = store.getRun(runId);
    if (after?.chain_handled_at != null) {
      onLog(
        `Pipeline halt recovery for run ${runId}: halt resolved elsewhere (already-chained)`
      );
      return {
        kind: "already-resolved",
        detail: "halt resolved elsewhere",
      };
    }
    onLog(
      `Pipeline halt recovery for run ${runId}: already-chained without claim — ${result.message}`
    );
    return {
      kind: "already-resolved",
      detail: "already-chained without durable claim",
    };
  }

  const still = store.getRun(runId);
  if (still?.chain_handled_at == null) {
    onLog(
      `Pipeline halt recovery for run ${runId}: execution refused ${result.reason} — ${result.message}`
    );
    return appendUnrecovered(store, runId, {
      action: "none",
      code: result.reason,
      detail: result.message,
    });
  }

  onLog(
    `Pipeline halt recovery for run ${runId}: refused ${result.reason} after claim — ${result.message}`
  );
  return {
    kind: "already-resolved",
    detail: `refused after claim: ${result.reason}`,
  };
}
