import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  compareSemver,
  extractUpgradeActions,
  formatRunningNodeLabel,
  formatUpgradeActionsLines,
  isFactoryIdentity,
  parseNodeFloorFromPackageManifest,
  parseNodeFloorRequirement,
  satisfiesNodeFloor,
  type UpgradeActionsExtract,
  type VersionIdentity,
} from "@lca/shared";

export type ApplyRefusal =
  | "factory"
  | "dirty"
  | "not-pinned"
  | "active-runs"
  | "dev-mode"
  | "bad-tag"
  | "not-newer"
  | "node-floor"
  | "malformed-target"
  | "test-build";

export type ApplyFacts = {
  checkout: VersionIdentity | null;
  /** Tags that point exactly at HEAD. */
  pinnedTags: readonly string[];
  dirty: boolean;
  activeRuns: number;
  devMode: boolean;
  /** `vX.Y.Z` */
  targetTag: string;
  /**
   * True when the published `v{checkout.version}` tag points at HEAD.
   * The CLI sets this when that tag is not in the local tag list.
   */
  publishedPinMatchesHead?: boolean;
  /** Included in the not-pinned refusal when the published tag could not be confirmed. */
  publishedPinError?: string;
};

export type ApplyDecision =
  | { ok: true; targetTag: string; targetVersion: string }
  | { ok: false; code: ApplyRefusal; message: string };

export type ApplyTargetMetadata = {
  targetTag: string;
  targetVersion: string;
  nodeRequirement: string;
  upgradeActions: UpgradeActionsExtract;
};

export type PreflightResult =
  | { ok: true; metadata: ApplyTargetMetadata }
  | { ok: false; code: ApplyRefusal; message: string; metadata?: ApplyTargetMetadata };

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

export function normalizeReleaseTag(input: string): string | null {
  const trimmed = input.trim();
  const withV = trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
  return RELEASE_TAG.test(withV) ? withV : null;
}

export function releaseFetchUrl(repo: string, host: string | null): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const base = (host ?? "https://github.com").replace(/\/$/, "");
  if (base === "https://api.github.com" || base === "api.github.com") {
    return `https://github.com/${repo}.git`;
  }
  if (base.endsWith("/api/v3")) {
    return `${base.slice(0, -"/api/v3".length)}/${repo}.git`;
  }
  return `${base}/${repo}.git`;
}

export function assessUpdateApply(facts: ApplyFacts): ApplyDecision {
  const targetTag = normalizeReleaseTag(facts.targetTag);
  if (!targetTag) {
    return {
      ok: false,
      code: "bad-tag",
      message: `Release tag must look like v1.2.3 (got ${facts.targetTag}).`,
    };
  }
  const targetVersion = targetTag.slice(1);

  if (!facts.checkout || isFactoryIdentity(facts.checkout)) {
    return {
      ok: false,
      code: "factory",
      message:
        "This checkout is the factory (0.0.0-dev). max update --apply only moves a tag-pinned public clone.",
    };
  }

  if (facts.checkout.channel === "test") {
    const base = facts.checkout.base ?? facts.checkout.version;
    return {
      ok: false,
      code: "test-build",
      message: `This checkout is test build ${facts.checkout.testId ?? "unknown"} on ${base}. Run max update --stable first, then max update --apply.`,
    };
  }

  if (facts.dirty) {
    return {
      ok: false,
      code: "dirty",
      message: "Working tree is dirty. Commit or stash local edits before applying a release.",
    };
  }

  const pinStatus = headIsPublishedRelease(facts);
  if (!pinStatus.ok) {
    return { ok: false, code: "not-pinned", message: pinStatus.message };
  }

  if (facts.activeRuns > 0) {
    return {
      ok: false,
      code: "active-runs",
      message: `${facts.activeRuns} run(s) are still active. Let them finish before applying a release.`,
    };
  }

  if (facts.devMode) {
    return {
      ok: false,
      code: "dev-mode",
      message: "The dev rig is running. Stop it before applying a release.",
    };
  }

  const cmp = compareSemver(facts.checkout.version, targetVersion);
  if (cmp === null || cmp >= 0) {
    return {
      ok: false,
      code: "not-newer",
      message: `Target ${targetTag} is not newer than the pinned checkout ${pinStatus.pin}.`,
    };
  }

  return { ok: true, targetTag, targetVersion };
}

export function formatNodeFloorApplyRefusal(input: {
  tag: string;
  requirement: string;
  running: string;
}): string {
  const running = formatRunningNodeLabel(input.running);
  return (
    `${input.tag} needs Node ${input.requirement.trim()}; this machine runs ${running}. ` +
    "Install Node, then re-run."
  );
}

