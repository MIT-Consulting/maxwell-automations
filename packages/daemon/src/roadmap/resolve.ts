/**
 * Workspace-confined roadmap resolution for implement-fully kickoff inputs.
 * Reads only; never writes roadmap files or touches the database.
 */

import {
  CHAIN_VALUE_MAX_LENGTH,
  KickoffError,
  validateFeatureSlugIdea,
  type ResolveImplementFullyKickoffRequest,
  type ResolveImplementFullyKickoffResponse,
} from "@lca/shared";
import {
  FileViewerError,
  listWorkspaceDir,
  readWorkspaceFile,
  resolveWorkspaceFile,
} from "../files/read.js";

const ROADMAP_DIR = "docs/roadmap";
const ROADMAP_INDEX = `${ROADMAP_DIR}/00-index.md`;
const FEATURE_ID_RE = /^b\d+$/;
const SLUG_RE = /^b\d+-[a-z0-9]+(-[a-z0-9]+)*$/;
const NEXT_MARKER_RE = /<!--\s*next:\s*(b\d+)\s*-->/g;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
/** Trailing `— [docs](./x.md) · [PRD](./y.md)` metadata tail on a roadmap row. */
const METADATA_LINK_TAIL_RE =
  /\s+—\s*\[[^\]]*\]\([^)]+\)(?:\s*[·,]\s*\[[^\]]*\]\([^)]+\))*\s*$/u;
const MAX_SLUG_LENGTH = 64;
const MAX_SLUG_SEGMENTS = 6;

export type RoadmapResolveBounds = {
  maxBytes: number;
  maxEntries: number;
};

export class RoadmapResolveError extends Error {
  constructor(
    public category: "bad_request" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "RoadmapResolveError";
  }
}

type IndexSection = "backlog" | "documented-ideas" | "completed";

type IndexEntry = {
  featureId: string;
  section: IndexSection;
  /** Raw row/bullet text used for links and idea composition. */
  raw: string;
  title: string;
  description: string;
};

type RoadmapChild = {
  name: string;
  kind: "dir" | "file" | "symlink";
};

function fail(
  category: "bad_request" | "not_found",
  message: string
): never {
  throw new RoadmapResolveError(category, message);
}

function mapFileError(err: unknown, fallback: string): never {
  if (err instanceof RoadmapResolveError) throw err;
  if (err instanceof FileViewerError) {
    fail(err.code, err.message === "File not found" ? fallback : err.message);
  }
  throw err;
}

/**
 * Human-readable text for a roadmap row. A trailing link tail is metadata —
 * its path is surfaced separately as prior art, so its label is dropped rather
 * than inlined. Remaining links keep their label and lose their syntax.
 */
function toHumanText(text: string): string {
  return text
    .replace(METADATA_LINK_TAIL_RE, "")
    .replace(MD_LINK_RE, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function extractMarkdownHrefs(text: string): string[] {
  const hrefs: string[] = [];
  const re = new RegExp(MD_LINK_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    hrefs.push(match[2]!.trim());
  }
  return hrefs;
}

/**
 * Normalize a relative Markdown href against docs/roadmap/.
 * Returns a forward-slash repo-relative path, or null for ignored links.
 */
function normalizeRoadmapHref(
  href: string,
  workspaceRoot: string
): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    fail("bad_request", "Roadmap link is unsafe");
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) {
    fail("bad_request", "Roadmap link must be relative");
  }

  let path = trimmed.replace(/^\.\//, "");
  const segments = path.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    fail("bad_request", "Roadmap link must not traverse");
  }
  if (segments.length === 0) {
    fail("bad_request", "Roadmap link is unsafe");
  }

  const repoRel = `${ROADMAP_DIR}/${segments.join("/")}`;
  try {
    resolveWorkspaceFile(workspaceRoot, repoRel);
  } catch (err) {
    if (err instanceof FileViewerError) {
      if (err.code === "bad_request") {
        fail("bad_request", "Roadmap link escapes the roadmap tree");
      }
      // Missing targets are not selectable metadata.
      return null;
    }
    throw err;
  }
  return repoRel;
}

