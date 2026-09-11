import {
  workerKeyFromConfigKey,
  type PipelineHaltRecoveryDecision,
  type RunEscalationAction,
  type RunEscalationRefusal,
  type RunEscalationRequest,
  type RunEscalationResponse,
} from "@lca/shared";
import type { RunEngine } from "./engine.js";
import {
  buildChainedPromptOverride,
  resolveChildModelRole,
} from "./chain-runner.js";
import type { RunStore } from "./store.js";

export type EscalationActor = "operator" | "daemon";

/** Daemon-only call context; never accepted from HTTP / RunEscalationRequest. */
export type EscalationCallContext = {
  actor?: EscalationActor; // omitted means operator
  recoveryDecision?: Extract<
    PipelineHaltRecoveryDecision,
    { action: "retry" | "skip" }
  >;
};

export type EscalationDeps = {
  store: RunStore;
  engine: RunEngine;
  onLog: (message: string) => void;
  /**
   * When a track-scoped run is aborted, abort its wave and stop siblings.
   * Optional so legacy harnesses without a wave coordinator keep today's semantics.
   */
  abortTrackWave?: (
    runId: string,
    reason: string
  ) => Promise<{ ok: boolean; waveId?: string }>;
};

export type EscalateResult =
  | { ok: true; response: RunEscalationResponse }
  | { ok: false; reason: RunEscalationRefusal; message: string };

const REFUSAL_MESSAGES: Record<RunEscalationRefusal, string> = {
  "not-found": "Run not found",
  "not-pipeline": "Run is not a context-aware pipeline run",
  "not-halted": "Run is not halted (retry/skip require a terminal status)",
  "already-chained": "Run already has a chain decision (escalation is one-shot)",
  "root-run": "Cannot retry the pipeline root; start a fresh kickoff instead",
  "no-successor": "No configured successor to skip to",
  "budget-exhausted": "Pipeline budget exhausted; cannot skip further",
};

function refusal(
  reason: RunEscalationRefusal,
  runId?: string
): EscalateResult {
  const base = REFUSAL_MESSAGES[reason];
  const message =
    reason === "not-found" && runId
      ? `Run not found: ${runId}`
      : runId
        ? `Run ${runId}: ${base}`
        : base;
  return { ok: false, reason, message };
}

function abortStopReason(reason: string | undefined): string {
  const text = reason?.trim() || "(no reason given)";
  return `aborted: ${text}`;
}

function skipNotice(
  workerKey: string,
  runId: string,
  reason: string | undefined,
  actor: EscalationActor
): string {
  const detail = reason?.trim() || "(no reason given)";
  if (actor === "daemon") {
    return `

--- step skipped by automatic halt recovery: ${workerKey} (run ${runId}) was not completed by an agent ---
${detail}`;
  }
  return `

--- step skipped by operator: ${workerKey} (run ${runId}) was not completed by an agent ---
${detail}`;
}

function resolveActor(callContext?: EscalationCallContext): EscalationActor {
  return callContext?.actor ?? "operator";
}

function escalatePayload(
  action: RunEscalationAction,
  actor: EscalationActor,
  reason: string | undefined,
  childRunId: string | null,
  recoveryDecision:
    | Extract<PipelineHaltRecoveryDecision, { action: "retry" | "skip" }>
    | undefined
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    action,
    actor,
    reason: reason ?? null,
    childRunId,
  };
  if (
    actor === "daemon" &&
    recoveryDecision &&
    (action === "retry" || action === "skip")
  ) {
    payload.recoveryCode = recoveryDecision.code;
    payload.recoveryDetail = recoveryDecision.detail;
  }
  return payload;
}

function assertDaemonCallContext(
  action: RunEscalationAction,
  callContext: EscalationCallContext | undefined,
  actor: EscalationActor
): Extract<PipelineHaltRecoveryDecision, { action: "retry" | "skip" }> | undefined {
  if (actor !== "daemon") {
    return undefined;
  }
  if (action === "abort") {
    throw new Error("Daemon escalation must not request abort");
  }
  const decision = callContext?.recoveryDecision;
  if (!decision || decision.action !== action) {
    throw new Error(
      `Daemon escalation requires a matching recoveryDecision for action ${action}`
    );
  }
  return decision;
}

