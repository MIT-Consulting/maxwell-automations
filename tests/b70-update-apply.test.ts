import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprintSharedDist as fingerprintSharedDistScript } from "../scripts/embed-version.mjs";
import {
  applyPlanLines,
  assessApplyStamps,
  assessUpdateApply,
  cleanBuildOutputs,
  executeUpdateApply,
  fetchPublishedPinSha,
  fingerprintSharedDist,
  formatPreflightReport,
  preflightUpdateTarget,
  readApplyStamps,
  releaseFetchUrl,
  type ApplyFacts,
  type ApplyStampReport,
} from "../packages/cli/src/update-apply.ts";
import { dashboardReloadAction } from "../packages/dashboard/src/dashboardReload.ts";

const pinned: ApplyFacts = {
  checkout: { version: "1.0.5", channel: "public" },
  pinnedTags: ["v1.0.5"],
  dirty: false,
  activeRuns: 0,
  devMode: false,
  targetTag: "v1.0.6",
};

function matchingStamps(version = "1.0.6"): ApplyStampReport {
  return {
    daemonVersion: version,
    cliVersion: version,
    dashboardVersion: version,
    daemonTestId: null,
    cliTestId: null,
    dashboardTestId: null,
    dashboardSharedDistHash: "hash",
    sharedDistHash: "hash",
  };
}

const TARGET_MANIFEST = JSON.stringify({ engines: { node: ">=22.13" } });
const TARGET_CHANGELOG = `## [1.0.6] - 2026-10-01

### Upgrade actions

- Install Node 22.13+ before applying
`;

function gitShowTarget(args: string[], changelog = TARGET_CHANGELOG, manifest = TARGET_MANIFEST): string {
  if (args[0] === "show" && args[1] === "refs/max/update-target:package.json") {
    return manifest;
  }
  if (args[0] === "show" && args[1] === "refs/max/update-target:CHANGELOG.md") {
    return changelog;
  }
  if (args[0] === "rev-parse") return "abc";
  return "";
}

