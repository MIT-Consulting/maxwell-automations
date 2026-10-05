/**
 * Pure roadmap index parsing — sections, entries, epics, formats, markers.
 * No fs, fetch, process, daemon, or dashboard imports.
 */

import {
  classifyId,
  IdFormatError,
  parseIdFormatDeclarations,
  parseNextMarkers,
  type CompiledIdFormat,
  type NextMarkerMatch,
  type ResolvedIdFormats,
} from "./roadmap-ids.js";

export type RoadmapIndexSection = "backlog" | "documented-ideas" | "completed";

export type RoadmapIndexEntry = {
  featureId: string;
  section: RoadmapIndexSection;
  /** Raw row/bullet text used for links and idea composition. */
  raw: string;
  title: string;
  description: string;
  /** Markdown hrefs extracted from raw (may include #fragments). */
  hrefs: string[];
};

export type RoadmapEpicEntry = {
  epicId: string;
  title: string;
  raw: string;
};

export type ParsedRoadmapIndex = {
  entries: RoadmapIndexEntry[];
  epics: RoadmapEpicEntry[];
  formats: ResolvedIdFormats;
  markers: NextMarkerMatch[];
};

const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
/** Trailing `— [docs](./x.md) · [PRD](./y.md)` metadata tail on a roadmap row. */
const METADATA_LINK_TAIL_RE =
  /\s+—\s*\[[^\]]*\]\([^)]+\)(?:\s*[·,]\s*\[[^\]]*\]\([^)]+\))*\s*$/u;

export function extractMarkdownHrefs(text: string): string[] {
  const hrefs: string[] = [];
  const re = new RegExp(MD_LINK_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    hrefs.push(match[2]!.trim());
  }
  return hrefs;
}

/**
 * Human-readable text for a roadmap row. A trailing link tail is metadata —
 * its path is surfaced separately as prior art, so its label is dropped rather
 * than inlined. Remaining links keep their label and lose their syntax.
 */
export function toHumanText(text: string): string {
  return text
    .replace(METADATA_LINK_TAIL_RE, "")
    .replace(MD_LINK_RE, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function sectionHeadingRe(heading: string): RegExp {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+${escaped}(?:\\s+.+)?\\s*$`, "i");
}

export function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const headingRe = sectionHeadingRe(heading);
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function idMatchesFormat(id: string, format: CompiledIdFormat): boolean {
  return format.anchored.test(id);
}

export function parseBacklogEntries(
  body: string,
  featureFormat: CompiledIdFormat
): RoadmapIndexEntry[] {
  const entries: RoadmapIndexEntry[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^- \*\*(.+?)\*\*\s+(.+)$/);
    if (!match) continue;
    const featureId = match[1]!.trim();
    if (!idMatchesFormat(featureId, featureFormat)) continue;
    const raw = match[2]!;
    const stripped = toHumanText(raw);
    const parts = stripped.split(/\s+—\s+/u);
    const title = (parts[0] ?? stripped).trim();
    const description = parts.slice(1).join(" — ").trim();
    entries.push({
      featureId,
      section: "backlog",
      raw,
      title,
      description,
      hrefs: extractMarkdownHrefs(raw),
    });
  }
  return entries;
}

export function parseTableEntries(
  body: string,
  section: "documented-ideas" | "completed",
  featureFormat: CompiledIdFormat
): RoadmapIndexEntry[] {
  const entries: RoadmapIndexEntry[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const featureId = cells[0]!;
    if (!idMatchesFormat(featureId, featureFormat)) continue;
    if (featureId === "ID" || /^[-:]+$/.test(featureId)) continue;

    entries.push({
      featureId,
      section,
      raw: line,
      title: toHumanText(cells[1] ?? ""),
      description:
        section === "completed" ? toHumanText(cells[2] ?? "") : "",
      hrefs: extractMarkdownHrefs(line),
    });
  }
  return entries;
}

export function parseEpicTableEntries(
  body: string,
  epicFormat: CompiledIdFormat
): RoadmapEpicEntry[] {
  const entries: RoadmapEpicEntry[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const epicId = cells[0]!;
    if (!idMatchesFormat(epicId, epicFormat)) continue;
    if (epicId === "ID" || /^[-:]+$/.test(epicId)) continue;
    entries.push({
      epicId,
      title: toHumanText(cells[1] ?? ""),
      raw: line,
    });
  }
  return entries;
}

export function parseIndexEntries(
  markdown: string,
  formats: ResolvedIdFormats
): RoadmapIndexEntry[] {
  const entries: RoadmapIndexEntry[] = [];
  const backlog = sectionBody(markdown, "Backlog");
  if (backlog != null) {
    entries.push(...parseBacklogEntries(backlog, formats.feature));
  }
  const completed = sectionBody(markdown, "Completed");
  if (completed != null) {
    entries.push(...parseTableEntries(completed, "completed", formats.feature));
  }
  const ideas = sectionBody(markdown, "Documented Ideas");
  if (ideas != null) {
    entries.push(
      ...parseTableEntries(ideas, "documented-ideas", formats.feature)
    );
  }
  return entries;
}

/**
 * Parse a roadmap index markdown string into entries, epics, formats, and markers.
 * Throws {@link IdFormatError} on malformed format declarations.
 */
export function parseRoadmapIndex(markdown: string): ParsedRoadmapIndex {
  const formats = parseIdFormatDeclarations(markdown);
  const markers = parseNextMarkers(markdown);
  const entries = parseIndexEntries(markdown, formats);
  const epicsBody = sectionBody(markdown, "Epics");
  const epics =
    epicsBody != null
      ? parseEpicTableEntries(epicsBody, formats.epic)
      : [];
  return { entries, epics, formats, markers };
}

export class RoadmapIndexError extends Error {
  constructor(
    public readonly code: "duplicate-entry" | "not-found",
    message: string,
    public readonly featureId: string,
    public readonly section?: RoadmapIndexSection
  ) {
    super(message);
    this.name = "RoadmapIndexError";
  }
}

export function pickCanonicalEntry(
  entries: RoadmapIndexEntry[],
  featureId: string
): RoadmapIndexEntry {
  const priority: RoadmapIndexSection[] = [
    "backlog",
    "documented-ideas",
    "completed",
  ];
  for (const section of priority) {
    const inSection = entries.filter(
      (e) => e.featureId === featureId && e.section === section
    );
    if (inSection.length > 1) {
      throw new RoadmapIndexError(
        "duplicate-entry",
        `Roadmap index has duplicate ${featureId} entries in the same section`,
        featureId,
        section
      );
    }
    if (inSection.length === 1) return inSection[0]!;
  }
  throw new RoadmapIndexError(
    "not-found",
    `Feature ${featureId} not found in roadmap index`,
    featureId
  );
}

/** Whether an entry exists anywhere in the parsed index. */
export function hasIndexEntry(
  entries: RoadmapIndexEntry[],
  featureId: string
): boolean {
  return entries.some((e) => e.featureId === featureId);
}

export function formatFeatureIdMustMatchMessage(
  formats: ResolvedIdFormats
): string {
  return `featureId must match ${formats.feature.template} (e.g. b42, b-xy58). See docs/roadmap-format.md.`;
}

export function epicRefusalMessage(epicId: string): string {
  return `${epicId} is an epic (parent brief), not a feature; kick off one of its children.`;
}

export { classifyId, IdFormatError };
