import {
  classifyPipelineOutcome,
  formatOperatorStopReason,
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  resolvePipelineStopFrontier,
  validatePipelineDirectiveAppend,
  withActorIdPayload,
  type PipelineDirectiveAppendRequest,
  type PipelineSnapshot,
} from "@lca/shared";
import type { DashboardStore } from "../http/dashboard-store.js";
import { formatModelPreflightFailures } from "../models/preflight.js";
import type { RunEngine } from "./engine.js";
import { hydratePipelineSnapshot } from "./pipeline-projection.js";
import type { RunRow, RunStore } from "./store.js";

export type PipelineSteeringRefusal =
  | "not-found"
  | "invalid-root"
  | "terminal"
  | "no-frontier"
  | "ambiguous-frontier"
  | "wave-track"
  | "already-stopped";

const REFUSAL_STATUS: Record<PipelineSteeringRefusal, number> = {
  "not-found": 404,
  "invalid-root": 400,
  terminal: 409,
  "no-frontier": 409,
  "ambiguous-frontier": 409,
  "wave-track": 409,
  "already-stopped": 409,
};

export function pipelineSteeringHttpStatus(
  reason: PipelineSteeringRefusal
): number {
  return REFUSAL_STATUS[reason];
}

function lineageStopCandidates(store: RunStore, rootRunId: string) {
  return store.listChainLineageRunRows(rootRunId).map((row) => ({
    id: row.id,
    status: row.status,
    parentRunId: row.parent_run_id,
    chainRootRunId: row.chain_root_run_id,
  }));
}

function isPipelineTerminal(
  store: RunStore,
  dashboardStore: DashboardStore,
  rootRunId: string
): boolean {
  const snapshot = hydratePipelineSnapshot(
    store,
    dashboardStore,
    rootRunId,
    Date.now()
  );
  if (!snapshot) {
    return true;
  }
  return snapshot.outcome !== "running";
}

function resolveStopFrontier(
  store: RunStore,
  rootRunId: string
):
  | { ok: true; frontierRunId: string; frontierRow: RunRow }
  | { ok: false; reason: PipelineSteeringRefusal; message: string } {
  const candidates = lineageStopCandidates(store, rootRunId);
  const resolution = resolvePipelineStopFrontier({
    rootRunId,
    candidates,
  });
  if (resolution.kind === "none") {
    return {
      ok: false,
      reason: "no-frontier",
      message: resolution.reason,
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      ok: false,
      reason: "ambiguous-frontier",
      message: `${resolution.reason} (${resolution.runIds.join(", ")})`,
    };
  }

  const frontierRow = store.getRun(resolution.runId);
  if (!frontierRow) {
    return {
      ok: false,
      reason: "no-frontier",
      message: "Frontier run not found",
    };
  }

  if (frontierRow.pipeline_track_id != null) {
    const waveId = frontierRow.pipeline_wave_id ?? "unknown";
    return {
      ok: false,
      reason: "wave-track",
      message: `Stop-after-step is not supported on wave tracks; use: lca wave ${waveId} retry|abort`,
    };
  }

  if (frontierRow.chain_stop_requested_at != null) {
    return {
      ok: false,
      reason: "already-stopped",
      message: "Pipeline frontier already has a stop marker",
    };
  }

  return {
    ok: true,
    frontierRunId: frontierRow.id,
    frontierRow,
  };
}

export async function appendPipelineDirectiveForRoot(args: {
  store: RunStore;
  dashboardStore: DashboardStore;
  engine: RunEngine;
  rootRunId: string;
  request: PipelineDirectiveAppendRequest;
  actorId?: string;
}): Promise<
  | {
      ok: true;
      id: string;
      kind: PipelineDirectiveAppendRequest["kind"];
      rootRunId: string;
      snapshot: PipelineSnapshot;
      cursor: number;
    }
  | { ok: false; reason: PipelineSteeringRefusal | "validation"; message: string }
