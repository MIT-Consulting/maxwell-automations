import {
  classifyFeatureQueueOutcome,
  featureQueueFailureDetail,
  readQueuePreviewFields,
  type FeatureQueueEntry,
  type FeatureQueueEntryOrigin,
  type TriggerRunRequest,
} from "@lca/shared";
import { randomUUID } from "node:crypto";
import type { LcaDatabase } from "../db/index.js";
import { IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY } from "../pipelines/implement-fully.js";
import type { RunStore } from "./store.js";

export type FeatureQueueEntryRow = {
  id: string;
  workspace_id: string;
  feature_id: string;
  position: number;
  after_json: string;
  kickoff_json: string;
  state: string;
  run_id: string | null;
  detail: string | null;
  created_at: string;
  started_at: string | null;
  settled_at: string | null;
  updated_at: string;
  batch_digest_at: string | null;
  origin: string;
};

export type QueueBatchDigestFacts = {
  doneCount: number;
  failedCount: number;
  blockedCount: number;
  failedFeatureIds: string[];
  blockedFeatureIds: string[];
};

export type FeatureQueueErrorCode = "duplicate" | "unknown-dependency";

export class FeatureQueueError extends Error {
  constructor(
    public readonly code: FeatureQueueErrorCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = "FeatureQueueError";
  }
}

const ACTIVE_DUPLICATE_STATES = ["queued", "running", "blocked"] as const;

export function failedFeatureBlockDetail(featureId: string): string {
  return `blocked by failed feature ${featureId}`;
}

export function dependencyBlockDetail(
  state: string,
  featureId: string
): string {
  return `blocked by ${state} dependency ${featureId}`;
}

export const FEATURE_QUEUE_RECOVERED_DETAIL =
  "recovered: final-gate completed after retry";

