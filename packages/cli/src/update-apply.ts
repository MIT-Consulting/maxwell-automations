import { compareSemver, isFactoryIdentity, type VersionIdentity } from "@lca/shared";

export type ApplyRefusal =
  | "factory"
  | "dirty"
  | "not-pinned"
  | "active-runs"
  | "dev-mode"
  | "bad-tag"
  | "not-newer";

export type ApplyFacts = {
  checkout: VersionIdentity | null;
  /** Tags that point exactly at HEAD. */
  pinnedTags: readonly string[];
  dirty: boolean;
  activeRuns: number;
  devMode: boolean;
  /** `vX.Y.Z` */
  targetTag: string;
};

export type ApplyDecision =
  | { ok: true; targetTag: string; targetVersion: string }
  | { ok: false; code: ApplyRefusal; message: string };

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

  if (facts.dirty) {
    return {
      ok: false,
      code: "dirty",
      message: "Working tree is dirty. Commit or stash local edits before applying a release.",
    };
  }

  const pin = `v${facts.checkout.version}`;
  if (!facts.pinnedTags.includes(pin)) {
    return {
      ok: false,
      code: "not-pinned",
      message: `HEAD is not the pinned tag ${pin}. Apply refuses local commits and detached commits that are not that tag.`,
    };
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
      message: `Target ${targetTag} is not newer than the pinned checkout ${pin}.`,
    };
  }

  return { ok: true, targetTag, targetVersion };
}

export function applyPlanLines(repo: string, targetTag: string): string[] {
  return [
    `Apply ${targetTag} from ${repo}`,
    "  backup HEAD at refs/max/update-backup",
    `  fetch ${targetTag}`,
    "  move this pin to that tag (no local commits to keep)",
    "  npm ci",
    "  npm run build",
    "  start the daemon and require /health to report the new version",
    "  if health fails, reset to the backup, rebuild, and start again",
  ];
}

export type ApplyOps = {
  git: (args: string[]) => string;
  npm: (args: string[]) => void;
  stopDaemon: () => Promise<void>;
  startDaemon: () => Promise<void>;
  healthVersion: () => Promise<string>;
  log: (line: string) => void;
};

/**
 * Mutates the checkout. Caller has already passed `assessUpdateApply`.
 * `wasRunning` controls whether a failed apply leaves the daemon down.
 */
export async function executeUpdateApply(args: {
  root: string;
  repo: string;
  fetchUrl: string;
  targetTag: string;
  targetVersion: string;
  token?: string;
  wasRunning: boolean;
  ops: ApplyOps;
}): Promise<void> {
  const { ops, targetTag, targetVersion } = args;
  ops.log(`Stopping daemon before changing ${args.root}`);
  await ops.stopDaemon();

  ops.log("Backup refs/max/update-backup");
  const head = ops.git(["rev-parse", "HEAD"]);
  ops.git(["update-ref", "refs/max/update-backup", head]);

  try {
    ops.log(`Fetch ${targetTag}`);
    const fetchArgs = ["fetch", "--no-tags", args.fetchUrl, `refs/tags/${targetTag}:refs/max/update-target`];
    if (args.token) {
      ops.git(["-c", `http.extraheader=AUTHORIZATION: bearer ${args.token}`, ...fetchArgs]);
    } else {
      ops.git(fetchArgs);
    }
    ops.log(`Move pin to ${targetTag}`);
    ops.git(["reset", "--hard", "refs/max/update-target"]);
    ops.log("npm ci");
    ops.npm(["ci"]);
    ops.log("npm run build");
    ops.npm(["run", "build"]);
    ops.log("Start daemon");
    await ops.startDaemon();
    const version = await ops.healthVersion();
    if (version !== targetVersion) {
      throw new Error(`Health reported ${version}, expected ${targetVersion}.`);
    }
    ops.log(`Running ${targetVersion}. Backup remains refs/max/update-backup.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ops.log(`Apply failed: ${message}`);
    ops.log("Rolling back to refs/max/update-backup");
    try {
      await ops.stopDaemon();
      ops.git(["reset", "--hard", "refs/max/update-backup"]);
      ops.npm(["ci"]);
      ops.npm(["run", "build"]);
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
