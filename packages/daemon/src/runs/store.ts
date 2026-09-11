import type {
  ChainBudgetExtensionEvidence,
  ChainControlRequest,
  ChainControlResponse,
  ChainRunContext,
  ModelSelection,
  RunEscalationAction,
  RunEscalationRefusal,
  RunStatus,
} from "@lca/shared";
import {
  CHAIN_MAX_DEPTH_MAX,
  GENERATED_CONFIG_KEY_PREFIX,
  chainRunContextSchema,
  modelSelectionFromLegacy,
  normalizeModelSelection,
} from "@lca/shared";
import { randomUUID } from "node:crypto";
import type { LcaDatabase } from "../db/index.js";
import type { DaemonEventSink } from "../events.js";
import { DEFAULT_SETTINGS } from "../config/settings.js";
import { capEventPayload } from "../events/payload-cap.js";
import { splitSelectionForDb } from "../models/selection-persist.js";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
} from "../pipelines/halt-discovery.js";

export type RunRow = {
  id: string;
  automation_id: string;
  workspace_id: string;
  status: RunStatus;
  agent_id: string | null;
  sdk_run_id: string | null;
  trigger_kind: string | null;
  prompt: string | null;
  title: string | null;
  summary: string | null;
  parent_run_id: string | null;
  model: string | null;
  model_params_json: string | null;
  chain_root_run_id: string | null;
  chain_depth: number | null;
  chain_max_depth: number | null;
  chain_context_json: string | null;
  chain_stop_requested_at: string | null;
  chain_stop_reason: string | null;
  chain_max_depth_override: number | null;
  chain_handled_at: string | null;
  pipeline_wave_id: string | null;
  pipeline_track_id: string | null;
  execution_cwd: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export type ApplyChainControlResult =
  | { ok: true; response: ChainControlResponse }
  | {
      ok: false;
      reason:
        | "not-found"
        | "terminal"
        | "rebudget-conflict"
        | "extend-conflict"
        | "no-budget-context";
    };

/** Facts needed to perform an escalation after eligibility checks pass. */
export type EscalationEligibility = {
  row: RunRow;
  context: ChainRunContext;
  effectiveMaxDepth: number;
  /** Resolved successor automation id; set for skip, null for retry/abort. */
  successorAutomationId: string | null;
};

export type EscalationEligibilityResult =
  | { ok: true; eligibility: EscalationEligibility }
  | { ok: false; reason: RunEscalationRefusal };

/** Same-root `run.pipeline-escalated` row for halt-recovery lineage assembly. */
export type PipelineEscalationLineageRow = {
  runId: string;
  chainDepth: number | null;
  /** Serialized JSON payload; caller decodes `actor`. */
  payload: string;
  createdAt: string;
  seq: number;
};

/** Bounded same-root run fields for halt-discovery diagnosis evidence. */
export type DiagnosisLineageRunRow = {
  id: string;
  automationId: string;
  status: RunStatus;
  parentRunId: string | null;
  chainDepth: number | null;
  triggerKind: string | null;
  endedAt: string | null;
  createdAt: string;
};

const PIPELINE_RESUME_CANDIDATE_LIMIT = 100;

export type ParsedChainContext =
  | { ok: true; context: ChainRunContext }
  | { ok: false; reason: string };

export type RunStoreOptions = {
  /** Hard cap on a single event payload in bytes; larger payloads are truncated. */
  maxEventPayloadBytes?: number;
};

export type AutomationRow = {
  id: string;
  workspace_id: string;
  name: string;
  config_key: string;
  prompt: string;
  model: string | null;
  model_params_json: string | null;
  model_role: string | null;
  trigger_json: string;
  chain_json: string | null;
};

export type QueuedRunMessageStatus = "pending" | "delivered" | "cancelled";

export type QueuedRunMessageRow = {
  id: string;
  run_id: string;
  message: string;
  attachments_json: string | null;
  status: QueuedRunMessageStatus;
  created_at: string;
  delivered_at: string | null;
  cancelled_at: string | null;
};

export class RunStore {
  private readonly maxEventPayloadBytes: number;

  constructor(
    private readonly db: LcaDatabase,
    private readonly events?: DaemonEventSink,
    options: RunStoreOptions = {}
  ) {
    this.maxEventPayloadBytes =
      options.maxEventPayloadBytes ?? DEFAULT_SETTINGS.maxEventPayloadBytes;
  }

  getAutomation(id: string): AutomationRow | undefined {
    return this.db
      .prepare(
        `SELECT id, workspace_id, name, config_key, prompt, model, model_params_json,
                model_role, trigger_json, chain_json
         FROM automations WHERE id = ? AND archived_at IS NULL`
      )
      .get(id) as AutomationRow | undefined;
  }

  /**
   * Lookup by id regardless of archive state. Use for history and for
   * resuming runs whose automation may have been archived (e.g. renamed)
   * mid-flight; the active trigger path should use {@link getAutomation}.
   */
  getAutomationByIdIncludingArchived(id: string): AutomationRow | undefined {
    return this.db
      .prepare(
        `SELECT id, workspace_id, name, config_key, prompt, model, model_params_json,
                model_role, trigger_json, chain_json
         FROM automations WHERE id = ?`
      )
      .get(id) as AutomationRow | undefined;
  }

  getWorkspacePath(workspaceId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT path FROM workspaces WHERE id = ?`)
      .get(workspaceId) as { path: string } | undefined;
    if (!row || row.path === "__global__") {
      return undefined;
    }
    return row.path;
  }

  insertRun(input: {
    id: string;
    automationId: string;
    workspaceId: string;
    triggerKind: string;
    prompt: string;
    parentRunId?: string | null;
    modelSelectionOverride?: ModelSelection | string | null;
    chainRootRunId?: string | null;
    chainDepth?: number | null;
    chainMaxDepth?: number | null;
    chainContext?: ChainRunContext | null;
    pipelineWaveId?: string | null;
    pipelineTrackId?: string | null;
    executionCwd?: string | null;
  }): void {
    const override = input.modelSelectionOverride;
    const hasModelOverride = override !== undefined;
    let storedModel: { model: string | null; modelParamsJson: string | null } = {
      model: null,
      modelParamsJson: null,
    };
    if (override !== undefined) {
      if (override === null) {
        storedModel = splitSelectionForDb(null);
      } else if (typeof override === "string") {
        storedModel = splitSelectionForDb(modelSelectionFromLegacy(override));
      } else {
        storedModel = splitSelectionForDb(normalizeModelSelection(override));
      }
    }

    const contextJson =
      input.chainContext == null
        ? null
        : JSON.stringify(input.chainContext);

    this.db
      .prepare(
        `INSERT INTO runs (
           id, automation_id, workspace_id, status, trigger_kind, prompt,
           parent_run_id, model, model_params_json,
           chain_root_run_id, chain_depth, chain_max_depth, chain_context_json,
           pipeline_wave_id, pipeline_track_id, execution_cwd
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.automationId,
        input.workspaceId,
        input.triggerKind,
        input.prompt,
        input.parentRunId ?? null,
        hasModelOverride ? storedModel.model : null,
        hasModelOverride ? storedModel.modelParamsJson : null,
        input.chainRootRunId ?? null,
        input.chainDepth ?? null,
        input.chainMaxDepth ?? null,
        contextJson,
        input.pipelineWaveId ?? null,
        input.pipelineTrackId ?? null,
        input.executionCwd ?? null
      );
  }

  /**
   * Validate persisted `chain_context_json`. Corrupt rows return an unusable
   * result (never throw) so daemon startup and projections stay healthy.
   */
  parseChainContext(row: RunRow): ParsedChainContext | null {
    if (row.chain_context_json == null || row.chain_context_json.trim() === "") {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.chain_context_json);
    } catch {
      const detail = "chain_context_json is not valid JSON";
      console.error(
        `[lca-daemon ${new Date().toISOString()}] run ${row.id}: ${detail}`
      );
      return { ok: false, reason: detail };
    }
    const check = chainRunContextSchema.safeParse(parsed);
    if (!check.success) {
      const detail = check.error.issues[0]?.message ?? "invalid chain context";
      console.error(
        `[lca-daemon ${new Date().toISOString()}] run ${row.id}: unusable chain context — ${detail}`
      );
      return { ok: false, reason: detail };
    }
    return { ok: true, context: check.data };
  }

  /** Count runs occupying an execution slot (running + needs_input + paused). */
  countActiveRuns(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs WHERE status IN ('running', 'needs_input', 'paused')`
      )
      .get() as { n: number };
    return row.n;
  }

  /** Oldest still-queued run, used by the concurrency pump to fill free slots. */
  getOldestQueuedRun(): RunRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1`
      )
      .get() as RunRow | undefined;
  }

  getRun(id: string): RunRow | undefined {
    return this.db
      .prepare(`SELECT * FROM runs WHERE id = ?`)
      .get(id) as RunRow | undefined;
  }

  /**
   * Record a run-scoped stop, absolute re-budget, and/or additive budget
   * extension. Only accepted while the run is non-terminal. Write-once per
   * budget decision; identical re-applies are no-ops.
   */
  applyChainControl(
    runId: string,
    request: ChainControlRequest
  ): ApplyChainControlResult {
    const apply = this.db.transaction((): ApplyChainControlResult => {
      const row = this.getRun(runId);
      if (!row) {
        return { ok: false, reason: "not-found" };
      }
      if (TERMINAL_RUN_STATUSES.has(row.status)) {
        return { ok: false, reason: "terminal" };
      }

      if (request.rebudget !== undefined) {
        const existing = row.chain_max_depth_override;
        if (
          existing != null &&
          existing !== request.rebudget.maxDepth
        ) {
          return { ok: false, reason: "rebudget-conflict" };
        }
      }

      let budgetExtension: ChainBudgetExtensionEvidence | undefined;
      let writeExtend = false;
      let extendOverride: number | null = null;

      if (request.extendBudget !== undefined) {
        const parsedContext = this.parseChainContext(row);
        const contextAware =
          parsedContext?.ok === true &&
          row.chain_depth != null &&
          row.chain_max_depth != null &&
          row.chain_root_run_id != null;
        if (!contextAware || row.chain_max_depth == null) {
          return { ok: false, reason: "no-budget-context" };
        }

        const requested = request.extendBudget.transitions;
        const desiredFromBase = Math.min(
          row.chain_max_depth + requested,
          CHAIN_MAX_DEPTH_MAX
        );

        if (row.chain_max_depth_override != null) {
          if (row.chain_max_depth_override !== desiredFromBase) {
            return { ok: false, reason: "extend-conflict" };
          }
          // Identical retry: no write, no growth.
          budgetExtension = {
            previousEffectiveMaxDepth: row.chain_max_depth_override,
            requestedTransitions: requested,
            appliedTransitions: 0,
            clamped: row.chain_max_depth + requested > CHAIN_MAX_DEPTH_MAX,
          };
        } else {
          const previousEffective = row.chain_max_depth;
          const uncapped = previousEffective + requested;
          const resulting = Math.min(uncapped, CHAIN_MAX_DEPTH_MAX);
          const applied = resulting - previousEffective;
          budgetExtension = {
            previousEffectiveMaxDepth: previousEffective,
            requestedTransitions: requested,
            appliedTransitions: applied,
            clamped: uncapped > CHAIN_MAX_DEPTH_MAX,
          };
          writeExtend = true;
          extendOverride = resulting;
        }
      }

      const writeStop =
        request.stop !== undefined && row.chain_stop_requested_at == null;
      const writeRebudget =
        request.rebudget !== undefined &&
        row.chain_max_depth_override == null;

      if (writeStop || writeRebudget || writeExtend) {
        this.db
          .prepare(
            `UPDATE runs SET
              chain_stop_requested_at = CASE
                WHEN @writeStop THEN datetime('now')
                ELSE chain_stop_requested_at
              END,
              chain_stop_reason = CASE
                WHEN @writeStop THEN @stopReason
                ELSE chain_stop_reason
              END,
              chain_max_depth_override = CASE
                WHEN @writeRebudget THEN @rebudgetOverride
                WHEN @writeExtend THEN @extendOverride
                ELSE chain_max_depth_override
              END,
              updated_at = datetime('now')
             WHERE id = @runId`
          )
          .run({
            runId,
            writeStop: writeStop ? 1 : 0,
            stopReason: writeStop ? request.stop!.reason : null,
            writeRebudget: writeRebudget ? 1 : 0,
            rebudgetOverride: writeRebudget
              ? request.rebudget!.maxDepth
              : null,
            writeExtend: writeExtend ? 1 : 0,
            extendOverride,
          });
      }

      const after = this.getRun(runId);
      if (!after) {
        return { ok: false, reason: "not-found" };
      }
      return {
        ok: true,
        response: this.toChainControlResponse(after, budgetExtension),
      };
    });

    return apply();
  }

  /**
   * One-shot claim for the chain transition. Returns true iff this caller
   * won the claim. Conditional UPDATE is the entire guard — no read-first.
   */
  claimChainHandled(runId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE runs SET chain_handled_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND chain_handled_at IS NULL`
      )
      .run(runId);
    return result.changes === 1;
  }

  /**
   * Terminal-safe stop marker for operator abort. Write-once: an existing
   * marker is an idempotent success (timestamp and reason untouched).
   */
  markChainStopped(runId: string, reason: string): boolean {
    const row = this.getRun(runId);
    if (!row) {
      return false;
    }
    if (row.chain_stop_requested_at != null) {
      return true;
    }
    this.db
      .prepare(
        `UPDATE runs SET
           chain_stop_requested_at = datetime('now'),
           chain_stop_reason = ?,
           updated_at = datetime('now')
         WHERE id = ? AND chain_stop_requested_at IS NULL`
      )
      .run(reason, runId);
    return true;
  }

  /**
   * Eligibility for operator escalation. Does not claim or mutate.
   */
  getEscalationEligibility(
    runId: string,
    action: RunEscalationAction
  ): EscalationEligibilityResult {
    const row = this.getRun(runId);
    if (!row) {
      return { ok: false, reason: "not-found" };
    }

    const parsedContext = this.parseChainContext(row);
    const contextAware =
      parsedContext?.ok === true &&
      row.chain_depth != null &&
      row.chain_max_depth != null &&
      row.chain_root_run_id != null;

    if (
      row.chain_root_run_id == null ||
      row.chain_depth == null ||
      row.chain_max_depth == null ||
      !parsedContext ||
      !parsedContext.ok ||
      !contextAware
    ) {
      return { ok: false, reason: "not-pipeline" };
    }

    if (row.chain_handled_at != null) {
      return { ok: false, reason: "already-chained" };
    }

    if (
      (action === "retry" || action === "skip") &&
      !TERMINAL_RUN_STATUSES.has(row.status)
    ) {
      return { ok: false, reason: "not-halted" };
    }

    if (action === "retry" && row.chain_depth === 0) {
      return { ok: false, reason: "root-run" };
    }

    const effectiveMaxDepth =
      row.chain_max_depth_override ?? row.chain_max_depth;

    let successorAutomationId: string | null = null;
    if (action === "skip") {
      if (row.chain_depth >= effectiveMaxDepth) {
        return { ok: false, reason: "budget-exhausted" };
      }

      const automation = this.getAutomationByIdIncludingArchived(
        row.automation_id
      );
      if (!automation?.chain_json) {
        return { ok: false, reason: "no-successor" };
      }
      let chain: { next?: string };
      try {
        chain = JSON.parse(automation.chain_json) as { next?: string };
      } catch {
        return { ok: false, reason: "no-successor" };
      }
      if (!chain.next) {
        return { ok: false, reason: "no-successor" };
      }
      successorAutomationId = this.resolveChainTarget(
        row.workspace_id,
        chain.next
      );
      if (!successorAutomationId) {
        return { ok: false, reason: "no-successor" };
      }
    }

    return {
      ok: true,
      eligibility: {
        row,
        context: parsedContext.context,
        effectiveMaxDepth,
        successorAutomationId,
      },
    };
  }

  /**
   * Completed context-aware runs whose successor transition was never claimed,
   * ended inside the lookback window. Newest first; hard-capped.
   */
  listPipelineResumeCandidates(lookbackMs: number, nowMs = Date.now()): RunRow[] {
    if (lookbackMs <= 0) {
      return [];
    }
    // Match SQLite `datetime('now')` shape (`YYYY-MM-DD HH:MM:SS`) for lex compare.
    const cutoff = new Date(nowMs - lookbackMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status = 'completed'
           AND chain_root_run_id IS NOT NULL
           AND chain_handled_at IS NULL
           AND chain_stop_requested_at IS NULL
           AND ended_at IS NOT NULL
           AND ended_at >= ?
         ORDER BY ended_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(cutoff, PIPELINE_RESUME_CANDIDATE_LIMIT) as RunRow[];
  }

  /**
   * Same-root `run.pipeline-escalated` events for halt-recovery lineage.
   * Ordered deterministically; runtime decodes `actor` from payload.
   */
  listPipelineEscalationEvents(
    chainRootRunId: string
  ): PipelineEscalationLineageRow[] {
    return (
      this.db
        .prepare(
          `SELECT r.id AS run_id, r.chain_depth AS chain_depth,
                  e.payload AS payload, e.created_at AS created_at, e.seq AS seq
           FROM run_events e
           INNER JOIN runs r ON r.id = e.run_id
           WHERE e.event_type = 'run.pipeline-escalated'
             AND r.chain_root_run_id = ?
           ORDER BY e.created_at ASC, r.rowid ASC, e.seq ASC`
        )
        .all(chainRootRunId) as Array<{
        run_id: string;
        chain_depth: number | null;
        payload: string;
        created_at: string;
        seq: number;
      }>
    ).map((row) => ({
      runId: row.run_id,
      chainDepth: row.chain_depth,
      payload: row.payload,
      createdAt: row.created_at,
      seq: row.seq,
    }));
  }

  /**
   * Bounded same-root run projection for halt-discovery fact assembly.
   * Depth then rowid order; empty when limit is not a positive integer.
   */
  listSameRootRunsForDiagnosis(
    chainRootRunId: string,
    limit: number
  ): DiagnosisLineageRunRow[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      return [];
    }
    return (
      this.db
        .prepare(
          `SELECT id, automation_id, status, parent_run_id, chain_depth,
                  trigger_kind, ended_at, created_at
           FROM runs
           WHERE chain_root_run_id = ?
           ORDER BY chain_depth ASC, rowid ASC
           LIMIT ?`
        )
        .all(chainRootRunId, limit) as Array<{
        id: string;
        automation_id: string;
        status: RunStatus;
        parent_run_id: string | null;
        chain_depth: number | null;
        trigger_kind: string | null;
        ended_at: string | null;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      automationId: row.automation_id,
      status: row.status,
      parentRunId: row.parent_run_id,
      chainDepth: row.chain_depth,
      triggerKind: row.trigger_kind,
      endedAt: row.ended_at,
      createdAt: row.created_at,
    }));
  }

  /**
   * Failed context-aware runs eligible for post-terminal halt recovery.
   * Newest first; hard-capped; empty when lookback is zero.
   */
  listPipelineHaltRecoveryCandidates(
    lookbackMs: number,
    nowMs = Date.now()
  ): RunRow[] {
    if (lookbackMs <= 0) {
      return [];
    }
    const cutoff = new Date(nowMs - lookbackMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status = 'failed'
           AND chain_root_run_id IS NOT NULL
           AND chain_handled_at IS NULL
           AND chain_stop_requested_at IS NULL
           AND ended_at IS NOT NULL
           AND ended_at >= ?
           AND NOT EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.run_id = runs.id
               AND e.event_type = 'run.pipeline-halt-unrecovered'
           )
         ORDER BY ended_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(cutoff, PIPELINE_RESUME_CANDIDATE_LIMIT) as RunRow[];
  }

  /**
   * Failed context-aware unrecovered halts missing a discovery lifecycle event.
   * Newest first; hard-capped; empty when lookback is zero.
   * Wave/track rows stay in the set so the trigger can record `wave-scoped`.
   */
  listPipelineHaltDiscoveryCandidates(
    lookbackMs: number,
    nowMs = Date.now()
  ): RunRow[] {
    if (lookbackMs <= 0) {
      return [];
    }
    const cutoff = new Date(nowMs - lookbackMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status = 'failed'
           AND chain_root_run_id IS NOT NULL
           AND chain_handled_at IS NULL
           AND chain_stop_requested_at IS NULL
           AND ended_at IS NOT NULL
           AND ended_at >= ?
           AND EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.run_id = runs.id
               AND e.event_type = 'run.pipeline-halt-unrecovered'
           )
           AND NOT EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.run_id = runs.id
               AND e.event_type IN (
                 'run.pipeline-halt-discovery-requested',
                 'run.pipeline-halt-discovery-skipped',
                 'run.pipeline-halt-discovery-failed'
               )
           )
         ORDER BY ended_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(cutoff, PIPELINE_RESUME_CANDIDATE_LIMIT) as RunRow[];
  }

  /**
   * Failed sources with an unresolved discovery request whose exact advisory
   * child is missing or terminal (failed/cancelled). Newest first; hard-capped;
   * empty when lookback is zero. Uses the same child identity as
   * {@link findHaltDiscoveryAdvisoryChild}.
   */
  listUnresolvedHaltDiscoveryAdvisoryCandidates(
    lookbackMs: number,
    nowMs = Date.now()
  ): RunRow[] {
    if (lookbackMs <= 0) {
      return [];
    }
    const cutoff = new Date(nowMs - lookbackMs)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "");
    const configKey =
      GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;
    const childStatusSql = `(
      SELECT r.status
      FROM runs r
      JOIN automations a ON a.id = r.automation_id
      WHERE r.parent_run_id = runs.id
        AND r.trigger_kind = ?
        AND a.config_key = ?
      ORDER BY r.created_at ASC, r.rowid ASC
      LIMIT 1
    )`;
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status = 'failed'
           AND ended_at IS NOT NULL
           AND ended_at >= ?
           AND EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.run_id = runs.id
               AND e.event_type = 'run.pipeline-halt-discovery-requested'
           )
           AND NOT EXISTS (
             SELECT 1 FROM run_events e
             WHERE e.run_id = runs.id
               AND e.event_type = 'run.pipeline-halt-discovery-failed'
           )
           AND (
             ${childStatusSql} IS NULL
             OR ${childStatusSql} IN ('failed', 'cancelled')
           )
         ORDER BY ended_at DESC, rowid DESC
         LIMIT ?`
      )
      .all(
        cutoff,
        HALT_DISCOVERY_TRIGGER_KIND,
        configKey,
        HALT_DISCOVERY_TRIGGER_KIND,
        configKey,
        PIPELINE_RESUME_CANDIDATE_LIMIT
      ) as RunRow[];
  }

  /**
   * Oldest halt-discovery advisory child for a source run.
   * Includes archived generated automations so identity survives reconcile.
   */
  findHaltDiscoveryAdvisoryChild(sourceRunId: string): RunRow | undefined {
    const configKey =
      GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY;
    return this.db
      .prepare(
        `SELECT r.*
         FROM runs r
         JOIN automations a ON a.id = r.automation_id
         WHERE r.parent_run_id = ?
           AND r.trigger_kind = ?
           AND a.config_key = ?
         ORDER BY r.created_at ASC, r.rowid ASC
         LIMIT 1`
      )
      .get(
        sourceRunId,
        HALT_DISCOVERY_TRIGGER_KIND,
        configKey
      ) as RunRow | undefined;
  }

  private toChainControlResponse(
    row: RunRow,
    budgetExtension?: ChainBudgetExtensionEvidence
  ): ChainControlResponse {
    return {
      runId: row.id,
      depth: row.chain_depth,
      effectiveMaxDepth:
        row.chain_max_depth_override ?? row.chain_max_depth,
      maxDepth: row.chain_max_depth,
      maxDepthOverride: row.chain_max_depth_override,
      stopRequested: row.chain_stop_requested_at != null,
      stopReason: row.chain_stop_reason,
      ...(budgetExtension !== undefined ? { budgetExtension } : {}),
    };
  }

  /**
   * Atomically set or clear the per-run model override (id + params).
   * Accepts a canonical selection or a legacy id string.
   */
  setRunModel(
    runId: string,
    model: ModelSelection | string | null
  ): void {
    const selection =
      model === null
        ? null
        : typeof model === "string"
          ? modelSelectionFromLegacy(model)
          : normalizeModelSelection(model);
    const stored = splitSelectionForDb(selection);
    this.db
      .prepare(
        `UPDATE runs
         SET model = ?, model_params_json = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(stored.model, stored.modelParamsJson, runId);
  }

  /**
   * Resolve a chain `next` ref to an automation id in the same workspace.
   * Prefers `config_key` match, then a unique non-archived `name` match.
   */
  resolveChainTarget(workspaceId: string, ref: string): string | null {
    const byKey = this.db
      .prepare(
        `SELECT id FROM automations
         WHERE workspace_id = ? AND config_key = ? AND archived_at IS NULL`
      )
      .get(workspaceId, ref) as { id: string } | undefined;
    if (byKey) {
      return byKey.id;
    }

    const byName = this.db
      .prepare(
        `SELECT id FROM automations
         WHERE workspace_id = ? AND name = ? AND archived_at IS NULL`
      )
      .all(workspaceId, ref) as Array<{ id: string }>;
    if (byName.length === 1) {
      return byName[0].id;
    }
    return null;
  }

  /** Number of ancestor runs via `parent_run_id` (stops at 100 hops). */
  chainDepth(runId: string): number {
    let depth = 0;
    let current = this.getRun(runId);
    const maxHops = 100;
    while (depth < maxHops && current?.parent_run_id) {
      depth += 1;
      current = this.getRun(current.parent_run_id);
    }
    return depth;
  }

  listRunEvents(runId: string): Array<{
    seq: number;
    event_type: string;
    payload: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT seq, event_type, payload, created_at FROM run_events
         WHERE run_id = ? ORDER BY seq ASC`
      )
      .all(runId) as Array<{
      seq: number;
      event_type: string;
      payload: string;
      created_at: string;
    }>;
  }

  countRunEvents(runId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?`)
      .get(runId) as { n: number };
    return row.n;
  }

  setStatus(runId: string, status: RunStatus): void {
    const ended =
      status === "completed" ||
      status === "failed" ||
      status === "cancelled";
    this.db
      .prepare(
        `UPDATE runs SET
          status = @status,
          started_at = COALESCE(started_at, CASE WHEN @status = 'running' THEN datetime('now') ELSE started_at END),
          ended_at = CASE WHEN @ended THEN datetime('now') ELSE ended_at END,
          updated_at = datetime('now')
         WHERE id = @runId`
      )
      .run({ runId, status, ended: ended ? 1 : 0 });
    this.events?.emitRunStatus(runId, status);
  }

  /**
   * Halt-discovery card-host only: reopen `completed → needs_input` after a
   * durable pending briefing exists. Preserves `ended_at`, claim, stop, budget,
   * and agent/session ids. Returns whether the row changed.
   */
  reopenCompletedHaltDiscoveryAdvisoryForInput(runId: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE runs SET
           status = 'needs_input',
           updated_at = datetime('now')
         WHERE id = ?
           AND status = 'completed'`
      )
      .run(runId);
    if (info.changes > 0) {
      this.events?.emitRunStatus(runId, "needs_input");
      return true;
    }
    return false;
  }

  setAgentIds(
    runId: string,
    agentId: string,
    sdkRunId: string
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET agent_id = ?, sdk_run_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(agentId, sdkRunId, runId);
  }

  /**
   * Atomically persist generated title+summary once for an eligible terminal run.
   * Returns true only when the row was updated (completed/failed and both still null).
   */
  setRunMetadataIfEligible(
    runId: string,
    metadata: { title: string; summary: string }
  ): boolean {
    const title = metadata.title.trim();
    const summary = metadata.summary.trim();
    if (!title || !summary) return false;
    const info = this.db
      .prepare(
        `UPDATE runs
         SET title = ?, summary = ?, updated_at = datetime('now')
         WHERE id = ?
           AND status IN ('completed', 'failed')
           AND title IS NULL
           AND summary IS NULL`
      )
      .run(title, summary, runId);
    return info.changes > 0;
  }

  /** Runs with a saved local SDK agent session (any status). */
  listRunsWithLocalAgent(): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE agent_id IS NOT NULL
           AND sdk_run_id IS NOT NULL
           AND agent_id NOT LIKE 'bc-%'
         ORDER BY created_at ASC`
      )
      .all() as RunRow[];
  }

  /**
   * Cap oversized payloads via shared field-aware trimming (tool_call heavy
   * leaves) with the blunt `_truncated` preview envelope as backstop.
   */
  private capPayload(eventType: string, payloadJson: string): string {
    return capEventPayload(eventType, payloadJson, this.maxEventPayloadBytes);
  }

  /**
   * Keep only the most recent `keep` events for a run; delete the older tail.
   * Called when a run ends so long, chatty runs don't grow the SQLite file
   * without bound. No-op when the run is already under the cap.
   */
  pruneRunEvents(runId: string, keep: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM run_events
         WHERE run_id = @runId
           AND seq <= (
             SELECT COALESCE(MAX(seq), 0) - @keep FROM run_events WHERE run_id = @runId
           )`
      )
      .run({ runId, keep });
    return info.changes;
  }

  appendEvent(runId: string, eventType: string, payload: unknown): number {
    const seqRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM run_events WHERE run_id = ?`
      )
      .get(runId) as { nextSeq: number };
    const seq = seqRow.nextSeq;
    const payloadJson = this.capPayload(eventType, JSON.stringify(payload) ?? "null");
    const info = this.db
      .prepare(
        `INSERT INTO run_events (run_id, seq, event_type, payload)
         VALUES (?, ?, ?, ?)`
      )
      .run(runId, seq, eventType, payloadJson);
    this.db
      .prepare(`UPDATE runs SET updated_at = datetime('now') WHERE id = ?`)
      .run(runId);
    this.events?.emitRunEvent(runId, {
      id: Number(info.lastInsertRowid),
      runId,
      seq,
      eventType,
      payload: payloadJson,
      createdAt: new Date().toISOString(),
    });
    return seq;
  }

  listResumableRuns(): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status IN ('running', 'needs_input')
           AND agent_id IS NOT NULL
           AND sdk_run_id IS NOT NULL
           AND agent_id NOT LIKE 'bc-%'
         ORDER BY created_at ASC`
      )
      .all() as RunRow[];
  }

  /** Non-terminal runs for one workspace (guard + queue runner). */
  listActiveRunsForWorkspace(workspaceId: string): Array<{
    id: string;
    automation_id: string;
    status: string;
  }> {
    const placeholders = [...TERMINAL_RUN_STATUSES]
      .map(() => "?")
      .join(", ");
    return this.db
      .prepare(
        `SELECT id, automation_id, status FROM runs
         WHERE workspace_id = ?
           AND status NOT IN (${placeholders})
         ORDER BY created_at ASC`
      )
      .all(workspaceId, ...TERMINAL_RUN_STATUSES) as Array<{
      id: string;
      automation_id: string;
      status: string;
    }>;
  }

  /** Non-terminal runs with parent/chain fields for chat soft-steer resolution. */
  listSteerCandidateRunsForWorkspace(workspaceId: string): Array<{
    id: string;
    status: string;
    parentRunId: string | null;
    chainRootRunId: string | null;
  }> {
    const placeholders = [...TERMINAL_RUN_STATUSES]
      .map(() => "?")
      .join(", ");
    return (
      this.db
        .prepare(
          `SELECT id, status, parent_run_id, chain_root_run_id FROM runs
           WHERE workspace_id = ?
             AND status NOT IN (${placeholders})
           ORDER BY created_at ASC`
        )
        .all(workspaceId, ...TERMINAL_RUN_STATUSES) as Array<{
        id: string;
        status: string;
        parent_run_id: string | null;
        chain_root_run_id: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      status: row.status,
      parentRunId: row.parent_run_id,
      chainRootRunId: row.chain_root_run_id,
    }));
  }

  /** Root run plus every run chained from it, with automation config keys. */
  listChainLineageRuns(rootRunId: string): Array<{
    status: string;
    configKey: string;
  }> {
    return this.db
      .prepare(
        `SELECT r.status, a.config_key AS configKey
         FROM runs r
         JOIN automations a ON a.id = r.automation_id
         WHERE r.id = ? OR r.chain_root_run_id = ?
         ORDER BY r.created_at ASC`
      )
      .all(rootRunId, rootRunId) as Array<{
      status: string;
      configKey: string;
    }>;
  }

  /** All runs tagged with a pipeline wave (track-local and integration). */
  listRunsForPipelineWave(waveId: string): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE pipeline_wave_id = ? ORDER BY created_at ASC`
      )
      .all(waveId) as RunRow[];
  }

  /** Active runs with no agent ids — M1 zombies that cannot be re-attached. */
  listOrphanedActiveRuns(): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status IN ('running', 'needs_input')
           AND (agent_id IS NULL OR sdk_run_id IS NULL)
         ORDER BY created_at ASC`
      )
      .all() as RunRow[];
  }

  /** `running` rows for stall watchdog idle-time checks. */
  listStallCandidates(): Array<{ id: string; updated_at: string }> {
    return this.db
      .prepare(
        `SELECT id, updated_at FROM runs
         WHERE status = 'running'
         ORDER BY created_at ASC`
      )
      .all() as Array<{ id: string; updated_at: string }>;
  }

  /** Migration-free spawn attempt counter (`run.spawn.attempt` events). */
  countSpawnAttempts(runId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM run_events
         WHERE run_id = ? AND event_type = 'run.spawn.attempt'`
      )
      .get(runId) as { n: number };
    return row.n;
  }

  /** Hard-delete terminal runs; child run_events and input_requests cascade. */
  deleteTerminalRuns(runIds: string[]): string[] {
    if (runIds.length === 0) return [];
    return this.db.transaction(() => {
      const deleted: string[] = [];
      const select = this.db.prepare(
        `SELECT id FROM runs WHERE id = ? AND status IN ('completed', 'failed', 'cancelled')`
      );
      const detachOrigin = this.db.prepare(
        `UPDATE chat_sessions SET origin_run_id = NULL WHERE origin_run_id = ?`
      );
      const delAttachments = this.db.prepare(
        `DELETE FROM attachments WHERE owner_kind = 'run' AND owner_id = ?`
      );
      const del = this.db.prepare(`DELETE FROM runs WHERE id = ?`);
      for (const id of runIds) {
        const row = select.get(id) as { id: string } | undefined;
        if (row) {
          detachOrigin.run(id);
          delAttachments.run(id);
          del.run(id);
          deleted.push(id);
        }
      }
      return deleted;
    })();
  }

  enqueueQueuedMessage(
    runId: string,
    message: string,
    attachmentsJson: string | null = null
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO run_queued_messages (id, run_id, message, attachments_json, status)
         VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(id, runId, message, attachmentsJson);
    return id;
  }

  getOldestPendingQueuedMessage(runId: string): QueuedRunMessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM run_queued_messages
         WHERE run_id = ? AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`
      )
      .get(runId) as QueuedRunMessageRow | undefined;
  }

  markQueuedMessageDelivered(id: string): void {
    this.db
      .prepare(
        `UPDATE run_queued_messages
         SET status = 'delivered', delivered_at = datetime('now')
         WHERE id = ?`
      )
      .run(id);
  }

  cancelAllPendingQueuedMessages(runId: string): number {
    const info = this.db
      .prepare(
        `UPDATE run_queued_messages
         SET status = 'cancelled', cancelled_at = datetime('now')
         WHERE run_id = ? AND status = 'pending'`
      )
      .run(runId);
    return info.changes;
  }

  listQueuedMessages(runId: string): QueuedRunMessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM run_queued_messages
         WHERE run_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(runId) as QueuedRunMessageRow[];
  }
}
