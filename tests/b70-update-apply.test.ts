import { describe, expect, it } from "vitest";
import {
  applyPlanLines,
  assessUpdateApply,
  executeUpdateApply,
  formatPreflightReport,
  preflightUpdateTarget,
  releaseFetchUrl,
  type ApplyFacts,
} from "../packages/cli/src/update-apply.ts";

const pinned: ApplyFacts = {
  checkout: { version: "1.0.5", channel: "public" },
  pinnedTags: ["v1.0.5"],
  dirty: false,
  activeRuns: 0,
  devMode: false,
  targetTag: "v1.0.6",
};

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
        log: (line) => events.push(`log:${line}`),
      },
    });

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
          log: () => {},
        },
      })
    ).rejects.toThrow(/expected 1\.0\.6/);

    expect(gitCalls.some((args) => args[0] === "update-ref" && args[1] === "refs/max/update-backup")).toBe(true);
    expect(gitCalls.some((args) => args[0] === "reset" && args[2] === "refs/max/update-target")).toBe(true);
    expect(gitCalls.some((args) => args[0] === "reset" && args[2] === "refs/max/update-backup")).toBe(true);
    expect(npmCalls.filter((args) => args[0] === "ci").length).toBe(2);
    expect(starts).toBe(2);
    expect(stops).toBe(2);
    expect(applyPlanLines("MIT-Consulting/maxwell-automations", "v1.0.6")[0]).toMatch(/v1\.0\.6/);
  });
});
