/**
 * Write the running-version embed next to daemon and CLI dist output.
 *
 *   node scripts/embed-version.mjs
 *   node scripts/embed-version.mjs --package daemon
 *
 * Reads root version.json (checkout stamp) and adds git extras captured at
 * build time. An already-running process keeps its previous embed.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = {
  daemon: join(REPO_ROOT, "packages", "daemon", "dist"),
  cli: join(REPO_ROOT, "packages", "cli", "dist"),
  dashboard: join(REPO_ROOT, "packages", "dashboard", "dist"),
};

/**
 * Fingerprint of every file under a shared `dist` directory.
 * Keep in lockstep with `fingerprintSharedDist` in `packages/cli/src/update-apply.ts`.
 * Returns null when the directory is absent.
 * @param {string} rootDir
 * @returns {string | null}
 */
export function fingerprintSharedDist(rootDir) {
  if (!existsSync(rootDir)) return null;
  /** @type {string[]} */
  const files = [];
  const walk = (dir, prefix) => {
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

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function readNodeFloor() {
  const path = join(REPO_ROOT, "package.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Could not read root package manifest at ${path}`);
  }
  const node = parsed?.engines?.node;
  if (typeof node !== "string" || !/^>=\d+\.\d+(?:\.\d+)?$/.test(node.trim())) {
    throw new Error(
      `Missing or malformed engines.node in ${path} (expected >=X.Y or >=X.Y.Z)`
    );
  }
  return node.trim();
}

function readStamp() {
  const path = join(REPO_ROOT, "version.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed.version === "string" && parsed.version.trim()) {
      const version = parsed.version.trim();
      const channel =
        parsed.channel === "public" || parsed.channel === "factory" || parsed.channel === "test"
          ? parsed.channel
          : "unknown";
      const stamp = { version, channel };
      if (channel === "test") {
        stamp.base = typeof parsed.base === "string" ? parsed.base.trim() : null;
        stamp.testId = typeof parsed.testId === "string" ? parsed.testId.trim() : null;
      }
      return stamp;
    }
  } catch {
    /* factory fallback */
  }
  return { version: "0.0.0-dev", channel: "factory" };
}

export function buildEmbed() {
  const stamp = readStamp();
  const describe = git(["describe", "--tags", "--always", "--dirty"]);
  const porcelain = git(["status", "--porcelain"]);
  return {
    version: stamp.version,
    channel: stamp.channel,
    ...(stamp.channel === "test" ? { base: stamp.base ?? null, testId: stamp.testId ?? null } : {}),
    commit: git(["rev-parse", "--short", "HEAD"]),
    dirty: typeof porcelain === "string" && porcelain.length > 0,
    describe,
    nodeFloor: readNodeFloor(),
  };
}

function selectedPackages(argv) {
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--package") {
      const name = argv[++i];
      if (!name || !TARGETS[name]) {
        throw new Error("--package must be daemon, cli, or dashboard");
      }
      names.push(name);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return names.length > 0 ? names : Object.keys(TARGETS);
}

function writeEmbeds(packages) {
  const embed = buildEmbed();
  const written = [];
  for (const name of packages) {
    const dir = TARGETS[name];
    if (!existsSync(dir)) continue;
    const body =
      name === "dashboard"
        ? {
            ...embed,
            sharedDistHash: fingerprintSharedDist(join(REPO_ROOT, "packages", "shared", "dist")),
          }
        : embed;
    const text = `${JSON.stringify(body, null, 2)}\n`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "version-embed.json"), text, "utf8");
    written.push(name);
  }
  return { embed, written };
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]).replace(/\\/g, "/").toLowerCase() ===
    fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();

if (isMain) {
  const { embed, written } = writeEmbeds(selectedPackages(process.argv.slice(2)));
  console.log(
    `version embed ${embed.version} (${embed.channel}) → ${
      written.length > 0 ? written.join(", ") : "no dist yet"
    }`
  );
}
