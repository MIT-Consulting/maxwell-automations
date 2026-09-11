import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type {
  AttachmentKind,
  AttachmentOwnerKind,
} from "@lca/shared";
import type { ResolvedSettings } from "../config/settings.js";
import { ATTACHMENTS_DIR } from "../paths.js";

export class AttachmentValidationError extends Error {
  constructor(
    readonly code: "bad_request" | "payload_too_large" | "unsupported_media",
    message: string
  ) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

export type WrittenAttachmentBlob = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: AttachmentKind;
  storagePath: string;
};

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function classifyAttachmentKind(mimeType: string): AttachmentKind {
  return isImageMime(mimeType) ? "image" : "file";
}

export function validateAttachmentLimits(
  settings: Pick<
    ResolvedSettings,
    "maxAttachmentBytes" | "maxAttachmentsPerMessage" | "allowedAttachmentMimeTypes"
  >,
  input: { mimeType: string; sizeBytes: number; attachmentCount?: number }
): void {
  const mime = input.mimeType.trim().toLowerCase();
  if (!mime) {
    throw new AttachmentValidationError("bad_request", "mimeType is required");
  }
  const allowed = settings.allowedAttachmentMimeTypes.map((m) =>
    m.trim().toLowerCase()
  );
  if (!allowed.includes(mime)) {
    throw new AttachmentValidationError(
      "unsupported_media",
      `Unsupported attachment type: ${input.mimeType}`
    );
  }
  if (input.sizeBytes <= 0) {
    throw new AttachmentValidationError(
      "bad_request",
      "Attachment content is empty"
    );
  }
  if (input.sizeBytes > settings.maxAttachmentBytes) {
    throw new AttachmentValidationError(
      "payload_too_large",
      `Attachment exceeds maxAttachmentBytes (${settings.maxAttachmentBytes})`
    );
  }
  if (
    input.attachmentCount !== undefined &&
    input.attachmentCount > settings.maxAttachmentsPerMessage
  ) {
    throw new AttachmentValidationError(
      "payload_too_large",
      `Too many attachments (max ${settings.maxAttachmentsPerMessage})`
    );
  }
}

export function decodeBase64Content(
  contentBase64: string,
  maxBytes: number
): Buffer {
  const trimmed = contentBase64.trim();
  if (!trimmed) {
    throw new AttachmentValidationError(
      "bad_request",
      "contentBase64 is required"
    );
  }
  // Rough pre-check: base64 expands ~4/3; reject obviously oversized strings early.
  const approxBytes = Math.floor((trimmed.length * 3) / 4);
  if (approxBytes > maxBytes + 64) {
    throw new AttachmentValidationError(
      "payload_too_large",
      `Attachment exceeds maxAttachmentBytes (${maxBytes})`
    );
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(trimmed, "base64");
  } catch {
    throw new AttachmentValidationError(
      "bad_request",
      "contentBase64 is not valid base64"
    );
  }
  if (buffer.length === 0) {
    throw new AttachmentValidationError(
      "bad_request",
      "Attachment content is empty"
    );
  }
  if (buffer.length > maxBytes) {
    throw new AttachmentValidationError(
      "payload_too_large",
      `Attachment exceeds maxAttachmentBytes (${maxBytes})`
    );
  }
  return buffer;
}

function sanitizeFilename(filename: string): string {
  const base = filename.replace(/[/\\]/g, "_").trim() || "attachment";
  return base.slice(0, 200);
}

function assertPathInsideAttachments(resolvedPath: string): void {
  const root = resolve(ATTACHMENTS_DIR) + sep;
  const normalized = resolve(resolvedPath);
  if (normalized !== resolve(ATTACHMENTS_DIR) && !normalized.startsWith(root)) {
    throw new AttachmentValidationError(
      "bad_request",
      "Invalid attachment storage path"
    );
  }
}

export function buildAttachmentStoragePath(
  ownerKind: AttachmentOwnerKind,
  ownerId: string,
  attachmentId: string
): string {
  return join(ATTACHMENTS_DIR, ownerKind, ownerId, attachmentId);
}

export function buildAttachmentOwnerDir(
  ownerKind: AttachmentOwnerKind,
  ownerId: string
): string {
  return join(ATTACHMENTS_DIR, ownerKind, ownerId);
}

/** Remove the owner directory (and all blobs) if present. Safe if missing. */
export function removeAttachmentOwnerDir(
  ownerKind: AttachmentOwnerKind,
  ownerId: string
): void {
  const dir = buildAttachmentOwnerDir(ownerKind, ownerId);
  assertPathInsideAttachments(dir);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Immediate child directory names under `attachments/{ownerKind}/`.
 * Missing root → empty list (normal zero-work for sweeps).
 */
export function listAttachmentOwnerDirs(
  ownerKind: AttachmentOwnerKind
): string[] {
  const root = join(ATTACHMENTS_DIR, ownerKind);
  assertPathInsideAttachments(root);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function writeAttachmentBlob(input: {
  ownerKind: AttachmentOwnerKind;
  ownerId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  settings: Pick<
    ResolvedSettings,
    "maxAttachmentBytes" | "maxAttachmentsPerMessage" | "allowedAttachmentMimeTypes"
  >;
}): WrittenAttachmentBlob {
  validateAttachmentLimits(input.settings, {
    mimeType: input.mimeType,
    sizeBytes: input.bytes.length,
  });

  const id = randomUUID();
  const storagePath = buildAttachmentStoragePath(
    input.ownerKind,
    input.ownerId,
    id
  );
  assertPathInsideAttachments(storagePath);
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, input.bytes);

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  return {
    id,
    filename: sanitizeFilename(input.filename),
    mimeType: input.mimeType.trim().toLowerCase(),
    sizeBytes: input.bytes.length,
    sha256,
    kind: classifyAttachmentKind(input.mimeType),
    storagePath,
  };
}

export function readAttachmentBytes(storagePath: string): Buffer {
  const normalized = normalize(storagePath);
  assertPathInsideAttachments(normalized);
  try {
    return readFileSync(normalized);
  } catch {
    throw new AttachmentValidationError("bad_request", "Attachment file missing");
  }
}
