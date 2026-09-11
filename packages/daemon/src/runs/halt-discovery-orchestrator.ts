/**
 * Durable halt-discovery advisory enqueue + terminal reconciliation
 * (b44 Phases 8–9). Converts one discovery request into at most one generated
 * advisory child, and settles source failure from a terminal advisory once.
 */

import {
  GENERATED_CONFIG_KEY_PREFIX,
  KickoffError,
  normalizeImplementFullyChainVariables,
  type GeneratedWorkerPlan,
  type GeneratedWorkerSpec,
  type PipelineHaltDiscoveryFailedPayload,
  type PipelineHaltDiscoveryFailureStage,
  type RunStatus,
} from "@lca/shared";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER,
  HALT_DISCOVERY_WORKER_KEY,
  HALT_DISCOVERY_WORKERS,
} from "../pipelines/halt-discovery.js";
import { resolveChildModelRole } from "./chain-runner.js";
import type { RunEngine, TriggerRunOptions } from "./engine.js";
import {
  assembleHaltDiscoveryFacts,
  buildHaltDiscoveryPrompt,
} from "./halt-discovery-facts.js";
import type { RunStore } from "./store.js";

const FAILURE_DETAIL_MAX_BYTES = 4096;

const HALT_DISCOVERY_CONFIG_KEY =
  GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;

export type HaltDiscoveryOrchestrateResult =
  | { kind: "enqueued"; advisoryRunId: string }
  | { kind: "existing"; advisoryRunId: string }
  | { kind: "failed"; code: string; detail: string }
  | { kind: "no-longer-actionable"; reason: string };

export type HaltDiscoveryTerminalReconcileResult =
  | {
      kind: "handled";
      stage: Extract<PipelineHaltDiscoveryFailureStage, "spawn" | "diagnosis">;
      code: string;
      detail: string;
      advisoryRunId: string;
    }
  | { kind: "noop"; reason: string };

export type HaltDiscoveryProvisionWorkers = (
  workspaceId: string,
  workers: readonly GeneratedWorkerSpec[]
) => GeneratedWorkerPlan;

export type HaltDiscoveryOrchestrateDeps = {
  store: RunStore;
  engine: RunEngine;
  provisionWorkers: HaltDiscoveryProvisionWorkers;
  onLog: (message: string) => void;
  sourceRunId: string;
};

export type HaltDiscoveryTerminalReconcileDeps = {
  store: RunStore;
  onLog: (message: string) => void;
  advisoryRunId: string;
  /** Declared terminal status from the lifecycle path. */
  status: RunStatus;
};

export function boundDetail(detail: string): string {
  if (Buffer.byteLength(detail, "utf8") <= FAILURE_DETAIL_MAX_BYTES) {
    return detail;
  }
  // Trim by code unit so a multi-byte code point is never split into a
  // replacement char, which would re-encode above the cap.
  let end = Math.min(detail.length, FAILURE_DETAIL_MAX_BYTES);
  while (
    end > 0 &&
    Buffer.byteLength(detail.slice(0, end), "utf8") > FAILURE_DETAIL_MAX_BYTES
  ) {
    end -= 1;
  }
  return detail.slice(0, end);
}

export function hasDiscoveryFailed(
  events: ReadonlyArray<{ event_type: string }>
): boolean {
  return events.some(
    (e) => e.event_type === "run.pipeline-halt-discovery-failed"
  );
}

function hasRunStarted(
  events: ReadonlyArray<{ event_type: string }>
): boolean {
  return events.some((e) => e.event_type === "run.started");
}

/**
 * Prefer newest run.error message/reason/cause; else newest non-empty
 * run.finished.result. Never returns raw unbounded payload JSON.
 */
function extractAdvisoryFailureDetail(
  events: ReadonlyArray<{ event_type: string; payload: string }>
): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event_type !== "run.error") continue;
    try {
      const parsed = JSON.parse(event.payload) as {
        message?: unknown;
        reason?: unknown;
        cause?: unknown;
      };
      if (typeof parsed.message === "string" && parsed.message.trim()) {
        return parsed.message.trim();
      }
      if (typeof parsed.reason === "string" && parsed.reason.trim()) {
        return parsed.reason.trim();
      }
      if (typeof parsed.cause === "string" && parsed.cause.trim()) {
        return parsed.cause.trim();
      }
    } catch {
      /* ignore malformed */
    }
  }

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.event_type !== "run.finished") continue;
    try {
      const parsed = JSON.parse(event.payload) as { result?: unknown };
      if (typeof parsed.result === "string" && parsed.result.trim()) {
        return parsed.result.trim();
      }
    } catch {
      /* ignore malformed */
    }
  }

  return null;
}

