import { useEffect, useState } from "react";
import { api } from "./api";

type FeatureDocsListingState = {
  /** File names present directly under the feature's roadmap dir.
   *  `null` while loading or on error — treated as "unknown", never as
   *  "missing", so we don't dim a link just because the listing failed. */
  names: Set<string> | null;
  loading: boolean;
};

/** `null` entry = listing failed (unknown), distinct from "not fetched yet". */
const listingCache = new Map<string, Set<string> | null>();
const pendingRequests = new Map<string, Promise<Set<string> | null>>();

function cacheKey(workspaceId: string, dir: string): string {
  return `${workspaceId}::${dir}`;
}

/**
 * Lists the files directly under a feature's `docs/roadmap/<slug>` dir so
 * the pipeline docs menu can tell "not created yet" apart from "open me".
 * One request per (workspace, dir); dashboard-lifetime cache since roadmap
 * dirs for in-flight pipelines don't get pruned mid-run.
 */
export function useFeatureDocsListing(
  workspaceId: string | null,
  featureDir: string | null
): FeatureDocsListingState {
  const key = workspaceId && featureDir ? cacheKey(workspaceId, featureDir) : null;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!key || !workspaceId || !featureDir) return;
    if (listingCache.has(key)) return;

    let cancelled = false;
    const request =
      pendingRequests.get(key) ??
      api
        .listWorkspaceFiles(workspaceId, featureDir)
        .then(
          (res) =>
            new Set(res.entries.filter((e) => e.kind === "file").map((e) => e.name))
        )
        .catch(() => null)
        .finally(() => {
          pendingRequests.delete(key);
        });
    pendingRequests.set(key, request);

    void request.then((names) => {
      listingCache.set(key, names);
      if (!cancelled) setTick((n) => n + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [key, workspaceId, featureDir]);

  if (!key) return { names: null, loading: false };
  if (!listingCache.has(key)) return { names: null, loading: true };
  return { names: listingCache.get(key) ?? null, loading: false };
}
