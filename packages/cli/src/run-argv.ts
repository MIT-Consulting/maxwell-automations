import { DaemonError } from "./client.js";

/** Kickoff-shaped flags that belong on `implement-fully`, not `run`. */
export const RUN_KICKOFF_LOOKING_FLAGS = [
  "--feature",
  "--idea",
  "--workspace",
  "--role",
  "--role-profile",
  "--profile",
  "--research-approval",
  "--dry-run",
  "--force",
  "--prune",
  "--execute",
] as const;

function isKickoffLookingFlag(token: string): boolean {
  return RUN_KICKOFF_LOOKING_FLAGS.some(
    (flag) => token === flag || token.startsWith(`${flag}=`)
  );
}

/** Refuse trailing argv on `lca run` / `max run` (automation query must be sole arg). */
export function assertNoExtraRunArgs(rest: string[]): void {
  if (rest.length <= 1) return;

  const extras = rest.slice(1);
  if (extras.some(isKickoffLookingFlag)) {
    throw new DaemonError(
      "Pipeline workers are started with implement-fully, not run. " +
        "Use: max implement-fully ... or lca implement-fully ..."
    );
  }

  throw new DaemonError("Usage: lca run <id|name>");
}
