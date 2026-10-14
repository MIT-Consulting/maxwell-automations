import type { CapabilitiesQueueSummary } from "./types/api.js";
import type {
  FeatureQueueEntry,
  FeatureQueueEntryState,
} from "./types/feature-queue.js";

export type FeatureQueueSummary = {
  counts: Record<FeatureQueueEntryState, number>;
  running: {
    featureId: string;
    runId: string;
    origin: FeatureQueueEntry["origin"];
    count: number;
  } | null;
  failed: Array<{ featureId: string; detail: string | null }>;
  blocked: Array<{ featureId: string; detail: string | null }>;
  nextEligibleFeatureId: string | null;
  isEmpty: boolean;
};

function newestEntryByFeatureId(
  entries: FeatureQueueEntry[],
  workspaceId: string,
  featureId: string
): FeatureQueueEntry | undefined {
  let best: FeatureQueueEntry | undefined;
  for (const entry of entries) {
    if (entry.workspaceId !== workspaceId || entry.featureId !== featureId) {
      continue;
    }
    if (!best || entry.position > best.position) {
      best = entry;
    }
  }
  return best;
}

function isQueueEntryEligible(
  entry: FeatureQueueEntry,
  entries: FeatureQueueEntry[]
): boolean {
  if (entry.state !== "queued") {
    return false;
  }
  for (const depId of entry.after) {
    const dep = newestEntryByFeatureId(entries, entry.workspaceId, depId);
    if (!dep || dep.state !== "done") {
      return false;
    }
  }
  return true;
}

function findNextEligibleFeatureId(
  entries: FeatureQueueEntry[]
): string | null {
  const byWorkspace = new Map<string, FeatureQueueEntry[]>();
  for (const entry of entries) {
    const list = byWorkspace.get(entry.workspaceId) ?? [];
    list.push(entry);
    byWorkspace.set(entry.workspaceId, list);
  }
  for (const workspaceEntries of byWorkspace.values()) {
    const queued = workspaceEntries
      .filter((e) => e.state === "queued")
      .sort((a, b) => a.position - b.position);
    const eligible = queued.find((entry) =>
      isQueueEntryEligible(entry, entries)
    );
    if (eligible) {
      return eligible.featureId;
    }
  }
  return null;
}

/** Health-mode queue summary from listFeatureQueue (no new endpoint). */
export function summarizeFeatureQueue(
  entries: FeatureQueueEntry[]
): FeatureQueueSummary {
  const counts: Record<FeatureQueueEntryState, number> = {
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const entry of entries) {
    counts[entry.state] += 1;
  }

  const runningEntries = entries.filter((e) => e.state === "running");
  const runningEntry = runningEntries[0];
  const running =
    runningEntry != null
      ? {
          featureId: runningEntry.featureId,
          runId: runningEntry.runId ?? "",
          origin: runningEntry.origin ?? "queue",
          count: runningEntries.length,
        }
      : null;

  const failed = entries
    .filter((e) => e.state === "failed")
    .map((e) => ({ featureId: e.featureId, detail: e.detail }));
  const blocked = entries
    .filter((e) => e.state === "blocked")
    .map((e) => ({ featureId: e.featureId, detail: e.detail }));

  const active = entries.filter(
    (e) => e.state !== "done" && e.state !== "cancelled"
  );

  return {
    counts,
    running,
    failed,
    blocked,
    nextEligibleFeatureId: findNextEligibleFeatureId(entries),
    isEmpty: active.length === 0,
  };
}

/** Bounded queue facts for orchestrator capability maps (no kickoff JSON or detail blobs). */
export function summarizeFeatureQueueForCapabilities(
  entries: FeatureQueueEntry[]
): CapabilitiesQueueSummary {
  const full = summarizeFeatureQueue(entries);
  return {
    counts: full.counts,
    running: full.running
      ? {
          featureId: full.running.featureId,
          runId: full.running.runId,
        }
      : null,
    failedFeatureIds: full.failed.map((entry) => entry.featureId),
    blockedFeatureIds: full.blocked.map((entry) => entry.featureId),
    nextEligibleFeatureId: full.nextEligibleFeatureId,
    isEmpty: full.isEmpty,
  };
}
