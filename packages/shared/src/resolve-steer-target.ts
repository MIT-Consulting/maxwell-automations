export type SteerTargetResolution =
  | { kind: "resolved"; runId: string }
  | { kind: "none"; reason: string }
  | { kind: "ambiguous"; runIds: string[]; reason: string };

export type SteerTargetCandidate = {
  id: string;
  status: string;
  parentRunId: string | null;
  chainRootRunId: string | null;
};

function isSteerable(status: string): boolean {
  return status === "running";
}

/** Mirrors dashboard `effectivePipelineGroupRuns` — leaves win; fall back to all. */
function effectivePipelineGroupRuns(
  runs: readonly SteerTargetCandidate[]
): readonly SteerTargetCandidate[] {
  if (runs.length === 0) return runs;
  const parentIds = new Set<string>();
  for (const run of runs) {
    if (run.parentRunId) parentIds.add(run.parentRunId);
  }
  const leaves = runs.filter((r) => !parentIds.has(r.id));
  return leaves.length > 0 ? leaves : runs;
}

function chainRootFor(candidate: SteerTargetCandidate): string {
  return candidate.chainRootRunId ?? candidate.id;
}

function resolvePinnedRun(
  pinnedRunId: string,
  candidates: readonly SteerTargetCandidate[]
): SteerTargetResolution {
  const pinned = candidates.find((c) => c.id === pinnedRunId);
  if (!pinned) {
    return {
      kind: "none",
      reason: `Run ${pinnedRunId} is not an active run in this workspace`,
    };
  }
  if (isSteerable(pinned.status)) {
    return { kind: "resolved", runId: pinned.id };
  }
  if (pinned.status === "paused") {
    return {
      kind: "none",
      reason:
        "Run is paused; send a message directly in this chat or resume the run before steering",
    };
  }
  return {
    kind: "none",
    reason: `Run ${pinnedRunId} is not steerable (status=${pinned.status})`,
  };
}

function resolveFromPipelineRoot(
  attachedRoot: string,
  candidates: readonly SteerTargetCandidate[]
): SteerTargetResolution {
  const pipelineCandidates = candidates.filter(
    (c) => chainRootFor(c) === attachedRoot
  );
  if (pipelineCandidates.length === 0) {
    return {
      kind: "none",
      reason: `Attached run ${attachedRoot} is not active in this workspace`,
    };
  }

  const frontier = effectivePipelineGroupRuns(pipelineCandidates);
  const steerableLeaves = frontier.filter((c) => isSteerable(c.status));

  if (steerableLeaves.length === 1) {
    return { kind: "resolved", runId: steerableLeaves[0]!.id };
  }
  if (steerableLeaves.length > 1) {
    const ids = steerableLeaves.map((c) => c.id);
    return {
      kind: "ambiguous",
      runIds: ids,
      reason: `Multiple running workers (${ids.join(", ")}); pass runId to steer one`,
    };
  }

  const pausedOnFrontier = frontier.some((c) => c.status === "paused");
  if (pausedOnFrontier) {
    return {
      kind: "none",
      reason:
        "Pipeline worker is paused; send a message directly in this chat or resume before steering",
    };
  }

  return {
    kind: "none",
    reason: "No running worker found for the attached pipeline",
  };
}

export function resolveSteerTargetRunId(args: {
  pinnedRunId?: string | null;
  attachedRunId?: string | null;
  candidates: ReadonlyArray<SteerTargetCandidate>;
}): SteerTargetResolution {
  const { pinnedRunId, attachedRunId, candidates } = args;

  if (pinnedRunId) {
    return resolvePinnedRun(pinnedRunId, candidates);
  }

  if (!attachedRunId) {
    return {
      kind: "none",
      reason: "No run attached; attach a live run or pass runId",
    };
  }

  const attached = candidates.find((c) => c.id === attachedRunId);
  if (attached && isSteerable(attached.status)) {
    return { kind: "resolved", runId: attached.id };
  }

  // Attached id is a pipeline handle: use its chain root when present in the
  // active set; otherwise treat the id itself as the root (terminal/dangling
  // attach still resolves to a live frontier worker).
  const attachedRoot = attached ? chainRootFor(attached) : attachedRunId;
  return resolveFromPipelineRoot(attachedRoot, candidates);
}
