import type {
  FeatureQueueEntry,
  TriggerRunRequest,
} from "@lca/shared";
import { randomUUID } from "node:crypto";
import type { LcaDatabase } from "../db/index.js";

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
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    featureId: row.feature_id,
    position: row.position,
    after,
    state: row.state as FeatureQueueEntry["state"],
    runId: row.run_id,
    detail: row.detail,
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
  constructor(private readonly db: LcaDatabase) {}

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
        const hasRow = this.db
          .prepare(
            `SELECT id FROM feature_queue_entries
             WHERE workspace_id = ? AND feature_id = ?
             LIMIT 1`
          )
          .get(input.workspaceId, depId) as { id: string } | undefined;
        const hasDone = this.db
          .prepare(
            `SELECT id FROM feature_queue_entries
             WHERE workspace_id = ? AND feature_id = ? AND state = 'done'
             LIMIT 1`
          )
          .get(input.workspaceId, depId) as { id: string } | undefined;
        if (!hasRow && !hasDone) {
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
    const detail = `blocked by failed feature ${failedFeatureId}`;
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
           AND batch_digest_at IS NULL`
      )
      .run(workspaceId);
  }
}
