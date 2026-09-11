/**
 * Completed halt-discovery advisory → durable Input Hub briefing card (b44.11).
 * Presents once, reopens the advisory card host, never escalates the source.
 */

import {
  HALT_DISCOVERY_INPUT_KIND,
  RUN_ESCALATION_ACTIONS,
  type PipelineHaltDiscoveryFailedPayload,
} from "@lca/shared";
import { GENERATED_CONFIG_KEY_PREFIX } from "../config/generated-workers.js";
import type { InputHub, PresentWithoutWaitResult } from "../input/hub.js";
import type { InputRequestRow } from "../input/store.js";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
} from "../pipelines/halt-discovery.js";
import { readFinishedResultText } from "./chain-runner.js";
import {
  buildHaltDiscoveryBriefing,
  extractHaltDiscoveryBriefing,
  type EscalationEligibility,
} from "./halt-discovery-briefing.js";
// Shared 4 KiB-safe detail cap and single-failure guard with the spawn/
// diagnosis stages, so every discovery stage bounds and dedupes identically.
import {
  boundDetail,
  hasDiscoveryFailed,
} from "./halt-discovery-orchestrator.js";
import type { RunStore } from "./store.js";

const HALT_DISCOVERY_CONFIG_KEY =
  GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;

export type HaltDiscoveryPresentationResult =
  | {
      kind: "presented";
      advisoryRunId: string;
      requestId: string;
      reopened: boolean;
    }
  | {
      kind: "repaired";
      advisoryRunId: string;
      requestId: string;
      reopened: boolean;
    }
  | { kind: "noop"; reason: string }
  | { kind: "failed"; code: string; detail: string; advisoryRunId: string };

export type HaltDiscoveryPresentationDeps = {
  store: RunStore;
  inputHub: InputHub;
  onLog: (message: string) => void;
  advisoryRunId: string;
};

function findLatestHaltDiscoveryRequest(
  inputHub: InputHub,
  runId: string
): InputRequestRow | undefined {
  const rows = inputHub.listForRun(runId);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (!row.metadata_json) continue;
    try {
      const meta = JSON.parse(row.metadata_json) as { kind?: unknown };
      if (meta.kind === HALT_DISCOVERY_INPUT_KIND) {
        return row;
      }
    } catch {
      /* ignore malformed metadata */
    }
  }
  return undefined;
}

function sourceEligibility(
  store: RunStore,
  sourceRunId: string
): EscalationEligibility {
  const eligibility: EscalationEligibility = {
    retry: false,
    skip: false,
    abort: false,
  };
  for (const action of RUN_ESCALATION_ACTIONS) {
    eligibility[action] = store.getEscalationEligibility(
      sourceRunId,
      action
    ).ok;
  }
  return eligibility;
}

