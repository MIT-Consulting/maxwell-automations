import { describe, expect, it, vi } from "vitest";
import {
  filesFromClipboardEvent,
  formatFileSize,
  isImageMime,
  newLocalId,
  resolveAttachmentMimeType,
} from "../packages/dashboard/src/chatAttachments.ts";

describe("chatAttachments helpers", () => {
  it("classifies image MIME types", () => {
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("text/plain")).toBe(false);
  });

  it("formats file sizes", () => {
    expect(formatFileSize(500)).toMatch(/B|bytes|500/i);
    expect(formatFileSize(2048)).toMatch(/2/);
  });

  it("extracts clipboard image items", () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const file = new File([blob], "paste.png", { type: "image/png" });
    const event = {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
        files: null,
      },
    } as unknown as ClipboardEvent;

    const files = filesFromClipboardEvent(event);
    expect(files).toHaveLength(1);
    expect(files[0]?.type).toBe("image/png");
  });

  it("infers MIME from extension when Android returns empty type", () => {
    expect(resolveAttachmentMimeType({ name: "photo.JPG", type: "" })).toBe(
      "image/jpeg"
    );
    expect(
      resolveAttachmentMimeType({
        name: "shot.png",
        type: "application/octet-stream",
      })
    ).toBe("image/png");
    expect(
      resolveAttachmentMimeType({ name: "notes.md", type: "text/markdown" })
    ).toBe("text/markdown");
  });

  it("newLocalId falls back when randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues: original?.getRandomValues?.bind(original),
    });
    try {
      const id = newLocalId();
      expect(id.startsWith("local-")).toBe(true);
      expect(id.length).toBeGreaterThan(10);
    } finally {
      vi.stubGlobal("crypto", original);
    }
  });
});