/**
 * Operator or daemon escalation: retry / skip / abort a halted pipeline run.
 * Claims `chain_handled_at` before creating a run or writing a stop marker.
 * Call context is runtime-only; HTTP callers omit it (operator default).
 */
export async function escalateRun(
  deps: EscalationDeps,
  runId: string,
  request: RunEscalationRequest,
  callContext?: EscalationCallContext
): Promise<EscalateResult> {
  const { store, engine, onLog } = deps;
  const action: RunEscalationAction = request.action;
  const actor = resolveActor(callContext);
  const recoveryDecision = assertDaemonCallContext(action, callContext, actor);

  const eligibility = store.getEscalationEligibility(runId, action);
  if (!eligibility.ok) {
    // Idempotent re-abort: already claimed and already marked stopped.
    if (action === "abort" && eligibility.reason === "already-chained") {
      const row = store.getRun(runId);
      if (row?.chain_stop_requested_at != null) {
        if (row.pipeline_track_id && deps.abortTrackWave) {
          await deps.abortTrackWave(
            runId,
            row.chain_stop_reason ?? abortStopReason(request.reason)
          );
        }
        store.appendEvent(
          runId,
          "run.pipeline-escalated",
          escalatePayload("abort", actor, request.reason, null, undefined)
        );
        onLog(`Escalation abort (idempotent) for run ${runId}`);
        return {
          ok: true,
          response: {
            action: "abort",
            runId,
            childRunId: null,
            stopReason: row.chain_stop_reason,
          },
        };
      }
    }
    return refusal(eligibility.reason, runId);
  }

  const { row, context, effectiveMaxDepth, successorAutomationId } =
    eligibility.eligibility;

  if (action === "retry") {
    const prompt = row.prompt?.trim() ?? "";
    if (!prompt) {
      throw new Error(`Run ${runId}: no stored prompt to retry`);
    }
  }

  if (action === "abort") {
    if (!store.claimChainHandled(runId)) {
      const after = store.getRun(runId);
      if (after?.chain_stop_requested_at != null) {
        if (after.pipeline_track_id && deps.abortTrackWave) {
          await deps.abortTrackWave(
            runId,
            after.chain_stop_reason ?? abortStopReason(request.reason)
          );
        }
        store.appendEvent(
          runId,
          "run.pipeline-escalated",
          escalatePayload("abort", actor, request.reason, null, undefined)
        );
        return {
          ok: true,
          response: {
            action: "abort",
            runId,
            childRunId: null,
            stopReason: after.chain_stop_reason,
          },
        };
      }
      return refusal("already-chained", runId);
    }

    const stopReason = abortStopReason(request.reason);
    store.markChainStopped(runId, stopReason);

    const current = store.getRun(runId);
    if (
      current &&
      (current.status === "queued" ||
        current.status === "running" ||
        current.status === "needs_input")
    ) {
      try {
        await engine.cancelRun(runId);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        onLog(`Escalation abort: cancel failed for ${runId}: ${text}`);
      }
    }

    if (row.pipeline_track_id && deps.abortTrackWave) {
      await deps.abortTrackWave(runId, stopReason);
    }

    const after = store.getRun(runId);
    store.appendEvent(
      runId,
      "run.pipeline-escalated",
      escalatePayload("abort", actor, request.reason, null, undefined)
    );
    onLog(`Escalation abort for run ${runId}: ${stopReason}`);
    return {
      ok: true,
      response: {
        action: "abort",
        runId,
        childRunId: null,
        stopReason: after?.chain_stop_reason ?? stopReason,
      },
    };
  }

  if (action === "retry") {
    const automation = store.getAutomationByIdIncludingArchived(
      row.automation_id
    );
    if (!automation) {
      throw new Error(
        `Run ${runId}: source automation ${row.automation_id} is unavailable`
      );
    }
    const { modelSelectionOverride } = resolveChildModelRole(
      true,
      context,
      automation,
      onLog
    );

    const triggerOptions = {
      parentRunId: runId,
      promptOverride: row.prompt!,
      chainContext: context,
      chainRootRunId: row.chain_root_run_id!,
      chainDepth: row.chain_depth!,
      chainMaxDepth: effectiveMaxDepth,
      pipelineWaveId: row.pipeline_wave_id,
      pipelineTrackId: row.pipeline_track_id,
      executionCwd: row.execution_cwd,
      ...(modelSelectionOverride !== undefined
        ? { modelSelectionOverride }
        : {}),
    };

    if (!store.claimChainHandled(runId)) {
      return refusal("already-chained", runId);
    }

    let childRunId: string;
    try {
      childRunId = await engine.triggerRun(
        row.automation_id,
        "escalation",
        triggerOptions
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      onLog(`Escalation retry failed for ${runId}: ${text}`);
      throw err;
    }

    store.appendEvent(
      runId,
      "run.pipeline-escalated",
      escalatePayload(
        "retry",
        actor,
        request.reason,
        childRunId,
        recoveryDecision
      )
    );
    onLog(`Escalation retry ${runId} → run ${childRunId}`);
    return {
      ok: true,
      response: {
        action: "retry",
        runId,
        childRunId,
        stopReason: null,
      },
    };
  }

  // skip
  const sourceAutomation = store.getAutomationByIdIncludingArchived(
    row.automation_id
  );
  if (!sourceAutomation?.chain_json || !successorAutomationId) {
    return refusal("no-successor", runId);
  }
  let chainNext = "";
  try {
    const chain = JSON.parse(sourceAutomation.chain_json) as {
      next?: string;
    };
    chainNext = chain.next ?? "";
  } catch {
    chainNext = "";
  }

  const target = store.getAutomation(successorAutomationId);
  if (!target) {
    store.appendEvent(runId, "run.chain-skipped", {
      reason: "unresolved",
      next: chainNext,
      depth: row.chain_depth,
      maxDepth: effectiveMaxDepth,
    });
    return refusal("no-successor", runId);
  }

  const promptBuilt = buildChainedPromptOverride(
    store,
    runId,
    row.status,
    sourceAutomation.name,
    target,
    false,
    context,
    onLog
  );

  if (!promptBuilt.ok) {
    store.appendEvent(runId, "run.chain-skipped", {
      reason: "template-error",
      next: chainNext,
      targetAutomationId: successorAutomationId,
      code: promptBuilt.code,
      detail: promptBuilt.message,
      placeholder: promptBuilt.placeholder,
      depth: row.chain_depth,
      maxDepth: effectiveMaxDepth,
    });
    onLog(
      `Escalation skip for run ${runId}: template-error (${promptBuilt.code})`
    );
    throw new Error(
      `Escalation skip template-error for run ${runId}: ${promptBuilt.message}`
    );
  }

  const workerKey =
    workerKeyFromConfigKey(sourceAutomation.config_key) ??
    sourceAutomation.config_key;
  const promptOverride =
    (promptBuilt.promptOverride ?? target.prompt) +
    skipNotice(workerKey, runId, request.reason, actor);

  const { modelSelectionOverride } = resolveChildModelRole(
    true,
    context,
    target,
    onLog
  );

  const triggerOptions = {
    parentRunId: runId,
    promptOverride,
    chainContext: context,
    chainRootRunId: row.chain_root_run_id!,
    chainDepth: row.chain_depth! + 1,
    chainMaxDepth: effectiveMaxDepth,
    pipelineWaveId: row.pipeline_wave_id,
    pipelineTrackId: row.pipeline_track_id,
    executionCwd: row.execution_cwd,
    ...(modelSelectionOverride !== undefined
      ? { modelSelectionOverride }
      : {}),
  };

  if (!store.claimChainHandled(runId)) {
    return refusal("already-chained", runId);
  }

  let childRunId: string;
  try {
    childRunId = await engine.triggerRun(
      successorAutomationId,
      "escalation",
      triggerOptions
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    onLog(`Escalation skip failed for ${runId}: ${text}`);
    throw err;
  }

  store.appendEvent(
    runId,
    "run.pipeline-escalated",
    escalatePayload("skip", actor, request.reason, childRunId, recoveryDecision)
  );
  onLog(`Escalation skip ${runId} → run ${childRunId} (${chainNext})`);
  return {
    ok: true,
    response: {
      action: "skip",
      runId,
      childRunId,
      stopReason: null,
    },
  };
}