function reasonCodeForTerminalStatus(
  status: "failed" | "cancelled"
): string {
  return status === "cancelled" ? "advisory-cancelled" : "advisory-failed";
}

function recordSpawnFailure(
  store: RunStore,
  onLog: (message: string) => void,
  sourceRunId: string,
  code: string,
  detail: string,
  advisoryRunId?: string
): HaltDiscoveryOrchestrateResult {
  const bounded = boundDetail(detail);
  const payload: PipelineHaltDiscoveryFailedPayload = {
    stage: "spawn",
    code,
    detail: bounded,
  };
  if (advisoryRunId !== undefined) {
    payload.advisoryRunId = advisoryRunId;
  }
  try {
    store.appendEvent(
      sourceRunId,
      "run.pipeline-halt-discovery-failed",
      payload
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    onLog(
      `Pipeline halt discovery failed-event append error for run ${sourceRunId}: ${text}`
    );
    throw err;
  }
  onLog(
    `Pipeline halt discovery spawn failed for run ${sourceRunId}: ${code}`
  );
  return { kind: "failed", code, detail: bounded };
}

/**
 * Convert a durable failed/cancelled advisory into one source discovery-failed
 * event. Idempotent; never mutates either run's status or claims the source.
 */
export function reconcileHaltDiscoveryAdvisoryTerminal(
  deps: HaltDiscoveryTerminalReconcileDeps
): HaltDiscoveryTerminalReconcileResult {
  const { store, onLog, advisoryRunId, status: declaredStatus } = deps;

  if (declaredStatus !== "failed" && declaredStatus !== "cancelled") {
    return { kind: "noop", reason: "non-terminal-status" };
  }

  const advisory = store.getRun(advisoryRunId);
  if (!advisory) {
    return { kind: "noop", reason: "advisory-not-found" };
  }

  if (advisory.trigger_kind !== HALT_DISCOVERY_TRIGGER_KIND) {
    return { kind: "noop", reason: "wrong-trigger-kind" };
  }

  const parentRunId = advisory.parent_run_id;
  if (parentRunId == null || parentRunId === "") {
    return { kind: "noop", reason: "missing-source-parent" };
  }

  const source = store.getRun(parentRunId);
  if (!source) {
    return { kind: "noop", reason: "source-not-found" };
  }

  const automation = store.getAutomationByIdIncludingArchived(
    advisory.automation_id
  );
  if (!automation || automation.config_key !== HALT_DISCOVERY_CONFIG_KEY) {
    return { kind: "noop", reason: "wrong-worker-identity" };
  }

  if (advisory.status !== "failed" && advisory.status !== "cancelled") {
    return { kind: "noop", reason: "non-terminal-status" };
  }

  // Persisted row is authoritative for staging and reason-code selection.
  const terminalStatus = advisory.status;

  const sourceEvents = store.listRunEvents(parentRunId);
  if (hasDiscoveryFailed(sourceEvents)) {
    return { kind: "noop", reason: "already-failed" };
  }

  const childEvents = store.listRunEvents(advisoryRunId);
  const stage: Extract<
    PipelineHaltDiscoveryFailureStage,
    "spawn" | "diagnosis"
  > = hasRunStarted(childEvents) ? "diagnosis" : "spawn";
  const code = reasonCodeForTerminalStatus(terminalStatus);
  const evidence = extractAdvisoryFailureDetail(childEvents);
  const detail = boundDetail(
    evidence ??
      (terminalStatus === "cancelled"
        ? "Advisory run cancelled without run.error/run.finished evidence"
        : "Advisory run failed without run.error/run.finished evidence")
  );

  const payload: PipelineHaltDiscoveryFailedPayload = {
    stage,
    code,
    detail,
    advisoryRunId,
  };

  try {
    store.appendEvent(
      parentRunId,
      "run.pipeline-halt-discovery-failed",
      payload
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    onLog(
      `Pipeline halt discovery failed-event append error for run ${parentRunId}: ${text}`
    );
    throw err;
  }

  onLog(
    `Pipeline halt discovery ${stage} failed for run ${parentRunId} via advisory ${advisoryRunId}: ${code}`
  );

  return {
    kind: "handled",
    stage,
    code,
    detail,
    advisoryRunId,
  };
}

/**
 * Best-effort: revalidate one requested halt, provision the diagnosis worker,
 * and enqueue at most one same-depth advisory child. Never claims the source.
 */
export async function orchestrateHaltDiscoveryAdvisory(
  deps: HaltDiscoveryOrchestrateDeps
): Promise<HaltDiscoveryOrchestrateResult> {
  const { store, engine, provisionWorkers, onLog, sourceRunId } = deps;

  const existing = store.findHaltDiscoveryAdvisoryChild(sourceRunId);
  if (existing) {
    return { kind: "existing", advisoryRunId: existing.id };
  }

  const source = store.getRun(sourceRunId);
  if (!source) {
    return { kind: "no-longer-actionable", reason: "not-found" };
  }

  const events = store.listRunEvents(sourceRunId);
  if (hasDiscoveryFailed(events)) {
    return { kind: "no-longer-actionable", reason: "already-failed" };
  }

  const assembled = assembleHaltDiscoveryFacts(store, sourceRunId);
  if (!assembled.ok) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      assembled.code,
      assembled.detail
    );
  }

  const parsedContext = store.parseChainContext(source);
  if (parsedContext?.ok !== true) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "context-invalid",
      "Source chain context is missing or invalid"
    );
  }

  let chainContext;
  try {
    chainContext = {
      ...parsedContext.context,
      variables: normalizeImplementFullyChainVariables(
        parsedContext.context.variables
      ),
    };
  } catch (err) {
    const detail =
      err instanceof KickoffError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "context-invalid",
      detail
    );
  }

  let plan: GeneratedWorkerPlan;
  try {
    plan = provisionWorkers(source.workspace_id, HALT_DISCOVERY_WORKERS);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "provision-not-applied",
      detail
    );
  }

  if (plan.items.some((item) => item.action === "conflict")) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "provision-conflict",
      "Generated halt-discovery worker conflicts with an existing automation"
    );
  }
  if (!plan.applied) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "provision-not-applied",
      "Generated halt-discovery worker provisioning was not applied"
    );
  }

  const planItem = plan.items.find(
    (item) => item.key === HALT_DISCOVERY_WORKER_KEY
  );
  const targetId = planItem?.automationId;
  if (!targetId) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "missing-target",
      "Halt-discovery worker automation id missing from provision plan"
    );
  }

  const target = store.getAutomation(targetId);
  if (!target) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "missing-target",
      "Halt-discovery worker automation not found after provisioning"
    );
  }

  const promptBuilt = buildHaltDiscoveryPrompt(
    HALT_DISCOVERY_WORKER.prompt,
    assembled.facts
  );
  if (!promptBuilt.ok) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      promptBuilt.code,
      promptBuilt.detail
    );
  }

  const { modelSelectionOverride } = resolveChildModelRole(
    true,
    chainContext,
    target,
    onLog
  );

  const depth = source.chain_depth;
  const effectiveMaxDepth =
    source.chain_max_depth_override ?? source.chain_max_depth;
  const chainRootRunId = source.chain_root_run_id;
  if (
    depth == null ||
    effectiveMaxDepth == null ||
    chainRootRunId == null
  ) {
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "ineligible-source",
      "Source is missing pipeline depth or root association"
    );
  }

  const triggerOptions: TriggerRunOptions = {
    parentRunId: source.id,
    promptOverride: promptBuilt.prompt,
    chainContext,
    chainRootRunId,
    chainDepth: depth,
    chainMaxDepth: effectiveMaxDepth,
    pipelineWaveId: null,
    pipelineTrackId: null,
    executionCwd: null,
  };
  if (modelSelectionOverride !== undefined) {
    triggerOptions.modelSelectionOverride = modelSelectionOverride;
  }

  let advisoryRunId: string;
  try {
    advisoryRunId = await engine.triggerRun(
      targetId,
      HALT_DISCOVERY_TRIGGER_KIND,
      triggerOptions
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return recordSpawnFailure(
      store,
      onLog,
      sourceRunId,
      "enqueue-failed",
      detail
    );
  }

  onLog(
    `Pipeline halt discovery advisory enqueued for run ${sourceRunId}: ${advisoryRunId}`
  );
  return { kind: "enqueued", advisoryRunId };
}
