/**
 * Pure roadmap readiness analysis — states, findings, feature plans.
 * No fs, fetch, process, daemon, or dashboard imports.
 */

import {
  isRoadmapIdCandidate,
  parseNextMarkers,
  type ResolvedIdFormats,
} from "./roadmap-ids.js";
import {
  formatFeatureIdMustMatchMessage,
  hasIndexEntry,
  IdFormatError,
  parseRoadmapIndex,
  pickCanonicalEntry,
  sectionBody,
  type RoadmapIndexEntry,
  type RoadmapIndexSection,
} from "./roadmap-index.js";
import {
  entryLinks,
  PER_PERSON_IDEA_REFUSAL,
  resolveSlugFromChildren,
  ROADMAP_DIR,
  splitHrefPathFragment,
  type RoadmapChild,
} from "./roadmap-resolution.js";
import {
  parseRoadmapTracker,
  RoadmapTrackerError,
  type TrackerPhaseStatus,
} from "./roadmap-tracker.js";

export type RoadmapReadinessState = "ready" | "empty" | "adoptable";

export type RoadmapFindingImpact =
  | "blocks-all"
  | "blocks-some"
  | "idea-only"
  | "info";

export type RoadmapFixableBy = "cli" | "agent" | "user";

export type RoadmapFinding = {
  code: string;
  impact: RoadmapFindingImpact;
  message: string;
  fix: string;
  fixable_by: RoadmapFixableBy;
  featureIds?: string[];
  path?: string;
};

export type RoadmapFeaturePlanKind =
  | "dir"
  | "file"
  | "derived"
  | "ambiguous"
  | "blocked";

export type RoadmapFeaturePlan = {
  id: string;
  section: RoadmapIndexSection;
  slug?: string;
  kind: RoadmapFeaturePlanKind;
  reason?: string;
  nextPhase?: { n: number; status: TrackerPhaseStatus };
};

export type RoadmapReadinessCandidate = {
  path: string;
  mtime?: number;
  size?: number;
  truncated?: boolean;
  estimatedItems?: number | "unknown";
};

export type RoadmapReadinessReport = {
  state: RoadmapReadinessState;
  findings: RoadmapFinding[];
  features: RoadmapFeaturePlan[];
  candidates: RoadmapReadinessCandidate[];
};

export type RoadmapReadinessInputs = {
  gitRepo: boolean;
  indexMarkdown: string | null;
  indexTruncated?: boolean;
  roadmapChildren: readonly RoadmapChild[];
  roadmapListingTruncated?: boolean;
  trackerMarkdownBySlug: Readonly<Record<string, string | null>>;
  trackerTruncatedSlugs?: readonly string[];
  candidateFiles: readonly RoadmapReadinessCandidate[];
};

const CANONICAL_HEADINGS = [
  /^##\s+Backlog(?:\s|$)/i,
  /^##\s+Completed(?:\s|$)/i,
  /^##\s+Documented Ideas(?:\s|$)/i,
  /^##\s+Epics(?:\s|$)/i,
];

function isBlocker(impact: RoadmapFindingImpact): boolean {
  return impact === "blocks-all" || impact === "blocks-some";
}

function recomputeState(
  findings: RoadmapFinding[],
  inputs: RoadmapReadinessInputs
): RoadmapReadinessState {
  const hasIndex = inputs.indexMarkdown != null;
  const hasCandidates = inputs.candidateFiles.length > 0;
  const hasBlockers = findings.some((f) => isBlocker(f.impact));

  if (!hasIndex) {
    if (hasCandidates) return "adoptable";
    return "empty";
  }
  if (hasBlockers) return "adoptable";
  return "ready";
}

function hasCanonicalSection(markdown: string): boolean {
  return (
    sectionBody(markdown, "Backlog") != null ||
    sectionBody(markdown, "Completed") != null ||
    sectionBody(markdown, "Documented Ideas") != null
  );
}

function isCanonicalHeading(line: string): boolean {
  return CANONICAL_HEADINGS.some((re) => re.test(line));
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

function idMatchesFormat(id: string, format: ResolvedIdFormats["feature"]): boolean {
  return format.anchored.test(id);
}

function scanIgnoredSectionIds(
  markdown: string,
  formats: ResolvedIdFormats
): string[] {
  const lines = markdown.split(/\r?\n/);
  const ignored: string[] = [];
  let inNonCanonical = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inNonCanonical = !isCanonicalHeading(line);
      continue;
    }
    if (!inNonCanonical) continue;
    const id = structuralIdFromLine(line);
    if (
      id != null &&
      isRoadmapIdCandidate(id) &&
      idMatchesFormat(id, formats.feature)
    ) {
      ignored.push(id);
    }
  }

  return [...new Set(ignored)];
}

