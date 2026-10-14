import { IMPLEMENT_FULLY_PIPELINE_ID } from "./types/api.js";
import type { FeatureQueueEntryDetail } from "./types/feature-queue.js";
import {
  emptyQueueEntryDetail,
  type FeatureQueueEntry,
  type FeatureQueueEntryState,
} from "./types/feature-queue.js";
import type { Run } from "./types/entities.js";

export type { FeatureQueueEntryDetail } from "./types/feature-queue.js";

export type QueuePreviewReadiness = "next" | "waiting" | "blocked" | "starting";

export type QueuePreviewItem = {
  entryId: string;
  workspaceId: string;
  featureId: string;
  featureSlug: string | null;
  summary: string | null;
  position: number;
  after: string[];
  entryDetail: FeatureQueueEntryDetail;
  createdAt: string;
  afterStates: {
    featureId: string;
    state: FeatureQueueEntryState | "missing";
  }[];
  readiness: QueuePreviewReadiness;
  reason: string | null;
};

const PREVIEW_STATES = new Set<FeatureQueueEntry["state"]>([
  "queued",
  "blocked",
  "running",
]);

const SLOT_BUSY_STATUSES = new Set<Run["status"]>([
  "queued",
  "running",
  "needs_input",
  "paused",
]);

export function readQueuePreviewFields(kickoffJson: string): {
  featureSlug: string | null;
  summary: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(kickoffJson);
  } catch {
    return { featureSlug: null, summary: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { featureSlug: null, summary: null };
  }
  const variables = (parsed as Record<string, unknown>).variables;
  if (typeof variables !== "object" || variables === null) {
    return { featureSlug: null, summary: null };
  }
  const vars = variables as Record<string, unknown>;

  let featureSlug: string | null = null;
  if (typeof vars.featureSlug === "string") {
    const trimmed = vars.featureSlug.trim();
    featureSlug = trimmed.length > 0 ? trimmed : null;
  }

  let summary: string | null = null;
  if (typeof vars.idea === "string") {
    const firstLine = vars.idea.split(/\r?\n/)[0]?.trim() ?? "";
    if (firstLine.length === 0) {
      summary = null;
    } else if (firstLine.length > 120) {
      summary = firstLine.slice(0, 119) + "…";
    } else {
      summary = firstLine;
    }
  }

  return { featureSlug, summary };
}

const QUEUE_ENTRY_ROLE_ORDER = [
  "researcher",
  "architect",
  "planner",
  "implementer",
  "reviewer",
  "docs",
  "gatekeeper",
] as const;

const ROLE_ORDER_INDEX = new Map<string, number>(
  QUEUE_ENTRY_ROLE_ORDER.map((role, index) => [role, index])
);

function trimStringField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readThenVariable(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "none") {
    return null;
  }
  return trimmed;
}

function modelIdFromSelection(value: unknown): string | null {
  if (typeof value === "string") {
    return trimStringField(value);
  }
  if (typeof value === "object" && value !== null) {
    return trimStringField((value as Record<string, unknown>).id);
  }
  return null;
}

function sortRoleModelPairs(
  pairs: { role: string; modelId: string }[]
): { role: string; modelId: string }[] {
  return [...pairs].sort((a, b) => {
    const ai = ROLE_ORDER_INDEX.get(a.role);
    const bi = ROLE_ORDER_INDEX.get(b.role);
    if (ai !== undefined && bi !== undefined) {
      return ai - bi;
    }
    if (ai !== undefined) {
      return -1;
    }
    if (bi !== undefined) {
      return 1;
    }
    return a.role.localeCompare(b.role);
  });
}

export function readQueueEntryDetail(
  kickoffJson: string
): FeatureQueueEntryDetail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(kickoffJson);
  } catch {
    return emptyQueueEntryDetail();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return emptyQueueEntryDetail();
  }
  const root = parsed as Record<string, unknown>;
  const variables = root.variables;
  if (typeof variables !== "object" || variables === null) {
    return emptyQueueEntryDetail();
  }
  const vars = variables as Record<string, unknown>;

  let roleModels: FeatureQueueEntryDetail["roleModels"] = null;
  const rawRoleModels = root.roleModels;
  if (rawRoleModels === undefined) {
    roleModels = null;
  } else if (typeof rawRoleModels !== "object" || rawRoleModels === null) {
    roleModels = null;
  } else if (Object.keys(rawRoleModels).length === 0) {
    roleModels = [];
  } else {
    const pairs: { role: string; modelId: string }[] = [];
    for (const [role, selection] of Object.entries(rawRoleModels)) {
      const modelId = modelIdFromSelection(selection);
      if (modelId) {
        pairs.push({ role, modelId });
      }
    }
    roleModels = sortRoleModelPairs(pairs);
  }

  return {
    featureDocPath: trimStringField(vars.featureIndex),
    roleModelProfileId: trimStringField(vars.roleModelProfileId),
    roleModels,
    planningDepth: trimStringField(vars.planningDepth),
    approvalPolicy: trimStringField(vars.approvalPolicy),
    researchApprovalPolicy: trimStringField(vars.researchApprovalPolicy),
    loopMode: trimStringField(vars.loopMode),
    then: readThenVariable(vars.then),
  };
}

function buildAfterStates(
  entries: readonly FeatureQueueEntry[],
  after: readonly string[]
): QueuePreviewItem["afterStates"] {
  return after.map((depId) => ({
    featureId: depId,
    state: newestRowForFeature(entries, depId)?.state ?? "missing",
  }));
}