function deriveSlug(featureId: string, source: string): string {
  const segments =
    source
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.slice(0, MAX_SLUG_SEGMENTS) ?? [];
  if (segments.length === 0) {
    fail("bad_request", "Cannot derive a feature slug from the source text");
  }

  const prefix = `${featureId}-`;
  let suffix = segments.join("-");
  const maxSuffix = MAX_SLUG_LENGTH - prefix.length;
  if (maxSuffix < 1) {
    fail("bad_request", "Cannot derive a feature slug from the source text");
  }
  if (suffix.length > maxSuffix) {
    suffix = suffix.slice(0, maxSuffix).replace(/-+$/g, "");
  }
  if (!suffix || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(suffix)) {
    fail("bad_request", "Cannot derive a feature slug from the source text");
  }
  return `${featureId}-${suffix}`;
}

function sectionBody(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, "i");
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

function parseBacklogEntries(body: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^- \*\*(b\d+)\*\*\s+(.+)$/);
    if (!match) continue;
    const featureId = match[1]!;
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
    });
  }
  return entries;
}

function parseTableEntries(
  body: string,
  section: "documented-ideas" | "completed"
): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    const featureId = cells[0]!;
    if (!FEATURE_ID_RE.test(featureId)) continue;
    // Skip header / separator rows.
    if (featureId === "ID" || /^[-:]+$/.test(featureId)) continue;

    // Documented Ideas is `ID | Idea | Status | File` — the third cell is
    // workflow status, not prose. Completed is `ID | Feature | Description | Docs`.
    entries.push({
      featureId,
      section,
      raw: line,
      title: toHumanText(cells[1] ?? ""),
      description:
        section === "completed" ? toHumanText(cells[2] ?? "") : "",
    });
  }
  return entries;
}

function parseIndexEntries(markdown: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const backlog = sectionBody(markdown, "Backlog");
  if (backlog != null) entries.push(...parseBacklogEntries(backlog));
  const completed = sectionBody(markdown, "Completed");
  if (completed != null) {
    entries.push(...parseTableEntries(completed, "completed"));
  }
  const ideas = sectionBody(markdown, "Documented Ideas");
  if (ideas != null) {
    entries.push(...parseTableEntries(ideas, "documented-ideas"));
  }
  return entries;
}

function pickCanonicalEntry(
  entries: IndexEntry[],
  featureId: string
): IndexEntry {
  const priority: IndexSection[] = [
    "backlog",
    "documented-ideas",
    "completed",
  ];
  for (const section of priority) {
    const inSection = entries.filter(
      (e) => e.featureId === featureId && e.section === section
    );
    if (inSection.length > 1) {
      fail(
        "bad_request",
        `Roadmap index has duplicate ${featureId} entries in the same section`
      );
    }
    if (inSection.length === 1) return inSection[0]!;
  }
  fail("not_found", `Feature ${featureId} not found in roadmap index`);
}

function readRoadmapIndex(
  workspaceRoot: string,
  bounds: RoadmapResolveBounds
): string {
  let content;
  try {
    content = readWorkspaceFile(workspaceRoot, ROADMAP_INDEX, {
      maxBytes: bounds.maxBytes,
    });
  } catch (err) {
    mapFileError(err, "Roadmap index not found");
  }
  if (content.encoding !== "utf8" || content.content == null) {
    fail("bad_request", "Roadmap index is not readable text");
  }
  if (content.truncated) {
    fail("bad_request", "Roadmap index exceeds the read limit");
  }
  return content.content;
}

function listRoadmapChildren(
  workspaceRoot: string,
  bounds: RoadmapResolveBounds
): RoadmapChild[] {
  let listing;
  try {
    listing = listWorkspaceDir(workspaceRoot, ROADMAP_DIR, {
      maxEntries: bounds.maxEntries,
    });
  } catch (err) {
    mapFileError(err, "Roadmap directory not found");
  }
  if (listing.truncated) {
    fail("bad_request", "Roadmap directory listing truncated");
  }
  return listing.entries.map((e) => ({
    name: e.name,
    kind: e.kind,
  }));
}

