/**
 * Workspace-confined roadmap readiness facts for shared analysis.
 * Reads only through files/read confinement helpers.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  analyzeRoadmapReadiness,
  buildRoadmapFixPlanDraft,
  countFindingsByImpact,
  entryLinks,
  IdFormatError,
  isRoadmapIdCandidate,
  parseRoadmapIndex,
  ROADMAP_DIR,
  splitHrefPathFragment,
  summarizeRoadmapReadiness,
  type ParsedRoadmapIndex,
  type RoadmapChild,
  type RoadmapFixPlan,
  type RoadmapFixPlanDraft,
  type RoadmapReadinessCandidate,
  type RoadmapReadinessInputs,
  type RoadmapReadinessReport,
  type RoadmapReadinessSummariesResponse,
  type RoadmapReadinessWorkspaceSummary,
} from "@lca/shared";
import type { WorkspaceFileEntry } from "@lca/shared";
import {
  FileViewerError,
  listWorkspaceDir,
  readWorkspaceFile,
} from "../files/read.js";
import type { RoadmapResolveBounds } from "./resolve.js";

export const ROADMAP_INDEX_PATH = `${ROADMAP_DIR}/00-index.md`;
export const CANDIDATE_READ_CAP = 40;
export const CANDIDATE_HEAD_BYTES = 8192;

const CONVENTIONAL_ROOT_NAMES = new Set([
  "ROADMAP.md",
  "BACKLOG.md",
  "TODO.md",
]);

const BACKLOG_HEADING_RE =
  /^##\s+(?:Backlog|TODO|Roadmap|Completed|Epics|Ideas|Documented Ideas)\s*$/i;

export type RoadmapReadinessGatherBounds = RoadmapResolveBounds;

function isGitRepo(workspaceRoot: string): boolean {
  try {
    return existsSync(join(workspaceRoot, ".git"));
  } catch {
    return false;
  }
}

function parseMtimeMs(iso: string | null | undefined): number | undefined {
  if (iso == null) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
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

function countStructuralIds(head: string): number {
  let count = 0;
  for (const line of head.split(/\r?\n/)) {
    const id = structuralIdFromLine(line);
    if (id != null && isRoadmapIdCandidate(id)) count += 1;
  }
  return count;
}

function headLooksBacklogLike(
  head: string,
  requireBacklogHeading: boolean
): boolean {
  let hasBacklogHeading = false;
  for (const line of head.split(/\r?\n/)) {
    if (BACKLOG_HEADING_RE.test(line)) {
      hasBacklogHeading = true;
      break;
    }
  }
  if (hasBacklogHeading) return true;
  if (requireBacklogHeading) return false;
  return countStructuralIds(head) >= 3;
}

function estimateItems(head: string): number | "unknown" {
  let count = 0;
  for (const line of head.split(/\r?\n/)) {
    if (/^-\s+\*\*/.test(line) || /^-\s+[A-Za-z]/.test(line)) count += 1;
    if (line.startsWith("|") && !/^[\|:\s-]+$/.test(line.replace(/\|/g, ""))) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells[0] && cells[0] !== "ID" && !/^[-:]+$/.test(cells[0])) {
        count += 1;
      }
    }
  }
  return count > 0 ? count : "unknown";
}

function isConventionalCandidatePath(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  if (CONVENTIONAL_ROOT_NAMES.has(base)) return true;
  const lower = base.toLowerCase();
  if (relPath.startsWith("docs/backlog") && lower.endsWith(".md")) return true;
  return false;
}

type RoadmapCandidateSkipSet = {
  linkedPaths: Set<string>;
  featureIds: Set<string>;
};

