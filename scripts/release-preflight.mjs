/**
 * Release preflight: changelog Upgrade actions contract + engines policy (b76).
 *
 *   node scripts/release-preflight.mjs
 *   npm run release:preflight
 *
 * Pure helpers are exported for vitest; the CLI orchestrator reads the live tree.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

export const UPGRADE_ACTIONS_HEADING = "### Upgrade actions";
const UPGRADE_ACTIONS_HEADING_RE = /^### Upgrade actions\s*$/;
const SUBSECTION_HEADING_RE = /^### /;
const RELEASE_BOUNDARY_RE = /^## \[/;
const RELEASE_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\]/;
const NODE_FLOOR_RE = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** @typedef {{ ok: true, lines: string[], isNone: boolean } | { ok: false, reason: string }} UpgradeSectionParse */

/**
 * @param {string} body release body (no ## [version] line)
 * @returns {UpgradeSectionParse}
 */
export function parseUpgradeActionsSection(body) {
  const lines = body.split(/\r?\n/);
  let hits = 0;
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (UPGRADE_ACTIONS_HEADING_RE.test(lines[i])) {
      hits += 1;
      sectionStart = i + 1;
    }
  }
  if (hits === 0) {
    return { ok: false, reason: "missing Upgrade actions section" };
  }
  if (hits > 1) {
    return { ok: false, reason: "duplicate Upgrade actions section" };
  }

  /** @type {string[]} */
  const contentLines = [];
  for (let i = sectionStart; i < lines.length; i += 1) {
    const line = lines[i];
    if (SUBSECTION_HEADING_RE.test(line) || RELEASE_BOUNDARY_RE.test(line)) break;
    contentLines.push(line);
  }

  const trimmed = contentLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty Upgrade actions section" };
  }
  if (trimmed.length === 1 && trimmed[0] === "none") {
    return { ok: true, lines: ["none"], isNone: true };
  }
  return { ok: true, lines: trimmed, isNone: false };
}

/**
 * @param {string} markdown
 * @returns {{ label: string, body: string }[]}
 */
