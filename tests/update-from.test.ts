import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_GIT_IDENTITY } from "../scripts/export-public.mjs";
import { DaemonError } from "../packages/cli/src/client.ts";
import { buildTestStamp, createTestBundle } from "../scripts/make-test-bundle.mjs";
import {
  assessApplyStamps,
  assessManifestNodeFloor,
  assessUpdateApply,
  assessUpdateFrom,
  assessUpdateStable,
  executeUpdateApply,
  fetchBundleTip,
  TEST_BUILD_REF,
  type ApplyStampReport,
  type UpdateWorkspaceFacts,
} from "../packages/cli/src/update-apply.ts";
import {
  dashboardBootKey,
  dashboardReloadAction,
} from "../packages/dashboard/src/dashboardReload.ts";
import {
  formatRunningLabel,
  formatTestBuildLine,
  formatUpdateSummary,
  isFactoryIdentity,
  parseIdentityJson,
  resolveUpdateState,
  updateChipLabel,
  updateStateDetail,
} from "../packages/shared/src/version.ts";

const releaseFacts: UpdateWorkspaceFacts = {
  checkout: { version: "1.1.3", channel: "public" },
  pinnedTags: ["v1.1.3"],
  dirty: false,
  activeRuns: 0,
  devMode: false,
  hasStableRef: false,
};

