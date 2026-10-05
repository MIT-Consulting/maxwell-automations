import {
  buildPipelineSnapshot,
  PIPELINE_LIFECYCLE_EVENTS,
  projectPipelineFeedPayload,
  type BuildPipelineSnapshotInput,
  type PipelineFeedEvent,
  type PipelineFeedResponse,
  type PipelineSnapshot,
  type PipelineSnapshotAutomationInput,
  type PipelineSnapshotEventInput,
  type PipelineSnapshotInputRequestInput,
  type PipelineSnapshotRunInput,
} from "@lca/shared";
import type { ChainRunContext } from "@lca/shared";
import { parseInputMetadataJson } from "../input/store.js";
import type { DashboardStore } from "../http/dashboard-store.js";
import type { LineageLifecycleEventRow, RunRow, RunStore } from "./store.js";
import type { PipelineFeedWaitRegistry } from "./pipeline-feed-wait.js";

export const PIPELINE_FEED_DEFAULT_WAIT_SEC = 25;
export const PIPELINE_FEED_MAX_WAIT_SEC = 55;
export const PIPELINE_FEED_EVENT_BATCH_LIMIT = 200;

export function parsePipelineFeedSinceParam(
  raw: string | null
): number | "invalid" {
  if (raw == null || raw.trim() === "") {
    return 0;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return "invalid";
  }
  return n;
}

export function parsePipelineFeedWaitParam(
  raw: string | null
): number | "invalid" {
  if (raw == null || raw.trim() === "") {
    return PIPELINE_FEED_DEFAULT_WAIT_SEC;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return "invalid";
  }
  return Math.min(PIPELINE_FEED_MAX_WAIT_SEC, Math.max(0, Math.floor(n)));
}

function mapLifecycleRowToFeedEvent(row: LineageLifecycleEventRow): PipelineFeedEvent {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.event_type,
    at: row.created_at,
    payload: projectPipelineFeedPayload(row.event_type, row.payload),
  };
}

function queryFeedEvents(
  store: RunStore,
  rootRunId: string,
  since: number
): PipelineFeedEvent[] {
  return store
    .listLifecycleEventsForLineage(rootRunId, PIPELINE_LIFECYCLE_EVENTS, {
      since,
      limit: PIPELINE_FEED_EVENT_BATCH_LIMIT,
    })
    .map(mapLifecycleRowToFeedEvent);
}

function advanceCursor(
  since: number,
  events: readonly PipelineFeedEvent[],
  maxGlobalId: number,
  batchLimit: number
): number {
  if (events.length > 0) {
    const lastId = events[events.length - 1]!.id;
    // A full page must stop at the last returned id so the next poll
    // can resume; jumping to maxGlobalId would skip remaining rows.
    if (events.length >= batchLimit) {
      return lastId;
    }
    return Math.max(since, lastId, maxGlobalId);
  }
  return Math.max(since, maxGlobalId);
}

function buildFeedResponse(
  store: RunStore,
  dashboardStore: DashboardStore,
  rootRunId: string,
  since: number,
  events: PipelineFeedEvent[],
  now: number
): PipelineFeedResponse {
  const snapshot = hydratePipelineSnapshot(
    store,
    dashboardStore,
    rootRunId,
    now
  );
  if (!snapshot) {
    throw new Error("pipeline root missing during feed hydration");
  }
  const cursor = advanceCursor(
    since,
    events,
    store.getMaxGlobalEventId(),
    PIPELINE_FEED_EVENT_BATCH_LIMIT
  );
  return { rootRunId, events, snapshot, cursor };
}

/** Long-poll pipeline lifecycle feed with query/subscribe/query race closure. */
export async function pollPipelineFeed(
  store: RunStore,
  dashboardStore: DashboardStore,
  waitRegistry: PipelineFeedWaitRegistry,
  rootRunId: string,
  since: number,
  waitSeconds: number,
  signal?: AbortSignal
): Promise<PipelineFeedResponse | null> {
  if (store.listChainLineageRunRows(rootRunId).length === 0) {
    return null;
  }

  let events = queryFeedEvents(store, rootRunId, since);
  if (events.length > 0) {
    return buildFeedResponse(
      store,
      dashboardStore,
      rootRunId,
      since,
      events,
      Date.now()
    );
  }

  if (waitSeconds <= 0) {
    return buildFeedResponse(
      store,
      dashboardStore,
      rootRunId,
      since,
      [],
      Date.now()
    );
  }

  await waitRegistry.waitForChange(rootRunId, waitSeconds * 1000, {
    signal,
    afterSubscribe: () => {
      events = queryFeedEvents(store, rootRunId, since);
      return events.length > 0;
    },
  });

  if (events.length === 0) {
    events = queryFeedEvents(store, rootRunId, since);
  }
  return buildFeedResponse(
    store,
    dashboardStore,
    rootRunId,
    since,
    events,
    Date.now()
  );
}