export function applyPlanLines(repo: string, targetTag: string): string[] {
  return [
    `Apply ${targetTag} from ${repo}`,
    "  backup HEAD at refs/max/update-backup",
    `  fetch ${targetTag}`,
    "  move this pin to that tag (no local commits to keep)",
    "  npm ci",
    "  npm run build from empty dist folders",
    "  require daemon, CLI, and dashboard stamps to match the new version",
    "  install bundled skills",
    "  start the daemon and require /health to report the new version",
    "  record the local release tag",
    "  if any step fails, reset to the backup, rebuild, restore skills, and start again",
  ];
}

export function formatPreflightReport(metadata: ApplyTargetMetadata): string[] {
  const lines = [
    `Target Node requirement: ${metadata.nodeRequirement}`,
    "Upgrade actions",
    ...formatUpgradeActionsLines(metadata.upgradeActions).map((line) => `  ${line}`),
  ];
  return lines;
}

export const STABLE_REF = "refs/max/stable";
export const TEST_BUILD_REF = "refs/max/test-build";

export type ApplyStampReport = {
  daemonVersion: string | null;
  cliVersion: string | null;
  dashboardVersion: string | null;
  daemonTestId: string | null;
  cliTestId: string | null;
  dashboardTestId: string | null;
  /** Shared-dist fingerprint recorded when the dashboard build wrote its stamp. */
  dashboardSharedDistHash: string | null;
  /** Shared-dist fingerprint after the whole build finished. */
  sharedDistHash: string | null;
};

export type ApplyOps = {
  git: (args: string[]) => string;
  npm: (args: string[]) => void;
  stopDaemon: () => Promise<void>;
  startDaemon: () => Promise<void>;
  healthVersion: () => Promise<string>;
  /** Stamps written by this build, plus the shared dist as it sits now. */
  readStamps: () => ApplyStampReport;
  /** Copy bundled skills into the operator profile and require them to match. */
  installSkills: () => void;
  /** Remove build output and incremental state so the next build starts empty. */
  cleanBuild: () => void;
  log: (line: string) => void;
};

/**
 * Delete each workspace package's `dist` and `*.tsbuildinfo`. A buildinfo that
 * outlives its `dist` makes `tsc` skip declaration emit, so the build would
 * otherwise depend on whatever the previous checkout left behind.
 * Returns the removed paths relative to `root`.
 */
export function cleanBuildOutputs(root: string): string[] {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(packagesDir)) {
    const pkg = join(packagesDir, name);
    if (!statSync(pkg).isDirectory()) continue;
    const dist = join(pkg, "dist");
    if (existsSync(dist)) {
      rmSync(dist, { recursive: true, force: true });
      removed.push(`packages/${name}/dist`);
    }
    for (const file of readdirSync(pkg)) {
      if (!file.endsWith(".tsbuildinfo")) continue;
      rmSync(join(pkg, file), { force: true });
      removed.push(`packages/${name}/${file}`);
    }
  }
  return removed;
}

/**
 * Fingerprint of every file under a shared `dist` directory.
 * Keep in lockstep with `fingerprintSharedDist` in `scripts/embed-version.mjs`.
 * Returns null when the directory is absent.
 */
