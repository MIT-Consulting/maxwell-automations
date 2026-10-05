import { describe, expect, it } from "vitest";
import {
  extractUpgradeActions,
  extractUpgradeActionsFromReleaseBody,
  formatUpgradeActionsLines,
  upgradeActionsForPersistence,
} from "../packages/shared/src/upgrade-actions.ts";

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

## [1.0.8] - 2026-10-01

### Added

- Newer release

### Upgrade actions

- Run migrations

## [1.0.7] - 2026-09-29

### Added

- Feature

### Upgrade actions

- Install Node 22.13+ before npm ci
- Rebuild after pull

### Changed

- Floor raised

## [1.0.6] - 2026-09-21

### Upgrade actions

none

## [1.0.5] - 2026-09-16

### Fixed

- Bug
`;

describe("b76 upgrade actions extraction", () => {
  it("extracts from a release body without a version heading", () => {
    const body = `### Added\n\n- Feature\n\n### Upgrade actions\n\n- npm ci\n`;
    expect(extractUpgradeActionsFromReleaseBody(body)).toEqual({
      status: "present",
      lines: ["- npm ci"],
    });
    expect(upgradeActionsForPersistence(extractUpgradeActionsFromReleaseBody(body))).toEqual([
      "- npm ci",
    ]);
    expect(upgradeActionsForPersistence(extractUpgradeActionsFromReleaseBody("no section"))).toBeNull();
  });

  it("extracts bullet lines in order for the target release", () => {
    const result = extractUpgradeActions(SAMPLE_CHANGELOG, "1.0.7");
    expect(result).toEqual({
      status: "present",
      lines: ["- Install Node 22.13+ before npm ci", "- Rebuild after pull"],
    });
    expect(formatUpgradeActionsLines(result)).toEqual([
      "- Install Node 22.13+ before npm ci",
      "- Rebuild after pull",
    ]);
  });

  it("returns none for an explicit none section", () => {
    const result = extractUpgradeActions(SAMPLE_CHANGELOG, "1.0.6");
    expect(result).toEqual({ status: "none" });
    expect(formatUpgradeActionsLines(result)).toEqual(["none"]);
  });

  it("ignores adjacent releases and other subsections", () => {
    const result = extractUpgradeActions(SAMPLE_CHANGELOG, "1.0.8");
    expect(result).toEqual({
      status: "present",
      lines: ["- Run migrations"],
    });
  });

  it("detects missing target, missing section, and empty section", () => {
    expect(extractUpgradeActions(SAMPLE_CHANGELOG, "9.9.9")).toEqual({
      status: "missing-target",
    });
    expect(extractUpgradeActions(SAMPLE_CHANGELOG, "1.0.5")).toEqual({
      status: "missing-section",
    });

    const emptySection = `## [2.0.0] - 2026-10-01

### Upgrade actions

### Changed

- Something
`;
    expect(extractUpgradeActions(emptySection, "2.0.0")).toEqual({ status: "empty" });
    expect(formatUpgradeActionsLines({ status: "empty" })).toEqual(["none"]);
  });

  it("rejects malformed heading case and level", () => {
    const wrongCase = `## [3.0.0] - 2026-10-01

### Upgrade Actions

- Should not match
`;
    expect(extractUpgradeActions(wrongCase, "3.0.0")).toEqual({ status: "missing-section" });

    const wrongLevel = `## [3.0.1] - 2026-10-01

#### Upgrade actions

- Too deep
`;
    expect(extractUpgradeActions(wrongLevel, "3.0.1")).toEqual({ status: "missing-section" });

    const h2Heading = `## [3.0.2] - 2026-10-01

## Upgrade actions

- Wrong level
`;
    expect(extractUpgradeActions(h2Heading, "3.0.2")).toEqual({ status: "missing-section" });
  });

  it("accepts v-prefixed target versions and paragraph content", () => {
    const paragraph = `## [4.0.0] - 2026-10-01

### Upgrade actions

Re-run npm ci after upgrading Node.

Then restart the daemon.
`;
    const result = extractUpgradeActions(paragraph, "v4.0.0");
    expect(result).toEqual({
      status: "present",
      lines: ["Re-run npm ci after upgrading Node.", "Then restart the daemon."],
    });
  });

  it("trims outer blank lines and bounds very long sections", () => {
    const manyLines = `## [5.0.0] - 2026-10-01

### Upgrade actions


- first

- second


`;
    const result = extractUpgradeActions(manyLines, "5.0.0");
    expect(result.status).toBe("present");
    if (result.status === "present") {
      expect(result.lines).toEqual(["- first", "- second"]);
    }

    const oversized = Array.from({ length: 60 }, (_, i) => `- action ${i + 1}`).join("\n");
    const bounded = extractUpgradeActions(
      `## [5.0.1] - 2026-10-01\n\n### Upgrade actions\n\n${oversized}\n`,
      "5.0.1"
    );
    expect(bounded.status).toBe("present");
    if (bounded.status === "present") {
      expect(bounded.lines).toHaveLength(50);
      expect(bounded.lines[0]).toBe("- action 1");
      expect(bounded.lines[49]).toBe("- action 50");
    }

    const hugeLine = `## [5.0.2]\n\n### Upgrade actions\n\n${"x".repeat(9_000)}\n`;
    const charBounded = extractUpgradeActions(hugeLine, "5.0.2");
    expect(charBounded.status).toBe("present");
    if (charBounded.status === "present") {
      expect(charBounded.lines.join("").length).toBeLessThanOrEqual(8_000);
    }
  });
});
