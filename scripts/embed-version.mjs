/**
 * Write the running-version embed next to daemon and CLI dist output.
 *
 *   node scripts/embed-version.mjs
 *   node scripts/embed-version.mjs --package daemon
 *
 * Reads root version.json (checkout stamp) and adds git extras captured at
 * build time. An already-running process keeps its previous embed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = {
  daemon: join(REPO_ROOT, "packages", "daemon", "dist"),
  cli: join(REPO_ROOT, "packages", "cli", "dist"),
};

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

function readStamp() {
  const path = join(REPO_ROOT, "version.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed.version === "string" && parsed.version.trim()) {
      const channel =
        parsed.channel === "public" || parsed.channel === "factory"
          ? parsed.channel
          : "unknown";
      return { version: parsed.version.trim(), channel };
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
    commit: git(["rev-parse", "--short", "HEAD"]),
    dirty: typeof porcelain === "string" && porcelain.length > 0,
    describe,
  };
}

function selectedPackages(argv) {
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--package") {
      const name = argv[++i];
      if (!name || !TARGETS[name]) {
        throw new Error("--package must be daemon or cli");
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
  const text = `${JSON.stringify(embed, null, 2)}\n`;
  const written = [];
  for (const name of packages) {
    const dir = TARGETS[name];
    if (!existsSync(dir)) continue;
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
