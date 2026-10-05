import { readFileSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEmbed } from "../scripts/embed-version.mjs";
import {
  evaluateBootstrapNodeFloor,
  formatNodeFloorRefusal,
  parseNodeFloorFromEmbed,
  parseNodeFloorFromPackageManifest,
  parseNodeFloorRequirement,
  parseRunningNodeVersion,
  resolveNodeFloorRequirement,
  runGuardedBootstrap,
  satisfiesNodeFloor,
} from "../packages/shared/src/node-floor.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readSrc(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("b76 node-floor parsing", () => {
  it("accepts >=X.Y and >=X.Y.Z and rejects malformed requirements", () => {
    expect(parseNodeFloorRequirement(">=22.13")).toEqual({
      ok: true,
      minimum: [22, 13, 0],
      raw: ">=22.13",
    });
    expect(parseNodeFloorRequirement(">=22.13.1")).toEqual({
      ok: true,
      minimum: [22, 13, 1],
      raw: ">=22.13.1",
    });
    expect(parseNodeFloorRequirement(">22.13").ok).toBe(false);
    expect(parseNodeFloorRequirement("22.13").ok).toBe(false);
    expect(parseNodeFloorRequirement("").ok).toBe(false);
  });

  it("compares running versions with optional v prefix and suffixes", () => {
    expect(satisfiesNodeFloor("22.12.9", ">=22.13").ok).toBe(false);
    expect(satisfiesNodeFloor("22.13.0", ">=22.13").ok).toBe(true);
    expect(satisfiesNodeFloor("v20.11.0", ">=22.13").ok).toBe(false);
    expect(satisfiesNodeFloor("22.13.0-beta.1", ">=22.13").ok).toBe(true);
    expect(parseRunningNodeVersion("22.13+build.1")).toEqual([22, 13, 0]);
  });

  it("formats an actionable refusal", () => {
    const message = formatNodeFloorRefusal({
      requirement: ">=22.13",
      running: "20.11.0",
    });
    expect(message).toContain("Max needs Node >=22.13");
    expect(message).toContain("runs 20.11.0");
    expect(message).toContain("https://nodejs.org/en/download");
    expect(message).toContain("Node 22 or 24 LTS");
  });
});

