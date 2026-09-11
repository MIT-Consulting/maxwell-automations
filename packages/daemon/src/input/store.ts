import { randomUUID } from "node:crypto";
import type {
  InputRequest,
  InputRequestMetadata,
  InputRequestStatus,
} from "@lca/shared";
import { inputRequestMetadataSchema } from "@lca/shared";
import type { LcaDatabase } from "../db/index.js";

export type InputRequestRow = {
  id: string;
  run_id: string;
  question: string;
  answer: string | null;
  status: InputRequestStatus;
  created_at: string;
  answered_at: string | null;
  metadata_json: string | null;
};

/** Defensive parse — null/malformed historical JSON degrades to absent metadata. */
export function parseInputMetadataJson(
  raw: string | null | undefined
): InputRequestMetadata | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const check = inputRequestMetadataSchema.safeParse(parsed);
  return check.success ? check.data : null;
}

export function rowToInputRequest(row: InputRequestRow): InputRequest {
  return {
    id: row.id,
    runId: row.run_id,
    question: row.question,
    answer: row.answer,
    status: row.status,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    metadata: parseInputMetadataJson(row.metadata_json),
  };
}

export class InputStore {
  constructor(private readonly db: LcaDatabase) {}

  insertPending(
    runId: string,
    question: string,
    metadata?: InputRequestMetadata | null
  ): InputRequestRow {
    const id = randomUUID();
    const metadataJson =
      metadata != null ? JSON.stringify(metadata) : null;
    this.db
      .prepare(
        `INSERT INTO input_requests (id, run_id, question, status, metadata_json)
         VALUES (?, ?, ?, 'pending', ?)`
      )
      .run(id, runId, question, metadataJson);
    return this.getById(id)!;
  }

  getById(id: string): InputRequestRow | undefined {
    return this.db
      .prepare(`SELECT * FROM input_requests WHERE id = ?`)
      .get(id) as InputRequestRow | undefined;
  }

  getPendingForRun(runId: string): InputRequestRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM input_requests
         WHERE run_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(runId) as InputRequestRow | undefined;
  }

  listForRun(runId: string): InputRequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM input_requests WHERE run_id = ? ORDER BY created_at ASC`
      )
      .all(runId) as InputRequestRow[];
  }

  /**
   * Newest-first bounded scan for a request whose metadata kind matches.
   * Caps history so callers never load an unbounded run input log.
   */
  findLatestForRunByKind(
    runId: string,
    kind: string,
    limit = 32
  ): InputRequestRow | undefined {
    const capped = Math.max(1, Math.min(Math.floor(limit), 64));
    const rows = this.db
      .prepare(
        `SELECT * FROM input_requests
         WHERE run_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(runId, capped) as InputRequestRow[];
    for (const row of rows) {
      const meta = parseInputMetadataJson(row.metadata_json);
      if (meta?.kind === kind) return row;
    }
    return undefined;
  }

  answer(id: string, answer: string): InputRequestRow | undefined {
    this.db
      .prepare(
        `UPDATE input_requests SET
          answer = ?,
          status = 'answered',
          answered_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      )
      .run(answer, id);
    return this.getById(id);
  }

  cancelPendingForRun(runId: string): void {
    this.db
      .prepare(
        `UPDATE input_requests SET status = 'cancelled'
         WHERE run_id = ? AND status = 'pending'`
      )
      .run(runId);
  }

  /**
   * Compare-and-set cancel for one exact pending request. Returns whether this
   * caller won the transition (false when already answered/cancelled/missing).
   */
  cancelPendingById(id: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE input_requests SET status = 'cancelled'
         WHERE id = ? AND status = 'pending'`
      )
      .run(id);
    return info.changes > 0;
  }
}