function scanFormatViolations(
  markdown: string,
  formats: ResolvedIdFormats
): string[] {
  const lines = markdown.split(/\r?\n/);
  const violations: string[] = [];
  let inFeatureSection = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inFeatureSection = isFeatureSectionHeading(line);
      continue;
    }
    if (!inFeatureSection) continue;
    const id = structuralIdFromLine(line);
    if (
      id != null &&
      isRoadmapIdCandidate(id) &&
      !idMatchesFormat(id, formats.feature)
    ) {
      violations.push(id);
    }
  }

  return [...new Set(violations)];
}

function childNames(children: readonly RoadmapChild[]): Set<string> {
  const names = new Set<string>();
  for (const child of children) {
    names.add(child.name);
    if (child.kind === "file" && child.name.endsWith(".md")) {
      names.add(child.name.slice(0, -3));
    }
  }
  return names;
}

function isLinkResolvable(link: string, names: Set<string>): boolean {
  const trimmed = link.trim();
  if (!trimmed || trimmed.startsWith("#")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;

  const { path } = splitHrefPathFragment(trimmed);
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    return false;
  }

  let normalized = path.replace(/^\.\//, "");
  const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    // Cross-doc links outside docs/roadmap/ are out of scope for feature resolution.
    return true;
  }
  if (segments.length === 0) return false;

  const repoRel = `${ROADMAP_DIR}/${segments.join("/")}`;
  const first = segments[0]!;
  const stem = first.endsWith(".md") ? first.slice(0, -3) : first;
  if (names.has(stem) || names.has(first)) return true;

  if (segments.length === 2 && segments[1] === "00-index.md") {
    return names.has(stem);
  }

  return names.has(repoRel) || names.has(stem);
}

function analyzeIdeaMarkers(markdown: string, findings: RoadmapFinding[]): void {
  const markers = parseNextMarkers(markdown);
  const plain = markers.filter((m) => m.kind === "plain");
  const perPerson = markers.filter((m) => m.kind === "per-person");

  if (perPerson.length > 0) {
    findings.push({
      code: "per-person-next-marker",
      impact: "idea-only",
      message: PER_PERSON_IDEA_REFUSAL,
      fix: "Add the item with your id to the index, then use --feature instead of --idea.",
      fixable_by: "user",
    });
  }
  if (plain.length === 0 && perPerson.length === 0) {
    findings.push({
      code: "missing-next-marker",
      impact: "idea-only",
      message: "Roadmap index is missing the next-id marker",
      fix: "Add <!-- next: b<n> --> to docs/roadmap/00-index.md.",
      fixable_by: "cli",
    });
  } else if (plain.length > 1) {
    findings.push({
      code: "duplicate-next-marker",
      impact: "idea-only",
      message: "Roadmap index has duplicate next-id markers",
      fix: "Keep one <!-- next: … --> marker in docs/roadmap/00-index.md.",
      fixable_by: "agent",
    });
  }
}

function mergeTrackerFeatureId(
  finding: RoadmapFinding,
  featureId: string
): void {
  const ids = new Set(finding.featureIds ?? []);
  ids.add(featureId);
  finding.featureIds = [...ids];
}

function analyzeTracker(
  slug: string,
  markdown: string | null | undefined,
  truncated: boolean,
  findings: RoadmapFinding[],
  featureId: string,
  trackerFindingBySlug: Map<string, RoadmapFinding>
): { n: number; status: TrackerPhaseStatus } | undefined {
  const trackerPath = `${ROADMAP_DIR}/${slug}/00-index.md`;

  if (truncated) {
    const prior = trackerFindingBySlug.get(slug);
    if (prior) {
      mergeTrackerFeatureId(prior, featureId);
      return undefined;
    }
    const finding: RoadmapFinding = {
      code: "tracker-truncated",
      impact: "blocks-some",
      message: `Feature tracker for ${slug} exceeds the read limit`,
      fix: "Shorten or split the tracker file so it fits within the read limit.",
      fixable_by: "user",
      featureIds: [featureId],
      path: trackerPath,
    };
    findings.push(finding);
    trackerFindingBySlug.set(slug, finding);
    return undefined;
  }
  if (markdown == null) return undefined;

  try {
    const parsed = parseRoadmapTracker(markdown);
    if (parsed.nextExecutable == null) return undefined;
    return {
      n: parsed.nextExecutable.number,
      status: parsed.nextExecutable.status,
    };
  } catch (err) {
    if (err instanceof RoadmapTrackerError) {
      const prior = trackerFindingBySlug.get(slug);
      if (prior) {
        mergeTrackerFeatureId(prior, featureId);
        return undefined;
      }
      const finding: RoadmapFinding = {
        code: "bad-tracker-header",
        impact: "blocks-some",
        message: `Feature folder ${slug} has a phase tracker Max cannot read: ${err.message}`,
        fix: trackerErrorFix(err.code),
        fixable_by: "agent",
        featureIds: [featureId],
        path: trackerPath,
      };
      findings.push(finding);
      trackerFindingBySlug.set(slug, finding);
    }
    return undefined;
  }
}

