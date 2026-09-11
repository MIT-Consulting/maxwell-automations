/**
 * Atomic halt-discovery advisory → workspace chat promotion (b44.5).
 * Settles the pending briefing card without answering or escalating the source.
 */

import {
  HALT_DISCOVERY_INPUT_KIND,
  INPUT_QUESTION_MAX_LENGTH,
  type ModelSelection,
  type PipelineHaltDiscoveryPromotedPayload,
} from "@lca/shared";
import type { LcaDatabase } from "../db/index.js";
import type { ChatEngine } from "../chats/engine.js";
import type { ChatSessionRow } from "../chats/store.js";
import type { InputHub } from "../input/hub.js";
import { parseInputMetadataJson } from "../input/store.js";
import { assertTransition } from "./state-machine.js";
import {
  resolveHaltDiscoveryBriefingAuthority,
} from "./halt-discovery-operator-bridge.js";
import type { RunRow } from "./store.js";
import type { RunStore } from "./store.js";

export type HaltDiscoveryPromotionResult =
  | { kind: "created"; chat: ChatSessionRow }
  | { kind: "existing"; chat: ChatSessionRow };

export class HaltDiscoveryPromotionError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "not_resumable"
      | "context_missing"
      | "busy"
      | "not_found",
    message: string
  ) {
    super(message);
    this.name = "HaltDiscoveryPromotionError";
  }
}

export type HaltDiscoveryPromotionDeps = {
  db: LcaDatabase;
  store: RunStore;
  inputHub: InputHub;
  chatEngine: ChatEngine;
  advisoryRunId: string;
  model: ModelSelection;
  /** Validate local agent/session ids; throw HaltDiscoveryPromotionError. */
  assertResumable: (row: RunRow) => RunRow & {
    agent_id: string;
    sdk_run_id: string;
  };
  /** Test seam: throw inside the open transaction to prove rollback. */
  afterClaimHook?: () => void;
};

/** Bound briefing seed including halted source id (input question char limit). */
export function buildHaltDiscoveryPromotionSeed(
  sourceRunId: string,
  question: string
): string {
  const header =
    `Continue diagnosis in chat.\n\nHalted source run: ${sourceRunId}\n\n`;
  const budget = Math.max(0, INPUT_QUESTION_MAX_LENGTH - header.length);
  const body =
    question.length <= budget ? question : question.slice(0, budget);
  return header + body;
}

/**
 * Promote an authoritative halt-discovery advisory into one origin-linked chat.
 * Returns null when the run is not a halt-discovery advisory (caller should use
 * generic b28 promotion). Throws HaltDiscoveryPromotionError for ineligible
 * advisories and first-claim conflicts.
 */
export function promoteHaltDiscoveryAdvisory(
  deps: HaltDiscoveryPromotionDeps
): HaltDiscoveryPromotionResult | null {
  const authority = resolveHaltDiscoveryBriefingAuthority(
    deps.store,
    deps.advisoryRunId
  );
  if (!authority.ok) {
    return null;
  }

  const chatStore = deps.chatEngine.getChatStore();
  const existing = chatStore.findActiveByOriginRunId(authority.advisoryRunId);
  if (existing) {
    return { kind: "existing", chat: existing };
  }

  const advisory = deps.store.getRun(authority.advisoryRunId);
  if (!advisory) {
    throw new HaltDiscoveryPromotionError(
      "not_found",
      `Run not found: ${authority.advisoryRunId}`
    );
  }
  if (advisory.status !== "needs_input") {
    throw new HaltDiscoveryPromotionError(
      "busy",
      `Run ${authority.advisoryRunId} cannot be promoted while status is ${advisory.status}`
    );
  }

  const pending = deps.inputHub.getPendingQuestion(authority.advisoryRunId);
  if (!pending) {
    throw new HaltDiscoveryPromotionError(
      "conflict",
      `No pending halt-discovery briefing for run ${authority.advisoryRunId}`
    );
  }
  const meta = parseInputMetadataJson(pending.metadata_json);
  if (meta?.kind !== HALT_DISCOVERY_INPUT_KIND) {
    throw new HaltDiscoveryPromotionError(
      "conflict",
      `Run ${authority.advisoryRunId}: pending input is not a halt-discovery briefing`
    );
  }

  const resumable = deps.assertResumable(advisory);
  const events = deps.store.listRunEvents(authority.advisoryRunId);
  const seed = buildHaltDiscoveryPromotionSeed(
    authority.sourceRunId,
    pending.question
  );

  return deps.db.transaction((): HaltDiscoveryPromotionResult => {
    const raced = chatStore.findActiveByOriginRunId(authority.advisoryRunId);
    if (raced) {
      return { kind: "existing", chat: raced };
    }

    const won = deps.inputHub.cancelPendingById(pending.id);
    if (!won) {
      throw new HaltDiscoveryPromotionError(
        "conflict",
        `Halt-discovery briefing for run ${authority.advisoryRunId} was already settled`
      );
    }

    deps.afterClaimHook?.();

    const chat = deps.chatEngine.promoteFromRun({
      runId: authority.advisoryRunId,
      workspaceId: resumable.workspace_id,
      agentId: resumable.agent_id,
      sdkRunId: resumable.sdk_run_id,
      model: deps.model,
      events,
      sourceRunId: authority.sourceRunId,
      seedMessage: seed,
    });

    const promotedPayload: PipelineHaltDiscoveryPromotedPayload = {
      sourceRunId: authority.sourceRunId,
      advisoryRunId: authority.advisoryRunId,
      chatId: chat.id,
    };
    deps.store.appendEvent(
      authority.advisoryRunId,
      "run.pipeline-halt-discovery-promoted",
      promotedPayload
    );

    const after = deps.store.getRun(authority.advisoryRunId);
    if (after?.status === "needs_input") {
      assertTransition("needs_input", "completed");
      deps.store.setStatus(authority.advisoryRunId, "completed");
    }

    return { kind: "created", chat };
  })();
}