function normalizeIndexLinkedCandidatePath(link: string): string | null {
  const { path } = splitHrefPathFragment(link.trim());
  if (!path) return null;
  const normalized = path.replace(/^\.\//, "");
  if (normalized.startsWith(`${ROADMAP_DIR}/`)) {
    const rest = normalized.slice(ROADMAP_DIR.length + 1);
    if (!rest.includes("/") && rest.toLowerCase().endsWith(".md")) {
      return normalized;
    }
    return null;
  }
  if (!normalized.includes("/") && normalized.toLowerCase().endsWith(".md")) {
    return `${ROADMAP_DIR}/${normalized}`;
  }
  return null;
}

function buildRoadmapCandidateSkipSet(
  parsed: ParsedRoadmapIndex
): RoadmapCandidateSkipSet {
  const linkedPaths = new Set<string>();
  const featureIds = new Set<string>();
  for (const entry of parsed.entries) {
    featureIds.add(entry.featureId);
    for (const href of entryLinks(entry)) {
      const candidatePath = normalizeIndexLinkedCandidatePath(href);
      if (candidatePath) linkedPaths.add(candidatePath);
    }
  }
  return { linkedPaths, featureIds };
}

function shouldSkipRoadmapCandidate(
  relPath: string,
  skip: RoadmapCandidateSkipSet
): boolean {
  if (!relPath.startsWith(`${ROADMAP_DIR}/`)) return false;
  if (skip.linkedPaths.has(relPath)) return true;
  const base = relPath.split("/").pop() ?? relPath;
  for (const id of skip.featureIds) {
    if (base.startsWith(`${id}-`)) return true;
  }
  return false;
}

function parseIndexForCandidateSkip(
  indexMarkdown: string | null
): RoadmapCandidateSkipSet {
  const empty: RoadmapCandidateSkipSet = {
    linkedPaths: new Set(),
    featureIds: new Set(),
  };
  if (indexMarkdown == null) return empty;
  try {
    return buildRoadmapCandidateSkipSet(parseRoadmapIndex(indexMarkdown));
  } catch (err) {
    if (err instanceof IdFormatError) return empty;
    throw err;
  }
}

function entryToChild(entry: WorkspaceFileEntry): RoadmapChild {
  if (entry.kind === "dir") return { name: entry.name, kind: "dir" };
  if (entry.kind === "symlink") return { name: entry.name, kind: "symlink" };
  return { name: entry.name, kind: "file" };
}

function safeListDir(
  workspaceRoot: string,
  relDir: string,
  bounds: RoadmapReadinessGatherBounds
): { entries: WorkspaceFileEntry[]; truncated: boolean } | null {
  try {
    const listing = listWorkspaceDir(workspaceRoot, relDir, {
      maxEntries: bounds.maxEntries,
    });
    return { entries: listing.entries, truncated: listing.truncated };
  } catch (err) {
    if (err instanceof FileViewerError && err.code === "not_found") {
      return null;
    }
    throw err;
  }
}

function collectCandidatePaths(
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds
): { paths: string[]; listingTruncated: boolean } {
  const paths = new Set<string>();
  let listingTruncated = false;

  const rootListing = safeListDir(workspaceRoot, "", bounds);
  if (rootListing) {
    listingTruncated ||= rootListing.truncated;
    for (const entry of rootListing.entries) {
      if (entry.kind !== "file") continue;
      if (entry.name.toLowerCase().endsWith(".md")) {
        paths.add(entry.name);
      }
    }
  }

  const docsListing = safeListDir(workspaceRoot, "docs", bounds);
  if (docsListing) {
    listingTruncated ||= docsListing.truncated;
    for (const entry of docsListing.entries) {
      if (entry.kind !== "file") continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      paths.add(`docs/${entry.name}`);
    }
  }

  const roadmapListing = safeListDir(workspaceRoot, ROADMAP_DIR, bounds);
  if (roadmapListing) {
    listingTruncated ||= roadmapListing.truncated;
    for (const entry of roadmapListing.entries) {
      if (entry.kind !== "file") continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (entry.name === "00-index.md") continue;
      paths.add(`${ROADMAP_DIR}/${entry.name}`);
    }
  }

  return {
    paths: [...paths].sort((a, b) => a.localeCompare(b)),
    listingTruncated,
  };
}

function readCandidateFacts(
  workspaceRoot: string,
  relPath: string,
  bounds: RoadmapReadinessGatherBounds,
  listingEntry?: WorkspaceFileEntry
): RoadmapReadinessCandidate | null {
  const conventional = isConventionalCandidatePath(relPath);
  let head: string | null = null;
  let truncated = false;
  let size = listingEntry?.size ?? undefined;
  let mtime = parseMtimeMs(listingEntry?.mtime ?? undefined);

  try {
    const content = readWorkspaceFile(workspaceRoot, relPath, {
      maxBytes: Math.min(CANDIDATE_HEAD_BYTES, bounds.maxBytes),
    });
    truncated = content.truncated;
    size = content.size;
    mtime = parseMtimeMs(content.mtime) ?? mtime;
    if (content.encoding === "utf8" && content.content != null) {
      head = content.content;
    }
  } catch (err) {
    if (err instanceof FileViewerError) return null;
    throw err;
  }

  if (
    !conventional &&
    (head == null || !headLooksBacklogLike(head, true))
  ) {
    return null;
  }

  return {
    path: relPath,
    mtime,
    size,
    truncated,
    estimatedItems: head != null ? estimateItems(head) : "unknown",
  };
}

const CONVENTIONAL_PROBE_PATHS = ["ROADMAP.md", "BACKLOG.md", "TODO.md"];

function gatherCandidateFiles(
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds,
  listingTruncated: boolean,
  listedPaths: readonly string[]
): RoadmapReadinessCandidate[] {
  const paths = new Set(listedPaths);
  if (listingTruncated) {
    for (const name of CONVENTIONAL_PROBE_PATHS) paths.add(name);
  }
  const ordered = [...paths].sort((a, b) => a.localeCompare(b));
  const candidates: RoadmapReadinessCandidate[] = [];
  for (const relPath of ordered.slice(0, CANDIDATE_READ_CAP)) {
    const fact = readCandidateFacts(workspaceRoot, relPath, bounds);
    if (fact) candidates.push(fact);
  }
  return candidates;
}

function readIndexMarkdown(
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds
): { markdown: string | null; truncated: boolean } {
  try {
    const content = readWorkspaceFile(workspaceRoot, ROADMAP_INDEX_PATH, {
      maxBytes: bounds.maxBytes,
    });
    if (content.encoding !== "utf8" || content.content == null) {
      return { markdown: null, truncated: false };
    }
    return { markdown: content.content, truncated: content.truncated };
  } catch (err) {
    if (err instanceof FileViewerError && err.code === "not_found") {
      return { markdown: null, truncated: false };
    }
    throw err;
  }
}

function listRoadmapChildren(
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds
): { children: RoadmapChild[]; truncated: boolean } {
  const listing = safeListDir(workspaceRoot, ROADMAP_DIR, bounds);
  if (!listing) return { children: [], truncated: false };
  return {
    children: listing.entries.map(entryToChild),
    truncated: listing.truncated,
  };
}

function gatherTrackerMarkdown(
  workspaceRoot: string,
  children: readonly RoadmapChild[],
  bounds: RoadmapReadinessGatherBounds
): {
  trackerMarkdownBySlug: Record<string, string | null>;
  trackerTruncatedSlugs: string[];
} {
  const trackerMarkdownBySlug: Record<string, string | null> = {};
  const trackerTruncatedSlugs: string[] = [];

  for (const child of children) {
    if (child.kind !== "dir") continue;
    const trackerPath = `${ROADMAP_DIR}/${child.name}/00-index.md`;
    try {
      const content = readWorkspaceFile(workspaceRoot, trackerPath, {
        maxBytes: bounds.maxBytes,
      });
      if (content.truncated) {
        trackerTruncatedSlugs.push(child.name);
      }
      trackerMarkdownBySlug[child.name] =
        content.encoding === "utf8" ? content.content : null;
    } catch (err) {
      if (err instanceof FileViewerError && err.code === "not_found") {
        trackerMarkdownBySlug[child.name] = null;
        continue;
      }
      throw err;
    }
  }

  return { trackerMarkdownBySlug, trackerTruncatedSlugs };
}

/**
 * Collect bounded filesystem facts for one workspace.
 */
export function gatherRoadmapReadinessInputs(
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds
): RoadmapReadinessInputs {
  const gitRepo = isGitRepo(workspaceRoot);
  const { markdown: indexMarkdown, truncated: indexTruncated } =
    readIndexMarkdown(workspaceRoot, bounds);
  const { children: roadmapChildren, truncated: roadmapListingTruncated } =
    listRoadmapChildren(workspaceRoot, bounds);
  const { trackerMarkdownBySlug, trackerTruncatedSlugs } =
    gatherTrackerMarkdown(workspaceRoot, roadmapChildren, bounds);
  const candidateSkip = parseIndexForCandidateSkip(indexMarkdown);
  const { paths: candidatePaths, listingTruncated } = collectCandidatePaths(
    workspaceRoot,
    bounds
  );
  const filteredCandidatePaths = candidatePaths.filter(
    (relPath) => !shouldSkipRoadmapCandidate(relPath, candidateSkip)
  );
  const candidateFiles = gatherCandidateFiles(
    workspaceRoot,
    bounds,
    listingTruncated,
    filteredCandidatePaths
  );

  return {
    gitRepo,
    indexMarkdown,
    indexTruncated,
    roadmapChildren,
    roadmapListingTruncated,
    trackerMarkdownBySlug,
    trackerTruncatedSlugs,
    candidateFiles,
  };
}

/** Full readiness report for one workspace root. */
export function analyzeWorkspaceRoadmapReadiness(
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds
): RoadmapReadinessReport {
  return analyzeRoadmapReadiness(
    gatherRoadmapReadinessInputs(workspaceRoot, bounds)
  );
}

/** Summary row for one registered workspace. */
export function summarizeWorkspaceRoadmapReadiness(
  workspaceId: string,
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds
): RoadmapReadinessWorkspaceSummary {
  const report = analyzeWorkspaceRoadmapReadiness(workspaceRoot, bounds);
  return summarizeRoadmapReadiness(workspaceId, report);
}

/** Summaries for all non-global workspaces, sorted by workspace id. */
export function summarizeAllWorkspacesRoadmapReadiness(
  workspaces: ReadonlyArray<{ id: string; path: string }>,
  bounds: RoadmapReadinessGatherBounds
): RoadmapReadinessSummariesResponse {
  const summaries = workspaces
    .filter((w) => w.path !== "__global__")
    .map((w) => summarizeWorkspaceRoadmapReadiness(w.id, w.path, bounds))
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
  return { workspaces: summaries };
}

export function hashRoadmapContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Build a content-addressed fix plan for one workspace. */
export function buildWorkspaceRoadmapFixPlan(
  workspaceId: string,
  workspaceRoot: string,
  bounds: RoadmapReadinessGatherBounds
): RoadmapFixPlanDraft | RoadmapFixPlan {
  const inputs = gatherRoadmapReadinessInputs(workspaceRoot, bounds);
  const draft = buildRoadmapFixPlanDraft(inputs);
  if (draft.kind !== "ready") return draft;
  return {
    workspaceId,
    relativePath: draft.relativePath,
    baseContent: draft.baseContent,
    proposedContent: draft.proposedContent,
    contentHash: hashRoadmapContent(draft.baseContent),
  };
}

export { countFindingsByImpact };
