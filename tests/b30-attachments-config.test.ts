import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

afterEach(() => {
  vi.resetModules();
  vi.unmock("node:os");
  delete process.env.LCA_MAX_ATTACHMENT_BYTES;
  delete process.env.LCA_MAX_ATTACHMENTS_PER_MESSAGE;
  delete process.env.LCA_ALLOWED_ATTACHMENT_MIME_TYPES;
});

describe("b30 attachment settings", () => {
  it("includes attachment defaults", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b30-settings-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { loadSettings, DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.maxAttachmentBytes).toBe(
        DEFAULT_SETTINGS.maxAttachmentBytes
      );
      expect(resolved.maxAttachmentsPerMessage).toBe(
        DEFAULT_SETTINGS.maxAttachmentsPerMessage
      );
      expect(resolved.allowedAttachmentMimeTypes).toContain("image/png");
      expect(resolved.allowedAttachmentMimeTypes).toContain("text/plain");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("honors env overrides", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b30-settings-env-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    process.env.LCA_MAX_ATTACHMENT_BYTES = "2048";
    process.env.LCA_MAX_ATTACHMENTS_PER_MESSAGE = "2";
    process.env.LCA_ALLOWED_ATTACHMENT_MIME_TYPES = "image/png,text/plain";

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.maxAttachmentBytes).toBe(2048);
      expect(resolved.maxAttachmentsPerMessage).toBe(2);
      expect(resolved.allowedAttachmentMimeTypes).toEqual([
        "image/png",
        "text/plain",
      ]);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("falls back when YAML settings are invalid", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b30-settings-bad-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `settings:\n  maxAttachmentBytes: not-a-number\n  typoKey: 1\n`,
      "utf8"
    );

    const { loadSettings, DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    const warnings: string[] = [];
    try {
      const resolved = loadSettings({ onLog: (m) => warnings.push(m) });
      expect(resolved.maxAttachmentBytes).toBe(
        DEFAULT_SETTINGS.maxAttachmentBytes
      );
      expect(warnings.some((w) => /Settings ignored/i.test(w))).toBe(true);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
