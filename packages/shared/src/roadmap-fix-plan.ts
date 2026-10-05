/**
 * Pure additive roadmap fix planning — no fs, fetch, process, or daemon imports.
 */

import {
  compileIdTemplate,
  defaultIdFormats,
  IdFormatError,
  parseNextMarkers,
} from "./roadmap-ids.js";
import {
  parseRoadmapIndex,
  sectionBody,
  type RoadmapIndexSection,
} from "./roadmap-index.js";
import {
  analyzeRoadmapReadiness,
  type RoadmapReadinessInputs,
} from "./roadmap-readiness.js";
import { ROADMAP_DIR } from "./roadmap-resolution.js";

export const ROADMAP_INDEX_REL = `${ROADMAP_DIR}/00-index.md`;

export type RoadmapFixPlanRefusal = {
  kind: "refused";
  message: string;
};

export type RoadmapFixPlanReady = {
  kind: "ready";
  relativePath: string;
  baseContent: string;
  proposedContent: string;
};

export type RoadmapFixPlanNoop = {
  kind: "noop";
  message: string;
};

export type RoadmapFixPlanDraft =
  | RoadmapFixPlanRefusal
  | RoadmapFixPlanReady
  | RoadmapFixPlanNoop;

export type RoadmapFixPlan = {
  workspaceId: string;
  relativePath: string;
  baseContent: string;
  proposedContent: string;
  contentHash: string;
};

const ID_FORMAT_DECL_LINE =
  /^[\t ]*<!--\s*id-format:\s*.+\s*-->[\t ]*$/im;

function hasCanonicalSection(markdown: string): boolean {
  return (
    sectionBody(markdown, "Backlog") != null ||
    sectionBody(markdown, "Completed") != null ||
    sectionBody(markdown, "Documented Ideas") != null
  );
}

function isFeatureSectionHeading(line: string): boolean {
  return (
    /^##\s+Backlog(?:\s|$)/i.test(line) ||
    /^##\s+Completed(?:\s|$)/i.test(line) ||
    /^##\s+Documented Ideas(?:\s|$)/i.test(line)
  );
}

function structuralIdFromLine(line: string): string | null {
  const bullet = line.match(/^- \*\*(.+?)\*\*\s+/);
  if (bullet) return bullet[1]!.trim();
  if (line.startsWith("|")) {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) return null;
    const id = cells[0]!;
    if (id === "ID" || /^[-:]+$/.test(id)) return null;
    return id;
  }
  return null;
}

function collectCanonicalStructuralIds(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const ids: string[] = [];
  let inFeatureSection = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inFeatureSection = isFeatureSectionHeading(line);
      continue;
    }
    if (!inFeatureSection) continue;
    const id = structuralIdFromLine(line);
    if (id != null) ids.push(id);
  }

  return [...new Set(ids)];
}

function idToTemplateAlternative(id: string): string | null {
  if (/^b\d+$/.test(id)) return "b<n>";
  if (/^b-[a-z]{2,3}\d+$/.test(id)) return "b-<owner><n>";
  const simple = id.match(/^([a-z]{1,8})(\d+)$/);
  if (simple) return `${simple[1]}<n>`;
  return null;
}

function inferIdFormatTemplate(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  const alts = new Set<string>();
  for (const id of ids) {
    const alt = idToTemplateAlternative(id);
    if (alt == null) return null;
    alts.add(alt);
  }
  const template = [...alts].sort().join(", ");
  try {
    const compiled = compileIdTemplate(template, "declared");
    if (!ids.every((id) => compiled.anchored.test(id))) return null;
    return template;
  } catch {
    return null;
  }
}

function hasIdFormatDeclaration(markdown: string): boolean {
  ID_FORMAT_DECL_LINE.lastIndex = 0;
  return ID_FORMAT_DECL_LINE.test(markdown);
}

function allIdsMatchDefault(ids: readonly string[]): boolean {
  const formats = defaultIdFormats();
  return ids.every((id) => formats.feature.anchored.test(id));
}

function computeNextPlainId(ids: readonly string[]): string {
  const plain = ids
    .filter((id) => /^b\d+$/.test(id))
    .map((id) => Number.parseInt(id.slice(1), 10))
    .filter((n) => Number.isFinite(n));
  const max = plain.length > 0 ? Math.max(...plain) : 0;
  return `b${max + 1}`;
}

function insertAfterTitle(
  markdown: string,
  insertLines: readonly string[]
): string {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const block = insertLines.join(newline);
  if (lines.length === 0) return block;
  const titleIdx = lines.findIndex((line) => /^#\s+/.test(line));
  const at = titleIdx >= 0 ? titleIdx + 1 : 0;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  const merged = [...before];
  if (merged.length > 0 && merged[merged.length - 1]!.trim() !== "") {
    merged.push("");
  }
  merged.push(...insertLines);
  if (after.length > 0 && after[0]!.trim() !== "") {
    merged.push("");
  }
  merged.push(...after);
  return merged.join(newline);
}

function addCanonicalSections(markdown: string): string {
  const scaffold = [
    "## Backlog",
    "",
    "## Completed",
    "",
    "| ID | Feature | Description | Docs |",
    "|----|---------|-------------|------|",
    "",
    "## Documented Ideas",
    "",
    "| ID | Idea | Status | File |",
    "|----|------|--------|------|",
  ];
  return insertAfterTitle(markdown, scaffold);
}

function addIdFormatDeclaration(markdown: string, template: string): string {
  const line = `<!-- id-format: ${template} -->`;
  return insertAfterTitle(markdown, [line]);
}

function addPlainNextMarker(markdown: string, nextId: string): string {
  const line = `<!-- next: ${nextId} -->`;
  return insertAfterTitle(markdown, [line]);
}

function assignBacklogIds(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let inBacklog = false;
  let nextNum = 1;
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^##\s+/.test(line)) {
      inBacklog = /^##\s+Backlog(?:\s|$)/i.test(line);
      continue;
    }
    if (!inBacklog) continue;
    if (!/^-\s+/.test(line)) continue;
    if (/^-\s+\*\*/.test(line)) continue;
    const body = line.replace(/^-\s+/, "").trim();
    if (!body) continue;
    lines[i] = `- **b${nextNum}** ${body}`;
    nextNum += 1;
    changed = true;
  }

  return changed ? lines.join(markdown.includes("\r\n") ? "\r\n" : "\n") : null;
}