function matchingSlugCandidates(
  children: RoadmapChild[],
  featureId: string,
  kind: "dir" | "file"
): string[] {
  const prefix = `${featureId}-`;
  const names: string[] = [];
  for (const child of children) {
    if (kind === "dir") {
      if (child.kind === "symlink" && child.name.startsWith(prefix)) {
        fail(
          "bad_request",
          "Roadmap candidate is a symlink and cannot be used"
        );
      }
      if (child.kind !== "dir") continue;
      if (SLUG_RE.test(child.name) && child.name.startsWith(prefix)) {
        names.push(child.name);
      }
      continue;
    }
    if (child.kind === "symlink" && child.name.startsWith(prefix)) {
      fail(
        "bad_request",
        "Roadmap candidate is a symlink and cannot be used"
      );
    }
    if (child.kind !== "file") continue;
    if (!child.name.endsWith(".md")) continue;
    const stem = child.name.slice(0, -3);
    if (SLUG_RE.test(stem) && stem.startsWith(prefix)) {
      names.push(stem);
    }
  }
  return names;
}

function safeLinksForEntry(
  entry: IndexEntry,
  workspaceRoot: string
): string[] {
  const out: string[] = [];
  for (const href of extractMarkdownHrefs(entry.raw)) {
    const normalized = normalizeRoadmapHref(href, workspaceRoot);
    if (normalized) out.push(normalized);
  }
  return out;
}

function selectByLink(
  candidates: string[],
  links: string[]
): string | null {
  const selected = new Set<string>();
  for (const link of links) {
    if (!link.startsWith(`${ROADMAP_DIR}/`)) continue;
    const rest = link.slice(ROADMAP_DIR.length + 1);
    const first = rest.split("/")[0]!;
    const stem = first.endsWith(".md") ? first.slice(0, -3) : first;
    if (candidates.includes(stem)) selected.add(stem);
  }
  if (selected.size === 1) return [...selected][0]!;
  return null;
}

function resolveSlugFromChildren(
  featureId: string,
  children: RoadmapChild[],
  links: string[],
  entry: IndexEntry
): { slug: string; kind: "dir" | "file" | "derived" } {
  const dirs = matchingSlugCandidates(children, featureId, "dir");
  if (dirs.length === 1) return { slug: dirs[0]!, kind: "dir" };
  if (dirs.length > 1) {
    const picked = selectByLink(dirs, links);
    if (picked) return { slug: picked, kind: "dir" };
    fail(
      "bad_request",
      `Ambiguous roadmap folders for ${featureId}`
    );
  }

  const files = matchingSlugCandidates(children, featureId, "file");
  if (files.length === 1) return { slug: files[0]!, kind: "file" };
  if (files.length > 1) {
    const picked = selectByLink(files, links);
    if (picked) return { slug: picked, kind: "file" };
    fail(
      "bad_request",
      `Ambiguous roadmap documents for ${featureId}`
    );
  }

  const source = [entry.title, entry.description].filter(Boolean).join(" ");
  return { slug: deriveSlug(featureId, source), kind: "derived" };
}

function pathExists(
  workspaceRoot: string,
  relPath: string,
  bounds: RoadmapResolveBounds
): boolean {
  try {
    const content = readWorkspaceFile(workspaceRoot, relPath, {
      maxBytes: Math.min(64, bounds.maxBytes),
    });
    return content != null;
  } catch (err) {
    if (err instanceof FileViewerError) {
      if (err.code === "not_found") return false;
      // Directory / symlink / escape → not usable prior art.
      return false;
    }
    throw err;
  }
}

function composeIdea(
  entry: IndexEntry,
  workspaceRoot: string,
  slug: string,
  slugKind: "dir" | "file" | "derived",
  links: string[],
  bounds: RoadmapResolveBounds
): string {
  const base = [entry.title, entry.description]
    .filter((part) => part.length > 0)
    .join(" — ");
  let priorArt: string | null = null;

  if (slugKind === "dir") {
    const prdPath = `${ROADMAP_DIR}/${slug}/prd.md`;
    if (pathExists(workspaceRoot, prdPath, bounds)) {
      priorArt = prdPath;
    }
  }
  if (priorArt == null) {
    for (const link of links) {
      if (link.endsWith(".md")) {
        priorArt = link;
        break;
      }
    }
  }
  if (priorArt == null && slugKind === "file") {
    priorArt = `${ROADMAP_DIR}/${slug}.md`;
  }

  const idea =
    priorArt != null ? `${base} Prior art: ${priorArt}.` : base;
  const trimmed = idea.trim();
  if (!trimmed) {
    fail("bad_request", "Resolved idea is empty");
  }
  const byteLength = new TextEncoder().encode(trimmed).length;
  if (byteLength > CHAIN_VALUE_MAX_LENGTH) {
    fail(
      "bad_request",
      `Resolved idea is ${byteLength} bytes; max is ${CHAIN_VALUE_MAX_LENGTH}`
    );
  }
  return trimmed;
}

