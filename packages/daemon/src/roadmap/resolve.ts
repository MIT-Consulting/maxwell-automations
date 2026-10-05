/**
 * Workspace-confined roadmap resolution for implement-fully kickoff inputs.
 * Reads only; never writes roadmap files or touches the database.
 */

import {
  CHAIN_VALUE_MAX_LENGTH,
  classifyId,
  epicRefusalMessage,
  extractMarkdownHrefs,
  formatFeatureIdMustMatchMessage,
  hasIndexEntry,
  hasPerPersonNextMarker,
  IdFormatError,
  KickoffError,
  isRoadmapIdCandidate,
  parseNextMarkers,
  parseRoadmapIndex,
  pickCanonicalEntry,
  RoadmapIndexError,
  toHumanText,
  validateFeatureSlugIdea,
  deriveSlug,
  entryLinks,
  isMarkdownPriorArtLink,
  matchingSlugCandidates,
  PER_PERSON_IDEA_REFUSAL,
  resolveSlugFromChildren,
  ROADMAP_DIR,
  splitHrefPathFragment,
  SYMLINK_CANDIDATE_MESSAGE,
  type RoadmapChild,
  type RoadmapIndexEntry,
  type RoadmapReadinessInputs,
  type ResolveImplementFullyKickoffRequest,
  type ResolveImplementFullyKickoffResponse,
} from "@lca/shared";
import {
  FileViewerError,
  listWorkspaceDir,
  readWorkspaceFile,
  resolveWorkspaceFile,
} from "../files/read.js";

const ROADMAP_INDEX = `${ROADMAP_DIR}/00-index.md`;

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

function mapIndexError(err: unknown): never {
  if (err instanceof RoadmapIndexError) {
    if (err.code === "not-found") {
      fail("not_found", err.message);
    }
    fail("bad_request", err.message);
  }
  if (err instanceof IdFormatError) {
    fail("bad_request", err.message);
  }
  throw err;
}

function mapSlugResolution(
  result: ReturnType<typeof resolveSlugFromChildren>
): { slug: string; kind: "dir" | "file" | "derived" } {
  if (result.outcome === "resolved") {
    return { slug: result.slug, kind: result.kind };
  }
  fail("bad_request", result.message);
}

/**
 * Normalize a relative Markdown href against docs/roadmap/.
 * Returns a forward-slash repo-relative path with optional #fragment, or null.
 */
function normalizeRoadmapHref(
  href: string,
  workspaceRoot: string
): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  const { path, fragment } = splitHrefPathFragment(trimmed);
  if (path.includes("\\") || path.includes("\0")) {
    fail("bad_request", "Roadmap link is unsafe");
  }
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    fail("bad_request", "Roadmap link must be relative");
  }

  let normalized = path.replace(/^\.\//, "");
  const segments = normalized
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
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
      return null;
    }
    throw err;
  }
  return `${repoRel}${fragment}`;
}

function readRoadmapIndex(
  workspaceRoot: string,
  bounds: RoadmapResolveBounds,
  cache?: Pick<RoadmapReadinessInputs, "indexMarkdown" | "indexTruncated">
): string {
  if (cache?.indexTruncated) {
    fail("bad_request", "Roadmap index exceeds the read limit");
  }
  if (cache?.indexMarkdown != null) {
    return cache.indexMarkdown;
  }
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
  bounds: RoadmapResolveBounds,
  cache?: Pick<RoadmapReadinessInputs, "roadmapChildren" | "roadmapListingTruncated">
): RoadmapChild[] {
  if (cache?.roadmapListingTruncated) {
    fail("bad_request", "Roadmap directory listing truncated");
  }
  if (cache?.roadmapChildren != null) {
    return [...cache.roadmapChildren];
  }
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

function safeLinksForEntry(
  entry: RoadmapIndexEntry,
  workspaceRoot: string
): string[] {
  const out: string[] = [];
  for (const href of entryLinks(entry)) {
    const normalized = normalizeRoadmapHref(href, workspaceRoot);
    if (normalized) out.push(normalized);
  }
  return out;
}

function assertNoSymlinkCandidates(
  children: RoadmapChild[],
  featureId: string
): void {
  for (const kind of ["dir", "file"] as const) {
    const result = matchingSlugCandidates(children, featureId, kind);
    if (result.symlinkBlocked) {
      fail("bad_request", SYMLINK_CANDIDATE_MESSAGE);
    }
  }
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
      return false;
    }
    throw err;
  }
}