function canAssignPlainNextMarker(
  markdown: string,
  ids: readonly string[]
): boolean {
  const markers = parseNextMarkers(markdown);
  if (markers.some((m) => m.kind === "per-person")) return false;
  if (markers.some((m) => m.kind === "plain")) return false;
  if (ids.length === 0) return true;
  return ids.every((id) => /^b\d+$/.test(id));
}

/** Build an additive fix draft from bounded readiness inputs. */
export function buildRoadmapFixPlanDraft(
  inputs: RoadmapReadinessInputs
): RoadmapFixPlanDraft {
  if (inputs.indexMarkdown == null) {
    return {
      kind: "refused",
      message:
        "No docs/roadmap/00-index.md — run max roadmap init to scaffold one.",
    };
  }

  if (inputs.indexTruncated) {
    return {
      kind: "refused",
      message:
        "Roadmap index exceeds the read limit — shorten it before applying fixes.",
    };
  }

  let markdown = inputs.indexMarkdown;

  try {
    parseRoadmapIndex(markdown);
  } catch (err) {
    if (err instanceof IdFormatError) {
      return {
        kind: "refused",
        message: err.message,
      };
    }
    throw err;
  }

  const markerSnapshot = parseNextMarkers(markdown);
  if (markerSnapshot.filter((m) => m.kind === "plain").length > 1) {
    return {
      kind: "refused",
      message:
        "Duplicate next-id markers — keep one <!-- next: … --> before running fix.",
    };
  }
  if (markerSnapshot.some((m) => m.kind === "per-person")) {
    return {
      kind: "refused",
      message:
        "Per-person next markers cannot be fixed automatically — add items with --feature instead.",
    };
  }

  const baseContent = markdown;
  let changed = false;

  if (!hasCanonicalSection(markdown)) {
    markdown = addCanonicalSections(markdown);
    changed = true;
  }

  let ids = collectCanonicalStructuralIds(markdown);
  if (ids.length === 0) {
    const assigned = assignBacklogIds(markdown);
    if (assigned != null) {
      markdown = assigned;
      changed = true;
      ids = collectCanonicalStructuralIds(markdown);
    }
  }

  if (
    !hasIdFormatDeclaration(markdown) &&
    ids.length > 0 &&
    !allIdsMatchDefault(ids)
  ) {
    const template = inferIdFormatTemplate(ids);
    if (template == null) {
      return {
        kind: "refused",
        message:
          "Present ids are not self-consistent enough for an automatic id-format declaration.",
      };
    }
    markdown = addIdFormatDeclaration(markdown, template);
    changed = true;
    ids = collectCanonicalStructuralIds(markdown);
  }

  const markers = parseNextMarkers(markdown);
  if (
    markers.filter((m) => m.kind === "plain").length === 0 &&
    canAssignPlainNextMarker(markdown, ids)
  ) {
    markdown = addPlainNextMarker(markdown, computeNextPlainId(ids));
    changed = true;
  }

  if (!changed || markdown === baseContent) {
    const report = analyzeRoadmapReadiness(inputs);
    const cliFixable = report.findings.some((f) => f.fixable_by === "cli");
    return {
      kind: "noop",
      message: cliFixable
        ? "No automatic CLI edits are available for the current findings."
        : "No CLI-fixable roadmap changes.",
    };
  }

  return {
    kind: "ready",
    relativePath: ROADMAP_INDEX_REL,
    baseContent,
    proposedContent: markdown,
  };
}

function idLessBacklogBody(line: string): string | null {
  if (!/^-\s+/.test(line) || /^-\s+\*\*/.test(line)) return null;
  const body = line.replace(/^-\s+/, "").trim();
  return body.length > 0 ? body : null;
}

function assignedPlainBacklogBody(line: string): string | null {
  const match = line.match(/^- \*\*b\d+\*\*\s+(.*)$/);
  if (!match) return null;
  const body = match[1]!.trim();
  return body.length > 0 ? body : null;
}

/** Whether proposed content only adds material, or prefixes id-less backlog bullets. */
export function isAdditiveRoadmapEdit(
  baseContent: string,
  proposedContent: string
): boolean {
  if (proposedContent === baseContent) return true;
  const proposedLines = proposedContent.split(/\r?\n/);
  const remaining = [...proposedLines];
  for (const line of baseContent.split(/\r?\n/)) {
    const idx = remaining.indexOf(line);
    if (idx >= 0) {
      remaining.splice(idx, 1);
      continue;
    }
    const body = idLessBacklogBody(line);
    if (body != null) {
      const assignedIdx = remaining.findIndex(
        (candidate) => assignedPlainBacklogBody(candidate) === body
      );
      if (assignedIdx >= 0) {
        remaining.splice(assignedIdx, 1);
        continue;
      }
    }
    return false;
  }
  return true;
}

export type RoadmapFixPlanSection = RoadmapIndexSection;