describe("b70 max update --apply", () => {
  it("accepts a clean checkout sitting exactly on an older release tag", () => {
    const decision = assessUpdateApply(pinned);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.targetVersion).toBe("1.0.6");
  });

  it("refuses the factory, a dirty tree, local commits, active runs, and dev mode", () => {
    expect(assessUpdateApply({ ...pinned, checkout: { version: "0.0.0-dev", channel: "factory" } }).ok).toBe(false);
    expect(assessUpdateApply({ ...pinned, dirty: true })).toMatchObject({ code: "dirty" });
    expect(assessUpdateApply({ ...pinned, pinnedTags: [] })).toMatchObject({ code: "not-pinned" });
    expect(assessUpdateApply({ ...pinned, pinnedTags: ["v1.0.4"] })).toMatchObject({ code: "not-pinned" });
    expect(
      assessUpdateApply({
        ...pinned,
        publishedPinMatchesHead: false,
        publishedPinError: "unused when the local tag matches",
      }).ok
    ).toBe(true);
    expect(assessUpdateApply({ ...pinned, activeRuns: 2 })).toMatchObject({ code: "active-runs" });
    expect(assessUpdateApply({ ...pinned, devMode: true })).toMatchObject({ code: "dev-mode" });
    expect(assessUpdateApply({ ...pinned, targetTag: "v1.0.5" })).toMatchObject({ code: "not-newer" });
    expect(assessUpdateApply({ ...pinned, targetTag: "latest" })).toMatchObject({ code: "bad-tag" });
  });

  it("builds the public fetch URL", () => {
    expect(releaseFetchUrl("MIT-Consulting/maxwell-automations", null)).toBe(
      "https://github.com/MIT-Consulting/maxwell-automations.git"
    );
  });

  it("prefetches the target and refuses node-floor before any mutation ops", () => {
    const gitCalls: string[][] = [];
    const result = preflightUpdateTarget({
      fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
      targetTag: "v1.0.6",
      targetVersion: "1.0.6",
      runningNode: "20.11.0",
      ops: {
        git: (args) => {
          gitCalls.push(args);
          return gitShowTarget(args);
        },
        log: () => {},
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("node-floor");
      expect(result.message).toContain("v1.0.6 needs Node >=22.13");
      expect(result.message).toContain("runs 20.11.0");
      expect(result.message).toContain("Install Node, then re-run.");
      const metadata = result.metadata;
      expect(metadata).toBeDefined();
      if (!metadata) throw new Error("expected node-floor metadata");
      expect(metadata).toEqual({
        targetTag: "v1.0.6",
        targetVersion: "1.0.6",
        nodeRequirement: ">=22.13",
        upgradeActions: {
          status: "present",
          lines: ["- Install Node 22.13+ before applying"],
        },
      });
      expect(formatPreflightReport(metadata)).toEqual([
        "Target Node requirement: >=22.13",
        "Upgrade actions",
        "  - Install Node 22.13+ before applying",
      ]);
    }
    expect(gitCalls.some((args) => args.includes("refs/tags/v1.0.6:refs/max/update-target"))).toBe(
      true
    );
    expect(gitCalls.some((args) => args[0] === "show" && args[1] === "refs/max/update-target:package.json")).toBe(
      true
    );
    expect(gitCalls.some((args) => args[0] === "show" && args[1] === "refs/max/update-target:CHANGELOG.md")).toBe(
      true
    );
    expect(gitCalls.some((args) => args[0] === "reset")).toBe(false);
    expect(gitCalls.some((args) => args[0] === "update-ref")).toBe(false);
  });

  it("refuses malformed-target without stop, reset, or npm", () => {
    const gitCalls: string[][] = [];
    const missingEngines = preflightUpdateTarget({
      fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
      targetTag: "v1.0.6",
      targetVersion: "1.0.6",
      runningNode: "22.13.0",
      ops: {
        git: (args) => {
          gitCalls.push(args);
          return gitShowTarget(args, TARGET_CHANGELOG, JSON.stringify({ name: "max" }));
        },
        log: () => {},
      },
    });
    expect(missingEngines).toMatchObject({
      ok: false,
      code: "malformed-target",
    });
    expect(missingEngines.ok ? "" : missingEngines.message).toContain("no engines.node");

    const missingSection = preflightUpdateTarget({
      fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
      targetTag: "v1.0.6",
      targetVersion: "1.0.6",
      runningNode: "22.13.0",
      ops: {
        git: (args) => {
          gitCalls.push(args);
          return gitShowTarget(args, "## [1.0.6] - 2026-10-01\n\n### Added\n\n- Feature\n");
        },
        log: () => {},
      },
    });
    expect(missingSection).toMatchObject({
      ok: false,
      code: "malformed-target",
    });
    expect(missingSection.ok ? "" : missingSection.message).toContain("Upgrade actions");

    const badRange = preflightUpdateTarget({
      fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
      targetTag: "v1.0.6",
      targetVersion: "1.0.6",
      runningNode: "22.13.0",
      ops: {
        git: (args) => gitShowTarget(args, TARGET_CHANGELOG, JSON.stringify({ engines: { node: "^22" } })),
        log: () => {},
      },
    });
    expect(badRange).toMatchObject({ ok: false, code: "malformed-target" });

    expect(gitCalls.some((args) => args[0] === "reset")).toBe(false);
    expect(gitCalls.some((args) => args[0] === "update-ref")).toBe(false);
  });

  it("prints none for an empty Upgrade actions section on a compatible target", () => {
    const emptySection = `## [1.0.6] - 2026-10-01

### Upgrade actions

`;
    const result = preflightUpdateTarget({
      fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
      targetTag: "v1.0.6",
      targetVersion: "1.0.6",
      runningNode: "22.13.0",
      ops: {
        git: (args) => gitShowTarget(args, emptySection),
        log: () => {},
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.upgradeActions).toEqual({ status: "empty" });
      expect(formatPreflightReport(result.metadata)).toEqual([
        "Target Node requirement: >=22.13",
        "Upgrade actions",
        "  none",
      ]);
    }
  });

  it("orders preflight fetch before stop, backup, reset, and npm during apply", async () => {
    const gitCalls: string[][] = [];
    const npmCalls: string[][] = [];
    const events: string[] = [];

    const preflight = preflightUpdateTarget({
      fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
      targetTag: "v1.0.6",
      targetVersion: "1.0.6",
      runningNode: "22.13.0",
      ops: {
        git: (args) => {
          gitCalls.push(args);
          return gitShowTarget(args);
        },
        log: (line) => events.push(`log:${line}`),
      },
    });
    expect(preflight.ok).toBe(true);

    let stops = 0;
    await executeUpdateApply({
      root: "/repo",
      targetTag: "v1.0.6",
      targetVersion: "1.0.6",
      wasRunning: true,
      ops: {
        git: (args) => {
          gitCalls.push(args);
          if (args[0] === "rev-parse") return "abc";
          return "";
        },
        npm: (args) => npmCalls.push(args),
        stopDaemon: async () => {
          stops += 1;
          events.push("stop");
        },
        startDaemon: async () => {
          events.push("start");
        },
        healthVersion: async () => "1.0.6",
        readStamps: () => matchingStamps(),
        installSkills: () => {
          events.push("skills");
        },
        cleanBuild: () => {
          npmCalls.push(["<clean>"]);
        },
        log: (line) => events.push(`log:${line}`),
      },
    });

    expect(npmCalls.map((args) => args.join(" "))).toEqual(["ci", "<clean>", "run build"]);
    const fetchIndex = gitCalls.findIndex((args) =>
      args.some((part) => part.includes("refs/max/update-target"))
    );
    const stopIndex = events.indexOf("stop");
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(fetchIndex);
    expect(stops).toBe(1);
    expect(gitCalls.some((args) => args[0] === "reset" && args[2] === "refs/max/update-target")).toBe(
      true
    );
    expect(npmCalls.some((args) => args[0] === "ci")).toBe(true);
    const skillIndex = events.indexOf("skills");
    const startIndex = events.indexOf("start");
    expect(skillIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeGreaterThan(skillIndex);
    expect(
      gitCalls.some(
        (args) => args[0] === "update-ref" && args[1] === "refs/tags/v1.0.6" && args[2] === "abc"
      )
    ).toBe(true);
  });

  it("rolls back when the new build does not report the target version", async () => {
    const gitCalls: string[][] = [];
    const npmCalls: string[][] = [];
    let starts = 0;
    let stops = 0;
    await expect(
      executeUpdateApply({
        root: "/repo",
        targetTag: "v1.0.6",
        targetVersion: "1.0.6",
        wasRunning: true,
        ops: {
          git: (args) => {
            gitCalls.push(args);
            if (args[0] === "rev-parse") return "abc";
            return "";
          },
          npm: (args) => {
            npmCalls.push(args);
          },
          stopDaemon: async () => {
            stops += 1;
          },
          startDaemon: async () => {
            starts += 1;
          },
          healthVersion: async () => "1.0.5",
          readStamps: () => matchingStamps(),
          installSkills: () => {},
          cleanBuild: () => {
            npmCalls.push(["<clean>"]);
          },
          log: () => {},
        },
      })
    ).rejects.toThrow(/expected 1\.0\.6/);

    expect(npmCalls.map((args) => args.join(" "))).toEqual([
      "ci",
      "<clean>",
      "run build",
      "ci",
      "<clean>",
      "run build",
    ]);

    expect(gitCalls.some((args) => args[0] === "update-ref" && args[1] === "refs/max/update-backup")).toBe(true);
    expect(gitCalls.some((args) => args[0] === "reset" && args[2] === "refs/max/update-target")).toBe(true);
    expect(gitCalls.some((args) => args[0] === "reset" && args[2] === "refs/max/update-backup")).toBe(true);
    expect(npmCalls.filter((args) => args[0] === "ci").length).toBe(2);
    expect(starts).toBe(2);
    expect(stops).toBe(2);
    expect(
      gitCalls.some((args) => args[0] === "update-ref" && args[1] === "refs/tags/v1.0.6")
    ).toBe(false);
    const plan = applyPlanLines("MIT-Consulting/maxwell-automations", "v1.0.6");
    expect(plan[0]).toMatch(/v1\.0\.6/);
    expect(plan.some((line) => line.includes("dashboard stamps"))).toBe(true);
    expect(plan.some((line) => line.includes("install bundled skills"))).toBe(true);
    expect(plan.some((line) => line.includes("record the local release tag"))).toBe(true);
  });

  it("accepts a missing local tag when the published tag points at HEAD", () => {
    const decision = assessUpdateApply({
      ...pinned,
      pinnedTags: [],
      publishedPinMatchesHead: true,
    });
    expect(decision.ok).toBe(true);
  });

  it("names the published tag when HEAD is a different commit", () => {
    const decision = assessUpdateApply({
      ...pinned,
      pinnedTags: [],
      publishedPinError: "Published v1.0.5 is abcdefabcdef, HEAD is 123456789abc.",
    });
    expect(decision).toMatchObject({ code: "not-pinned" });
    if (!decision.ok) {
      expect(decision.message).toContain("published tag v1.0.5");
      expect(decision.message).toContain("HEAD is 123456789abc");
    }
  });

  it("fetches the published pin into refs/max/update-pin without writing other tags", () => {
    const gitCalls: string[][] = [];
    const sha = fetchPublishedPinSha({
      fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
      pinTag: "v1.0.5",
      git: (args) => {
        gitCalls.push(args);
        if (args[0] === "rev-parse") return "abc123";
        return "";
      },
    });
    expect(sha).toBe("abc123");
    expect(gitCalls[0]?.[0]).toBe("fetch");
    expect(gitCalls[0]).toContain("--no-tags");
    expect(gitCalls[0]).toContain("refs/tags/v1.0.5:refs/max/update-pin");
    expect(gitCalls[1]).toEqual(["rev-parse", "refs/max/update-pin"]);
    const cliSrc = readFileSync(
      join(import.meta.dirname, "../packages/cli/src/cli.ts"),
      "utf8"
    );
    expect(cliSrc).toContain("fetchPublishedPinSha");
    expect(cliSrc).toContain("readApplyStamps");
    expect(cliSrc).toContain("installBundledSkills");
  });

  it("refuses a dashboard stamp that does not match the shared build it bundled", () => {
    expect(
      assessApplyStamps({
        targetVersion: "1.0.6",
        stamps: { ...matchingStamps(), sharedDistHash: "newer" },
      })
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("different shared build"),
    });
    expect(
      assessApplyStamps({
        targetVersion: "1.0.6",
        stamps: { ...matchingStamps(), dashboardVersion: null },
      })
    ).toMatchObject({ ok: false, message: expect.stringContaining("dashboard") });
    expect(assessApplyStamps({ targetVersion: "1.0.6", stamps: matchingStamps() })).toEqual({
      ok: true,
    });
  });

  it("rolls back without starting the new daemon when stamps disagree", async () => {
    let starts = 0;
    let skills = 0;
    await expect(
      executeUpdateApply({
        root: "/repo",
        targetTag: "v1.0.6",
        targetVersion: "1.0.6",
        wasRunning: true,
        ops: {
          git: (args) => (args[0] === "rev-parse" ? "abc" : ""),
          npm: () => {},
          stopDaemon: async () => {},
          startDaemon: async () => {
            starts += 1;
          },
          healthVersion: async () => "1.0.6",
          readStamps: () => ({ ...matchingStamps(), dashboardVersion: "1.0.5" }),
          installSkills: () => {
            skills += 1;
          },
          cleanBuild: () => {},
          log: () => {},
        },
      })
    ).rejects.toThrow(/dashboard 1\.0\.5/);
    expect(starts).toBe(1);
    expect(skills).toBe(1);
  });

  it("rolls back when skills do not land in sync", async () => {
    let skills = 0;
    let starts = 0;
    await expect(
      executeUpdateApply({
        root: "/repo",
        targetTag: "v1.0.6",
        targetVersion: "1.0.6",
        wasRunning: true,
        ops: {
          git: (args) => (args[0] === "rev-parse" ? "abc" : ""),
          npm: () => {},
          stopDaemon: async () => {},
          startDaemon: async () => {
            starts += 1;
          },
          healthVersion: async () => "1.0.6",
          readStamps: () => matchingStamps(),
          installSkills: () => {
            skills += 1;
            if (skills === 1) throw new Error("skills install exited 1");
          },
          cleanBuild: () => {},
          log: () => {},
        },
      })
    ).rejects.toThrow(/skills install exited 1/);
    expect(skills).toBe(2);
    expect(starts).toBe(1);
  });

  it("reads component stamps and agrees with the embed script on a shared-dist fingerprint", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-stamps-"));
    try {
      const shared = join(root, "packages", "shared", "dist");
      mkdirSync(join(shared, "nested"), { recursive: true });
      writeFileSync(join(shared, "index.js"), "export {}\n");
      writeFileSync(join(shared, "nested", "roadmap.js"), "export const id = 1;\n");
      const stamp = {
        version: "1.0.6",
        channel: "public",
        sharedDistHash: "from-dashboard",
      };
      for (const pkg of ["daemon", "cli", "dashboard"]) {
        const dir = join(root, "packages", pkg, "dist");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "version-embed.json"), `${JSON.stringify(stamp)}\n`);
      }
      const read = readApplyStamps(root);
      expect(read.daemonVersion).toBe("1.0.6");
      expect(read.cliVersion).toBe("1.0.6");
      expect(read.dashboardVersion).toBe("1.0.6");
      expect(read.dashboardSharedDistHash).toBe("from-dashboard");
      expect(read.sharedDistHash).toBe(fingerprintSharedDist(shared));
      expect(read.sharedDistHash).toBe(fingerprintSharedDistScript(shared));
      expect(read.sharedDistHash).not.toBe("from-dashboard");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes package dist folders and tsbuildinfo before a build", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-clean-"));
    try {
      for (const pkg of ["shared", "dashboard"]) {
        mkdirSync(join(root, "packages", pkg, "dist", "nested"), { recursive: true });
        writeFileSync(join(root, "packages", pkg, "dist", "nested", "index.js"), "export {}\n");
        writeFileSync(join(root, "packages", pkg, "package.json"), "{}\n");
      }
      writeFileSync(join(root, "packages", "shared", "tsconfig.tsbuildinfo"), "{}\n");
      mkdirSync(join(root, "packages", "shared", "src"), { recursive: true });
      writeFileSync(join(root, "packages", "shared", "src", "index.ts"), "export {}\n");

      const removed = cleanBuildOutputs(root).sort();

      expect(removed).toEqual([
        "packages/dashboard/dist",
        "packages/shared/dist",
        "packages/shared/tsconfig.tsbuildinfo",
      ]);
      expect(existsSync(join(root, "packages", "shared", "dist"))).toBe(false);
      expect(existsSync(join(root, "packages", "shared", "tsconfig.tsbuildinfo"))).toBe(false);
      expect(existsSync(join(root, "packages", "shared", "src", "index.ts"))).toBe(true);
      expect(existsSync(join(root, "packages", "shared", "package.json"))).toBe(true);
      expect(cleanBuildOutputs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reloads an open dashboard only after the daemon version changes", () => {
    expect(dashboardReloadAction(null, "1.0.6")).toBe("record");
    expect(dashboardReloadAction(null, "")).toBe("stay");
    expect(dashboardReloadAction("1.0.6", "1.0.6")).toBe("stay");
    expect(dashboardReloadAction("1.0.6", "1.0.7")).toBe("reload");
  });
});