export function fingerprintSharedDist(rootDir: string): string | null {
  if (!existsSync(rootDir)) return null;
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const info = statSync(full);
      if (info.isDirectory()) walk(full, rel);
      else if (info.isFile()) files.push(rel);
    }
  };
  walk(rootDir, "");
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(rootDir, ...rel.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function versionField(parsed: Record<string, unknown> | null): string | null {
  if (!parsed || typeof parsed.version !== "string") return null;
  const version = parsed.version.trim();
  return version.length > 0 ? version : null;
}

function testIdField(parsed: Record<string, unknown> | null): string | null {
  if (!parsed || typeof parsed.testId !== "string") return null;
  const testId = parsed.testId.trim();
  return testId.length > 0 ? testId : null;
}

export function readApplyStamps(root: string): ApplyStampReport {
  const readJson = (rel: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const dashboard = readJson("packages/dashboard/dist/version-embed.json");
  const dashboardSharedDistHash =
    dashboard && typeof dashboard.sharedDistHash === "string"
      ? dashboard.sharedDistHash.trim() || null
      : null;
  const daemon = readJson("packages/daemon/dist/version-embed.json");
  const cli = readJson("packages/cli/dist/version-embed.json");
  return {
    daemonVersion: versionField(daemon),
    cliVersion: versionField(cli),
    dashboardVersion: versionField(dashboard),
    daemonTestId: testIdField(daemon),
    cliTestId: testIdField(cli),
    dashboardTestId: testIdField(dashboard),
    dashboardSharedDistHash,
    sharedDistHash: fingerprintSharedDist(join(root, "packages", "shared", "dist")),
  };
}

export function assessApplyStamps(input: {
  targetVersion: string;
  stamps: ApplyStampReport;
  /** When set, every component stamp must carry this test id. */
  testId?: string | null;
}): { ok: true } | { ok: false; message: string } {
  const { stamps, targetVersion } = input;
  const missing: string[] = [];
  if (!stamps.daemonVersion) missing.push("daemon");
  if (!stamps.cliVersion) missing.push("cli");
  if (!stamps.dashboardVersion) missing.push("dashboard");
  if (missing.length > 0) {
    return { ok: false, message: `Build did not stamp ${missing.join(", ")}.` };
  }
  const wrong: string[] = [];
  if (stamps.daemonVersion !== targetVersion) wrong.push(`daemon ${stamps.daemonVersion}`);
  if (stamps.cliVersion !== targetVersion) wrong.push(`cli ${stamps.cliVersion}`);
  if (stamps.dashboardVersion !== targetVersion) {
    wrong.push(`dashboard ${stamps.dashboardVersion}`);
  }
  if (wrong.length > 0) {
    return {
      ok: false,
      message: `Build stamps are ${wrong.join(", ")}; expected ${targetVersion}.`,
    };
  }
  if (
    !stamps.dashboardSharedDistHash ||
    !stamps.sharedDistHash ||
    stamps.dashboardSharedDistHash !== stamps.sharedDistHash
  ) {
    return {
      ok: false,
      message:
        "Dashboard was built against a different shared build than the one this build produced.",
    };
  }
  if (input.testId) {
    const missing = (
      [
        ["daemon", stamps.daemonTestId],
        ["cli", stamps.cliTestId],
        ["dashboard", stamps.dashboardTestId],
      ] as const
    )
      .filter(([, id]) => id !== input.testId)
      .map(([name]) => name);
    if (missing.length > 0) {
      return {
        ok: false,
        message: `Build stamps are missing test ${input.testId} on ${missing.join(", ")}.`,
      };
    }
  }
  return { ok: true };
}

/** Fetch `refs/tags/<pin>` into `refs/max/update-pin` and return that commit. */
export function fetchPublishedPinSha(args: {
  fetchUrl: string;
  pinTag: string;
  token?: string;
  git: (args: string[]) => string;
}): string {
  const fetchArgs = [
    "fetch",
    "--no-tags",
    args.fetchUrl,
    `refs/tags/${args.pinTag}:refs/max/update-pin`,
  ];
  if (args.token) {
    args.git(["-c", `http.extraheader=AUTHORIZATION: bearer ${args.token}`, ...fetchArgs]);
  } else {
    args.git(fetchArgs);
  }
  return args.git(["rev-parse", "refs/max/update-pin"]);
}

export type UpdateWorkspaceFacts = {
  checkout: VersionIdentity | null;
  pinnedTags: readonly string[];
  publishedPinMatchesHead?: boolean;
  publishedPinError?: string;
  dirty: boolean;
  activeRuns: number;
  devMode: boolean;
  hasStableRef: boolean;
};

function workspaceRefusal(
  facts: Pick<UpdateWorkspaceFacts, "checkout" | "dirty" | "activeRuns" | "devMode">
): ApplyDecision | null {
  if (!facts.checkout || isFactoryIdentity(facts.checkout)) {
    return {
      ok: false,
      code: "factory",
      message:
        "This checkout is the factory (0.0.0-dev). This command only moves a public clone.",
    };
  }
  if (facts.dirty) {
    return {
      ok: false,
      code: "dirty",
      message: "Working tree is dirty. Commit or stash local edits before continuing.",
    };
  }
  if (facts.activeRuns > 0) {
    return {
      ok: false,
      code: "active-runs",
      message: `${facts.activeRuns} run(s) are still active. Let them finish before continuing.`,
    };
  }
  if (facts.devMode) {
    return {
      ok: false,
      code: "dev-mode",
      message: "The dev rig is running. Stop it before continuing.",
    };
  }
  return null;
}

/** True when HEAD is the published release named by version.json. */
export function headIsPublishedRelease(
  facts: Pick<
    ApplyFacts,
    "checkout" | "pinnedTags" | "publishedPinMatchesHead" | "publishedPinError"
  >
): { ok: true; pin: string } | { ok: false; message: string } {
  const pin = `v${facts.checkout?.version ?? ""}`;
  if (facts.checkout && (facts.pinnedTags.includes(pin) || facts.publishedPinMatchesHead === true)) {
    return { ok: true, pin };
  }
  const detail = facts.publishedPinError ? ` ${facts.publishedPinError}` : "";
  return {
    ok: false,
    message: `HEAD is not the published tag ${pin}. Apply only moves a checkout sitting on that tag.${detail}`,
  };
}

/**
 * A file install may leave the published release, or replace a test build
 * whose stable release was already saved.
 */
export function assessUpdateFrom(
  facts: UpdateWorkspaceFacts
): { ok: true; mode: "release" | "test" } | { ok: false; code: ApplyRefusal; message: string } {
  const refused = workspaceRefusal(facts);
  if (refused && !refused.ok) return refused;
  if (facts.checkout?.channel === "test") {
    if (!facts.hasStableRef) {
      return {
        ok: false,
        code: "not-pinned",
        message:
          "This test build has no saved stable release. Refusing to replace it.",
      };
    }
    return { ok: true, mode: "test" };
  }
  const pin = headIsPublishedRelease(facts);
  if (!pin.ok) return { ok: false, code: "not-pinned", message: pin.message };
  return { ok: true, mode: "release" };
}

export function assessUpdateStable(
  facts: Pick<UpdateWorkspaceFacts, "checkout" | "dirty" | "activeRuns" | "devMode" | "hasStableRef">
): ApplyDecision {
  const refused = workspaceRefusal(facts);
  if (refused) return refused;
  if (!facts.hasStableRef) {
    return {
      ok: false,
      code: "not-pinned",
      message: "No stable release is saved. max update --from saves one before leaving the release.",
    };
  }
  return { ok: true, targetTag: "", targetVersion: facts.checkout?.version ?? "" };
}

export function assessManifestNodeFloor(input: {
  label: string;
  manifestText: string;
  runningNode: string;
}): { ok: true; requirement: string } | { ok: false; message: string } {
  const requirement = parseNodeFloorFromPackageManifest(input.manifestText);
  if (!requirement) {
    return { ok: false, message: `${input.label} package.json has no engines.node requirement.` };
  }
  const parsed = parseNodeFloorRequirement(requirement);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `${input.label} has unsupported engines.node (${requirement}).`,
    };
  }
  const floor = satisfiesNodeFloor(input.runningNode, requirement);
  if (!floor.ok) {
    return {
      ok: false,
      message: formatNodeFloorApplyRefusal({
        tag: input.label,
        requirement,
        running: input.runningNode,
      }),
    };
  }
  return { ok: true, requirement };
}

