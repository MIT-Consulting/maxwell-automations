import { useEffect, useRef, useState } from "react";
import type { RoadmapReadinessWorkspaceSummary } from "@lca/shared";
import { api } from "./api";

export type RoadmapSummaryEntry =
  | { status: "loading" }
  | { status: "ready"; summary: RoadmapReadinessWorkspaceSummary }
  | { status: "unavailable"; error?: string };

export function workspaceReadinessSummaryKey(
  workspaceIds: readonly string[]
): string {
  return workspaceIds
    .filter((id) => id !== "__global__")
    .slice()
    .sort()
    .join("\0");
}

/**
 * Fetch roadmap readiness summaries when the workspace id set changes — not on
 * every dashboard poll tick. Depend only on the sorted-id key so a new
 * `workspaces` array from the 8s refresh cannot cancel an in-flight fetch.
 */
export function useRoadmapReadinessSummaries(
  workspaceIds: readonly string[]
): Map<string, RoadmapSummaryEntry> {
  const [map, setMap] = useState<Map<string, RoadmapSummaryEntry>>(new Map());
  const key = workspaceReadinessSummaryKey(workspaceIds);
  const idsRef = useRef(workspaceIds);
  idsRef.current = workspaceIds;

  useEffect(() => {
    const ids = idsRef.current.filter((id) => id !== "__global__");
    if (ids.length === 0) {
      setMap(new Map());
      return;
    }

    setMap(new Map(ids.map((id) => [id, { status: "loading" }])));

    let cancelled = false;
    void api
      .getRoadmapReadinessSummaries()
      .then((res) => {
        if (cancelled) return;
        const byId = new Map(
          res.workspaces.map((summary) => [summary.workspaceId, summary])
        );
        setMap(
          new Map(
            ids.map((id) => {
              const summary = byId.get(id);
              if (summary) {
                return [id, { status: "ready", summary }] as const;
              }
              return [id, { status: "unavailable" }] as const;
            })
          )
        );
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setMap(
          new Map(
            ids.map((id) => [id, { status: "unavailable", error: message }])
          )
        );
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  return map;
}