> {
  const root = args.store.getRun(args.rootRunId);
  if (!root) {
    return { ok: false, reason: "not-found", message: "pipeline run not found" };
  }
  if (!args.store.isImplementFullyRootRun(root)) {
    return {
      ok: false,
      reason: "invalid-root",
      message: "Run is not an implement-fully pipeline root",
    };
  }
  if (
    isPipelineTerminal(args.store, args.dashboardStore, args.rootRunId)
  ) {
    return {
      ok: false,
      reason: "terminal",
      message: "Pipeline is no longer running",
    };
  }

  const validated = validatePipelineDirectiveAppend(args.request);
  if (!validated.ok) {
    return { ok: false, reason: "validation", message: validated.error };
  }

  if (validated.body && "roleModels" in validated.body) {
    const failures = await args.engine.preflightRoleModels(
      validated.body.roleModels
    );
    if (failures.length > 0) {
      return {
        ok: false,
        reason: "validation",
        message: formatModelPreflightFailures(failures),
      };
    }
  }

  const appended = args.store.appendPipelineDirective({
    rootRunId: args.rootRunId,
    kind: args.request.kind,
    ...(args.actorId ? { actorId: args.actorId } : {}),
    body: validated.body,
  });
  if (!appended.ok) {
    const reason =
      appended.reason === "not-found"
        ? "not-found"
        : appended.reason === "invalid-root"
          ? "invalid-root"
          : "validation";
    return {
      ok: false,
      reason,
      message: `Could not append directive (${appended.reason})`,
    };
  }

  args.store.appendEvent(
    args.rootRunId,
    "run.pipeline-directive",
    withActorIdPayload(
      {
        kind: args.request.kind,
        directiveId: appended.id,
      },
      args.actorId
    )
  );

  const snapshot = hydratePipelineSnapshot(
    args.store,
    args.dashboardStore,
    args.rootRunId,
    Date.now()
  );
  if (!snapshot) {
    return {
      ok: false,
      reason: "not-found",
      message: "pipeline run not found after append",
    };
  }

  return {
    ok: true,
    id: appended.id,
    kind: args.request.kind,
    rootRunId: args.rootRunId,
    snapshot,
    cursor: args.store.getMaxGlobalEventId(),
  };
}

export function applyPipelineStopAfterStep(args: {
  store: RunStore;
  dashboardStore: DashboardStore;
  engine: RunEngine;
  rootRunId: string;
  reason?: string;
  actorId?: string;
}):
  | {
      ok: true;
      rootRunId: string;
      frontierRunId: string;
      stopReason: string;
      snapshot: PipelineSnapshot;
      cursor: number;
    }
  | { ok: false; reason: PipelineSteeringRefusal | "validation"; message: string } {
  const root = args.store.getRun(args.rootRunId);
  if (!root) {
    return { ok: false, reason: "not-found", message: "pipeline run not found" };
  }
  if (!args.store.isImplementFullyRootRun(root)) {
    return {
      ok: false,
      reason: "invalid-root",
      message: "Run is not an implement-fully pipeline root",
    };
  }
  if (
    isPipelineTerminal(args.store, args.dashboardStore, args.rootRunId)
  ) {
    return {
      ok: false,
      reason: "terminal",
      message: "Pipeline is no longer running",
    };
  }

  let stopReason: string;
  try {
    stopReason = formatOperatorStopReason(args.actorId, args.reason);
  } catch (err) {
    return {
      ok: false,
      reason: "validation",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const frontier = resolveStopFrontier(args.store, args.rootRunId);
  if (!frontier.ok) {
    return {
      ok: false,
      reason: frontier.reason,
      message: frontier.message,
    };
  }

  const result = args.engine.applyOperatorPipelineStop(
    frontier.frontierRunId,
    stopReason
  );
  if (!result.ok) {
    if (result.reason === "already-stopped") {
      return {
        ok: false,
        reason: "already-stopped",
        message: "Pipeline frontier already has a stop marker",
      };
    }
    return {
      ok: false,
      reason: "validation",
      message: `Could not apply stop (${result.reason})`,
    };
  }

  args.store.appendEvent(
    args.rootRunId,
    "run.pipeline-stop-requested",
    withActorIdPayload(
      {
        frontierRunId: frontier.frontierRunId,
        stopReason,
      },
      args.actorId
    )
  );

  const snapshot = hydratePipelineSnapshot(
    args.store,
    args.dashboardStore,
    args.rootRunId,
    Date.now()
  );
  if (!snapshot) {
    return {
      ok: false,
      reason: "not-found",
      message: "pipeline run not found after stop",
    };
  }

  return {
    ok: true,
    rootRunId: args.rootRunId,
    frontierRunId: frontier.frontierRunId,
    stopReason,
    snapshot,
    cursor: args.store.getMaxGlobalEventId(),
  };
}

/** Classify whether a root run is terminal (for tests). */
export function classifyRootPipelineOutcome(
  store: RunStore,
  rootRunId: string
): ReturnType<typeof classifyPipelineOutcome> {
  const rows = store.listChainLineageRuns(rootRunId);
  return classifyPipelineOutcome({
    runs: rows.map((row) => ({
      status: row.status,
      configKey: row.configKey,
      chainStopReason: row.chainStopReason,
      chainStopRequestedAt: row.chainStopRequestedAt,
      chainHandledAt: null,
      createdAt: row.createdAt,
    })),
    finalGateConfigKey: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY}`,
  });
}
