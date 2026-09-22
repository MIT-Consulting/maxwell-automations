import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveInstallIdentity,
  type VersionIdentity,
} from "@lca/shared";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `git describe` enrichment. Failure leaves the stamp unchanged. */
export function enrichCheckoutWithGit(
  root: string,
  identity: VersionIdentity
): VersionIdentity {
  if (!existsSync(join(root, ".git"))) return identity;
  try {
    const describe = execFileSync(
      "git",
      ["-C", root, "describe", "--tags", "--always", "--dirty"],
      {
        encoding: "utf8",
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    ).trim();
    return {
      ...identity,
      describe: describe || null,
      dirty: describe.endsWith("-dirty") || identity.dirty === true,
    };
  } catch {
    return identity;
  }
}

/** Running embed beside the compiled module, plus the checkout `version.json`. */
export function loadInstallIdentity(moduleUrl: string): {
  running: VersionIdentity;
  checkout: VersionIdentity | null;
  checkoutRoot: string | null;
} {
  const modulePath = fileURLToPath(moduleUrl);
  const resolved = resolveInstallIdentity({
    modulePath,
    dirname,
    join,
    parseRoot: (path) => parse(path).root,
    readText,
  });
  if (!resolved.checkout || !resolved.checkoutRoot) return resolved;
  return {
    ...resolved,
    checkout: enrichCheckoutWithGit(resolved.checkoutRoot, resolved.checkout),
  };
}
