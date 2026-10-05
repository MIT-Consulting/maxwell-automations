import {
  isRoadmapIdCandidate,
  ROADMAP_ID_CANDIDATE_RE,
  resolveSteerTargetRunId,
  type PipelineSnapshot,
  type Run,
  type SteerTargetCandidate,
} from "@lca/shared";
import { resolveWorkspaceFromCwd } from "./implement-fully.js";
import { DaemonClient, DaemonError, resolveWorkspaceId } from "./client.js";
import { resolveRunId } from "./run-resolve.js";

/** Compatibility re-export; prefer `isRoadmapIdCandidate` from `@lca/shared`. */
export const FEATURE_ID_RE = ROADMAP_ID_CANDIDATE_RE;

export type FeatureTargetVerb =
  | "watch"
  | "doctor"
  | "pause"
  | "resume"
  | "message"
  | "interrupt"
  | "answer"
  | "cancel"
  | "escalate"
  | "directive"
  | "pipeline-stop";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParsedOperatorTargetFlags =
  | {
      ok: true;
      positional?: string;
      feature?: string;
      workspaceQuery?: string;
      rest: string[];
    }
  | { ok: false; message: string };

export function parseOperatorTargetFlags(
  argv: readonly string[],
  options?: { requireTarget?: boolean }
): ParsedOperatorTargetFlags {
  let positional: string | undefined;
  let feature: string | undefined;
  let workspaceQuery: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-w" || arg === "--workspace") {
      workspaceQuery = argv[++i];
      if (!workspaceQuery?.trim()) {
        return { ok: false, message: "--workspace requires a value" };
      }
      continue;
    }
    if (arg === "--feature") {
      feature = argv[++i];
      if (!feature?.trim()) {
        return { ok: false, message: "--feature requires a value" };
      }
      feature = feature.trim();
      continue;
    }
    if (arg.startsWith("-")) {
      rest.push(arg, ...argv.slice(i + 1));
      break;
    }
    if (positional != null || feature != null) {
      rest.push(arg, ...argv.slice(i + 1));
      break;
    }
    positional = arg;
  }

  if (positional && feature) {
    return {
      ok: false,
      message: "Cannot combine a positional run/feature target with --feature",
    };
  }

  if (options?.requireTarget && !positional && !feature) {
    return {
      ok: false,
      message: "Provide <runId|feature-id> or --feature <feature-id>",
    };
  }

  return {
    ok: true,
    positional: positional?.trim(),
    feature,
    workspaceQuery: workspaceQuery?.trim(),
    rest,
  };
}

export async function resolveWorkspaceForFeatureTarget(
  client: DaemonClient,
  workspaceQuery?: string
): Promise<string> {
  if (workspaceQuery) {
    return resolveWorkspaceId(client, workspaceQuery);
  }
  return resolveWorkspaceFromCwd(
    await client.listWorkspaces(),
    process.cwd()
  ).id;
}

export async function resolveFeaturePipeline(
  client: DaemonClient,
  featureId: string,
  workspaceQuery?: string
): Promise<{ rootRunId: string; snapshot: PipelineSnapshot }> {
  if (!isRoadmapIdCandidate(featureId)) {
    throw new DaemonError(
      `Invalid feature id "${featureId}"; expected a feature id (e.g. b42, b-dm58).`
    );
  }
  const workspaceId = await resolveWorkspaceForFeatureTarget(
    client,
    workspaceQuery
  );
  return client.resolvePipelineSnapshot(workspaceId, featureId);
}

function lineageCandidates(
  runs: readonly Run[],
  rootRunId: string
): SteerTargetCandidate[] {
  return runs
    .filter((run) => (run.chainRootRunId ?? run.id) === rootRunId)
    .map((run) => ({
      id: run.id,
      status: run.status,
      parentRunId: run.parentRunId ?? null,
      chainRootRunId: run.chainRootRunId ?? null,
    }));
}

