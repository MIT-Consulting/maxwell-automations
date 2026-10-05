import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkEngineFloorPolicy,
  listChangelogSections,
  parseNodeFloorRequirement,
  parseUpgradeActionsSection,
  runReleasePreflight,
  validateChangelogUpgradeActions,
} from "../scripts/release-preflight.mjs";

const VALID_CHANGELOG = `# Changelog

## [Unreleased]

### Upgrade actions

none

## [1.0.7] - 2026-09-29

### Changed

- Node floor is 22.13+.

### Upgrade actions

- Node 22.13+ is required because \`@cursor/sdk\` 1.0.32 needs it. Install Node 22 or 24 LTS before \`npm ci\`.

## [1.0.6] - 2026-09-21

### Upgrade actions

none
`;

const PACKAGE_22 = JSON.stringify({ engines: { node: ">=22.13" } }, null, 2);

function initGitClone(dir: string, tag: string, engines: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ engines: { node: engines } }, null, 2)
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("add", "package.json");
  git("commit", "-q", "-m", "init");
  git("tag", `v${tag}`);
}

describe("b76 release preflight — Upgrade actions parser", () => {
  it("accepts explicit none", () => {
    expect(parseUpgradeActionsSection("### Upgrade actions\n\nnone\n")).toEqual({
      ok: true,
      lines: ["none"],
      isNone: true,
    });
  });

  it("accepts bullet actions", () => {
    expect(
      parseUpgradeActionsSection("### Upgrade actions\n\n- Install Node\n")
    ).toEqual({
      ok: true,
      lines: ["- Install Node"],
      isNone: false,
    });
  });

  it("rejects missing, duplicate, and empty sections", () => {
    expect(parseUpgradeActionsSection("### Added\n\n- x")).toEqual({
      ok: false,
      reason: "missing Upgrade actions section",
    });
    expect(
      parseUpgradeActionsSection(
        "### Upgrade actions\n\n### Upgrade actions\n\nnone\n"
      )
    ).toEqual({
      ok: false,
      reason: "duplicate Upgrade actions section",
    });
    expect(parseUpgradeActionsSection("### Upgrade actions\n\n\n")).toEqual({
      ok: false,
      reason: "empty Upgrade actions section",
    });
  });
});

describe("b76 release preflight — changelog validation", () => {
  it("lists Unreleased and versioned sections", () => {
    const sections = listChangelogSections(VALID_CHANGELOG);
    expect(sections.map((s) => s.label)).toEqual(["Unreleased", "1.0.7", "1.0.6"]);
  });

  it("passes a well-formed changelog", () => {
    expect(validateChangelogUpgradeActions(VALID_CHANGELOG)).toEqual({ ok: true });
  });

  it("rejects malformed headings in fixtures", () => {
    const missing = VALID_CHANGELOG.replace(
      "### Upgrade actions\n\nnone\n",
      ""
    );
    const missingResult = validateChangelogUpgradeActions(missing);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) {
      expect(
        missingResult.errors.some((e) => e.includes("missing Upgrade actions"))
      ).toBe(true);
    }

    const wrongCase = VALID_CHANGELOG.replace(
      "### Upgrade actions\n\nnone\n",
      "### Upgrade Actions\n\nnone\n"
    );
    const caseResult = validateChangelogUpgradeActions(wrongCase);
    expect(caseResult.ok).toBe(false);
    if (!caseResult.ok) {
      expect(caseResult.errors.join("\n")).toMatch(/wrong-case/);
    }

    const wrongLevel = VALID_CHANGELOG.replace(
      "### Upgrade actions\n\nnone\n",
      "## Upgrade actions\n\nnone\n"
    );
    const levelResult = validateChangelogUpgradeActions(wrongLevel);
    expect(levelResult.ok).toBe(false);
    if (!levelResult.ok) {
      expect(levelResult.errors.join("\n")).toMatch(/wrong-level/);
    }
  });
});

