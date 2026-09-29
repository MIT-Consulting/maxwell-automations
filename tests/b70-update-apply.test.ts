import { describe, expect, it } from "vitest";
import {
  applyPlanLines,
  assessUpdateApply,
  executeUpdateApply,
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

  it("rolls back when the new build does not report the target version", async () => {
    const gitCalls: string[][] = [];
    const npmCalls: string[][] = [];
    let starts = 0;
    let stops = 0;
    await expect(
      executeUpdateApply({
        root: "/repo",
        repo: "MIT-Consulting/maxwell-automations",
        fetchUrl: "https://github.com/MIT-Consulting/maxwell-automations.git",
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
