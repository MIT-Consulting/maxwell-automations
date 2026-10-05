import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatPersistedUpgradeActionsLines,
  formatRunningLabel,
  formatUpdateSummary,
  resolveInstallIdentity,
  resolveUpdateSettings,
  UpdateChecker,
  updateSettingsSchema,
  type UpdateSnapshot,
  type VersionIdentity,
} from "@lca/shared";
import { parse as parseYaml } from "yaml";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function enrichCheckoutWithGit(
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

export function loadCliIdentity(moduleUrl: string = import.meta.url): {
  running: VersionIdentity;
  checkout: VersionIdentity | null;
  checkoutRoot: string | null;
} {
  const resolved = resolveInstallIdentity({
    modulePath: fileURLToPath(moduleUrl),
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

/** One line for `max --version`: the CLI embed, no daemon. */
export function cliVersionLine(moduleUrl?: string): string {
  return loadCliIdentity(moduleUrl).running.version;
}

export function formatVersionReport(
  identity: {
    running: VersionIdentity;
    checkout: VersionIdentity | null;
  },
  daemon: UpdateSnapshot | null
): string {
  const lines = ["Max"];
  if (daemon) {
    lines.push(`Daemon:   ${formatRunningLabel(daemon.running)}`);
    if (daemon.running.version !== identity.running.version) {
      lines.push(`CLI:      ${formatRunningLabel(identity.running)}`);
    }
    if (
      daemon.checkout &&
      daemon.checkout.version !== daemon.running.version
    ) {
      lines.push(`Checkout: ${formatRunningLabel(daemon.checkout)}`);
    }
    lines.push(`State:    ${formatUpdateSummary(daemon)}`);
    if (daemon.available) {
      lines.push(`Approved: ${daemon.available.version}`);
    }
    return lines.join("\n");
  }

  lines.push(`CLI:      ${formatRunningLabel(identity.running)}`);
  if (identity.checkout) {
    lines.push(`Checkout: ${formatRunningLabel(identity.checkout)}`);
  }
  lines.push("State:    daemon not running");
  return lines.join("\n");
}

export function formatUpdateCheckReport(snapshot: UpdateSnapshot): string {
  const lines = [formatUpdateSummary(snapshot)];
  if (snapshot.releaseUrl) {
    lines.push(snapshot.releaseUrl);
  } else if (snapshot.available?.url) {
    lines.push(snapshot.available.url);
  }
  if (snapshot.available?.notes) {
    lines.push(snapshot.available.notes);
  }
  if (snapshot.available) {
    lines.push("Upgrade actions");
    for (const line of formatPersistedUpgradeActionsLines(
      snapshot.available.upgradeActions
    )) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return undefined;
}

function envNum(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFileUpdateSettings(): {
  check?: boolean;
  repo?: string;
  publicRepo?: string;
  cacheHours?: number;
  token?: string;
  host?: string;
} {
  const path = join(homedir(), ".cursor-local-automations", "automations.yaml");
  const text = readText(path);
  if (!text) return {};
  try {
    const doc = parseYaml(text) as { settings?: { update?: unknown } } | null;
    const parsed = updateSettingsSchema.safeParse(doc?.settings?.update ?? {});
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function loadCliUpdateSettings() {
  return resolveUpdateSettings({
    file: readFileUpdateSettings(),
    env: {
      check: envBool("LCA_UPDATE_CHECK"),
      repo: process.env.LCA_UPDATE_REPO?.trim() || undefined,
      publicRepo: process.env.LCA_UPDATE_PUBLIC_REPO?.trim() || undefined,
      cacheHours: envNum("LCA_UPDATE_CACHE_HOURS"),
      token: process.env.LCA_UPDATE_TOKEN?.trim() || undefined,
      host: process.env.LCA_UPDATE_HOST?.trim() || undefined,
    },
  });
}

/** Refresh the shared cache when the daemon is down. */
export async function checkUpdateLocally(
  moduleUrl?: string
): Promise<UpdateSnapshot> {
  const identity = loadCliIdentity(moduleUrl);
  const cachePath = join(homedir(), ".cursor-local-automations", "update-cache.json");
  const checker = new UpdateChecker({
    settings: loadCliUpdateSettings(),
    running: identity.running,
    checkout: identity.checkout,
    runningNode: process.versions.node,
    readCache: () => readText(cachePath),
    writeCache: (text) => {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, text);
    },
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      return {
        status: response.status,
        ok: response.ok,
        headers: { get: (name) => response.headers.get(name) },
        json: () => response.json() as Promise<unknown>,
        text: () => response.text(),
      };
    },
  });
  return checker.checkNow();
}