/** Verify a bundle and fetch its tip into refs/max/update-target. Returns that commit. */
export function fetchBundleTip(args: {
  bundlePath: string;
  git: (args: string[]) => string;
}): string {
  args.git(["bundle", "verify", args.bundlePath]);
  const heads = args.git(["bundle", "list-heads", args.bundlePath]);
  const line = heads
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  const ref = line?.split(/\s+/)[1];
  if (!ref) {
    throw new Error("Bundle has no tip ref.");
  }
  args.git(["fetch", args.bundlePath, `${ref}:refs/max/update-target`]);
  return args.git(["rev-parse", "refs/max/update-target"]);
}

function gitFetchTargetRef(args: {
  fetchUrl: string;
  targetTag: string;
  token?: string;
  git: (args: string[]) => string;
}): void {
  const fetchArgs = [
    "fetch",
    "--no-tags",
    args.fetchUrl,
    `refs/tags/${args.targetTag}:refs/max/update-target`,
  ];
  if (args.token) {
    args.git(["-c", `http.extraheader=AUTHORIZATION: bearer ${args.token}`, ...fetchArgs]);
  } else {
    args.git(fetchArgs);
  }
}

/**
 * Fetch the target tag into refs/max/update-target and inspect package.json +
 * CHANGELOG.md before any daemon stop or worktree mutation.
 */
