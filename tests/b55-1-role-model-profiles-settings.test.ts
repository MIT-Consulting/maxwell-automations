import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pipelineRoleModelProfilesSchema,
  pipelineRoleModelsSchema,
  settingsSchema,
} from "@lca/shared";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("../packages/daemon/src/config/parse.ts");
});

describe("pipelineRoleModelProfilesSchema", () => {
  it("accepts a valid named profile with scalar and structured selections", () => {
    const parsed = pipelineRoleModelProfilesSchema.parse({
      cheap: {
        planner: "grok-4.5",
        implementer: {
          id: "  composer-2.5  ",
          params: [
            { id: "z", value: "2" },
            { id: "a", value: "1" },
          ],
        },
        reviewer: "grok-4.5",
        docs: "composer-2.5",
      },
    });

    expect(parsed.cheap?.planner).toBe("grok-4.5");
    expect(parsed.cheap?.implementer).toEqual({
      id: "composer-2.5",
      params: [
        { id: "a", value: "1" },
        { id: "z", value: "2" },
      ],
    });
  });

  it("rejects profile id default as reserved", () => {
    const result = pipelineRoleModelProfilesSchema.safeParse({
      default: { planner: "grok-4.5" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("; ");
      expect(message).toMatch(/default/i);
    }
  });

  it("rejects invalid profile id characters", () => {
    const result = pipelineRoleModelProfilesSchema.safeParse({
      "Cheap-Mode": { planner: "grok-4.5" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("; ");
      expect(message).toMatch(/profile id/i);
    }
  });

  it("allows partial role maps inside a profile", () => {
    const parsed = pipelineRoleModelProfilesSchema.parse({
      cheap: {
        planner: "grok-4.5",
        docs: "composer-2.5",
      },
    });
    expect(parsed.cheap?.planner).toBe("grok-4.5");
    expect(parsed.cheap?.docs).toBe("composer-2.5");
    expect(parsed.cheap?.implementer).toBeUndefined();
  });
});

describe("settingsSchema + pipelineRoleModelProfiles", () => {
  it("accepts named profiles and default profile id alongside pipelineRoleModels", () => {
    const parsed = settingsSchema.parse({
      pipelineRoleModels: {
        planner: "grok-4.5",
      },
      pipelineRoleModelProfiles: {
        cheap: {
          planner: "grok-4.5",
          implementer: "composer-2.5",
        },
      },
      defaultPipelineRoleModelProfile: "cheap",
    });
    expect(parsed.pipelineRoleModels?.planner).toBe("grok-4.5");
    expect(parsed.pipelineRoleModelProfiles?.cheap?.implementer).toBe(
      "composer-2.5"
    );
    expect(parsed.defaultPipelineRoleModelProfile).toBe("cheap");
  });

  it("rejects default as a named profile key in settings", () => {
    const result = settingsSchema.safeParse({
      pipelineRoleModelProfiles: {
        default: { planner: "grok-4.5" },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("loadSettings pipelineRoleModelProfiles resolution", () => {
  it("returns normalized named profiles from YAML", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b55-1-resolve-"));
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
        "  pipelineRoleModelProfiles:",
        "    cheap:",
        "      planner: grok-4.5",
        "      implementer:",
        "        id: composer-2.5",
        "        params:",
        "          - id: z",
        "            value: '2'",
        "          - id: a",
        "            value: '1'",
        "      reviewer: grok-4.5",
        "",
      ].join("\n"),
      "utf8"
    );

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.pipelineRoleModelProfiles.cheap).toEqual({
        planner: { id: "grok-4.5" },
        implementer: {
          id: "composer-2.5",
          params: [
            { id: "a", value: "1" },
            { id: "z", value: "2" },
          ],
        },
        reviewer: { id: "grok-4.5" },
      });
      expect(resolved.pipelineRoleModelProfiles.cheap?.docs).toBeUndefined();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("defaults to empty profiles and null default id when keys are omitted", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b55-1-default-"));
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
      expect(resolved.pipelineRoleModelProfiles).toEqual({});
      expect(resolved.defaultPipelineRoleModelProfile).toBeNull();
      expect(DEFAULT_SETTINGS.pipelineRoleModelProfiles).toEqual({});
      expect(DEFAULT_SETTINGS.defaultPipelineRoleModelProfile).toBeNull();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("drops one unusable role entry while keeping other roles in the profile", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b55-1-malformed-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    vi.doMock("../packages/daemon/src/config/parse.ts", () => ({
      parseGlobalConfig: () => ({
        settings: {
          pipelineRoleModelProfiles: {
            cheap: {
              planner: "",
              implementer: "composer-2.5",
              reviewer: { id: "  " },
              docs: "grok-4.5",
            },
          },
        },
      }),
    }));

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.pipelineRoleModelProfiles.cheap).toEqual({
        implementer: { id: "composer-2.5" },
        docs: { id: "grok-4.5" },
      });
      expect(resolved.pipelineRoleModelProfiles.cheap?.planner).toBeUndefined();
      expect(resolved.pipelineRoleModelProfiles.cheap?.reviewer).toBeUndefined();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("treats unknown defaultPipelineRoleModelProfile as null", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b55-1-unknown-default-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const logs: string[] = [];
    vi.doMock("../packages/daemon/src/config/parse.ts", () => ({
      parseGlobalConfig: () => ({
        settings: {
          pipelineRoleModelProfiles: {
            cheap: { planner: "grok-4.5" },
          },
          defaultPipelineRoleModelProfile: "missing",
        },
      }),
    }));

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings({ onLog: (msg) => logs.push(msg) });
      expect(resolved.defaultPipelineRoleModelProfile).toBeNull();
      expect(logs.some((msg) => msg.includes("missing"))).toBe(true);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("resolves a valid defaultPipelineRoleModelProfile id", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b55-1-known-default-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    vi.doMock("../packages/daemon/src/config/parse.ts", () => ({
      parseGlobalConfig: () => ({
        settings: {
          pipelineRoleModelProfiles: {
            cheap: { planner: "grok-4.5" },
            quality: { planner: "claude-opus-5" },
          },
          defaultPipelineRoleModelProfile: "cheap",
        },
      }),
    }));

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.defaultPipelineRoleModelProfile).toBe("cheap");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("leaves pipelineRoleModels resolution unchanged when profiles are present", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b55-1-legacy-"));
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
        "  pipelineRoleModels:",
        "    planner: grok-4.5",
        "  pipelineRoleModelProfiles:",
        "    cheap:",
        "      implementer: composer-2.5",
        "",
      ].join("\n"),
      "utf8"
    );

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.pipelineRoleModels).toEqual({
        planner: { id: "grok-4.5" },
      });
      expect(resolved.pipelineRoleModelProfiles.cheap).toEqual({
        implementer: { id: "composer-2.5" },
      });
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("pipelineRoleModelsSchema reuse", () => {
  it("still accepts the same role map shape used as profile values", () => {
    const profileValue = pipelineRoleModelsSchema.parse({
      planner: "grok-4.5",
      implementer: { id: "composer-2.5" },
    });
    expect(profileValue.planner).toBe("grok-4.5");
    expect(profileValue.implementer).toEqual({ id: "composer-2.5" });
  });
});
