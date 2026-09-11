import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PIPELINE_MODEL_ROLES,
  pipelineRoleModelsSchema,
  settingsSchema,
} from "@lca/shared";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("../packages/daemon/src/config/parse.ts");
});

describe("pipelineRoleModelsSchema", () => {
  it("accepts all four roles mixing scalar ids and structured selections", () => {
    const parsed = pipelineRoleModelsSchema.parse({
      planner: "grok-4.5",
      implementer: {
        id: "  composer-2.5  ",
        params: [
          { id: "z", value: "2" },
          { id: "a", value: "1" },
        ],
      },
      reviewer: {
        id: "claude-4.6-sonnet-medium-thinking",
        params: [],
      },
      docs: "composer-2.5",
    });

    expect(parsed.planner).toBe("grok-4.5");
    expect(parsed.implementer).toEqual({
      id: "composer-2.5",
      params: [
        { id: "a", value: "1" },
        { id: "z", value: "2" },
      ],
    });
    expect(parsed.reviewer).toEqual({
      id: "claude-4.6-sonnet-medium-thinking",
    });
    expect(parsed.docs).toBe("composer-2.5");
  });

  it("rejects an unknown role key and names it", () => {
    const result = pipelineRoleModelsSchema.safeParse({
      planer: "grok-4.5",
      implementer: "composer-2.5",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("; ");
      expect(message).toMatch(/planer/);
    }
  });

  it("rejects a non-string/non-object value", () => {
    const result = pipelineRoleModelsSchema.safeParse({
      planner: 42,
    });
    expect(result.success).toBe(false);
  });

  it("allows a partial map with absent roles simply absent", () => {
    const parsed = pipelineRoleModelsSchema.parse({
      planner: "grok-4.5",
      reviewer: "claude-4.6-sonnet-medium-thinking",
    });
    expect(parsed.planner).toBe("grok-4.5");
    expect(parsed.reviewer).toBe("claude-4.6-sonnet-medium-thinking");
    expect(parsed.implementer).toBeUndefined();
    expect(parsed.docs).toBeUndefined();
    expect("implementer" in parsed && parsed.implementer === null).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(["planner", "reviewer"]);
  });
});

describe("settingsSchema + pipelineRoleModels", () => {
  it("keeps existing keys when pipelineRoleModels is present", () => {
    const parsed = settingsSchema.parse({
      maxConcurrentRuns: 5,
      controlToken: "secret-token",
      maxAttachmentBytes: 2048,
      pipelineRoleModels: {
        planner: "grok-4.5",
        implementer: "composer-2.5",
      },
    });
    expect(parsed.maxConcurrentRuns).toBe(5);
    expect(parsed.controlToken).toBe("secret-token");
    expect(parsed.maxAttachmentBytes).toBe(2048);
    expect(parsed.pipelineRoleModels).toEqual({
      planner: "grok-4.5",
      implementer: "composer-2.5",
    });
  });
});

describe("loadSettings pipelineRoleModels resolution", () => {
  it("resolves YAML role maps to normalized ModelSelection values", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-4-resolve-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      [
        "settings:",
        "  maxConcurrentRuns: 4",
        "  pipelineRoleModels:",
        "    planner: grok-4.5",
        "    implementer:",
        "      id: composer-2.5",
        "      params:",
        "        - id: z",
        "          value: '2'",
        "        - id: a",
        "          value: '1'",
        "    reviewer:",
        "      id: claude-4.6-sonnet-medium-thinking",
        "      params: []",
        "",
      ].join("\n"),
      "utf8"
    );

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.maxConcurrentRuns).toBe(4);
      expect(resolved.pipelineRoleModels).toEqual({
        planner: { id: "grok-4.5" },
        implementer: {
          id: "composer-2.5",
          params: [
            { id: "a", value: "1" },
            { id: "z", value: "2" },
          ],
        },
        reviewer: { id: "claude-4.6-sonnet-medium-thinking" },
      });
      expect(resolved.pipelineRoleModels.docs).toBeUndefined();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("defaults to an empty map when the key is omitted", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-4-default-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      "settings:\n  maxConcurrentRuns: 2\n",
      "utf8"
    );

    const { loadSettings, DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.pipelineRoleModels).toEqual({});
      expect(DEFAULT_SETTINGS.pipelineRoleModels).toEqual({});
      expect(resolved.maxConcurrentRuns).toBe(2);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("drops one unusable entry while keeping other roles", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-4-malformed-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    // Empty-string ids are rejected by the schema before loadSettings sees them;
    // inject a post-parse map so the per-role drop path is exercised.
    vi.doMock("../packages/daemon/src/config/parse.ts", () => ({
      parseGlobalConfig: () => ({
        settings: {
          maxConcurrentRuns: 6,
          pipelineRoleModels: {
            planner: "",
            implementer: "composer-2.5",
            reviewer: { id: "  " },
            docs: "grok-4.5",
          },
        },
      }),
    }));

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.maxConcurrentRuns).toBe(6);
      expect(resolved.pipelineRoleModels).toEqual({
        implementer: { id: "composer-2.5" },
        docs: { id: "grok-4.5" },
      });
      expect(resolved.pipelineRoleModels.planner).toBeUndefined();
      expect(resolved.pipelineRoleModels.reviewer).toBeUndefined();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("canonical role vocabulary matches PIPELINE_MODEL_ROLES", () => {
    expect([...PIPELINE_MODEL_ROLES]).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "docs",
      "researcher",
      "gatekeeper",
      "architect",
    ]);
  });
});
