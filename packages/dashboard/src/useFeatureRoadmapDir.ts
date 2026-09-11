import { useEffect, useState } from "react";
import { api } from "./api";
import { featureRoadmapDir } from "./pipelineDocLinks";

const DONE_DIR = "docs/roadmap/done";

const resolvedDirCache = new Map<string, string>();
const pendingRequests = new Map<string, Promise<string>>();

function cacheKey(workspaceId: string, featureSlug: string): string {
  return `${workspaceId}::${featureSlug}`;
}

async function resolveDir(workspaceId: string, featureSlug: string): Promise<string> {
  const liveDir = featureRoadmapDir(featureSlug);
  try {
    const live = await api.listWorkspaceFiles(workspaceId, liveDir);
    if (live.entries.length > 0) return liveDir;
  } catch {
    // Live dir is gone (or never existed) — fall through to the done/ lookup.
  }
  try {
    const done = await api.listWorkspaceFiles(workspaceId, DONE_DIR);
    const archived = done.entries.find(
      (e) => e.kind === "dir" && (e.name === featureSlug || e.name.endsWith(`-${featureSlug}`))
    );
    if (archived) return `${DONE_DIR}/${archived.name}`;
  } catch {
    // No done/ dir yet, or listing failed — keep the optimistic default below.
  }
  return liveDir;
}

/**
 * Resolves a feature's roadmap dir, accounting for `/roadmap-tidy` (or
 * manual) archiving that can move `docs/roadmap/<slug>/` to
 * `docs/roadmap/done/b<n>-<slug>/` while a pipeline for it is still on the
 * board. Returns the optimistic live dir immediately, then updates to the
 * archived dir once resolved (cached dashboard-lifetime per workspace+slug).
 */
export function useFeatureRoadmapDir(
  workspaceId: string | null,
  featureSlug: string | null
): string {
  const liveDir = featureSlug ? featureRoadmapDir(featureSlug) : "";
  const key = workspaceId && featureSlug ? cacheKey(workspaceId, featureSlug) : null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!key || !workspaceId || !featureSlug) return;
    if (resolvedDirCache.has(key)) return;

    let cancelled = false;
    const request =
      pendingRequests.get(key) ??
      resolveDir(workspaceId, featureSlug).finally(() => {
        pendingRequests.delete(key);
      });
    pendingRequests.set(key, request);

    void request.then((dir) => {
      resolvedDirCache.set(key, dir);
      if (!cancelled) setTick((n) => n + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, featureSlug]);

  if (!key) return liveDir;
  return resolvedDirCache.get(key) ?? liveDir;
}
