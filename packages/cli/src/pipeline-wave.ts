import type {
  PipelineWaveOperatorAction,
  PipelineWaveOperatorResponse,
} from "@lca/shared";
import { DaemonError } from "./client.js";

const WAVE_USAGE =
  "Usage: lca wave <waveId> retry|abort [--reason <text>]";

const WAVE_CLI_ACTIONS = ["retry", "abort"] as const;

function toWaveOperatorAction(
  actionRaw: string
): PipelineWaveOperatorAction | null {
  if (actionRaw === "retry" || actionRaw === "retry-integration") {
    return "retry-integration";
  }
  if (actionRaw === "abort") {
    return "abort";
  }
  return null;
}

export function parseWaveArgs(args: string[]): {
  waveId: string;
  action: PipelineWaveOperatorAction;
  reason?: string;
} {
  const positional: string[] = [];
  let reason: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--reason") {
      const value = args[++i];
      if (!value || value.startsWith("-")) {
        throw new DaemonError(WAVE_USAGE);
      }
      reason = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new DaemonError(`Unknown flag "${arg}". ${WAVE_USAGE}`);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new DaemonError(WAVE_USAGE);
  }
  const [waveId, actionRaw] = positional;
  const action = toWaveOperatorAction(actionRaw!);
  if (!action) {
    throw new DaemonError(
      `Invalid action "${actionRaw}". Valid: ${WAVE_CLI_ACTIONS.join(", ")}`
    );
  }
  return {
    waveId: waveId!,
    action,
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function formatWaveOperatorResponse(
  response: PipelineWaveOperatorResponse
): string {
  const shortId = response.waveId.slice(0, 8);
  if (response.action === "retry-integration") {
    const integration = response.integrationRunId?.slice(0, 8);
    return integration
      ? `Wave ${shortId}: retry accepted → integration run ${integration} (status ${response.status})`
      : `Wave ${shortId}: retry accepted (status ${response.status})`;
  }

  const lines = [`Wave ${shortId}: aborted (status ${response.status})`];
  if (response.retained && response.retained.length > 0) {
    lines.push("Retained resources:");
    for (const item of response.retained) {
      lines.push(
        `  - branch ${item.branch} @ ${item.worktreePath} (${item.reason})`
      );
    }
  }
  return lines.join("\n");
}