function composeIdea(
  entry: RoadmapIndexEntry,
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
      if (isMarkdownPriorArtLink(link)) {
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

function classifyFeatureIdOrFail(
  featureId: string,
  parsed: ReturnType<typeof parseRoadmapIndex>
): void {
  if (!isRoadmapIdCandidate(featureId)) {
    fail("bad_request", formatFeatureIdMustMatchMessage(parsed.formats));
  }
  const kind = classifyId(featureId, parsed.formats);
  if (kind === "epic") {
    fail("bad_request", epicRefusalMessage(featureId));
  }
  if (kind === "unknown") {
    fail("bad_request", formatFeatureIdMustMatchMessage(parsed.formats));
  }
}

function resolveFeatureId(
  workspaceRoot: string,
  featureId: string,
  bounds: RoadmapResolveBounds,
  cache?: RoadmapReadinessInputs
): ResolveImplementFullyKickoffResponse {
  const markdown = readRoadmapIndex(workspaceRoot, bounds, cache);
  let parsed;
  try {
    parsed = parseRoadmapIndex(markdown);
  } catch (err) {
    mapIndexError(err);
  }
  classifyFeatureIdOrFail(featureId, parsed);

  let entry: RoadmapIndexEntry;
  try {
    entry = pickCanonicalEntry(parsed.entries, featureId);
  } catch (err) {
    mapIndexError(err);
  }
  const children = listRoadmapChildren(workspaceRoot, bounds, cache);
  assertNoSymlinkCandidates(children, featureId);
  const links = safeLinksForEntry(entry, workspaceRoot);
  const { slug, kind } = mapSlugResolution(
    resolveSlugFromChildren(featureId, children, links, entry)
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

function resolveIdea(
  workspaceRoot: string,
  idea: string,
  bounds: RoadmapResolveBounds,
  cache?: RoadmapReadinessInputs
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

  const markdown = readRoadmapIndex(workspaceRoot, bounds, cache);
  if (hasPerPersonNextMarker(markdown)) {
    fail("bad_request", PER_PERSON_IDEA_REFUSAL);
  }

  const plainMarkers = parseNextMarkers(markdown).filter(
    (m) => m.kind === "plain"
  );
  if (plainMarkers.length === 0) {
    fail("bad_request", "Roadmap index is missing the next-id marker");
  }
  if (plainMarkers.length > 1) {
    fail("bad_request", "Roadmap index has duplicate next-id markers");
  }
  const featureId = plainMarkers[0]!.id;

  let parsed;
  try {
    parsed = parseRoadmapIndex(markdown);
  } catch (err) {
    mapIndexError(err);
  }

  const children = listRoadmapChildren(workspaceRoot, bounds, cache);
  if (hasIndexEntry(parsed.entries, featureId)) {
    fail(
      "bad_request",
      `Next feature id ${featureId} is already allocated`
    );
  }
  for (const kind of ["dir", "file"] as const) {
    const match = matchingSlugCandidates(children, featureId, kind);
    if (match.symlinkBlocked) {
      fail("bad_request", SYMLINK_CANDIDATE_MESSAGE);
    }
    if (match.candidates.length > 0) {
      fail(
        "bad_request",
        `Next feature id ${featureId} is already allocated`
      );
    }
  }

  const derived = deriveSlug(featureId, trimmed);
  if (!derived.ok) {
    fail("bad_request", derived.message);
  }
  return assertValidatedTriple(featureId, derived.slug, trimmed);
}

/**
 * Resolve an implement-fully kickoff input against one workspace root.
 */
export function resolveImplementFullyKickoff(
  workspaceRoot: string,
  input: ResolveImplementFullyKickoffRequest["input"],
  bounds: RoadmapResolveBounds,
  cache?: RoadmapReadinessInputs
): ResolveImplementFullyKickoffResponse {
  if (input.kind === "feature-id") {
    return resolveFeatureId(workspaceRoot, input.featureId, bounds, cache);
  }
  return resolveIdea(workspaceRoot, input.idea, bounds, cache);
}

// Re-export for tests that import parsing helpers from resolve.
export { toHumanText, extractMarkdownHrefs };
