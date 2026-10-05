import { describe, expect, it } from "vitest";
import {
  collectEnvironmentFacts,
  npmBinFor,
  npmSpawnSyncOptions,
} from "../packages/cli/src/cli.ts";
import {
  formatEnvironmentLines,
  summarizeEnvironment,
  type EnvironmentFacts,
} from "../packages/cli/src/doctor.ts";

function facts(overrides: Partial<EnvironmentFacts> = {}): EnvironmentFacts {
  return {
    cliNode: "22.22.2",
    requirement: ">=22.13",
    requirementSource: "package.json",
    npmVersion: "10.9.7",
    skillStatus: "in-sync",
    ...overrides,
  };
}

describe("b76 doctor Environment", () => {
  it("npmBinFor selects npm.cmd on win32 and npm elsewhere", () => {
    expect(npmBinFor("win32")).toBe("npm.cmd");
    expect(npmBinFor("linux")).toBe("npm");
    expect(npmBinFor("darwin")).toBe("npm");
  });

  it("npmSpawnSyncOptions enables shell on win32 only", () => {
    const winOpts = npmSpawnSyncOptions("win32", { encoding: "utf8" });
    expect(winOpts.shell).toBe(true);
    expect(winOpts.windowsHide).toBe(true);
    expect(winOpts.encoding).toBe("utf8");

    const linuxOpts = npmSpawnSyncOptions("linux", { encoding: "utf8" });
    expect(linuxOpts.shell).toBe(false);
    expect(linuxOpts.windowsHide).toBe(true);

    const darwinOpts = npmSpawnSyncOptions("darwin", {});
    expect(darwinOpts.shell).toBe(false);
    expect(darwinOpts.windowsHide).toBe(true);
  });

  it("npmSpawnSyncOptions cannot override shell off on win32", () => {
    const opts = npmSpawnSyncOptions("win32", { shell: false });
    expect(opts.shell).toBe(true);
  });

  it("formats a healthy environment", () => {
    const lines = formatEnvironmentLines(summarizeEnvironment(facts()));
    expect(lines.join("\n")).toMatch(/Node: 22\.22\.2 \(requires >=22\.13\)/);
    expect(lines.join("\n")).toMatch(/npm: 10\.9\.7/);
    expect(lines.join("\n")).toMatch(/skills: in sync with this checkout/);
    expect(lines.some((l) => l.startsWith("  fix:"))).toBe(false);
  });

  it("reports old CLI Node with LTS fix", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(facts({ cliNode: "20.19.0" }))
    );
    expect(lines.join("\n")).toMatch(/Node: CLI 20\.19\.0/);
    expect(lines.join("\n")).toMatch(/Install Node 22 or 24 LTS/);
    expect(lines.join("\n")).toMatch(/https:\/\/nodejs\.org\/en\/download/);
  });

  it("shows daemon Node separately when it differs from CLI", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(
        facts({ cliNode: "22.22.2", daemonNode: "22.13.1" })
      )
    );
    expect(lines.join("\n")).toMatch(/CLI 22\.22\.2/);
    expect(lines.join("\n")).toMatch(/daemon 22\.13\.1/);
  });

  it("shares one Node line when CLI and daemon match", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(
        facts({ cliNode: "22.22.2", daemonNode: "22.22.2" })
      )
    );
    expect(lines.join("\n")).toMatch(/Node: 22\.22\.2.*CLI and daemon/);
  });

  it("degrades npm to unavailable with fix", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(
        facts({
          npmVersion: null,
          npmUnavailableReason: "spawn ENOENT",
        })
      )
    );
    expect(lines.join("\n")).toMatch(/npm: unavailable/);
    expect(lines.join("\n")).toMatch(/fix: spawn ENOENT/);
  });

  it("reports skill drift with install command", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(facts({ skillStatus: "drift" }))
    );
    expect(lines.join("\n")).toMatch(/skills: differs from this checkout/);
    expect(lines.join("\n")).toMatch(/fix: max skills install/);
  });

  it("reports unavailable skill check without calling it drift", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(
        facts({
          skillStatus: "unavailable",
          skillUnavailableReason: "install-skill.mjs not found",
        })
      )
    );
    expect(lines.join("\n")).toMatch(/skills: install-skill\.mjs not found/);
    expect(lines.join("\n")).toMatch(/fix: max skills install/);
  });

  it("handles missing requirement source", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(
        facts({
          requirement: null,
          requirementSource: null,
        })
      )
    );
    expect(lines.join("\n")).toMatch(/Could not resolve the required Node version/);
  });

  it("omits daemon Node when not provided", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(facts({ daemonNode: undefined }))
    );
    expect(lines.join("\n")).not.toMatch(/daemon/);
  });

  it("collects Environment with daemon down without aborting", () => {
    const collected = collectEnvironmentFacts(null);
    expect(collected.cliNode).toBe(process.versions.node);
    expect(collected.daemonNode).toBeUndefined();
    expect(["in-sync", "drift", "unavailable"]).toContain(collected.skillStatus);
    if (collected.npmVersion == null) {
      expect(collected.npmUnavailableReason).toBeTruthy();
    }
    if (collected.skillStatus === "unavailable") {
      expect(collected.skillUnavailableReason).toBeTruthy();
    }
    const lines = formatEnvironmentLines(summarizeEnvironment(collected));
    expect(lines.findIndex((l) => l.includes("Node:"))).toBeLessThan(
      lines.findIndex((l) => l.includes("npm:"))
    );
    expect(lines.join("\n")).not.toMatch(/daemon/);
  });

  it("renders Node, npm, and skills in deterministic order", () => {
    const lines = formatEnvironmentLines(
      summarizeEnvironment(
        facts({
          cliNode: "20.0.0",
          npmVersion: null,
          skillStatus: "drift",
        })
      )
    );
    const nodeIdx = lines.findIndex((l) => l.includes("Node:"));
    const npmIdx = lines.findIndex((l) => l.includes("npm:"));
    const skillsIdx = lines.findIndex((l) => l.includes("skills:"));
    expect(nodeIdx).toBeGreaterThanOrEqual(0);
    expect(npmIdx).toBeGreaterThan(nodeIdx);
    expect(skillsIdx).toBeGreaterThan(npmIdx);
  });
});
