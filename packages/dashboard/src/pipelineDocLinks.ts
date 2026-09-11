/**
 * Derive workspace-relative feature/phase doc paths for kanban deep links.
 *
 * Paths are anchored to a *roadmap dir* rather than a bare feature slug,
 * because `/roadmap-tidy` (or manual archiving) can move a completed
 * feature's docs from `docs/roadmap/<slug>/` to `docs/roadmap/done/b<n>-
 * <slug>/` at any time — including while its pipeline is still visible on
 * the board (e.g. in the Completed column). `useFeatureRoadmapDir` resolves
 * the live-vs-archived dir; `featureRoadmapDir` below is only the
 * *optimistic default* used before that resolution completes.
 */

export type PipelinePhaseDocLink = {
  phaseRef: string;
  path: string;
};

/**
 * Sequential (non-wave) implement-fully steps don't get a structured
 * `pipelineTrack.phaseFile` — only parallel-track runs do. But the daemon
 * bakes the resolved phase file into the run `title` as its last
 * `·`-separated segment (e.g. `"review · b51 · 04-docs-and-focused-verify.md"`),
 * so parse that as a fallback rather than always falling back to the index.
 */
export function phaseFileFromRunTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const parts = title.split("·").map((p) => p.trim());
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  return last && /\.md$/i.test(last) ? last : null;
}

/** Track phase file if present (parallel/wave run); otherwise parsed from
 *  the run title (sequential run). */
export function effectivePhaseFileForRun(run: {
  pipelineTrack?: { phaseFile: string } | null;
  title?: string | null;
}): string | null {
  return run.pipelineTrack?.phaseFile ?? phaseFileFromRunTitle(run.title);
}

/** Optimistic default dir, assuming the feature hasn't been archived yet. */
export function featureRoadmapDir(featureSlug: string): string {
  return `docs/roadmap/${featureSlug}`;
}

export function indexPathInDir(dir: string): string {
  return `${dir}/00-index.md`;
}

export function prdPathInDir(dir: string): string {
  return `${dir}/prd.md`;
}

/**
 * Resolve a track `phaseFile` to a workspace-relative path under `dir`.
 * Full `docs/…` paths are kept as-is; bare names join under `dir`.
 */
export function resolvePhaseDocPathInDir(dir: string, phaseFile: string): string {
  const normalized = phaseFile.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.startsWith("docs/")) return normalized;
  return `${dir}/${normalized}`;
}

/** Unique phase docs from a pipeline group's runs (run order preserved).
 *  Covers both parallel-track runs (`pipelineTrack.phaseFile`) and
 *  sequential runs (phase file parsed from the run title). */
export function collectGroupPhaseDocLinksInDir(
  dir: string,
  runs: ReadonlyArray<{
    pipelineTrack?: { phaseRef: string; phaseFile: string } | null;
    title?: string | null;
  }>
): PipelinePhaseDocLink[] {
  const out: PipelinePhaseDocLink[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const phaseFile = effectivePhaseFileForRun(run);
    if (!phaseFile) continue;
    const path = resolvePhaseDocPathInDir(dir, phaseFile);
    if (seen.has(path)) continue;
    seen.add(path);
    const phaseRef =
      run.pipelineTrack?.phaseRef ||
      path.split("/").pop()?.replace(/\.md$/i, "") ||
      path;
    out.push({ phaseRef, path });
  }
  return out;
}

/** Prefer the track phase doc; otherwise the feature index — both under `dir`. */
export function pipelineRunDocPathInDir(
  dir: string | null,
  phaseFile: string | null | undefined
): string | null {
  if (!dir) return null;
  if (phaseFile) return resolvePhaseDocPathInDir(dir, phaseFile);
  return indexPathInDir(dir);
}
