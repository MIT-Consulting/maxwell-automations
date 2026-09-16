import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument, isSeq, isMap } from "yaml";
import { describe, expect, it } from "vitest";
import {
  appendWorkspaceToConfig,
  writeNotifySettings,
  writeWorkspaceChatDefaults,
} from "../packages/daemon/src/config/write.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lca-b67-yaml-"));
}

describe("b67 YAML writers initialize collections via createNode", () => {
  it("appendWorkspaceToConfig creates a seq on missing, empty, and {} docs", () => {
    const root = tempDir();
    try {
      const ws = join(root, "repo");
      mkdirSync(ws);
      const missing = join(root, "missing.yaml");
      expect(appendWorkspaceToConfig(missing, ws)).toBe(true);
      const missingDoc = parseDocument(readFileSync(missing, "utf8"));
      expect(isSeq(missingDoc.get("workspaces"))).toBe(true);

      const emptyPath = join(root, "empty.yaml");
      writeFileSync(emptyPath, "", "utf8");
      expect(appendWorkspaceToConfig(emptyPath, ws)).toBe(true);
      expect(readFileSync(emptyPath, "utf8")).toMatch(/workspaces:/);

      const objectPath = join(root, "object.yaml");
      writeFileSync(objectPath, "{}", "utf8");
      expect(appendWorkspaceToConfig(objectPath, ws)).toBe(true);
      const objectDoc = parseDocument(readFileSync(objectPath, "utf8"));
      expect(isSeq(objectDoc.get("workspaces"))).toBe(true);
      expect(appendWorkspaceToConfig(objectPath, ws)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appendWorkspaceToConfig preserves comments", () => {
    const root = tempDir();
    try {
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first);
      mkdirSync(second);
      const configPath = join(root, "automations.yaml");
      writeFileSync(
        configPath,
        "# keep me\nworkspaces:\n  - " + first.replace(/\\/g, "/") + "\n",
        "utf8"
      );
      expect(appendWorkspaceToConfig(configPath, first)).toBe(false);
      expect(appendWorkspaceToConfig(configPath, second)).toBe(true);
      const raw = readFileSync(configPath, "utf8");
      expect(raw).toContain("# keep me");
      expect(raw).toMatch(/workspaces:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeNotifySettings creates a settings map on an empty file", () => {
    const root = tempDir();
    try {
      const configPath = join(root, "automations.yaml");
      writeFileSync(configPath, "", "utf8");
      writeNotifySettings(configPath, {
        ntfy: { topic: "b67-test-topic" },
      });
      const doc = parseDocument(readFileSync(configPath, "utf8"));
      expect(isMap(doc.get("settings"))).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain("b67-test-topic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeWorkspaceChatDefaults writes a missing chat.yaml", () => {
    const root = tempDir();
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      writeWorkspaceChatDefaults(workspace, { model: "composer-2.5" });
      const chatPath = join(workspace, ".cursor", "chat.yaml");
      expect(existsSync(chatPath)).toBe(true);
      expect(readFileSync(chatPath, "utf8")).toContain("composer-2.5");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
