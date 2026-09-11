/**
 * Install in-repo implement-fully skills into the operator's Cursor profile.
 *
 *   node scripts/install-skill.mjs           # apply
 *   node scripts/install-skill.mjs --check   # report drift, exit 1 if any
 *   node scripts/install-skill.mjs --dry-run # report planned writes, write nothing
 *
 * Installs both skills/implement-fully and skills/plan-implement-fully.
 * Never deletes destination files. Never touches ~/.cursor/rules/ or
 * ~/.cursor-local-automations/.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_DEST_ROOT = join(homedir(), ".cursor", "skills");

/** Skill source directories installed by the CLI entry point. */
const DEFAULT_SOURCES = [
  join(REPO_ROOT, "skills", "implement-fully"),
  join(REPO_ROOT, "skills", "plan-implement-fully"),
];

/**
 * @typedef {"apply" | "check" | "dry-run"} InstallMode
 * @typedef {"created" | "updated" | "unchanged" | "missing" | "extra" | "would-create" | "would-update"} FileAction
 * @typedef {{ path: string, action: FileAction }} FileReport
 * @typedef {{
 *   mode: InstallMode,
 *   sourceDir: string,
 *   destDir: string,
 *   files: FileReport[],
 *   drift: boolean,
 *   wrote: boolean,
 * }} InstallResult
 */

/**
 * Recursively list relative file paths under `dir` (forward-slash style in
 * reports; OS separators on disk).
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]}
 */
function listFilesRecursive(dir, prefix = "") {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full, rel));
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * @param {string} a
 * @param {string} b
 */
function sameContents(a, b) {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Install (or check/dry-run) a skill directory into a destination skills root.
 * Destination skill folder name is the source directory basename.
 *
 * @param {string} sourceDir Absolute path to the skill source (contains SKILL.md).
 * @param {string} destRoot Absolute path to the skills root (e.g. ~/.cursor/skills).
 * @param {InstallMode} mode
 * @returns {InstallResult}
 */
export function installSkill(sourceDir, destRoot, mode) {
  const src = resolve(sourceDir);
  const root = resolve(destRoot);
  const skillDirName = basename(src);
  const destDir = join(root, skillDirName);

  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`Source skill directory missing or not a directory: ${src}`);
  }
  if (existsSync(destDir) && !statSync(destDir).isDirectory()) {
    throw new Error(
      `Destination exists and is not a directory: ${destDir}`
    );
  }

  const sourceFiles = listFilesRecursive(src);
  const destFiles = existsSync(destDir) ? listFilesRecursive(destDir) : [];

  /** @type {FileReport[]} */
  const files = [];
  let drift = false;
  let wrote = false;

  for (const rel of sourceFiles) {
    const from = join(src, ...rel.split("/"));
    const to = join(destDir, ...rel.split("/"));
    const exists = existsSync(to);
    const identical = exists && sameContents(from, to);

    if (mode === "check") {
      if (!exists) {
        files.push({ path: rel, action: "missing" });
        drift = true;
      } else if (!identical) {
        files.push({ path: rel, action: "updated" });
        drift = true;
      } else {
        files.push({ path: rel, action: "unchanged" });
      }
      continue;
    }

    if (mode === "dry-run") {
      if (!exists) {
        files.push({ path: rel, action: "would-create" });
      } else if (!identical) {
        files.push({ path: rel, action: "would-update" });
      } else {
        files.push({ path: rel, action: "unchanged" });
      }
      continue;
    }

    // apply
    if (!exists) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      files.push({ path: rel, action: "created" });
      wrote = true;
    } else if (!identical) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      files.push({ path: rel, action: "updated" });
      wrote = true;
    } else {
      files.push({ path: rel, action: "unchanged" });
    }
  }

  // Destination-only files: never delete; report as drift in check mode.
  const sourceSet = new Set(sourceFiles);
  for (const rel of destFiles) {
    if (sourceSet.has(rel)) continue;
    files.push({ path: rel, action: "extra" });
    if (mode === "check") {
      drift = true;
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    mode,
    sourceDir: src,
    destDir,
    files,
    drift,
    wrote,
  };
}

/**
 * @param {string[]} argv
 * @returns {InstallMode}
 */
export function parseInstallArgs(argv) {
  let mode = /** @type {InstallMode} */ ("apply");
  for (const arg of argv) {
    if (arg === "--check") {
      mode = "check";
    } else if (arg === "--dry-run") {
      mode = "dry-run";
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/install-skill.mjs [--check|--dry-run]\n" +
          "  (default)  copy skills/implement-fully and skills/plan-implement-fully\n" +
          "             → ~/.cursor/skills/<skill-name>\n" +
          "  --check    report drift; exit 1 if any skill drifts\n" +
          "  --dry-run  report planned writes; write nothing"
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag "${arg}". Use --check or --dry-run.`);
    } else {
      throw new Error(`Unexpected argument "${arg}".`);
    }
  }
  return mode;
}

/**
 * @param {InstallResult} result
 */
function printReport(result) {
  console.log(
    `${result.mode}: ${relative(REPO_ROOT, result.sourceDir) || result.sourceDir} → ${result.destDir}`
  );
  for (const f of result.files) {
    console.log(`  ${f.action.padEnd(13)} ${f.path}`);
  }
  if (result.mode === "check") {
    console.log(result.drift ? "Drift detected." : "In sync.");
  } else if (result.mode === "dry-run") {
    const planned = result.files.filter(
      (f) => f.action === "would-create" || f.action === "would-update"
    ).length;
    console.log(
      planned === 0
        ? "No writes planned."
        : `${planned} write(s) planned (dry-run; nothing written).`
    );
  } else {
    console.log(result.wrote ? "Install complete." : "Already up to date.");
  }
}

function main() {
  const mode = parseInstallArgs(process.argv.slice(2));
  let anyDrift = false;
  for (const sourceDir of DEFAULT_SOURCES) {
    const result = installSkill(sourceDir, DEFAULT_DEST_ROOT, mode);
    printReport(result);
    if (result.drift) {
      anyDrift = true;
    }
  }
  if (mode === "check" && anyDrift) {
    process.exit(1);
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