export function newestRowForFeature(
  entries: readonly FeatureQueueEntry[],
  featureId: string
): FeatureQueueEntry | undefined {
  let best: FeatureQueueEntry | undefined;
  for (const entry of entries) {
    if (entry.featureId !== featureId) continue;
    if (!best || entry.position > best.position) {
      best = entry;
    }
  }
  return best;
}

function isDepSatisfied(
  entries: readonly FeatureQueueEntry[],
  featureId: string
): boolean {
  const row = newestRowForFeature(entries, featureId);
  return row?.state === "done";
}

function assertSingleWorkspace(entries: readonly FeatureQueueEntry[]): void {
  if (entries.length === 0) return;
  const first = entries[0]!.workspaceId;
  for (const entry of entries) {
    if (entry.workspaceId !== first) {
      throw new Error("selectQueuePreview expects one workspace");
    }
  }
}

export function selectQueuePreview(input: {
  entries: readonly FeatureQueueEntry[];
  slotBusy: boolean;
}): QueuePreviewItem[] {
  const { entries, slotBusy } = input;
  assertSingleWorkspace(entries);
  if (entries.length === 0) return [];

  const previewEntries = entries
    .filter(
      (entry) =>
        entry.runId == null && PREVIEW_STATES.has(entry.state)
    )
    .sort((a, b) => a.position - b.position);

  const runningEntries = entries.filter((entry) => entry.state === "running");
  const anyRunning = runningEntries.length > 0;
  const allRunningAreDirect =
    anyRunning && runningEntries.every((entry) => entry.origin === "direct");

  const items: QueuePreviewItem[] = [];
  let headFeatureId: string | null = null;

  for (const entry of previewEntries) {
    const base = {
      entryId: entry.id,
      workspaceId: entry.workspaceId,
      featureId: entry.featureId,
      featureSlug: entry.featureSlug ?? null,
      summary: entry.summary ?? null,
      position: entry.position,
      after: entry.after,
      entryDetail: entry.entryDetail ?? emptyQueueEntryDetail(),
      createdAt: entry.createdAt,
      afterStates: buildAfterStates(entries, entry.after),
    };

    if (entry.state === "blocked") {
      const detail = entry.detail?.trim();
      items.push({
        ...base,
        readiness: "blocked",
        reason: detail && detail.length > 0 ? detail : "blocked",
      });
      continue;
    }

    if (entry.state === "running") {
      items.push({
        ...base,
        readiness: "starting",
        reason: "starting",
      });
      continue;
    }

    const unmet = entry.after.filter((depId) => !isDepSatisfied(entries, depId));
    if (unmet.length > 0) {
      items.push({
        ...base,
        readiness: "waiting",
        reason: `after ${unmet.join(", ")}`,
      });
      continue;
    }

    if (headFeatureId === null) {
      headFeatureId = entry.featureId;
      if (anyRunning && !allRunningAreDirect) {
        items.push({
          ...base,
          readiness: "waiting",
          reason: "queue busy",
        });
      } else if (anyRunning || slotBusy) {
        items.push({
          ...base,
          readiness: "waiting",
          reason: "waiting for slot",
        });
      } else {
        items.push({
          ...base,
          readiness: "next",
          reason: null,
        });
      }
    } else {
      items.push({
        ...base,
        readiness: "waiting",
        reason: `queued behind ${headFeatureId}`,
      });
    }
  }

  return items;
}

function isSlotBusy(
  runs: readonly Pick<Run, "workspaceId" | "status" | "pipeline">[],
  workspaceId: string
): boolean {
  return runs.some(
    (run) =>
      run.workspaceId === workspaceId &&
      run.pipeline?.pipelineId === IMPLEMENT_FULLY_PIPELINE_ID &&
      SLOT_BUSY_STATUSES.has(run.status)
  );
}

function groupWorkspaceIds(
  entries: readonly FeatureQueueEntry[],
  workspaceOrder: readonly string[]
): string[] {
  const ids = new Set(entries.map((entry) => entry.workspaceId));
  const ordered: string[] = [];
  for (const id of workspaceOrder) {
    if (ids.has(id)) {
      ordered.push(id);
      ids.delete(id);
    }
  }
  const leftover = [...ids].sort((a, b) => a.localeCompare(b));
  return [...ordered, ...leftover];
}

function matchesSearch(item: QueuePreviewItem, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  if (item.featureId.toLowerCase().includes(needle)) return true;
  if (item.featureSlug?.toLowerCase().includes(needle)) return true;
  if (item.summary?.toLowerCase().includes(needle)) return true;
  return false;
}

export function visibleQueuePreviews(args: {
  entries: readonly FeatureQueueEntry[];
  runs: readonly Pick<Run, "workspaceId" | "status" | "pipeline">[];
  workspaceId: string | null;
  workspaceOrder: readonly string[];
  search: string;
}): QueuePreviewItem[] {
  const { entries, runs, workspaceId, workspaceOrder, search } = args;
  const workspaceIds =
    workspaceId !== null
      ? [workspaceId]
      : groupWorkspaceIds(entries, workspaceOrder);

  const result: QueuePreviewItem[] = [];
  for (const wsId of workspaceIds) {
    const wsEntries = entries.filter((entry) => entry.workspaceId === wsId);
    if (wsEntries.length === 0) continue;
    const slotBusy = isSlotBusy(runs, wsId);
    result.push(...selectQueuePreview({ entries: wsEntries, slotBusy }));
  }

  return result.filter((item) => matchesSearch(item, search));
}