function mapRunRowToSnapshotInput(
  row: RunRow,
  rootRunId: string,
  dashboardStore: DashboardStore,
  rootChainContext: ChainRunContext | null
): PipelineSnapshotRunInput {
  const detail = dashboardStore.getRunDetail(row.id);
  const run = detail?.run;
  return {
    id: row.id,
    automationId: row.automation_id,
    workspaceId: row.workspace_id,
    status: row.status,
    parentRunId: row.parent_run_id,
    chainRootRunId: row.chain_root_run_id,
    chainDepth: row.chain_depth,
    chainMaxDepth: row.chain_max_depth,
    chainMaxDepthOverride: row.chain_max_depth_override,
    chainStopRequestedAt: row.chain_stop_requested_at,
    chainStopReason: row.chain_stop_reason,
    chainHandledAt: row.chain_handled_at,
    chainContext: row.id === rootRunId ? rootChainContext : undefined,
    pipeline: run?.pipeline ?? null,
    pipelineWave: run?.pipelineWave ?? null,
    pipelineTrack: run?.pipelineTrack ?? null,
    triggerKind: row.trigger_kind,
    model: row.model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

function collectAutomationInputs(
  store: RunStore,
  rows: RunRow[]
): PipelineSnapshotAutomationInput[] {
  const seen = new Set<string>();
  const automations: PipelineSnapshotAutomationInput[] = [];
  for (const row of rows) {
    if (seen.has(row.automation_id)) {
      continue;
    }
    seen.add(row.automation_id);
    const automation = store.getAutomationByIdIncludingArchived(row.automation_id);
    if (!automation) {
      continue;
    }
    automations.push({
      id: automation.id,
      configKey: automation.config_key,
      modelRole: automation.model_role,
    });
  }
  return automations;
}

function collectLifecycleEvents(
  store: RunStore,
  rootRunId: string
): PipelineSnapshotEventInput[] {
  return store
    .listLifecycleEventsForLineage(rootRunId, PIPELINE_LIFECYCLE_EVENTS)
    .map(
      (row): PipelineSnapshotEventInput => ({
        id: row.id,
        runId: row.run_id,
        eventType: row.event_type,
        payload: row.payload,
        createdAt: row.created_at,
      })
    );
}

function collectPendingInputRequests(
  store: RunStore,
  rootRunId: string
): PipelineSnapshotInputRequestInput[] {
  return store
    .listPendingInputRequestsForLineage(rootRunId)
    .map(
      (row): PipelineSnapshotInputRequestInput => ({
        id: row.id,
        runId: row.run_id,
        status: row.status,
        question: row.question,
        metadata: parseInputMetadataJson(row.metadata_json),
        createdAt: row.created_at,
      })
    );
}

/** Hydrate a pipeline snapshot for a root run id; null when the root is missing. */
export function hydratePipelineSnapshot(
  store: RunStore,
  dashboardStore: DashboardStore,
  rootRunId: string,
  now: number
): PipelineSnapshot | null {
  const rows = store.listChainLineageRunRows(rootRunId);
  if (rows.length === 0) {
    return null;
  }

  const rootRow = rows.find((row) => row.id === rootRunId);
  if (!rootRow) {
    return null;
  }

  const parsed = store.parseChainContext(rootRow);
  const rootChainContext = parsed?.ok === true ? parsed.context : null;

  const builderInput: BuildPipelineSnapshotInput = {
    rootRunId,
    runs: rows.map((row) =>
      mapRunRowToSnapshotInput(row, rootRunId, dashboardStore, rootChainContext)
    ),
    automations: collectAutomationInputs(store, rows),
    events: collectLifecycleEvents(store, rootRunId),
    inputRequests: collectPendingInputRequests(store, rootRunId),
    cursor: store.getMaxGlobalEventId(),
  };

  return buildPipelineSnapshot(builderInput, now);
}

/** Resolve the newest implement-fully root for a feature and hydrate its snapshot. */
export function resolvePipelineSnapshotByFeature(
  store: RunStore,
  dashboardStore: DashboardStore,
  workspaceId: string,
  featureId: string,
  now: number
): { rootRunId: string; snapshot: PipelineSnapshot } | null {
  const root = store.findLatestImplementFullyRootByFeature(workspaceId, featureId);
  if (!root) {
    return null;
  }
  const snapshot = hydratePipelineSnapshot(
    store,
    dashboardStore,
    root.id,
    now
  );
  if (!snapshot) {
    return null;
  }
  return { rootRunId: root.id, snapshot };
}