export function listChangelogSections(markdown) {
  /** @type {{ label: string, body: string }[]} */
  const sections = [];
  const lines = markdown.split(/\r?\n/);
  let currentLabel = null;
  /** @type {string[]} */
  let bodyLines = [];

  const flush = () => {
    if (currentLabel != null) {
      sections.push({ label: currentLabel, body: bodyLines.join("\n") });
    }
  };

  for (const line of lines) {
    if (line === "## [Unreleased]") {
      flush();
      currentLabel = "Unreleased";
      bodyLines = [];
      continue;
    }
    const releaseMatch = RELEASE_HEADING_RE.exec(line);
    if (releaseMatch) {
      flush();
      currentLabel = releaseMatch[1];
      bodyLines = [];
      continue;
    }
    if (currentLabel != null) {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * @param {string} markdown
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateChangelogUpgradeActions(markdown) {
  /** @type {string[]} */
  const errors = [];
  const sections = listChangelogSections(markdown);
  if (!sections.some((s) => s.label === "Unreleased")) {
    errors.push("CHANGELOG.md is missing ## [Unreleased]");
  }

  for (const section of sections) {
    /** @type {{ hashes: string, line: string }[]} */
    const upgradeHeadings = [];
    for (const line of section.body.split(/\r?\n/)) {
      const heading = /^(#{1,6})\s*(.+?)\s*$/.exec(line);
      if (!heading) continue;
      if (!/^upgrade actions$/i.test(heading[2])) continue;
      upgradeHeadings.push({ hashes: heading[1], line });
    }
    if (
      upgradeHeadings.some(
        (h) => h.hashes === "###" && !UPGRADE_ACTIONS_HEADING_RE.test(h.line)
      )
    ) {
      errors.push(`${section.label}: wrong-case Upgrade actions heading`);
    }
    if (upgradeHeadings.some((h) => h.hashes !== "###")) {
      errors.push(`${section.label}: wrong-level Upgrade actions heading`);
    }

    const parsed = parseUpgradeActionsSection(section.body);
    if (!parsed.ok) {
      errors.push(`${section.label}: ${parsed.reason}`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * @param {string} input
 * @returns {{ ok: true, tuple: [number, number, number], raw: string } | { ok: false, reason: string }}
 */
export function parseNodeFloorRequirement(input) {
  const raw = String(input ?? "").trim();
  const match = NODE_FLOOR_RE.exec(raw);
  if (!match) {
    return { ok: false, reason: `unsupported Node floor syntax: ${raw}` };
  }
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  return {
    ok: true,
    tuple: [Number(match[1]), Number(match[2]), patch],
    raw,
  };
}

/**
 * @param {[number, number, number]} left
 * @param {[number, number, number]} right
 * @returns {-1 | 0 | 1}
 */
export function compareNodeFloorTuples(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

/**
 * @param {string} version
 * @returns {{ ok: true, parts: [number, number, number] } | { ok: false, reason: string }}
 */
export function parseSemver(version) {
  const value = String(version).trim().replace(/^v/, "");
  const match = SEMVER_RE.exec(value);
  if (!match) {
    return { ok: false, reason: `malformed semver: ${version}` };
  }
  return {
    ok: true,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
  };
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a.ok) throw new Error(a.reason);
  if (!b.ok) throw new Error(b.reason);
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] < b.parts[i]) return -1;
    if (a.parts[i] > b.parts[i]) return 1;
  }
  return 0;
}

/**
 * @param {string} enginesNode
 * @returns {string | null}
 */
export function parseEnginesNodeFromManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const engines = value?.engines;
  if (!engines || typeof engines !== "object") return null;
  const node = engines.node;
  return typeof node === "string" && node.trim() ? node.trim() : null;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function upgradeActionsMentionEngineChange(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("node") ||
    lower.includes("engine") ||
    lower.includes("npm ci") ||
    lower.includes("runtime")
  );
}

/**
 * @param {{
 *   currentEngines: string,
 *   previousEngines: string,
 *   upgradeActionsText: string,
 *   currentVersion: string,
 *   previousVersion: string,
 * }} input
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function checkEngineFloorPolicy(input) {
  /** @type {string[]} */
  const errors = [];
  const current = parseNodeFloorRequirement(input.currentEngines);
  const previous = parseNodeFloorRequirement(input.previousEngines);
  if (!current.ok) errors.push(`current engines.node: ${current.reason}`);
  if (!previous.ok) errors.push(`previous engines.node: ${previous.reason}`);
  if (errors.length > 0) return { ok: false, errors };

  const cmp = compareNodeFloorTuples(current.tuple, previous.tuple);
  if (cmp === 0) return { ok: true };

  if (!upgradeActionsMentionEngineChange(input.upgradeActionsText)) {
    errors.push(
      "engines.node changed since the previous public tag but Upgrade actions do not mention the runtime change"
    );
  }

  if (cmp > 0) {
    let semverCmp;
    try {
      semverCmp = compareSemver(input.currentVersion, input.previousVersion);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return { ok: false, errors };
    }
    if (semverCmp <= 0) {
      errors.push("raised Node floor requires at least a minor version bump");
    } else {
      const cur = parseSemver(input.currentVersion);
      const prev = parseSemver(input.previousVersion);
      if (cur.ok && prev.ok && cur.parts[0] === prev.parts[0] && cur.parts[1] === prev.parts[1]) {
        errors.push("raised Node floor requires at least a minor version bump (patch is insufficient)");
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** @param {string} clonePath */
export function listPublicSemverTags(clonePath) {
  if (!existsSync(join(clonePath, ".git"))) {
    throw new Error(
      `release preflight: missing export clone at ${clonePath} (clone MIT-Consulting/maxwell-automations into .export-public/)`
    );
  }
  const raw = execFileSync("git", ["-C", clonePath, "tag", "-l", "v*"], {
    encoding: "utf8",
  });
  /** @type {string[]} */
  const tags = raw
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.replace(/^v/, ""))
    .filter((t) => SEMVER_RE.test(t));
  tags.sort(compareSemver);
  return tags;
}

/**
 * @param {string} clonePath
 * @param {string} tag semver without v prefix
 */
export function readTaggedPackageEngines(clonePath, tag) {
  const spec = `v${tag}:package.json`;
  let text;
  try {
    text = execFileSync("git", ["-C", clonePath, "show", spec], {
      encoding: "utf8",
    });
  } catch {
    throw new Error(
      `release preflight: cannot read ${spec} from export clone (tag missing?)`
    );
  }
  const engines = parseEnginesNodeFromManifest(text);
  if (!engines) {
    throw new Error(`release preflight: ${spec} has no engines.node`);
  }
  return engines;
}

/**
 * @param {{
 *   repoRoot?: string,
 *   clonePath?: string,
 *   changelogText?: string,
 *   packageJsonText?: string,
 * }} [opts]
 * @returns {{ ok: true, newestVersion: string | null, previousTag: string | null } | { ok: false, errors: string[] }}
 */
export function runReleasePreflight(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const clonePath =
    opts.clonePath ?? join(repoRoot, ".export-public", "maxwell-automations");
  const changelogText =
    opts.changelogText ?? readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const packageJsonText =
    opts.packageJsonText ?? readFileSync(join(repoRoot, "package.json"), "utf8");

  /** @type {string[]} */
  const errors = [];

  const changelogCheck = validateChangelogUpgradeActions(changelogText);
  if (!changelogCheck.ok) {
    errors.push(...changelogCheck.errors);
  }

  const currentEngines = parseEnginesNodeFromManifest(packageJsonText);
  if (!currentEngines) {
    errors.push("root package.json is missing engines.node");
  }

  const sections = listChangelogSections(changelogText);
  const newestVersion =
    sections.find((s) => s.label !== "Unreleased")?.label ?? null;
  if (!newestVersion) {
    errors.push("CHANGELOG.md has no ## [x.y.z] release heading");
  }

  let previousTag = null;
  try {
    const tags = listPublicSemverTags(clonePath);
    if (tags.length === 0) {
      errors.push(
        "export clone has no semver tags — fetch tags before release preflight"
      );
    } else {
      previousTag = tags[tags.length - 1];
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (currentEngines && newestVersion && previousTag) {
    try {
      const previousEngines = readTaggedPackageEngines(clonePath, previousTag);
      const newestSection = sections.find((s) => s.label === newestVersion);
      const upgradeParsed = newestSection
        ? parseUpgradeActionsSection(newestSection.body)
        : { ok: false, reason: "missing release section" };
      const upgradeText =
        upgradeParsed.ok && !upgradeParsed.isNone
          ? upgradeParsed.lines.join("\n")
          : upgradeParsed.ok
            ? ""
            : "";

      const policy = checkEngineFloorPolicy({
        currentEngines,
        previousEngines,
        upgradeActionsText: upgradeText,
        currentVersion: newestVersion,
        previousVersion: previousTag,
      });
      if (!policy.ok) {
        errors.push(...policy.errors);
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, newestVersion, previousTag };
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]).replace(/\\/g, "/").toLowerCase() ===
    fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();

if (isMain) {
  const result = runReleasePreflight();
  if (!result.ok) {
    console.error("release preflight: FAILED");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  console.log(
    `release preflight: ok (newest ${result.newestVersion}, previous tag v${result.previousTag})`
  );
}