export function preflightUpdateTarget(args: {
  fetchUrl: string;
  targetTag: string;
  targetVersion: string;
  runningNode: string;
  token?: string;
  ops: Pick<ApplyOps, "git" | "log">;
}): PreflightResult {
  const { ops, targetTag, targetVersion } = args;
  ops.log(`Fetch ${targetTag} into refs/max/update-target`);
  try {
    gitFetchTargetRef({
      fetchUrl: args.fetchUrl,
      targetTag,
      token: args.token,
      git: ops.git,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "malformed-target",
      message: `Could not fetch ${targetTag}: ${message}`,
    };
  }

  let manifestText: string;
  let changelogText: string;
  try {
    manifestText = ops.git(["show", "refs/max/update-target:package.json"]);
    changelogText = ops.git(["show", "refs/max/update-target:CHANGELOG.md"]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "malformed-target",
      message: `Target ${targetTag} is missing package.json or CHANGELOG.md: ${message}`,
    };
  }

  const nodeRequirement = parseNodeFloorFromPackageManifest(manifestText);
  if (!nodeRequirement) {
    return {
      ok: false,
      code: "malformed-target",
      message: `Target ${targetTag} package.json has no engines.node requirement.`,
    };
  }
  const parsedReq = parseNodeFloorRequirement(nodeRequirement);
  if (!parsedReq.ok) {
    return {
      ok: false,
      code: "malformed-target",
      message: `Target ${targetTag} has unsupported engines.node (${nodeRequirement}).`,
    };
  }

  const upgradeActions = extractUpgradeActions(changelogText, targetVersion);
  if (
    upgradeActions.status === "missing-target" ||
    upgradeActions.status === "missing-section"
  ) {
    return {
      ok: false,
      code: "malformed-target",
      message: `Target ${targetTag} CHANGELOG.md is missing a ### Upgrade actions section for ${targetVersion}.`,
    };
  }

  const metadata: ApplyTargetMetadata = {
    targetTag,
    targetVersion,
    nodeRequirement,
    upgradeActions,
  };

  const floorCheck = satisfiesNodeFloor(args.runningNode, nodeRequirement);
  if (!floorCheck.ok) {
    return {
      ok: false,
      code: "node-floor",
      message: formatNodeFloorApplyRefusal({
        tag: targetTag,
        requirement: nodeRequirement,
        running: args.runningNode,
      }),
      metadata,
    };
  }

  return { ok: true, metadata };
}

/**
 * Mutates the checkout after successful preflight. Caller has already passed
 * `assessUpdateApply` and `preflightUpdateTarget`.
 */
export async function executeUpdateApply(args: {
  root: string;
  targetTag: string;
  targetVersion: string;
  wasRunning: boolean;
  /** Ref written after a healthy build. Defaults to the release tag. */
  recordRef?: string;
  /** When set, daemon, CLI, and dashboard stamps must carry this test id. */
  expectedTestId?: string | null;
  ops: ApplyOps;
}): Promise<void> {
  const { ops, targetTag, targetVersion } = args;
  ops.log(`Stopping daemon before changing ${args.root}`);
  await ops.stopDaemon();

  ops.log("Backup refs/max/update-backup");
  const head = ops.git(["rev-parse", "HEAD"]);
  ops.git(["update-ref", "refs/max/update-backup", head]);

  try {
    ops.log(`Move pin to ${targetTag}`);
    ops.git(["reset", "--hard", "refs/max/update-target"]);
    ops.log("npm ci");
    ops.npm(["ci"]);
    ops.log("Clean build output");
    ops.cleanBuild();
    ops.log("npm run build");
    ops.npm(["run", "build"]);
    const stampDecision = assessApplyStamps({
      targetVersion,
      stamps: ops.readStamps(),
      testId: args.expectedTestId,
    });
    if (!stampDecision.ok) {
      throw new Error(stampDecision.message);
    }
    ops.log("Install skills");
    ops.installSkills();
    ops.log("Start daemon");
    await ops.startDaemon();
    const version = await ops.healthVersion();
    if (version !== targetVersion) {
      throw new Error(`Health reported ${version}, expected ${targetVersion}.`);
    }
    const applied = ops.git(["rev-parse", "HEAD"]);
    const recordRef = args.recordRef ?? `refs/tags/${targetTag}`;
    ops.git(["update-ref", recordRef, applied]);
    ops.log(`Running ${targetVersion}. Backup remains refs/max/update-backup.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ops.log(`Apply failed: ${message}`);
    ops.log("Rolling back to refs/max/update-backup");
    try {
      await ops.stopDaemon();
      ops.git(["reset", "--hard", "refs/max/update-backup"]);
      ops.npm(["ci"]);
      ops.cleanBuild();
      ops.npm(["run", "build"]);
      ops.log("Restore skills");
      ops.installSkills();
      if (args.wasRunning) {
        await ops.startDaemon();
      }
    } catch (rollbackErr) {
      const rollbackMessage =
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      throw new Error(`${message} Rollback also failed: ${rollbackMessage}`);
    }
    throw new Error(message);
  }
}
