import type {
  Attachment,
  AttachmentKind,
  AttachmentOwnerKind,
  AttachmentRef,
} from "@lca/shared";
import type { LcaDatabase } from "../db/index.js";

export type AttachmentRow = {
  id: string;
  owner_kind: AttachmentOwnerKind;
  owner_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  kind: AttachmentKind;
  storage_path: string;
  status: string;
  message_seq: number | null;
  created_at: string;
};

/** Stable key for an attachment owner (run or chat). */
export type AttachmentOwnerKey = {
  ownerKind: AttachmentOwnerKind;
  ownerId: string;
};

function isAttachmentOwnerKind(value: string): value is AttachmentOwnerKind {
  return value === "run" || value === "chat";
}

export function mapAttachmentRow(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    name: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    kind: row.kind,
    createdAt: row.created_at,
  };
}

export function toAttachmentRef(row: AttachmentRow): AttachmentRef {
  return {
    id: row.id,
    name: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    kind: row.kind,
  };
}

export function serializeAttachmentRefs(
  attachments: AttachmentRef[] | undefined
): string | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  return JSON.stringify(attachments);
}

export function parseAttachmentRefs(
  raw: string | null | undefined
): AttachmentRef[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isAttachmentRef);
  } catch {
    return [];
  }
}

function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.mimeType === "string" &&
    typeof row.sizeBytes === "number" &&
    (row.kind === "image" || row.kind === "file")
  );
}

export class AttachmentStore {
  constructor(private readonly db: LcaDatabase) {}

  insertUploaded(input: {
    id: string;
    ownerKind: AttachmentOwnerKind;
    ownerId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    kind: AttachmentKind;
    storagePath: string;
  }): AttachmentRow {
    this.db
      .prepare(
        `INSERT INTO attachments (
           id, owner_kind, owner_id, filename, mime_type, size_bytes,
           sha256, kind, storage_path, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploaded')`
      )
      .run(
        input.id,
        input.ownerKind,
        input.ownerId,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.sha256,
        input.kind,
        input.storagePath
      );
    const row = this.getById(input.ownerKind, input.ownerId, input.id);
    if (!row) {
      throw new Error(`Failed to read inserted attachment ${input.id}`);
    }
    return row;
  }

  listForOwner(
    ownerKind: AttachmentOwnerKind,
    ownerId: string
  ): AttachmentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM attachments
         WHERE owner_kind = ? AND owner_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(ownerKind, ownerId) as AttachmentRow[];
  }

  getById(
    ownerKind: AttachmentOwnerKind,
    ownerId: string,
    id: string
  ): AttachmentRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM attachments
         WHERE id = ? AND owner_kind = ? AND owner_id = ?`
      )
      .get(id, ownerKind, ownerId) as AttachmentRow | undefined;
  }

  associateWithMessageSeq(
    ownerKind: AttachmentOwnerKind,
    ownerId: string,
    attachmentIds: string[],
    messageSeq: number
  ): void {
    if (attachmentIds.length === 0) {
      return;
    }
    const stmt = this.db.prepare(
      `UPDATE attachments
       SET message_seq = ?
       WHERE id = ? AND owner_kind = ? AND owner_id = ?`
    );
    const tx = this.db.transaction(() => {
      for (const id of attachmentIds) {
        stmt.run(messageSeq, id, ownerKind, ownerId);
      }
    });
    tx();
  }

  deleteForOwner(ownerKind: AttachmentOwnerKind, ownerId: string): number {
    const info = this.db
      .prepare(`DELETE FROM attachments WHERE owner_kind = ? AND owner_id = ?`)
      .run(ownerKind, ownerId);
    return info.changes;
  }

  /**
   * Distinct attachment owners whose run/chat row no longer exists.
   * Unknown owner_kind values are ignored (never used to build table names).
   */
  listOrphanedOwners(): AttachmentOwnerKey[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT owner_kind, owner_id
         FROM attachments
         WHERE
           (owner_kind = 'run'
             AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = attachments.owner_id))
           OR
           (owner_kind = 'chat'
             AND NOT EXISTS (
               SELECT 1 FROM chat_sessions
               WHERE chat_sessions.id = attachments.owner_id
             ))`
      )
      .all() as Array<{ owner_kind: string; owner_id: string }>;

    const out: AttachmentOwnerKey[] = [];
    for (const row of rows) {
      if (!isAttachmentOwnerKind(row.owner_kind)) {
        continue;
      }
      out.push({ ownerKind: row.owner_kind, ownerId: row.owner_id });
    }
    return out;
  }

  /** True when the run/chat owner row still exists. Unknown kinds → false. */
  ownerExists(ownerKind: string, ownerId: string): boolean {
    if (!isAttachmentOwnerKind(ownerKind)) {
      return false;
    }
    if (ownerKind === "run") {
      return (
        this.db.prepare("SELECT 1 AS ok FROM runs WHERE id = ?").get(ownerId) !==
        undefined
      );
    }
    return (
      this.db
        .prepare("SELECT 1 AS ok FROM chat_sessions WHERE id = ?")
        .get(ownerId) !== undefined
    );
  }
}
