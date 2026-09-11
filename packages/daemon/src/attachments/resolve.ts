import type { AttachmentRef } from "@lca/shared";
import type { OperatorAttachment, OperatorMessage } from "../executor/types.js";
import {
  AttachmentStore,
  parseAttachmentRefs,
  serializeAttachmentRefs,
  toAttachmentRef,
  type AttachmentRow,
} from "./store.js";

export function resolveOperatorAttachments(
  store: AttachmentStore,
  ownerKind: "run" | "chat",
  ownerId: string,
  refs: AttachmentRef[] | undefined
): OperatorAttachment[] {
  if (!refs || refs.length === 0) {
    return [];
  }
  const resolved: OperatorAttachment[] = [];
  for (const ref of refs) {
    const row = store.getById(ownerKind, ownerId, ref.id);
    if (!row) {
      throw new Error(`Attachment not found: ${ref.id}`);
    }
    resolved.push({
      id: row.id,
      name: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      kind: row.kind,
      storagePath: row.storage_path,
    });
  }
  return resolved;
}

export function attachmentRefsFromRows(rows: AttachmentRow[]): AttachmentRef[] {
  return rows.map(toAttachmentRef);
}

export function buildOperatorMessage(
  text: string,
  attachments: OperatorAttachment[]
): OperatorMessage {
  return {
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function operatorMessageFromQueued(
  store: AttachmentStore,
  ownerKind: "run" | "chat",
  ownerId: string,
  message: string,
  attachmentsJson: string | null | undefined
): OperatorMessage {
  const refs = parseAttachmentRefs(attachmentsJson);
  const attachments = resolveOperatorAttachments(
    store,
    ownerKind,
    ownerId,
    refs
  );
  return buildOperatorMessage(message, attachments);
}

export { serializeAttachmentRefs, parseAttachmentRefs };
