import type { RunStatus } from "@lca/shared";

export const SLOT_WAITING_LABEL = "Waiting for slot";

export function runCardStatusLabel(status: RunStatus): string {
  if (status === "queued") {
    return SLOT_WAITING_LABEL;
  }
  if (status === "paused") {
    return "Paused";
  }
  return status;
}
