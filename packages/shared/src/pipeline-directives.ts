import { normalizeModelSelection, type ModelSelection } from "./model.js";
import type { PipelineModelRole } from "./types/api.js";
import { PIPELINE_MODEL_ROLES } from "./types/api.js";
import type { PipelineSnapshot } from "./pipeline-snapshot.js";

/** Durable pipeline directive kinds (b81 phase 4). */
export const PIPELINE_DIRECTIVE_KINDS = ["note", "role-override"] as const;

export type PipelineDirectiveKind = (typeof PIPELINE_DIRECTIVE_KINDS)[number];

export const PIPELINE_DIRECTIVE_KIND_SET: ReadonlySet<string> = new Set(
  PIPELINE_DIRECTIVE_KINDS
);

/** Max directives retained per pipeline root (oldest dropped at append). */
export const PIPELINE_DIRECTIVE_MAX_COUNT = 64;

/** Max UTF-8 bytes for a note directive body. */
export const PIPELINE_DIRECTIVE_NOTE_MAX_BYTES = 8 * 1024;

/** Max roles in one role-override directive. */
export const PIPELINE_DIRECTIVE_ROLE_OVERRIDE_MAX_ROLES = 8;

export type PipelineDirectiveNoteBody = {
  text: string;
};

export type PipelineDirectiveRoleOverrideBody = {
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>;
};

export type PipelineDirectiveBody =
  | PipelineDirectiveNoteBody
  | PipelineDirectiveRoleOverrideBody;

export type PipelineDirectiveRow = {
  id: string;
  rootRunId: string;
  kind: PipelineDirectiveKind;
  actorId: string | null;
  body: PipelineDirectiveBody;
  createdAt: string;
};

export type PipelineDirectiveAppendRequest =
  | { kind: "note"; text: string }
  | { kind: "role-override"; roleModels: Partial<Record<PipelineModelRole, ModelSelection>> };

export type PipelineDirectiveAppendResponse = {
  id: string;
  kind: PipelineDirectiveKind;
  rootRunId: string;
  cursor: number;
  snapshot: PipelineSnapshot;
};

export type PipelineStopAfterStepRequest = {
  reason?: string;
  actorId?: string;
};

export type PipelineStopAfterStepResponse = {
  rootRunId: string;
  frontierRunId: string;
  stopReason: string;
  cursor: number;
  snapshot: PipelineSnapshot;
};

const RESERVED_STOP_PREFIXES = ["complete:", "blocked:", "deadlock:"] as const;

/** Reject operator reasons that impersonate final-gate outcome prefixes. */
export function rejectsReservedStopReasonPrefix(reason: string): boolean {
  const trimmed = reason.trim().toLowerCase();
  return RESERVED_STOP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Build the persisted chain_stop_reason for operator stop-after-step. */
export function formatOperatorStopReason(
  actorId: string | undefined,
  reason: string | undefined
): string {
  const actor = actorId?.trim() || "operator";
  const detail = reason?.trim() || "stop after this step";
  const bounded =
    detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;
  if (rejectsReservedStopReasonPrefix(bounded)) {
    throw new Error("stop reason cannot use reserved outcome prefixes");
  }
  return `operator-stop: ${actor} ${bounded}`;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function validatePipelineDirectiveAppend(
  request: PipelineDirectiveAppendRequest
): { ok: true; body: PipelineDirectiveBody } | { ok: false; error: string } {
  if (request.kind === "note") {
    const text = request.text?.trim() ?? "";
    if (!text) {
      return { ok: false, error: "note text is required" };
    }
    if (utf8ByteLength(text) > PIPELINE_DIRECTIVE_NOTE_MAX_BYTES) {
      return {
        ok: false,
        error: `note exceeds ${PIPELINE_DIRECTIVE_NOTE_MAX_BYTES} bytes`,
      };
    }
    return { ok: true, body: { text } };
  }

  const entries = Object.entries(request.roleModels ?? {});
  if (entries.length === 0) {
    return { ok: false, error: "role-override requires at least one role" };
  }
  if (entries.length > PIPELINE_DIRECTIVE_ROLE_OVERRIDE_MAX_ROLES) {
    return {
      ok: false,
      error: `role-override allows at most ${PIPELINE_DIRECTIVE_ROLE_OVERRIDE_MAX_ROLES} roles`,
    };
  }
  const roleModels: Partial<Record<PipelineModelRole, ModelSelection>> = {};
  for (const [role, selection] of entries) {
    if (!(PIPELINE_MODEL_ROLES as readonly string[]).includes(role)) {
      return { ok: false, error: `unknown role "${role}"` };
    }
    if (selection == null || typeof selection !== "object") {
      return { ok: false, error: `invalid model selection for role "${role}"` };
    }
    if (!("id" in selection) || typeof selection.id !== "string") {
      return { ok: false, error: `invalid model selection for role "${role}"` };
    }
    try {
      roleModels[role as PipelineModelRole] = normalizeModelSelection(selection);
    } catch (err) {
      return {
        ok: false,
        error: `invalid model selection for role "${role}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
  return { ok: true, body: { roleModels } };
}
