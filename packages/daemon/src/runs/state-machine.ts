import type { RunStatus } from "@lca/shared";

const ALLOWED: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["needs_input", "completed", "failed", "cancelled", "queued", "paused"],
  needs_input: ["running", "completed", "failed", "cancelled", "queued"],
  paused: ["running", "cancelled", "failed"],
  completed: ["running"],
  failed: ["running"],
  cancelled: ["running"],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid run transition: ${from} → ${to}`);
  }
}