export async function resolveFeatureTargetRunId(
  client: DaemonClient,
  verb: FeatureTargetVerb,
  featureId: string,
  workspaceQuery?: string
): Promise<{ rootRunId: string; runId: string; snapshot: PipelineSnapshot }> {
  const { rootRunId, snapshot } = await resolveFeaturePipeline(
    client,
    featureId,
    workspaceQuery
  );

  switch (verb) {
    case "watch":
    case "doctor":
    case "directive":
    case "pipeline-stop":
      return { rootRunId, runId: rootRunId, snapshot };
    case "answer": {
      if (!snapshot.waiting) {
        throw new DaemonError(
          `Feature ${featureId} is not waiting for input in this workspace.`
        );
      }
      return { rootRunId, runId: snapshot.waiting.runId, snapshot };
    }
    case "escalate": {
      if (!snapshot.halt) {
        throw new DaemonError(
          `Feature ${featureId} has no halted run to escalate in this workspace.`
        );
      }
      return { rootRunId, runId: snapshot.halt.runId, snapshot };
    }
    case "resume": {
      const runs = await client.listRuns();
      const paused = lineageCandidates(runs, rootRunId).filter(
        (c) => c.status === "paused"
      );
      if (paused.length === 1) {
        return { rootRunId, runId: paused[0]!.id, snapshot };
      }
      if (paused.length > 1) {
        throw new DaemonError(
          `Multiple paused workers (${paused.map((c) => c.id).join(", ")}); pass runId`
        );
      }
      throw new DaemonError(`No paused worker for feature ${featureId}.`);
    }
    case "cancel": {
      const runs = await client.listRuns();
      const active = lineageCandidates(runs, rootRunId).filter((c) =>
        ["running", "needs_input", "queued"].includes(c.status)
      );
      if (active.length === 1) {
        return { rootRunId, runId: active[0]!.id, snapshot };
      }
      if (active.length > 1) {
        throw new DaemonError(
          `Multiple active workers (${active.map((c) => c.id).join(", ")}); pass runId`
        );
      }
      throw new DaemonError(`No active run to cancel for feature ${featureId}.`);
    }
    case "pause":
    case "message":
    case "interrupt": {
      const runs = await client.listRuns();
      const candidates = lineageCandidates(runs, rootRunId);
      const resolution = resolveSteerTargetRunId({
        attachedRunId: rootRunId,
        candidates,
      });
      if (resolution.kind === "resolved") {
        return { rootRunId, runId: resolution.runId, snapshot };
      }
      if (resolution.kind === "ambiguous") {
        throw new DaemonError(
          `${resolution.reason} (${resolution.runIds.join(", ")})`
        );
      }
      if (
        verb === "message" &&
        snapshot.current?.status === "paused" &&
        snapshot.current.runId
      ) {
        return {
          rootRunId,
          runId: snapshot.current.runId,
          snapshot,
        };
      }
      throw new DaemonError(resolution.reason);
    }
  }
}

export async function resolveOperatorRunTarget(
  client: DaemonClient,
  verb: FeatureTargetVerb,
  flags: Extract<ParsedOperatorTargetFlags, { ok: true }>
): Promise<{ rootRunId?: string; runId: string }> {
  if (flags.feature) {
    const resolved = await resolveFeatureTargetRunId(
      client,
      verb,
      flags.feature,
      flags.workspaceQuery
    );
    console.error(`rootRunId: ${resolved.rootRunId}`);
    return { rootRunId: resolved.rootRunId, runId: resolved.runId };
  }
  if (flags.positional && isRoadmapIdCandidate(flags.positional)) {
    const resolved = await resolveFeatureTargetRunId(
      client,
      verb,
      flags.positional,
      flags.workspaceQuery
    );
    console.error(`rootRunId: ${resolved.rootRunId}`);
    return { rootRunId: resolved.rootRunId, runId: resolved.runId };
  }
  if (!flags.positional) {
    throw new UsageError("Provide <runId|feature-id> or --feature <feature-id>");
  }
  const runId = await resolveRunId(client, flags.positional);
  if (verb === "directive" || verb === "pipeline-stop") {
    const snap = await client.getRun(runId);
    const rootRunId = snap.run.chain_root_run_id ?? runId;
    console.error(`rootRunId: ${rootRunId}`);
    return { rootRunId, runId: rootRunId };
  }
  return { runId };
}
