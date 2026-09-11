/**
 * Halt-discovery briefing answer → operator-attributed source escalation (b44.12).
 * Identity-gated; never grants the diagnosis agent escalate authority.
 */

import {
  GENERATED_CONFIG_KEY_PREFIX,
  HALT_DISCOVERY_INPUT_KIND,
  RUN_ESCALATION_ACTIONS,
  type PipelineHaltDiscoveryActionResultPayload,
  type RunEscalationAction,
} from "@lca/shared";
import type { InputHub } from "../input/hub.js";
import { parseInputMetadataJson } from "../input/store.js";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
} from "../pipelines/halt-discovery.js";
import { boundDetail } from "./halt-discovery-orchestrator.js";
import type { RunStore } from "./store.js";

const HALT_DISCOVERY_CONFIG_KEY =
  GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;

const ESCALATION_ACTION_SET = new Set<string>(RUN_ESCALATION_ACTIONS);

export type HaltDiscoveryBriefingAuthority =
  | {
      ok: true;
      sourceRunId: string;
      advisoryRunId: string;
    }
  | { ok: false; reason: string };

/**
 * Authoritative generated halt-discovery child with a pending briefing card.
 * Used at daemon restart to leave parked cards alone (no agent re-attach).
 */
export function isParkedAuthoritativeHaltDiscoveryBriefing(
  store: RunStore,
  inputHub: InputHub,
  runId: string
): boolean {
  const authority = resolveHaltDiscoveryBriefingAuthority(store, runId);
  if (!authority.ok) {
    return false;
  }
  const pending = inputHub.getPendingQuestion(runId);
  if (!pending) {
    return false;
  }
  const meta = parseInputMetadataJson(pending.metadata_json);
  return meta?.kind === HALT_DISCOVERY_INPUT_KIND;
}

export function resolveHaltDiscoveryBriefingAuthority(
  store: RunStore,
  advisoryRunId: string
): HaltDiscoveryBriefingAuthority {
  const advisory = store.getRun(advisoryRunId);
  if (!advisory) {
    return { ok: false, reason: "advisory-not-found" };
  }
  if (advisory.trigger_kind !== HALT_DISCOVERY_TRIGGER_KIND) {
    return { ok: false, reason: "wrong-trigger-kind" };
  }
  const parentRunId = advisory.parent_run_id;
  if (parentRunId == null || parentRunId === "") {
    return { ok: false, reason: "missing-source-parent" };
  }
  const automation = store.getAutomationByIdIncludingArchived(
    advisory.automation_id
  );
  if (!automation || automation.config_key !== HALT_DISCOVERY_CONFIG_KEY) {
    return { ok: false, reason: "wrong-worker-identity" };
  }
  const authoritative = store.findHaltDiscoveryAdvisoryChild(parentRunId);
  if (authoritative?.id !== advisory.id) {
    return { ok: false, reason: "superseded-duplicate" };
  }
  return {
    ok: true,
    sourceRunId: parentRunId,
    advisoryRunId: advisory.id,
  };
}

/**
 * True when the pending request is a halt-discovery briefing that may take the
 * special answer path (still requires authority before escalating).
 */
export function pendingIsHaltDiscoveryBriefing(
  inputHub: InputHub,
  runId: string
): boolean {
  const pending = inputHub.getPendingQuestion(runId);
  if (!pending) {
    return false;
  }
  const meta = parseInputMetadataJson(pending.metadata_json);
  return meta?.kind === HALT_DISCOVERY_INPUT_KIND;
}

export function parseEscalationActionAnswer(
  answer: string
): RunEscalationAction | null {
  if (!ESCALATION_ACTION_SET.has(answer)) {
    return null;
  }
  return answer as RunEscalationAction;
}

export function buildActionResultPayload(
  input: PipelineHaltDiscoveryActionResultPayload
): PipelineHaltDiscoveryActionResultPayload {
  const payload: PipelineHaltDiscoveryActionResultPayload = {
    sourceRunId: input.sourceRunId,
    advisoryRunId: input.advisoryRunId,
    action: input.action,
    outcome: input.outcome,
  };
  if (input.code != null && input.code !== "") {
    payload.code = input.code;
  }
  if (input.childRunId != null && input.childRunId !== "") {
    payload.childRunId = input.childRunId;
  }
  if (input.detail != null && input.detail !== "") {
    payload.detail = boundDetail(input.detail);
  }
  return payload;
}

export function operatorBriefingReason(action: RunEscalationAction): string {
  return `Halt discovery briefing approved (${action})`;
}