function stamps(version: string, testId: string | null): ApplyStampReport {
  return {
    daemonVersion: version,
    cliVersion: version,
    dashboardVersion: version,
    daemonTestId: testId,
    cliTestId: testId,
    dashboardTestId: testId,
    dashboardSharedDistHash: "hash",
    sharedDistHash: "hash",
  };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(root: string, email: string): void {
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", email]);
  git(root, ["config", "user.name", PUBLIC_GIT_IDENTITY.name]);
  git(root, ["config", "core.autocrlf", "false"]);
}

function commitRelease(root: string, versionJson: string): void {
  writeFileSync(join(root, "version.json"), versionJson);
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "max-test", engines: { node: ">=22.13" } }, null, 2)}\n`
  );
  git(root, ["add", "version.json", "package.json"]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "release"]);
  git(root, ["tag", "v1.2.3"]);
}

describe("test build identity", () => {
  it("keeps a test on its base semver and names the return command", () => {
    const parsed = parseIdentityJson(
      JSON.stringify({
        version: "1.1.3",
        channel: "test",
        base: "1.1.3",
        testId: "abc.1",
      })
    );
    expect(parsed?.channel).toBe("test");
    expect(parsed?.base).toBe("1.1.3");
    expect(parsed?.testId).toBe("abc.1");
    expect(formatRunningLabel(parsed!)).toBe("1.1.3 test abc.1");
    expect(formatTestBuildLine(parsed!)).toBe(
      "Test build abc.1 on 1.1.3. Return to the release with max update --stable."
    );
    expect(isFactoryIdentity(parsed)).toBe(false);
  });

  it("drops an incomplete or suffixed test stamp to unknown", () => {
    expect(
      parseIdentityJson(JSON.stringify({ version: "1.1.3", channel: "test" }))?.channel
    ).toBe("unknown");
    expect(
      parseIdentityJson(
        JSON.stringify({
          version: "1.1.4-test.1",
          channel: "test",
          base: "1.1.4",
          testId: "t",
        })
      )?.channel
    ).toBe("unknown");
    const factory = parseIdentityJson(
      JSON.stringify({ version: "0.0.0-dev", channel: "factory" })
    );
    expect(formatTestBuildLine(factory!)).toBeNull();
  });

  it("reports a test build instead of comparing it to the approved release", () => {
    const running = {
      version: "1.1.3",
      channel: "test" as const,
      base: "1.1.3",
      testId: "abc",
    };
    for (const available of ["1.1.4", "1.1.3", null]) {
      expect(
        resolveUpdateState({
          running,
          checkout: running,
          available,
          availableUnresolved: false,
          checkEnabled: true,
          offline: false,
        })
      ).toBe("test-build");
    }
    expect(updateChipLabel({ updateState: "test-build", running })).toBeNull();
    expect(updateStateDetail("test-build")).toMatch(/Test build installed/);
    expect(formatUpdateSummary({ updateState: "test-build", running })).toBe(
      "test-build — 1.1.3 test abc; return with max update --stable"
    );
  });

  it("names DaemonError so the CLI prints a refusal as one line, not a stack", () => {
    const err = new DaemonError("HEAD is not the published tag v1.1.3.");
    expect(err.name).toBe("DaemonError");
    expect(err).toBeInstanceOf(Error);
  });

  it("refuses --apply on a test build and names the way back", () => {
    expect(
      assessUpdateApply({
        checkout: { version: "1.1.3", channel: "test", base: "1.1.3", testId: "abc" },
        pinnedTags: [],
        dirty: false,
        activeRuns: 0,
        devMode: false,
        targetTag: "v1.1.4",
      })
    ).toEqual({
      ok: false,
      code: "test-build",
      message:
        "This checkout is test build abc on 1.1.3. Run max update --stable first, then max update --apply.",
    });
  });
});

describe("max update --from and --stable", () => {
  it("refuses factory, dirty, active, dev, and an unpinned public checkout before any fetch", () => {
    expect(assessUpdateFrom(releaseFacts)).toEqual({ ok: true, mode: "release" });
    expect(
      assessUpdateFrom({
        ...releaseFacts,
        checkout: { version: "0.0.0-dev", channel: "factory" },
      })
    ).toMatchObject({ code: "factory" });
    expect(assessUpdateFrom({ ...releaseFacts, dirty: true })).toMatchObject({ code: "dirty" });
    expect(assessUpdateFrom({ ...releaseFacts, activeRuns: 1 })).toMatchObject({
      code: "active-runs",
    });
    expect(assessUpdateFrom({ ...releaseFacts, devMode: true })).toMatchObject({ code: "dev-mode" });
    expect(assessUpdateFrom({ ...releaseFacts, pinnedTags: [] })).toMatchObject({
      code: "not-pinned",
    });
  });

  it("replaces a test build only when a stable release is already saved", () => {
    const onTest: UpdateWorkspaceFacts = {
      ...releaseFacts,
      checkout: { version: "1.1.3", channel: "test", base: "1.1.3", testId: "abc" },
      pinnedTags: [],
      hasStableRef: true,
    };
    expect(assessUpdateFrom(onTest)).toEqual({ ok: true, mode: "test" });
    expect(assessUpdateFrom({ ...onTest, hasStableRef: false })).toMatchObject({
      ok: false,
      message: expect.stringContaining("no saved stable"),
    });
    expect(assessUpdateStable(onTest).ok).toBe(true);
    expect(assessUpdateStable({ ...releaseFacts, hasStableRef: false })).toMatchObject({
      message: expect.stringContaining("No stable release is saved"),
    });
  });

  it("requires the test id on daemon, CLI, and dashboard stamps", () => {
    expect(
      assessApplyStamps({ targetVersion: "1.1.3", stamps: stamps("1.1.3", "abc"), testId: "abc" })
    ).toEqual({ ok: true });
    expect(
      assessApplyStamps({
        targetVersion: "1.1.3",
        stamps: { ...stamps("1.1.3", "abc"), cliTestId: null },
        testId: "abc",
      })
    ).toMatchObject({
      ok: false,
      message: "Build stamps are missing test abc on cli.",
    });
  });

  it("records the test ref only after the stamps match", async () => {
    const calls: string[][] = [];
    const gitOp = (args: string[]): string => {
      calls.push(args);
      return args[0] === "rev-parse" ? "abc" : "";
    };
    await expect(
      executeUpdateApply({
        root: "/repo",
        targetTag: "test-abc",
        targetVersion: "1.1.3",
        wasRunning: false,
        recordRef: TEST_BUILD_REF,
        expectedTestId: "abc",
        ops: {
          git: gitOp,
          npm: () => {},
          stopDaemon: async () => {},
          startDaemon: async () => {},
          healthVersion: async () => "1.1.3",
          readStamps: () => ({ ...stamps("1.1.3", "abc"), cliTestId: "other" }),
          installSkills: () => {},
          cleanBuild: () => {},
          log: () => {},
        },
      })
    ).rejects.toThrow(/missing test abc on cli/);
    expect(calls.some((args) => args[1] === TEST_BUILD_REF)).toBe(false);

    calls.length = 0;
    await executeUpdateApply({
      root: "/repo",
      targetTag: "test-abc",
      targetVersion: "1.1.3",
      wasRunning: false,
      recordRef: TEST_BUILD_REF,
      expectedTestId: "abc",
      ops: {
        git: gitOp,
        npm: () => {},
        stopDaemon: async () => {},
        startDaemon: async () => {},
        healthVersion: async () => "1.1.3",
        readStamps: () => stamps("1.1.3", "abc"),
        installSkills: () => {},
        cleanBuild: () => {},
        log: () => {},
      },
    });
    expect(calls).toContainEqual(["update-ref", TEST_BUILD_REF, "abc"]);
  });

  it("refuses a bundle manifest above this machine's Node floor", () => {
    const decision = assessManifestNodeFloor({
      label: "Test abc",
      manifestText: JSON.stringify({ engines: { node: ">=99.0" } }),
      runningNode: process.versions.node,
    });
    expect(decision.ok).toBe(false);
  });

  it("checks the bundle before it stops the daemon, and returns through the saved ref", () => {
    const cli = readFileSync(join(import.meta.dirname, "../packages/cli/src/cli.ts"), "utf8");
    const fromAt = cli.indexOf("async function cmdUpdateFrom");
    const stableAt = cli.indexOf("async function cmdUpdateStable");
    const fromBody = cli.slice(fromAt, stableAt);
    const stableBody = cli.slice(stableAt, cli.indexOf("function installBundledSkills"));
    expect(fromBody.indexOf("assessUpdateFrom")).toBeLessThan(fromBody.indexOf("fetchBundleTip"));
    expect(fromBody.indexOf("fetchBundleTip")).toBeLessThan(fromBody.indexOf("executeUpdateApply"));
    expect(fromBody).toContain("expectedTestId: identity.testId");
    expect(fromBody).toContain("recordRef: TEST_BUILD_REF");
    expect(fromBody).toContain("identity.base !== workspace.checkout?.version");
    expect(cli).toContain('identity.checkout.channel !== "test"');
    expect(stableBody.indexOf("assessUpdateStable")).toBeLessThan(
      stableBody.indexOf("executeUpdateApply")
    );
    expect(stableBody).toContain("refs/tags/v${identity.version}");
    expect(stableBody).toContain("STABLE_REF");
    expect(stableBody).toContain('["update-ref", "-d", TEST_BUILD_REF]');
    const about = readFileSync(
      join(import.meta.dirname, "../packages/dashboard/src/AboutSettingsPanel.tsx"),
      "utf8"
    );
    expect(about).toContain("formatTestBuildLine");
    expect(about).toContain("does not install a release");
    expect(about).not.toContain("max update --apply");
  });
});

describe("dashboard reload across a same-version test build", () => {
  it("reloads when the channel or test id changes and stays on factory", () => {
    const release = dashboardBootKey({
      version: "1.1.3",
      running: { channel: "public", testId: null },
    });
    const testBuild = dashboardBootKey({
      version: "1.1.3",
      running: { channel: "test", testId: "abc" },
    });
    const factory = dashboardBootKey({
      version: "0.0.0-dev",
      running: { channel: "factory", testId: null },
    });
    expect(dashboardReloadAction(null, release)).toBe("record");
    expect(dashboardReloadAction(release, release)).toBe("stay");
    expect(dashboardReloadAction(release, testBuild)).toBe("reload");
    expect(dashboardReloadAction(testBuild, factory)).toBe("reload");
    expect(dashboardReloadAction(factory, factory)).toBe("stay");
    expect(
      dashboardReloadAction(
        null,
        dashboardBootKey({ version: " ", running: { channel: "test", testId: "abc" } })
      )
    ).toBe("stay");
  });
});

describe("test bundle maker", () => {
  it("builds a bundle a clone of the release can fetch, and refuses the other cases", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-from-src-"));
    const consumer = mkdtempSync(join(tmpdir(), "lca-from-consumer-"));
    const stranger = mkdtempSync(join(tmpdir(), "lca-from-stranger-"));
    const dirty = mkdtempSync(join(tmpdir(), "lca-from-dirty-"));
    const wrong = mkdtempSync(join(tmpdir(), "lca-from-email-"));
    const already = mkdtempSync(join(tmpdir(), "lca-from-tagged-"));
    const bundle = join(root, "max-test.bundle");
    try {
      initRepo(root, PUBLIC_GIT_IDENTITY.email);
      commitRelease(
        root,
        `${JSON.stringify({ version: "1.2.3", channel: "public" }, null, 2)}\n`
      );
      const made = createTestBundle({ repo: root, out: bundle, id: "probe1" });
      expect(made).toMatchObject({ base: "1.2.3", testId: "probe1", tag: "v1.2.3" });
      expect(buildTestStamp("1.2.3", "probe1")).toEqual({
        version: "1.2.3",
        channel: "test",
        base: "1.2.3",
        testId: "probe1",
      });

      rmSync(consumer, { recursive: true, force: true });
      execFileSync("git", ["clone", "--quiet", root, consumer], {
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      git(consumer, ["checkout", "--quiet", "--detach", "v1.2.3"]);
      const head = git(consumer, ["rev-parse", "HEAD"]);
      const tip = fetchBundleTip({
        bundlePath: bundle,
        git: (args) => git(consumer, args),
      });
      expect(tip).not.toBe(head);
      expect(git(consumer, ["rev-parse", "HEAD"])).toBe(head);
      const installed = parseIdentityJson(
        git(consumer, ["show", "refs/max/update-target:version.json"])
      );
      expect(installed).toMatchObject({
        version: "1.2.3",
        channel: "test",
        base: "1.2.3",
        testId: "probe1",
      });

      initRepo(stranger, "bundle-test@example.com");
      writeFileSync(join(stranger, "README.md"), "other\n");
      git(stranger, ["add", "README.md"]);
      git(stranger, ["-c", "commit.gpgsign=false", "commit", "-m", "other"]);
      expect(() =>
        fetchBundleTip({ bundlePath: bundle, git: (args) => git(stranger, args) })
      ).toThrow(/prerequisite|lacks|does not/i);

      initRepo(dirty, PUBLIC_GIT_IDENTITY.email);
      commitRelease(
        dirty,
        `${JSON.stringify({ version: "1.2.3", channel: "public" }, null, 2)}\n`
      );
      writeFileSync(join(dirty, "local.txt"), "edit\n");
      expect(() =>
        createTestBundle({ repo: dirty, out: join(dirty, "no.bundle"), id: "dirty1" })
      ).toThrow(/dirty/);

      initRepo(wrong, "bundle-test@example.com");
      commitRelease(
        wrong,
        `${JSON.stringify({ version: "1.2.3", channel: "public" }, null, 2)}\n`
      );
      expect(() =>
        createTestBundle({ repo: wrong, out: join(wrong, "no.bundle"), id: "mail1" })
      ).toThrow(/user\.email/);

      initRepo(already, PUBLIC_GIT_IDENTITY.email);
      commitRelease(
        already,
        `${JSON.stringify(buildTestStamp("1.2.3", "same1"), null, 2)}\n`
      );
      expect(() =>
        createTestBundle({ repo: already, out: join(already, "no.bundle"), id: "same1" })
      ).toThrow(/is HEAD/);

      git(already, [
        "remote",
        "add",
        "origin",
        "https://github.com/MIT-Consulting/maxwell-automations.git",
      ]);
      expect(() =>
        createTestBundle({ repo: already, out: join(already, "no.bundle"), id: "pub1" })
      ).toThrow(/origin is https:\/\/github\.com/);
      expect(git(already, ["log", "-1", "--format=%s"])).not.toMatch(/pub1/);
    } finally {
      for (const dir of [root, consumer, stranger, dirty, wrong, already]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