function assertValidatedTriple(
  featureId: string,
  featureSlug: string,
  idea: string
): ResolveImplementFullyKickoffResponse {
  try {
    validateFeatureSlugIdea(featureId, featureSlug, idea);
  } catch (err) {
    if (err instanceof KickoffError) {
      fail("bad_request", err.message);
    }
    throw err;
  }
  return { featureId, featureSlug, idea };
}

function resolveFeatureId(
  workspaceRoot: string,
  featureId: string,
  bounds: RoadmapResolveBounds
): ResolveImplementFullyKickoffResponse {
  if (!FEATURE_ID_RE.test(featureId)) {
    fail("bad_request", "featureId must match ^b\\d+$");
  }
  const markdown = readRoadmapIndex(workspaceRoot, bounds);
  const entries = parseIndexEntries(markdown);
  const entry = pickCanonicalEntry(entries, featureId);
  const children = listRoadmapChildren(workspaceRoot, bounds);
  const links = safeLinksForEntry(entry, workspaceRoot);
  const { slug, kind } = resolveSlugFromChildren(
    featureId,
    children,
    links,
    entry
  );
  const idea = composeIdea(
    entry,
    workspaceRoot,
    slug,
    kind,
    links,
    bounds
  );
  return assertValidatedTriple(featureId, slug, idea);
}

function hasExactIndexEntry(entries: IndexEntry[], featureId: string): boolean {
  return entries.some((e) => e.featureId === featureId);
}

function hasDirectMatch(
  children: RoadmapChild[],
  featureId: string
): boolean {
  return (
    matchingSlugCandidates(children, featureId, "dir").length > 0 ||
    matchingSlugCandidates(children, featureId, "file").length > 0
  );
}

function resolveIdea(
  workspaceRoot: string,
  idea: string,
  bounds: RoadmapResolveBounds
): ResolveImplementFullyKickoffResponse {
  const trimmed = idea.trim();
  if (!trimmed) {
    fail("bad_request", "idea must be non-empty after trimming");
  }
  const byteLength = new TextEncoder().encode(trimmed).length;
  if (byteLength > CHAIN_VALUE_MAX_LENGTH) {
    fail(
      "bad_request",
      `idea is ${byteLength} bytes; max is ${CHAIN_VALUE_MAX_LENGTH}`
    );
  }

  const markdown = readRoadmapIndex(workspaceRoot, bounds);
  const markers = [...markdown.matchAll(NEXT_MARKER_RE)].map((m) => m[1]!);
  if (markers.length === 0) {
    fail("bad_request", "Roadmap index is missing the next-id marker");
  }
  if (markers.length > 1) {
    fail("bad_request", "Roadmap index has duplicate next-id markers");
  }
  const featureId = markers[0]!;
  const entries = parseIndexEntries(markdown);
  const children = listRoadmapChildren(workspaceRoot, bounds);
  if (
    hasExactIndexEntry(entries, featureId) ||
    hasDirectMatch(children, featureId)
  ) {
    fail(
      "bad_request",
      `Next feature id ${featureId} is already allocated`
    );
  }

  const featureSlug = deriveSlug(featureId, trimmed);
  return assertValidatedTriple(featureId, featureSlug, trimmed);
}

/**
 * Resolve an implement-fully kickoff input against one workspace root.
 */
export function resolveImplementFullyKickoff(
  workspaceRoot: string,
  input: ResolveImplementFullyKickoffRequest["input"],
  bounds: RoadmapResolveBounds
): ResolveImplementFullyKickoffResponse {
  if (input.kind === "feature-id") {
    return resolveFeatureId(workspaceRoot, input.featureId, bounds);
  }
  return resolveIdea(workspaceRoot, input.idea, bounds);
}