function recordBriefingFailure(
  store: RunStore,
  onLog: (message: string) => void,
  sourceRunId: string,
  advisoryRunId: string,
  code: string,
  detail: string
): HaltDiscoveryPresentationResult {
  const sourceEvents = store.listRunEvents(sourceRunId);
  if (hasDiscoveryFailed(sourceEvents)) {
    return {
      kind: "failed",
      code,
      detail: boundDetail(detail),
      advisoryRunId,
    };
  }

  const bounded = boundDetail(detail);
  const payload: PipelineHaltDiscoveryFailedPayload = {
    stage: "briefing",
    code,
    detail: bounded,
    advisoryRunId,
  };
  try {
    store.appendEvent(
      sourceRunId,
      "run.pipeline-halt-discovery-failed",
      payload
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    onLog(
      `Pipeline halt discovery briefing-failed append error for run ${sourceRunId}: ${text}`
    );
    throw err;
  }
  onLog(
    `Pipeline halt discovery briefing failed for run ${sourceRunId} via advisory ${advisoryRunId}: ${code}`
  );
  return { kind: "failed", code, detail: bounded, advisoryRunId };
}

/**
 * Turn one authoritative completed advisory into a durable no-timeout card and
 * reopen the advisory to `needs_input`. Idempotent; never mutates the source.
 */
export function presentCompletedHaltDiscoveryAdvisory(
  deps: HaltDiscoveryPresentationDeps
): HaltDiscoveryPresentationResult {
  const { store, inputHub, onLog, advisoryRunId } = deps;

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

  const automation = store.getAutomationByIdIncludingArchived(
    advisory.automation_id
  );
  if (!automation || automation.config_key !== HALT_DISCOVERY_CONFIG_KEY) {
    return { kind: "noop", reason: "wrong-worker-identity" };
  }

  const authoritative = store.findHaltDiscoveryAdvisoryChild(parentRunId);
  if (authoritative?.id !== advisory.id) {
    return { kind: "noop", reason: "superseded-duplicate" };
  }

  if (advisory.status !== "completed") {
    return { kind: "noop", reason: "not-completed" };
  }

  const source = store.getRun(parentRunId);
  if (!source) {
    onLog(
      `Pipeline halt discovery briefing skipped: source missing for advisory ${advisoryRunId}`
    );
    return { kind: "noop", reason: "source-not-found" };
  }

  const existing = findLatestHaltDiscoveryRequest(inputHub, advisoryRunId);
  if (existing) {
    if (existing.status === "pending") {
      const reopened =
        store.reopenCompletedHaltDiscoveryAdvisoryForInput(advisoryRunId);
      return {
        kind: "repaired",
        advisoryRunId,
        requestId: existing.id,
        reopened,
      };
    }
    return { kind: "noop", reason: `history-${existing.status}` };
  }

  const resultText = readFinishedResultText(store, advisoryRunId);
  if (resultText == null || resultText.trim() === "") {
    return recordBriefingFailure(
      store,
      onLog,
      parentRunId,
      advisoryRunId,
      "missing-result",
      "Advisory completed without run.finished.result text"
    );
  }

  const extracted = extractHaltDiscoveryBriefing(resultText);
  if (!extracted.ok) {
    return recordBriefingFailure(
      store,
      onLog,
      parentRunId,
      advisoryRunId,
      extracted.code,
      extracted.detail
    );
  }

  const eligibility = sourceEligibility(store, parentRunId);
  const built = buildHaltDiscoveryBriefing(extracted.packet, eligibility);
  if (!built.ok) {
    return recordBriefingFailure(
      store,
      onLog,
      parentRunId,
      advisoryRunId,
      built.code,
      built.detail
    );
  }

  let presentResult: PresentWithoutWaitResult;
  try {
    presentResult = inputHub.presentWithoutWait(
      advisoryRunId,
      built.card.question,
      built.card.metadata
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return recordBriefingFailure(
      store,
      onLog,
      parentRunId,
      advisoryRunId,
      "presentation-conflict",
      text
    );
  }

  if (presentResult.status === "existing") {
    if (presentResult.request.status === "pending") {
      const reopened =
        store.reopenCompletedHaltDiscoveryAdvisoryForInput(advisoryRunId);
      return {
        kind: "repaired",
        advisoryRunId,
        requestId: presentResult.request.id,
        reopened,
      };
    }
    return {
      kind: "noop",
      reason: `history-${presentResult.request.status}`,
    };
  }

  const reopened =
    store.reopenCompletedHaltDiscoveryAdvisoryForInput(advisoryRunId);
  if (!reopened) {
    return recordBriefingFailure(
      store,
      onLog,
      parentRunId,
      advisoryRunId,
      "reopen-failed",
      "Pending briefing card exists but advisory could not reopen to needs_input"
    );
  }

  onLog(
    `Pipeline halt discovery briefing presented for advisory ${advisoryRunId} (source ${parentRunId})`
  );

  return {
    kind: "presented",
    advisoryRunId,
    requestId: presentResult.request.id,
    reopened: true,
  };
}