export function toFeatureQueueEntry(row: FeatureQueueEntryRow): FeatureQueueEntry {
  let after: string[] = [];
  try {
    const parsed = JSON.parse(row.after_json) as unknown;
    if (Array.isArray(parsed)) {
      after = parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    after = [];
  }
  const origin: FeatureQueueEntryOrigin =
    row.origin === "direct" ? "direct" : "queue";
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    featureId: row.feature_id,
    position: row.position,
    after,
    origin,
    state: row.state as FeatureQueueEntry["state"],
    runId: row.run_id,
    detail: row.detail,
    ...readQueuePreviewFields(row.kickoff_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    updatedAt: row.updated_at,
  };
}

export function parseFeatureQueueKickoff(row: FeatureQueueEntryRow): TriggerRunRequest {
  return JSON.parse(row.kickoff_json) as TriggerRunRequest;
}

export class FeatureQueueStore {
  constructor(
    private readonly db: LcaDatabase,
    private readonly runStore?: RunStore
  ) {}

  enqueue(input: {
    workspaceId: string;
    featureId: string;
    after: string[];
    kickoff: TriggerRunRequest;
  }): FeatureQueueEntryRow {
    const apply = this.db.transaction(() => {
      const duplicate = this.db
        .prepare(
          `SELECT id FROM feature_queue_entries
           WHERE workspace_id = ? AND feature_id = ?
             AND state IN (${ACTIVE_DUPLICATE_STATES.map(() => "?").join(", ")})
           LIMIT 1`
        )
        .get(input.workspaceId, input.featureId, ...ACTIVE_DUPLICATE_STATES) as
        | { id: string }
        | undefined;
      if (duplicate) {
        throw new FeatureQueueError(
          "duplicate",
          `feature ${input.featureId} is already active in this workspace`
        );
      }

      for (const depId of input.after) {
        if (!this.hasDependencyRow(input.workspaceId, depId)) {
          this.tryAdoptDirectRoot(input.workspaceId, depId);
        }
        if (!this.hasDependencyRow(input.workspaceId, depId)) {
          throw new FeatureQueueError(
            "unknown-dependency",
            `unknown dependency feature id: ${depId}`
          );
        }
      }

      const positionRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(position), 0) AS n
           FROM feature_queue_entries
           WHERE workspace_id = ?`
        )
        .get(input.workspaceId) as { n: number };
      const position = positionRow.n + 1;
      const id = randomUUID();

      this.db
        .prepare(
          `INSERT INTO feature_queue_entries (
             id, workspace_id, feature_id, position,
             after_json, kickoff_json, state
           ) VALUES (?, ?, ?, ?, ?, ?, 'queued')`
        )
        .run(
          id,
          input.workspaceId,
          input.featureId,
          position,
          JSON.stringify(input.after),
          JSON.stringify(input.kickoff)
        );

      return this.getEntry(id)!;
    });

    return apply();
  }

  listEntries(workspaceId?: string): FeatureQueueEntryRow[] {
    if (workspaceId) {
      return this.db
        .prepare(
          `SELECT * FROM feature_queue_entries
           WHERE workspace_id = ?
           ORDER BY position ASC`
        )
        .all(workspaceId) as FeatureQueueEntryRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM feature_queue_entries ORDER BY position ASC`
      )
      .all() as FeatureQueueEntryRow[];
  }

  getEntry(id: string): FeatureQueueEntryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM feature_queue_entries WHERE id = ?`)
      .get(id) as FeatureQueueEntryRow | undefined;
  }

  getEntryByRunId(runId: string): FeatureQueueEntryRow | undefined {
    return this.db
      .prepare(`SELECT * FROM feature_queue_entries WHERE run_id = ?`)
      .get(runId) as FeatureQueueEntryRow | undefined;
  }

  cancelEntry(id: string): "cancelled" | "running" | "missing" {
    const row = this.getEntry(id);
    if (!row) {
      return "missing";
    }
    if (row.state === "running") return "running";
    if (row.state === "cancelled") return "cancelled";
    if (row.state !== "queued" && row.state !== "blocked") {
      return "running";
    }
    const result = this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           state = 'cancelled',
           updated_at = datetime('now')
         WHERE id = ? AND state IN ('queued', 'blocked')`
      )
      .run(id);
    return result.changes === 1 ? "cancelled" : "running";
  }

  hasQueueActivity(workspaceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM feature_queue_entries
         WHERE workspace_id = ?
           AND state IN ('queued', 'running', 'blocked')
         LIMIT 1`
      )
      .get(workspaceId) as { id: string } | undefined;
    return row != null;
  }

  getRunningEntry(workspaceId: string): FeatureQueueEntryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM feature_queue_entries
         WHERE workspace_id = ? AND state = 'running'
         LIMIT 1`
      )
      .get(workspaceId) as FeatureQueueEntryRow | undefined;
  }

  listRunningEntries(workspaceId: string): FeatureQueueEntryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM feature_queue_entries
         WHERE workspace_id = ? AND state = 'running'
         ORDER BY position ASC`
      )
      .all(workspaceId) as FeatureQueueEntryRow[];
  }

  hasActiveFeatureRow(workspaceId: string, featureId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM feature_queue_entries
         WHERE workspace_id = ? AND feature_id = ?
           AND state IN (${ACTIVE_DUPLICATE_STATES.map(() => "?").join(", ")})
         LIMIT 1`
      )
      .get(workspaceId, featureId, ...ACTIVE_DUPLICATE_STATES) as
      | { id: string }
      | undefined;
    return row != null;
  }

  recordDirectKickoff(input: {
    workspaceId: string;
    featureId: string;
    runId: string;
    kickoff: TriggerRunRequest;
  }): "recorded" | "skipped-active" | "skipped-duplicate-run" {
    const apply = this.db.transaction((): "recorded" | "skipped-active" | "skipped-duplicate-run" => {
      if (this.hasActiveFeatureRow(input.workspaceId, input.featureId)) {
        return "skipped-active";
      }
      const existingRun = this.db
        .prepare(`SELECT id FROM feature_queue_entries WHERE run_id = ? LIMIT 1`)
        .get(input.runId) as { id: string } | undefined;
      if (existingRun) {
        return "skipped-duplicate-run";
      }

      const positionRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(position), 0) AS n
           FROM feature_queue_entries
           WHERE workspace_id = ?`
        )
        .get(input.workspaceId) as { n: number };
      const position = positionRow.n + 1;
      const id = randomUUID();

      this.db
        .prepare(
          `INSERT INTO feature_queue_entries (
             id, workspace_id, feature_id, position,
             after_json, kickoff_json, state, run_id,
             started_at, batch_digest_at, origin
           ) VALUES (?, ?, ?, ?, '[]', ?, 'running', ?, datetime('now'), datetime('now'), 'direct')`
        )
        .run(
          id,
          input.workspaceId,
          input.featureId,
          position,
          JSON.stringify(input.kickoff),
          input.runId
        );
      return "recorded";
    });
    return apply();
  }

  listQueuedEntries(workspaceId: string): FeatureQueueEntryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM feature_queue_entries
         WHERE workspace_id = ? AND state = 'queued'
         ORDER BY position ASC`
      )
      .all(workspaceId) as FeatureQueueEntryRow[];
  }

  listWorkspaceIdsWithActiveQueue(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT workspace_id AS workspace_id
         FROM feature_queue_entries
         WHERE state IN ('running', 'queued')`
      )
      .all() as Array<{ workspace_id: string }>;
    return rows.map((row) => row.workspace_id);
  }

  getNewestEntryByFeatureId(
    workspaceId: string,
    featureId: string
  ): FeatureQueueEntryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM feature_queue_entries
         WHERE workspace_id = ? AND feature_id = ?
         ORDER BY position DESC
         LIMIT 1`
      )
      .get(workspaceId, featureId) as FeatureQueueEntryRow | undefined;
  }

  claimEntry(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           state = 'running',
           updated_at = datetime('now')
         WHERE id = ? AND state = 'queued'`
      )
      .run(id);
    return result.changes === 1;
  }

  recordStart(id: string, runId: string): void {
    this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           run_id = ?,
           started_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND state = 'running'`
      )
      .run(runId, id);
  }

  settleEntry(
    id: string,
    state: "done" | "failed",
    detail: string | null
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           state = ?,
           detail = ?,
           settled_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ? AND state = 'running'`
      )
      .run(state, detail, id);
    return result.changes === 1;
  }

  blockEntry(id: string, detail: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           state = 'blocked',
           detail = ?,
           updated_at = datetime('now')
         WHERE id = ? AND state = 'queued'`
      )
      .run(detail, id);
    return result.changes === 1;
  }

  parkDependents(failedFeatureId: string, workspaceId: string): number {
    const detail = failedFeatureBlockDetail(failedFeatureId);
    const result = this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           state = 'blocked',
           detail = ?,
           updated_at = datetime('now')
         WHERE workspace_id = ?
           AND state = 'queued'
           AND id IN (
             SELECT e.id FROM feature_queue_entries e, json_each(e.after_json) j
             WHERE e.workspace_id = ?
               AND e.state = 'queued'
               AND j.value = ?
           )`
      )
      .run(detail, workspaceId, workspaceId, failedFeatureId);
    return result.changes;
  }

  hasRunningOrQueued(workspaceId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM feature_queue_entries
         WHERE workspace_id = ?
           AND state IN ('running', 'queued')
         LIMIT 1`
      )
      .get(workspaceId) as { id: string } | undefined;
    return row != null;
  }

  collectUndigestedBatchDigest(
    workspaceId: string
  ): QueueBatchDigestFacts | null {
    const rows = this.db
      .prepare(
        `SELECT feature_id, state FROM feature_queue_entries
         WHERE workspace_id = ?
           AND batch_digest_at IS NULL
           AND origin = 'queue'
           AND state IN ('done', 'failed', 'blocked')`
      )
      .all(workspaceId) as Array<{ feature_id: string; state: string }>;

    let doneCount = 0;
    let failedCount = 0;
    let blockedCount = 0;
    const failedFeatureIds: string[] = [];
    const blockedFeatureIds: string[] = [];

    for (const row of rows) {
      if (row.state === "done") {
        doneCount += 1;
      } else if (row.state === "failed") {
        failedCount += 1;
        failedFeatureIds.push(row.feature_id);
      } else if (row.state === "blocked") {
        blockedCount += 1;
        blockedFeatureIds.push(row.feature_id);
      }
    }

    if (doneCount + failedCount === 0) {
      return null;
    }

    return {
      doneCount,
      failedCount,
      blockedCount,
      failedFeatureIds,
      blockedFeatureIds,
    };
  }

  markBatchDigested(workspaceId: string): void {
    this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           batch_digest_at = datetime('now'),
           updated_at = datetime('now')
         WHERE workspace_id = ?
           AND batch_digest_at IS NULL
           AND origin = 'queue'`
      )
      .run(workspaceId);
  }

  recoverFailedEntry(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE feature_queue_entries SET
           state = 'done',
           detail = ?,
           settled_at = datetime('now'),
           updated_at = datetime('now'),
           batch_digest_at = NULL
         WHERE id = ? AND state = 'failed'`
      )
      .run(FEATURE_QUEUE_RECOVERED_DETAIL, id);
    return result.changes === 1;
  }

  requeueBlockedDependents(
    featureId: string,
    workspaceId: string
  ): string[] {
    const requeued: string[] = [];
    const apply = this.db.transaction(() => {
      const visited = new Set<string>();
      const frontier = [featureId];
      while (frontier.length > 0) {
        const current = frontier.shift()!;
        if (visited.has(current)) {
          continue;
        }
        visited.add(current);
        const details = [
          failedFeatureBlockDetail(current),
          dependencyBlockDetail("failed", current),
          dependencyBlockDetail("blocked", current),
        ];
        const rows = this.db
          .prepare(
            `SELECT id, feature_id FROM feature_queue_entries
             WHERE workspace_id = ? AND state = 'blocked'
               AND detail IN (?, ?, ?)
             ORDER BY position ASC`
          )
          .all(workspaceId, ...details) as Array<{
          id: string;
          feature_id: string;
        }>;
        for (const row of rows) {
          const result = this.db
            .prepare(
              `UPDATE feature_queue_entries SET
                 state = 'queued',
                 detail = NULL,
                 batch_digest_at = NULL,
                 updated_at = datetime('now')
               WHERE id = ? AND state = 'blocked'`
            )
            .run(row.id);
          if (result.changes === 1) {
            requeued.push(row.feature_id);
            if (!visited.has(row.feature_id)) {
              frontier.push(row.feature_id);
            }
          }
        }
      }
    });
    apply();
    return requeued;
  }

  private hasDependencyRow(workspaceId: string, featureId: string): boolean {
    const hasRow = this.db
      .prepare(
        `SELECT id FROM feature_queue_entries
         WHERE workspace_id = ? AND feature_id = ?
         LIMIT 1`
      )
      .get(workspaceId, featureId) as { id: string } | undefined;
    const hasDone = this.db
      .prepare(
        `SELECT id FROM feature_queue_entries
         WHERE workspace_id = ? AND feature_id = ? AND state = 'done'
         LIMIT 1`
      )
      .get(workspaceId, featureId) as { id: string } | undefined;
    return hasRow != null || hasDone != null;
  }

  private tryAdoptDirectRoot(workspaceId: string, featureId: string): void {
    if (!this.runStore) {
      return;
    }
    const root = this.runStore.findLatestImplementFullyRootByFeature(
      workspaceId,
      featureId
    );
    if (!root) {
      return;
    }
    const kickoff = this.runStore.triggerRunRequestFromRootRun(root);
    if (!kickoff) {
      return;
    }
    if (this.hasActiveFeatureRow(workspaceId, featureId)) {
      return;
    }
    const existingRun = this.db
      .prepare(`SELECT id FROM feature_queue_entries WHERE run_id = ? LIMIT 1`)
      .get(root.id) as { id: string } | undefined;
    if (existingRun) {
      return;
    }

    const lineage = this.runStore.listChainLineageRuns(root.id);
    const outcome = classifyFeatureQueueOutcome(
      lineage,
      IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY
    );
    const state =
      outcome === "done" ? "done" : outcome === "failed" ? "failed" : "running";
    const detail =
      outcome === "failed"
        ? featureQueueFailureDetail(lineage, IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY)
        : null;

    const positionRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(position), 0) AS n
         FROM feature_queue_entries
         WHERE workspace_id = ?`
      )
      .get(workspaceId) as { n: number };
    const position = positionRow.n + 1;
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO feature_queue_entries (
           id, workspace_id, feature_id, position,
           after_json, kickoff_json, state, run_id, detail,
           started_at, settled_at, batch_digest_at, origin
         ) VALUES (
           ?, ?, ?, ?, '[]', ?, ?, ?, ?,
           CASE WHEN ? = 'running' THEN COALESCE(?, datetime('now')) ELSE ? END,
           CASE WHEN ? IN ('done', 'failed') THEN COALESCE(?, datetime('now')) ELSE NULL END,
           datetime('now'), 'direct'
         )`
      )
      .run(
        id,
        workspaceId,
        featureId,
        position,
        JSON.stringify(kickoff),
        state,
        root.id,
        detail,
        state,
        root.started_at,
        root.started_at,
        state,
        root.ended_at
      );
  }
}
