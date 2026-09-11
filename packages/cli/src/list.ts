import type { Automation, Run } from "@lca/shared";
import { DaemonError } from "./client.js";

const LIST_RUN_DISPLAY_CAP = 15;

export function parseListArgs(
  args: string[]
): { workspaceQuery: string | undefined } {
  let workspaceQuery: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace" || arg === "-w") {
      workspaceQuery = args[++i];
      if (!workspaceQuery) {
        throw new DaemonError("--workspace requires an id|name");
      }
    } else {
      throw new DaemonError(`Unknown list option: ${arg}`);
    }
  }

  return { workspaceQuery };
}

export function selectListEntries(
  automations: Automation[],
  runs: Run[],
  workspaceId?: string
): { automations: Automation[]; runs: Run[] } {
  const filteredAutomations = workspaceId
    ? automations.filter((a) => a.workspaceId === workspaceId)
    : [...automations];
  const filteredRuns = workspaceId
    ? runs.filter((r) => r.workspaceId === workspaceId)
    : [...runs];

  return {
    automations: filteredAutomations,
    runs: filteredRuns.slice(0, LIST_RUN_DISPLAY_CAP),
  };
}
