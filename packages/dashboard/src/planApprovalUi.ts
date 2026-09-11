import type { InputRequest } from "@lca/shared";
import { PLAN_APPROVAL_INPUT_KIND } from "@lca/shared";

const GUIDED_PLAN_APPROVAL_CHOICE_IDS = ["approve", "revise", "abort"] as const;

/** True when the request matches Guided plan-approval gate shape (kind + triad). */
export function isPlanApprovalShapedRequest(request: InputRequest): boolean {
  const meta = request.metadata;
  if (!meta || meta.kind !== PLAN_APPROVAL_INPUT_KIND) {
    return false;
  }
  const choices = meta.choices;
  if (!choices || choices.length === 0) {
    return false;
  }
  const ids = new Set(choices.map((c) => c.id));
  return GUIDED_PLAN_APPROVAL_CHOICE_IDS.every((id) => ids.has(id));
}
