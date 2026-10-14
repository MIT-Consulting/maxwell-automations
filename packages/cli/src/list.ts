import type { Automation, Run, Workspace } from "@lca/shared";
import { DaemonError } from "./client.js";

export const LIST_RUN_FETCH_LIMIT = 50;
export const LIST_RUN_DISPLAY_CAP = 15;

export function parseListArgs(
  args: string[]
): { workspaceQuery: string | undefined; json: boolean } {
  let workspaceQuery: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--workspace" || arg === "-w") {
      workspaceQuery = args[++i];
      if (!workspaceQuery) {
        throw new DaemonError("--workspace requires an id|name");
      }
    } else {
      throw new DaemonError(`Unknown list option: ${arg}`);
    }
  }

  return { workspaceQuery, json };
}

export type ListJsonDocument = {
  workspace: { id: string; name: string } | null;
  automations: Automation[];
  runs: Run[];
  limits: {
    runFetchLimit: number;
    runDisplayCap: number;
  };
};

export function buildListJsonDocument(
  automations: Automation[],
  runs: Run[],
  workspace: Workspace | undefined
): ListJsonDocument {
  return {
    workspace: workspace
      ? { id: workspace.id, name: workspace.name ?? workspace.path }
      : null,
    automations,
    runs,
    limits: {
      runFetchLimit: LIST_RUN_FETCH_LIMIT,
      runDisplayCap: LIST_RUN_DISPLAY_CAP,
    },
  };
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