describe("b76 release preflight — engine floor policy", () => {
  it("passes when engines are unchanged", () => {
    expect(
      checkEngineFloorPolicy({
        currentEngines: ">=22.13",
        previousEngines: ">=22.13",
        upgradeActionsText: "",
        currentVersion: "1.0.8",
        previousVersion: "1.0.7",
      })
    ).toEqual({ ok: true });
  });

  it("fails when engines changed but Upgrade actions omit runtime work", () => {
    const result = checkEngineFloorPolicy({
      currentEngines: ">=22.13",
      previousEngines: ">=20.0",
      upgradeActionsText: "none",
      currentVersion: "1.0.7",
      previousVersion: "1.0.6",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/Upgrade actions/);
    }
  });

  it("fails patch bump when floor is raised", () => {
    const result = checkEngineFloorPolicy({
      currentEngines: ">=22.13",
      previousEngines: ">=20.0",
      upgradeActionsText: "Install Node 22.13+ before npm ci",
      currentVersion: "1.0.7",
      previousVersion: "1.0.6",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/minor version bump/);
    }
  });

  it("allows minor bump when floor is raised and documented", () => {
    expect(
      checkEngineFloorPolicy({
        currentEngines: ">=22.13",
        previousEngines: ">=20.0",
        upgradeActionsText: "Install Node 22.13+ before npm ci",
        currentVersion: "1.1.0",
        previousVersion: "1.0.6",
      })
    ).toEqual({ ok: true });
  });

  it("allows major bump when floor is raised and documented", () => {
    expect(
      checkEngineFloorPolicy({
        currentEngines: ">=22.13",
        previousEngines: ">=20.0",
        upgradeActionsText: "Install Node 22.13+ before npm ci",
        currentVersion: "2.0.0",
        previousVersion: "1.0.6",
      })
    ).toEqual({ ok: true });
  });

  it("allows floor decrease when documented", () => {
    expect(
      checkEngineFloorPolicy({
        currentEngines: ">=20.0",
        previousEngines: ">=22.13",
        upgradeActionsText: "Node floor lowered to 20 for compatibility",
        currentVersion: "2.0.0",
        previousVersion: "1.0.7",
      })
    ).toEqual({ ok: true });
  });

  it("parses >=X.Y and >=X.Y.Z floors", () => {
    expect(parseNodeFloorRequirement(">=22.13").ok).toBe(true);
    expect(parseNodeFloorRequirement(">=22.13.1").ok).toBe(true);
    expect(parseNodeFloorRequirement("^22.13").ok).toBe(false);
  });
});

describe("b76 release preflight — orchestrator", () => {
  it("fails closed when the export clone is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "max-preflight-"));
    try {
      const result = runReleasePreflight({
        repoRoot: dir,
        changelogText: VALID_CHANGELOG,
        packageJsonText: PACKAGE_22,
        clonePath: join(dir, "missing-clone"),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/export clone/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when clone tag matches current engines", () => {
    const dir = mkdtempSync(join(tmpdir(), "max-preflight-"));
    const clone = join(dir, "maxwell-automations");
    try {
      initGitClone(clone, "1.0.7", ">=22.13");
      const result = runReleasePreflight({
        repoRoot: dir,
        changelogText: VALID_CHANGELOG,
        packageJsonText: PACKAGE_22,
        clonePath: clone,
      });
      expect(result).toEqual({
        ok: true,
        newestVersion: "1.0.7",
        previousTag: "1.0.7",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails a patch floor raise against a lower tagged engines.node", () => {
    const dir = mkdtempSync(join(tmpdir(), "max-preflight-"));
    const clone = join(dir, "maxwell-automations");
    try {
      initGitClone(clone, "1.0.6", ">=20.0");
      const result = runReleasePreflight({
        repoRoot: dir,
        changelogText: VALID_CHANGELOG,
        packageJsonText: PACKAGE_22,
        clonePath: clone,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/minor version bump/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("b76 release preflight — live changelog", () => {
  it("validates the repository CHANGELOG.md", () => {
    const changelog = readFileSync(
      join(process.cwd(), "CHANGELOG.md"),
      "utf8"
    );
    expect(validateChangelogUpgradeActions(changelog)).toEqual({ ok: true });
    expect(changelog).toContain("### Upgrade actions");
    expect(changelog).toMatch(/Node 22\.13\+ is required because `@cursor\/sdk` 1\.0\.32/);
  });
});
