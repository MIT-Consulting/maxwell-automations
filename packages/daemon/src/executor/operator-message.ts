import type { SDKUserMessage } from "@cursor/sdk";
import { readAttachmentBytes } from "../attachments/storage.js";
import type { OperatorAttachment, OperatorMessage } from "./types.js";
import { normalizeOperatorMessage } from "./types.js";

function nonImageReferenceLines(attachments: OperatorAttachment[]): string[] {
  return attachments
    .filter((a) => a.kind !== "image")
    .map(
      (a) =>
        `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes) stored at ${a.storagePath}`
    );
}

/**
 * Convert a daemon OperatorMessage into the value passed to `agent.send`.
 * Text-only stays a string; images use SDK `{ text, images }`.
 */
export function toSdkSendInput(
  message: string | OperatorMessage
): string | SDKUserMessage {
  const normalized = normalizeOperatorMessage(message);
  const attachments = normalized.attachments ?? [];
  if (attachments.length === 0) {
    return normalized.text;
  }

  const images = attachments
    .filter((a) => a.kind === "image")
    .map((a) => {
      const bytes = readAttachmentBytes(a.storagePath);
      return {
        data: bytes.toString("base64"),
        mimeType: a.mimeType,
      };
    });

  const fileLines = nonImageReferenceLines(attachments);
  let text = normalized.text.trim();
  if (fileLines.length > 0) {
    const block = ["Attached files:", ...fileLines].join("\n");
    text = text ? `${text}\n\n${block}` : block;
  }
  if (!text && images.length > 0) {
    text = "See attached image(s).";
  }

  if (images.length === 0) {
    return text;
  }

  return { text, images };
}
