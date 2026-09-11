import type { Attachment, AttachmentRef } from "@lca/shared";

/**
 * Staging id for compose chips. `crypto.randomUUID()` is secure-context-only;
 * phones hit Max over Tailscale as plain `http://100.…`, so we must fall back.
 */
export function newLocalId(): string {
  const cryptoObj = globalThis.crypto;
  if (typeof cryptoObj?.randomUUID === "function") {
    try {
      return cryptoObj.randomUUID();
    } catch {
      /* insecure context or other failure — fall through */
    }
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".log": "text/x-log",
};

/**
 * Android's Files picker often returns an empty `File.type` (or
 * `application/octet-stream`). Infer from the extension so the daemon allowlist
 * can accept normal images/text.
 */
export function resolveAttachmentMimeType(file: {
  name: string;
  type: string;
}): string {
  const declared = file.type.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") {
    return declared;
  }
  const lower = file.name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot >= 0) {
    const inferred = EXT_TO_MIME[lower.slice(dot)];
    if (inferred) return inferred;
  }
  return declared || "application/octet-stream";
}

function clipboardFile(item: DataTransferItem): File | null {
  if (item.kind !== "file") return null;

  const file = item.getAsFile();
  if (!file) return null;
  if (file.name) return file;

  const mimeType = file.type || item.type || "application/octet-stream";
  const name = isImageMime(mimeType) ? "clipboard-image.png" : "clipboard-file";
  return new File([file], name, { type: mimeType, lastModified: file.lastModified });
}

export function filesFromClipboardEvent(event: ClipboardEvent): File[] {
  const items = Array.from(event.clipboardData?.items ?? []);
  const files = items
    .map(clipboardFile)
    .filter((file): file is File => file !== null);

  if (files.length > 0) return files;
  return Array.from(event.clipboardData?.files ?? []);
}

export function filesFromDragEvent(event: DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);

  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function isImageMime(mime: string): boolean {
  return mime.toLowerCase().startsWith("image/");
}

export function toAttachmentRef(attachment: Attachment): AttachmentRef {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
  };
}
