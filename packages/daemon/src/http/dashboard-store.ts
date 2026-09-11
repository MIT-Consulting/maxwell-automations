import { randomUUID } from "node:crypto";
import type {
  Automation,
  AutomationOrigin,
  AutomationStatus,
  ChainConfig,
  CreateAutomationRequest,
  Run,
  RunPipelineSummary,
  RunPipelineTrackDoctorDetail,
  RunPipelineTrackSummary,
  RunPipelineWaveDoctorDetail,
  RunPipelineWaveSummary,
  RunStatus,
  TriggerConfig,
  UpdateAutomationRequest,
  Workspace,
} from "@lca/shared";
import {
  chainRunContextSchema,
  pipelineSummaryFromContext,
  resolveModelMutationInput,
} from "@lca/shared";
import { automationId } from "../config/parse.js";
import type { LcaDatabase } from "../db/index.js";
import {
  selectionFromStored,
  splitSelectionForDb,
} from "../models/selection-persist.js";
import { PipelineWaveStore } from "../runs/pipeline-wave-store.js";
import { nextCronRun } from "../triggers/cron.js";
import type { ExportRunRow } from "./export.js";

export class WorkspaceNotFoundError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace not found: ${workspaceId}`);
    this.name = "WorkspaceNotFoundError";
  }
}

export type WorkspacePathLookup = {
  found: boolean;
  path?: string;
};

export type RunDetailProjection = {
  run: Run;
  pipelineWaveDetail: RunPipelineWaveDoctorDetail | null;
  pipelineTrackDetail: RunPipelineTrackDoctorDetail | null;
};

type AutomationDbRow = {
  id: string;
  workspace_id: string;
  name: string;
  enabled: number;
  status: string;
  origin: string;
  trigger_json: string;
  prompt: string;
  model: string | null;
  model_params_json: string | null;
  model_role: string | null;
  chain_json: string | null;
  config_path: string;
  config_key: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type RunDbRow = {
  id: string;
  automation_id: string;
  workspace_id: string;
  status: string;
  agent_id: string | null;
  sdk_run_id: string | null;
  trigger_kind: string | null;
  parent_run_id: string | null;
  title: string | null;
  summary: string | null;
  model: string | null;
  model_params_json: string | null;
  chain_root_run_id: string | null;
  chain_depth: number | null;
  chain_max_depth: number | null;
  chain_max_depth_override: number | null;
  chain_stop_requested_at: string | null;
  chain_stop_reason: string | null;
  chain_handled_at: string | null;
  chain_context_json: string | null;
  pipeline_wave_id: string | null;
  pipeline_track_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Tolerant parse of persisted chain context for the board projection. Never throws. */
function pipelineFromChainContextJson(
  json: string | null
): RunPipelineSummary | null {
  if (json == null || json.trim() === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const check = chainRunContextSchema.safeParse(parsed);
  if (!check.success) {
    return null;
  }
  return pipelineSummaryFromContext(check.data);
}

type WorkspaceDbRow = {
  id: string;
  path: string;
  name: string | null;
  created_at: string;
  updated_at: string;
};

function enabledToStatus(enabled: boolean): AutomationStatus {
  return enabled ? "enabled" : "backlog";
}

function mapAutomation(row: AutomationDbRow): Automation {
  const enabled = row.enabled === 1;
  const trigger = JSON.parse(row.trigger_json) as TriggerConfig;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    enabled,
    status: row.status as AutomationStatus,
    origin: row.origin as AutomationOrigin,
    trigger,
    prompt: row.prompt,
    model: row.model,
    modelSelection: selectionFromStored(row.model, row.model_params_json),
    modelRole: row.model_role ?? undefined,
    chain: row.chain_json ? (JSON.parse(row.chain_json) as ChainConfig) : null,
    configPath: row.config_path,
    configKey: row.config_key,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt:
      enabled && trigger.type === "cron"
        ? nextCronRun(trigger.expression)
        : null,
  };
}

function mapRun(
  row: RunDbRow,
  waveSummary: RunPipelineWaveSummary | null,
  trackSummary: RunPipelineTrackSummary | null
): Run {
  return {
    id: row.id,
    automationId: row.automation_id,
    workspaceId: row.workspace_id,
    status: row.status as RunStatus,
    agentId: row.agent_id,
    sdkRunId: row.sdk_run_id,
    triggerKind: row.trigger_kind,
    parentRunId: row.parent_run_id,
    title: row.title ?? null,
    summary: row.summary ?? null,
    model: row.model ?? null,
    modelSelection: selectionFromStored(row.model, row.model_params_json),
    chainRootRunId: row.chain_root_run_id,
    chainDepth: row.chain_depth,
    chainMaxDepth: row.chain_max_depth,
    chainMaxDepthOverride: row.chain_max_depth_override,
    chainStopRequestedAt: row.chain_stop_requested_at,
    chainStopReason: row.chain_stop_reason,
    chainHandledAt: row.chain_handled_at,
    pipeline: pipelineFromChainContextJson(row.chain_context_json),
    pipelineWave: waveSummary,
    pipelineTrack: trackSummary,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkspace(row: WorkspaceDbRow): Workspace {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const AUTOMATION_COLUMNS = `id, workspace_id, name, enabled, status, origin, trigger_json, prompt,
                model, model_params_json, model_role, chain_json, config_path, config_key,
                archived_at, created_at, updated_at`;

const RUN_COLUMNS = `id, automation_id, workspace_id, status, agent_id, sdk_run_id,
                trigger_kind, parent_run_id, title, summary, model, model_params_json,
                chain_root_run_id, chain_depth, chain_max_depth, chain_max_depth_override,
                chain_stop_requested_at, chain_stop_reason, chain_handled_at,
                chain_context_json, pipeline_wave_id, pipeline_track_id,
                started_at, ended_at, created_at, updated_at`;

function selectAutomationById(db: LcaDatabase, id: string): AutomationDbRow | undefined {
  return db
    .prepare(`SELECT ${AUTOMATION_COLUMNS} FROM automations WHERE id = ?`)
    .get(id) as AutomationDbRow | undefined;
}

type WaveSummaryCache = Map<string, RunPipelineWaveSummary | null>;
type TrackSummaryCache = Map<string, RunPipelineTrackSummary | null>;

function waveSummaryCached(
  waveStore: PipelineWaveStore,
  cache: WaveSummaryCache,
  waveId: string
): RunPipelineWaveSummary | null {
  let summary = cache.get(waveId);
  if (summary === undefined) {
    summary = waveStore.boardWaveSummary(waveId);
    cache.set(waveId, summary);
  }
  return summary;
}

function trackSummaryCached(
  waveStore: PipelineWaveStore,
  cache: TrackSummaryCache,
  trackId: string
): RunPipelineTrackSummary | null {
  let summary = cache.get(trackId);
  if (summary === undefined) {
    summary = waveStore.boardTrackSummary(trackId);
    cache.set(trackId, summary);
  }
  return summary;
}

function mapRunRows(
  rows: RunDbRow[],
  waveStore: PipelineWaveStore
): Run[] {
  const waveCache: WaveSummaryCache = new Map();
  const trackCache: TrackSummaryCache = new Map();
  return rows.map((row) => {
    const waveSummary = row.pipeline_wave_id
      ? waveSummaryCached(waveStore, waveCache, row.pipeline_wave_id)
      : null;
    const trackSummary = row.pipeline_track_id
      ? trackSummaryCached(waveStore, trackCache, row.pipeline_track_id)
      : null;
    return mapRun(row, waveSummary, trackSummary);
  });
}

/**
 * Read surface + arm/disarm writes the dashboard REST layer talks to. Keeps the
 * camelCase shared-entity mapping in one place, separate from the run engine's
 * internal snake_case row types.
 */
export class DashboardStore {
  private readonly waveStore: PipelineWaveStore;

  constructor(private readonly db: LcaDatabase) {
    this.waveStore = new PipelineWaveStore(db);
  }

  listAutomations(): Automation[] {
    const rows = this.db
      .prepare(
        `SELECT ${AUTOMATION_COLUMNS}
         FROM automations
         WHERE archived_at IS NULL
         ORDER BY name COLLATE NOCASE ASC`
      )
      .all() as AutomationDbRow[];
    return rows.map(mapAutomation);
  }

  listRuns(limit = 200): Run[] {
    const rows = this.db
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM runs
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as RunDbRow[];
    return mapRunRows(rows, this.waveStore);
  }

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
      .get(id) as RunDbRow | undefined;
    if (!row) return undefined;
    return mapRunRows([row], this.waveStore)[0];
  }

  /** Detail/doctor projection with branch/commit/cleanup; never used for board list. */
  getRunDetail(id: string): RunDetailProjection | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    const row = this.db
      .prepare(`SELECT pipeline_wave_id, pipeline_track_id FROM runs WHERE id = ?`)
      .get(id) as
      | { pipeline_wave_id: string | null; pipeline_track_id: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      run,
      pipelineWaveDetail: row.pipeline_wave_id
        ? this.waveStore.doctorWaveDetail(row.pipeline_wave_id)
        : null,
      pipelineTrackDetail: row.pipeline_track_id
        ? this.waveStore.doctorTrackDetail(row.pipeline_track_id)
        : null,
    };
  }

  /**
   * Enriched, self-contained run history for export. Joins the automation name
   * and workspace path and counts events, so the dump needs no further lookups.
   * Optionally filtered to one workspace; newest first.
   */
  exportRuns(opts: { workspaceId?: string; limit?: number } = {}): ExportRunRow[] {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 10000;
    const where = opts.workspaceId ? "WHERE r.workspace_id = @workspaceId" : "";
    const params: Record<string, unknown> = { limit };
    if (opts.workspaceId) {
      params.workspaceId = opts.workspaceId;
    }
    const rows = this.db
      .prepare(
        `SELECT
           r.id AS id,
           r.automation_id AS automationId,
           COALESCE(a.name, r.automation_id) AS automationName,
           r.workspace_id AS workspaceId,
           COALESCE(w.path, r.workspace_id) AS workspacePath,
           r.status AS status,
           r.trigger_kind AS triggerKind,
           r.created_at AS createdAt,
           r.started_at AS startedAt,
           r.ended_at AS endedAt,
           (SELECT COUNT(*) FROM run_events e WHERE e.run_id = r.id) AS eventCount
         FROM runs r
         LEFT JOIN automations a ON a.id = r.automation_id
         LEFT JOIN workspaces w ON w.id = r.workspace_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT @limit`
      )
      .all(params) as ExportRunRow[];
    return rows;
  }

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare(
        `SELECT id, path, name, created_at, updated_at
         FROM workspaces
         WHERE path != '__global__'
         ORDER BY path ASC`
      )
      .all() as WorkspaceDbRow[];
    return rows.map(mapWorkspace);
  }

  getWorkspacePath(workspaceId: string): WorkspacePathLookup {
    const row = this.db
      .prepare(`SELECT path FROM workspaces WHERE id = ?`)
      .get(workspaceId) as { path: string } | undefined;
    if (!row) {
      return { found: false };
    }
    if (row.path === "__global__") {
      return { found: true };
    }
    return { found: true, path: row.path };
  }

  /**
   * Arm (enabled=true) or disarm an automation. Returns the updated automation,
   * or undefined if it does not exist / is archived. The YAML config remains the
   * declarative default; a manual toggle persists until the next config reconcile.
   */
  setAutomationEnabled(id: string, enabled: boolean): Automation | undefined {
    const status = enabledToStatus(enabled);
    const info = this.db
      .prepare(
        `UPDATE automations
         SET enabled = @enabled, status = @status, updated_at = datetime('now')
         WHERE id = @id AND archived_at IS NULL`
      )
      .run({ id, enabled: enabled ? 1 : 0, status });
    if (info.changes === 0) {
      return undefined;
    }
    const row = selectAutomationById(this.db, id);
    return row ? mapAutomation(row) : undefined;
  }

  createAutomation(input: CreateAutomationRequest): Automation {
    const workspace = this.db
      .prepare("SELECT id FROM workspaces WHERE id = ?")
      .get(input.workspaceId) as { id: string } | undefined;
    if (!workspace) {
      throw new WorkspaceNotFoundError(input.workspaceId);
    }

    const enabled = input.enabled === true;
    const status = enabledToStatus(enabled);
    const configKey = `dashboard:${randomUUID()}`;
    const configPath = "__dashboard__";
    const id = automationId(input.workspaceId, configKey);

    const chainJson = input.chain ? JSON.stringify(input.chain) : null;
    const selection = resolveModelMutationInput({
      model: input.model,
      modelSelection: input.modelSelection,
    });
    const { model, modelParamsJson } = splitSelectionForDb(selection ?? null);

    this.db
      .prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          model_params_json, model_role, config_path, config_key, origin,
          archived_at, updated_at, chain_json
        ) VALUES (
          @id, @workspaceId, @name, @enabled, @status, @triggerJson, @prompt, @model,
          @modelParamsJson, @modelRole, @configPath, @configKey, 'dashboard',
          NULL, datetime('now'), @chainJson
        )`
      )
      .run({
        id,
        workspaceId: input.workspaceId,
        name: input.name,
        enabled: enabled ? 1 : 0,
        status,
        triggerJson: JSON.stringify(input.trigger),
        prompt: input.prompt,
        model,
        modelParamsJson,
        modelRole: input.modelRole ?? null,
        configPath,
        configKey,
        chainJson,
      });

    const row = selectAutomationById(this.db, id);
    if (!row) {
      throw new Error(`Failed to load automation after insert: ${id}`);
    }
    return mapAutomation(row);
  }

  updateAutomation(
    id: string,
    patch: UpdateAutomationRequest
  ): Automation | "not_found" | "forbidden" {
    const existing = selectAutomationById(this.db, id);
    if (!existing || existing.archived_at !== null) {
      return "not_found";
    }
    if (existing.origin !== "dashboard") {
      return "forbidden";
    }

    const enabled =
      patch.enabled !== undefined ? patch.enabled : existing.enabled === 1;
    const status =
      patch.enabled !== undefined ? enabledToStatus(patch.enabled) : existing.status;

    const chainJson = patch.chain ? JSON.stringify(patch.chain) : null;
    const selection = resolveModelMutationInput({
      model: patch.model,
      modelSelection: patch.modelSelection,
    });
    const modelProvided = selection !== undefined ? 1 : 0;
    const stored =
      selection === undefined
        ? { model: null, modelParamsJson: null }
        : splitSelectionForDb(selection);

    const info = this.db
      .prepare(
        `UPDATE automations SET
          name = COALESCE(@name, name),
          trigger_json = COALESCE(@triggerJson, trigger_json),
          prompt = COALESCE(@prompt, prompt),
          model = CASE WHEN @modelProvided THEN @model ELSE model END,
          model_params_json = CASE WHEN @modelProvided THEN @modelParamsJson ELSE model_params_json END,
          model_role = CASE WHEN @modelRoleProvided THEN @modelRole ELSE model_role END,
          chain_json = CASE WHEN @chainProvided THEN @chainJson ELSE chain_json END,
          enabled = @enabled,
          status = @status,
          updated_at = datetime('now')
         WHERE id = @id AND archived_at IS NULL`
      )
      .run({
        id,
        name: patch.name ?? null,
        triggerJson: patch.trigger ? JSON.stringify(patch.trigger) : null,
        prompt: patch.prompt ?? null,
        modelProvided,
        model: stored.model,
        modelParamsJson: stored.modelParamsJson,
        modelRoleProvided: patch.modelRole !== undefined ? 1 : 0,
        modelRole: patch.modelRole !== undefined ? patch.modelRole : null,
        chainProvided: patch.chain !== undefined ? 1 : 0,
        chainJson,
        enabled: enabled ? 1 : 0,
        status,
      });

    if (info.changes === 0) {
      return "not_found";
    }

    const row = selectAutomationById(this.db, id);
    return row ? mapAutomation(row) : "not_found";
  }

  deleteAutomation(id: string): "ok" | "not_found" | "forbidden" {
    const existing = selectAutomationById(this.db, id);
    if (!existing || existing.archived_at !== null) {
      return "not_found";
    }
    if (existing.origin !== "dashboard") {
      return "forbidden";
    }

    const info = this.db
      .prepare(
        `UPDATE automations SET
          archived_at = datetime('now'),
          enabled = 0,
          status = 'backlog',
          updated_at = datetime('now')
         WHERE id = @id AND archived_at IS NULL`
      )
      .run({ id });

    return info.changes === 0 ? "not_found" : "ok";
  }
}
