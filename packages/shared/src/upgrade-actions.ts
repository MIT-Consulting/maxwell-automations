/**
 * Extract the fixed `### Upgrade actions` subsection from Keep-a-Changelog markdown.
 * Pure: no network, no execution of action text.
 */

export type UpgradeActionsExtract =
  | { status: "present"; lines: readonly string[] }
  | { status: "none" }
  | { status: "empty" }
  | { status: "missing-section" }
  | { status: "missing-target" };

const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\]/;
const UPGRADE_ACTIONS_HEADING = /^### Upgrade actions\s*$/;
const SUBSECTION_HEADING = /^### /;
const RELEASE_BOUNDARY = /^## \[/;

const MAX_LINES = 50;
const MAX_CHARS = 8_000;

function normalizeVersion(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

/** Bound action lines before cache/API persistence. */
export function boundUpgradeActionLines(lines: readonly string[]): readonly string[] {
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= MAX_LINES) break;
    if (chars + line.length > MAX_CHARS) {
      const remaining = MAX_CHARS - chars;
      if (remaining > 0) out.push(line.slice(0, remaining));
      break;
    }
    out.push(line);
    chars += line.length;
  }
  return out;
}

function trimOuterBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start += 1;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function extractReleaseBody(markdown: string, version: string): string | null {
  const normalized = normalizeVersion(version);
  const lines = markdown.split(/\r?\n/);
  let inTarget = false;
  const body: string[] = [];

  for (const line of lines) {
    const releaseMatch = RELEASE_HEADING.exec(line);
    if (releaseMatch) {
      if (inTarget) break;
      if (releaseMatch[1] === normalized) {
        inTarget = true;
      }
      continue;
    }
    if (inTarget) {
      body.push(line);
    }
  }
  return inTarget ? body.join("\n") : null;
}

/** Extract Upgrade actions from a single GitHub release body (no changelog heading). */
export function extractUpgradeActionsFromReleaseBody(body: string): UpgradeActionsExtract {
  const lines = body.split(/\r?\n/);
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (UPGRADE_ACTIONS_HEADING.test(lines[i]!)) {
      sectionStart = i + 1;
      break;
    }
    if (RELEASE_BOUNDARY.test(lines[i]!)) break;
  }
  if (sectionStart < 0) return { status: "missing-section" };

  const contentLines: string[] = [];
  for (let i = sectionStart; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (SUBSECTION_HEADING.test(line) || RELEASE_BOUNDARY.test(line)) break;
    contentLines.push(line);
  }

  const trimmed = trimOuterBlankLines(contentLines).filter((line) => line.trim() !== "");
  if (trimmed.length === 0) return { status: "empty" };
  if (trimmed.length === 1 && trimmed[0]!.trim() === "none") return { status: "none" };
  return { status: "present", lines: boundUpgradeActionLines(trimmed) };
}

/** Extract Upgrade actions for one release version from full changelog markdown. */
export function extractUpgradeActions(
  markdown: string,
  targetVersion: string
): UpgradeActionsExtract {
  const body = extractReleaseBody(markdown, targetVersion);
  if (body === null) return { status: "missing-target" };
  return extractUpgradeActionsFromReleaseBody(body);
}

/**
 * Bound Upgrade actions for cache/API persistence.
 * `null` = unknown or section missing; `[]` = explicit none/empty; lines = present.
 */
export function upgradeActionsForPersistence(
  extract: UpgradeActionsExtract
): string[] | null {
  switch (extract.status) {
    case "present":
      return [...extract.lines];
    case "none":
    case "empty":
      return [];
    default:
      return null;
  }
}

/** Stable operator-facing lines under the `Upgrade actions` heading. */
export function formatUpgradeActionsLines(extract: UpgradeActionsExtract): readonly string[] {
  switch (extract.status) {
    case "present":
      return extract.lines;
    case "none":
    case "empty":
    case "missing-section":
      return ["none"];
    case "missing-target":
      return ["none"];
    default:
      return ["none"];
  }
}