describe("b76 node-floor resolution", () => {
  it("reads nodeFloor from embed then package.json fallback", () => {
    const embed = JSON.stringify({ nodeFloor: ">=22.13" });
    expect(parseNodeFloorFromEmbed(embed)).toBe(">=22.13");
    expect(parseNodeFloorFromEmbed("{}")).toBeNull();

    const manifest = JSON.stringify({ engines: { node: ">=22.13" } });
    expect(parseNodeFloorFromPackageManifest(manifest)).toBe(">=22.13");
    expect(parseNodeFloorFromPackageManifest("{}")).toBeNull();

    const startDir = join(REPO_ROOT, "packages", "cli", "dist");
    const embedPath = join(startDir, "version-embed.json");
    const files = new Map<string, string>([[embedPath, embed]]);
    const fromEmbed = resolveNodeFloorRequirement({
      readText: (path) => files.get(path) ?? null,
      startDir,
      dirname: (path) => dirname(path),
      join,
      parseRoot: (path) => parsePath(path).root,
    });
    expect(fromEmbed).toEqual({ requirement: ">=22.13", source: "embed" });

    const repoRoot = REPO_ROOT;
    const walkedStart = join(repoRoot, "packages", "cli", "dist");
    const manifestPath = join(repoRoot, "package.json");
    const walked = resolveNodeFloorRequirement({
      readText: (path) =>
        path === manifestPath
          ? JSON.stringify({ engines: { node: ">=22.13" } })
          : null,
      startDir: walkedStart,
      dirname: (path) => dirname(path),
      join,
      parseRoot: (path) => parsePath(path).root,
    });
    expect(walked).toEqual({ requirement: ">=22.13", source: "package.json" });
  });

  it("evaluates bootstrap without touching process.versions", () => {
    const ok = evaluateBootstrapNodeFloor({
      runningVersion: "22.13.0",
      deps: {
        readText: (path) =>
          path.endsWith("version-embed.json")
            ? JSON.stringify({ nodeFloor: ">=22.13" })
            : null,
        startDir: "/dist",
        dirname: (path) => dirname(path),
        join,
        parseRoot: () => "/",
      },
    });
    expect(ok).toEqual({ ok: true, requirement: ">=22.13", source: "embed" });

    const blocked = evaluateBootstrapNodeFloor({
      runningVersion: "20.11.0",
      deps: {
        readText: (path) =>
          path.endsWith("version-embed.json")
            ? JSON.stringify({ nodeFloor: ">=22.13" })
            : null,
        startDir: "/dist",
        dirname: (path) => dirname(path),
        join,
        parseRoot: () => "/",
      },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.message).toContain("runs 20.11.0");
    }
  });

  it("refuses Node 20 without calling the application importer", async () => {
    let loadCount = 0;
    let mainCount = 0;
    const errors: string[] = [];
    const exits: number[] = [];
    const outcome = await runGuardedBootstrap({
      runningVersion: "20.11.0",
      deps: {
        readText: (path) =>
          path.endsWith("version-embed.json")
            ? JSON.stringify({ nodeFloor: ">=22.13" })
            : null,
        startDir: "/dist",
        dirname: (path) => dirname(path),
        join,
        parseRoot: () => "/",
      },
      loadApp: async () => {
        loadCount += 1;
        return {
          main: async () => {
            mainCount += 1;
          },
        };
      },
      writeError: (message) => {
        errors.push(message);
      },
      exit: (code) => {
        exits.push(code);
      },
    });
    expect(outcome).toBe("refused");
    expect(loadCount).toBe(0);
    expect(mainCount).toBe(0);
    expect(exits).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Max needs Node >=22.13");
    expect(errors[0]).toContain("runs 20.11.0");
  });

  it("loads the application importer exactly once on a supported runtime", async () => {
    let loadCount = 0;
    let mainCount = 0;
    const errors: string[] = [];
    const exits: number[] = [];
    const outcome = await runGuardedBootstrap({
      runningVersion: "22.13.0",
      deps: {
        readText: (path) =>
          path.endsWith("version-embed.json")
            ? JSON.stringify({ nodeFloor: ">=22.13" })
            : null,
        startDir: "/dist",
        dirname: (path) => dirname(path),
        join,
        parseRoot: () => "/",
      },
      loadApp: async () => {
        loadCount += 1;
        return {
          main: async () => {
            mainCount += 1;
          },
        };
      },
      writeError: (message) => {
        errors.push(message);
      },
      exit: (code) => {
        exits.push(code);
      },
    });
    expect(outcome).toBe("loaded");
    expect(loadCount).toBe(1);
    expect(mainCount).toBe(1);
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });
});

describe("b76 embed-version", () => {
  it("embeds root engines.node as nodeFloor", () => {
    const embed = buildEmbed();
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(embed.nodeFloor).toBe(root.engines.node);
    expect(embed.nodeFloor).toBe(">=22.13");
  });
});

describe("b76 bootstrap entry contracts", () => {
  it("keeps CLI bootstrap dependency-light and dynamic-imports cli.js", () => {
    const src = readSrc("packages/cli/src/index.ts");
    expect(src).toContain("@lca/shared/node-floor");
    expect(src).not.toMatch(/from "@lca\/shared"/);
    expect(src).toContain('import("./cli.js")');
    expect(src).not.toContain("./client.js");
  });

  it("keeps daemon bootstrap dependency-light and dynamic-imports daemon.js", () => {
    const src = readSrc("packages/daemon/src/index.ts");
    expect(src).toContain("@lca/shared/node-floor");
    expect(src).not.toMatch(/from "@lca\/shared"/);
    expect(src).toContain('import("./daemon.js")');
  });

  it("exports main from application modules without auto-run", () => {
    const cliSrc = readSrc("packages/cli/src/cli.ts");
    expect(cliSrc).toMatch(/export async function main\(/);
    expect(cliSrc).not.toContain("isExecutedAsCli");

    const daemonSrc = readSrc("packages/daemon/src/daemon.ts");
    expect(daemonSrc).toMatch(/export async function main\(/);
    expect(daemonSrc).not.toMatch(/main\(\)\.catch/);
  });
});

describe("b76 engine-strict export", () => {
  it("includes engine-strict in root .npmrc", () => {
    const npmrc = readSrc(".npmrc");
    expect(npmrc.trim()).toBe("engine-strict=true");
  });
});
