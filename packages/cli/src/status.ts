import type { Automation, DaemonStatus, Run, RunStatus, Workspace } from "@lca/shared";
import { DaemonError } from "./client.js";
import type { DaemonClient } from "./client.js";

export const STATUS_RUN_FETCH_LIMIT = 500;

const ALL_RUN_STATUSES: RunStatus[] = [
  "queued",
  "running",
  "needs_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

export type ParsedStatusArgs =
  | { ok: true; json: boolean }
  | { ok: false; message: string };

export function parseStatusArgs(argv: readonly string[]): ParsedStatusArgs {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    return { ok: false, message: `Unknown option "${arg}" for max status.` };
  }
  return { ok: true, json };
}

export type StatusSnapshot = {
  automations: Automation[];
  workspaces: Workspace[];
  runs: Run[];
};

export async function collectStatusSnapshot(
  client: DaemonClient
): Promise<StatusSnapshot> {
  const [automations, runs, workspaces] = await Promise.all([
    client.listAutomations(),
    client.listRuns(STATUS_RUN_FETCH_LIMIT),
    client.listWorkspaces(),
  ]);
  return { automations, workspaces, runs };
}

export type StatusJsonDocument = {
  daemon: DaemonStatus;
  counts: {
    automations: { total: number; enabled: number };
    workspaces: number;
    runsByStatus: Record<RunStatus, number>;
  };
  limits: {
    runFetchLimit: number;
  };
};

export function buildStatusJsonDocument(
  daemon: DaemonStatus,
  snapshot: StatusSnapshot
): StatusJsonDocument {
  const runsByStatus = Object.fromEntries(
    ALL_RUN_STATUSES.map((status) => [status, 0])
  ) as Record<RunStatus, number>;
  for (const run of snapshot.runs) {
    runsByStatus[run.status] += 1;
  }
  const enabled = snapshot.automations.filter((automation) => automation.enabled)
    .length;
  return {
    daemon,
    counts: {
      automations: {
        total: snapshot.automations.length,
        enabled,
      },
      workspaces: snapshot.workspaces.length,
      runsByStatus,
    },
    limits: { runFetchLimit: STATUS_RUN_FETCH_LIMIT },
  };
}

export function assertStatusArgs(argv: readonly string[]): boolean {
  const parsed = parseStatusArgs(argv);
  if (!parsed.ok) {
    throw new DaemonError(parsed.message);
  }
  return parsed.json;
}