function trackerErrorFix(code: RoadmapTrackerError["code"]): string {
  switch (code) {
    case "missing-header":
      return "Add the five-column tracker table with header | Phase | File | Status | Depends on | Commit |.";
    case "unknown-status":
      return "Start each Status cell with Pending, In Progress, or Done.";
    case "duplicate-phase":
      return "Make phase numbers unique in the tracker table.";
    case "malformed-phase":
      return "Start each Phase cell with the phase number (1, 1 — Title, or P1 — Title).";
    case "malformed-dependency":
      return "List phase numbers or — in each Depends on cell.";
    case "missing-link":
      return "Put the phase file in the File cell (markdown link or plain path).";
    case "misordered-header":
    case "extra-header":
      return "Use the documented five-column header: | Phase | File | Status | Depends on | Commit |.";
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

function planFeature(
  entry: RoadmapIndexEntry,
  children: readonly RoadmapChild[],
  trackerBySlug: Readonly<Record<string, string | null>>,
  truncatedSlugs: Set<string>,
  findings: RoadmapFinding[],
  trackerFindingBySlug: Map<string, RoadmapFinding>
): RoadmapFeaturePlan {
  const links = entryLinks(entry);
  const resolution = resolveSlugFromChildren(
    entry.featureId,
    children,
    links,
    entry
  );

  if (resolution.outcome === "blocked") {
    if (resolution.reason === "symlink") {
      findings.push({
        code: "symlink-candidate",
        impact: "blocks-some",
        message: resolution.message,
        fix: "Replace the symlink with a real folder or markdown file.",
        fixable_by: "user",
        featureIds: [entry.featureId],
      });
    } else if (resolution.reason === "ambiguous") {
      findings.push({
        code: "ambiguous-slug",
        impact: "blocks-some",
        message: resolution.message,
        fix: "Add an index link that selects one folder or document.",
        fixable_by: "agent",
        featureIds: [entry.featureId],
      });
    }
    return {
      id: entry.featureId,
      section: entry.section,
      kind: resolution.reason === "ambiguous" ? "ambiguous" : "blocked",
      reason: resolution.message,
    };
  }

  const nextExecutable =
    resolution.kind === "dir"
      ? analyzeTracker(
          resolution.slug,
          trackerBySlug[resolution.slug],
          truncatedSlugs.has(resolution.slug),
          findings,
          entry.featureId,
          trackerFindingBySlug
        )
      : undefined;

  return {
    id: entry.featureId,
    section: entry.section,
    slug: resolution.slug,
    kind: resolution.kind,
    nextPhase: nextExecutable
      ? { n: nextExecutable.n, status: nextExecutable.status }
      : undefined,
  };
}

/**
 * Convert bounded filesystem facts into a serializable readiness report.
 */
export function analyzeRoadmapReadiness(
  inputs: RoadmapReadinessInputs
): RoadmapReadinessReport {
  const findings: RoadmapFinding[] = [];
  const features: RoadmapFeaturePlan[] = [];
  const truncatedSlugs = new Set(inputs.trackerTruncatedSlugs ?? []);

  if (!inputs.gitRepo) {
    findings.push({
      code: "not-git-repo",
      impact: "blocks-all",
      message: "Workspace is not a git repository",
      fix: "Run git init in the workspace root.",
      fixable_by: "user",
    });
  }

  if (inputs.roadmapListingTruncated) {
    findings.push({
      code: "roadmap-listing-truncated",
      impact: "blocks-all",
      message: "Roadmap directory listing was truncated",
      fix: "Reduce the number of entries under docs/roadmap/.",
      fixable_by: "user",
    });
  }

  const markdown = inputs.indexMarkdown;
  if (markdown == null) {
    for (const candidate of inputs.candidateFiles) {
      findings.push({
        code: "ignored-backlog-file",
        impact: "info",
        message: `Backlog-like file ignored by Max: ${candidate.path}`,
        fix: "Create docs/roadmap/00-index.md or run max roadmap init.",
        fixable_by: "cli",
        path: candidate.path,
      });
    }
    const state = recomputeState(findings, inputs);
    return { state, findings, features, candidates: [...inputs.candidateFiles] };
  }

  if (inputs.indexTruncated) {
    findings.push({
      code: "index-truncated",
      impact: "blocks-all",
      message: "Roadmap index exceeds the read limit",
      fix: "Shorten docs/roadmap/00-index.md so it fits within the read limit.",
      fixable_by: "user",
      path: `${ROADMAP_DIR}/00-index.md`,
    });
  }

  let parsed;
  try {
    parsed = parseRoadmapIndex(markdown);
  } catch (err) {
    if (err instanceof IdFormatError) {
      findings.push({
        code: "malformed-index",
        impact: "blocks-all",
        message: err.message,
        fix: "Fix the id-format or epic-format declaration in docs/roadmap/00-index.md.",
        fixable_by: "agent",
        path: `${ROADMAP_DIR}/00-index.md`,
      });
    } else {
      throw err;
    }
    const state = recomputeState(findings, inputs);
    return { state, findings, features, candidates: [...inputs.candidateFiles] };
  }

  if (!hasCanonicalSection(markdown)) {
    findings.push({
      code: "no-canonical-sections",
      impact: "blocks-all",
      message: "Roadmap index is missing the sections Max reads",
      fix: "Add ## Backlog and ## Completed (and optionally ## Documented Ideas).",
      fixable_by: "cli",
      path: `${ROADMAP_DIR}/00-index.md`,
    });
  }

  analyzeIdeaMarkers(markdown, findings);

  const ignoredIds = scanIgnoredSectionIds(markdown, parsed.formats).filter(
    (id) => !hasIndexEntry(parsed.entries, id)
  );
  if (ignoredIds.length > 0) {
    findings.push({
      code: "ignored-section-ids",
      impact: "blocks-some",
      message: `${ignoredIds.length} feature id(s) appear only in sections Max ignores`,
      fix: "Move those ids into ## Backlog, ## Completed, or ## Documented Ideas.",
      fixable_by: "agent",
      featureIds: ignoredIds,
    });
  }

  const formatViolations = scanFormatViolations(markdown, parsed.formats);
  if (formatViolations.length > 0) {
    findings.push({
      code: "format-violation",
      impact: "blocks-some",
      message: `${formatViolations.length} feature id(s) do not match the declared format`,
      fix: formatFeatureIdMustMatchMessage(parsed.formats),
      fixable_by: "agent",
      featureIds: formatViolations,
    });
  }

  if (parsed.epics.length > 0) {
    findings.push({
      code: "epics-present",
      impact: "info",
      message: `${parsed.epics.length} epic(s) are not startable as features`,
      fix: "Kick off one of the epic's child features instead.",
      fixable_by: "user",
      featureIds: parsed.epics.map((e) => e.epicId),
    });
  }

  const names = childNames(inputs.roadmapChildren);
  const seenCanonicalPairs = new Set<string>();
  const trackerFindingBySlug = new Map<string, RoadmapFinding>();
  const entriesForPlanning: RoadmapIndexEntry[] = [];
  const uniqueFeatureIds: string[] = [];
  const seenFeatureIds = new Set<string>();

  for (const entry of parsed.entries) {
    const pairKey = `${entry.featureId}\0${entry.section}`;
    if (seenCanonicalPairs.has(pairKey)) {
      findings.push({
        code: "duplicate-entry",
        impact: "blocks-some",
        message: `Roadmap index has duplicate ${entry.featureId} entries in the same section`,
        fix: "Remove or merge the duplicate row in docs/roadmap/00-index.md.",
        fixable_by: "agent",
        featureIds: [entry.featureId],
      });
      continue;
    }
    seenCanonicalPairs.add(pairKey);

    for (const href of entryLinks(entry)) {
      if (!isLinkResolvable(href, names)) {
        findings.push({
          code: "unresolvable-link",
          impact: "info",
          message: `Link for ${entry.featureId} does not resolve under docs/roadmap/`,
          fix: "Fix the link target or create the missing folder or file.",
          fixable_by: "agent",
          featureIds: [entry.featureId],
        });
        break;
      }
    }

    entriesForPlanning.push(entry);
    if (!seenFeatureIds.has(entry.featureId)) {
      seenFeatureIds.add(entry.featureId);
      uniqueFeatureIds.push(entry.featureId);
    }
  }

  for (const featureId of uniqueFeatureIds) {
    const canonical = pickCanonicalEntry(entriesForPlanning, featureId);
    features.push(
      planFeature(
        canonical,
        inputs.roadmapChildren,
        inputs.trackerMarkdownBySlug,
        truncatedSlugs,
        findings,
        trackerFindingBySlug
      )
    );
  }

  for (const candidate of inputs.candidateFiles) {
    findings.push({
      code: "ignored-backlog-file",
      impact: "info",
      message: `Other backlog-like file ignored by Max: ${candidate.path}`,
      fix: "Adopt it into docs/roadmap/00-index.md when ready.",
      fixable_by: "agent",
      path: candidate.path,
    });
  }

  const state = recomputeState(findings, inputs);
  return { state, findings, features, candidates: [...inputs.candidateFiles] };
}

/** Whether a report has kickoff-blocking findings. */
export function roadmapReadinessHasBlockers(report: RoadmapReadinessReport): boolean {
  return report.findings.some((f) => isBlocker(f.impact));
}

export type RoadmapReadinessImpactCounts = {
  "blocks-all": number;
  "blocks-some": number;
  "idea-only": number;
  info: number;
};

export type RoadmapReadinessWorkspaceSummary = {
  workspaceId: string;
  state: RoadmapReadinessState;
  counts: RoadmapReadinessImpactCounts;
};

export type RoadmapReadinessSummariesResponse = {
  workspaces: RoadmapReadinessWorkspaceSummary[];
};

const IMPACT_SORT_ORDER: Record<RoadmapFindingImpact, number> = {
  "blocks-all": 0,
  "blocks-some": 1,
  "idea-only": 2,
  info: 3,
};

/** Deterministic ordering for kickoff and display. */
export function compareRoadmapFindings(
  a: RoadmapFinding,
  b: RoadmapFinding
): number {
  const byImpact = IMPACT_SORT_ORDER[a.impact] - IMPACT_SORT_ORDER[b.impact];
  if (byImpact !== 0) return byImpact;
  const byCode = a.code.localeCompare(b.code);
  if (byCode !== 0) return byCode;
  return a.message.localeCompare(b.message);
}

export function countFindingsByImpact(
  findings: readonly RoadmapFinding[]
): RoadmapReadinessImpactCounts {
  const counts: RoadmapReadinessImpactCounts = {
    "blocks-all": 0,
    "blocks-some": 0,
    "idea-only": 0,
    info: 0,
  };
  for (const finding of findings) {
    counts[finding.impact] += 1;
  }
  return counts;
}

export function summarizeRoadmapReadiness(
  workspaceId: string,
  report: RoadmapReadinessReport
): RoadmapReadinessWorkspaceSummary {
  return {
    workspaceId,
    state: report.state,
    counts: countFindingsByImpact(report.findings),
  };
}

export class KickoffReadinessError extends Error {
  constructor(
    public category: "bad_request" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "KickoffReadinessError";
  }
}

function kickoffErrorText(finding: RoadmapFinding): string {
  // Idea-only refusals keep the exact b77 marker strings.
  if (finding.impact === "idea-only") return finding.message;
  const fix = finding.fix.trim();
  return fix.length > 0 ? `${finding.message} ${fix}` : finding.message;
}

/**
 * Enforce readiness blockers before feature resolution. Informational findings
 * never block. Idea-only findings block `--idea` but not explicit feature ids.
 */
export function assertKickoffReadinessAllowed(
  report: RoadmapReadinessReport,
  input:
    | { kind: "feature-id"; featureId: string }
    | { kind: "idea"; idea: string }
): void {
  const sorted = [...report.findings].sort(compareRoadmapFindings);
  const blocksAll = sorted.find((f) => f.impact === "blocks-all");
  if (blocksAll) {
    throw new KickoffReadinessError("bad_request", kickoffErrorText(blocksAll));
  }
  if (input.kind === "idea") {
    const ideaBlock = sorted.find((f) => f.impact === "idea-only");
    if (ideaBlock) {
      throw new KickoffReadinessError("bad_request", kickoffErrorText(ideaBlock));
    }
    return;
  }
  for (const finding of sorted) {
    if (finding.impact !== "blocks-some") continue;
    if (finding.featureIds?.includes(input.featureId)) {
      throw new KickoffReadinessError(
        "bad_request",
        kickoffErrorText(finding)
      );
    }
  }
}

