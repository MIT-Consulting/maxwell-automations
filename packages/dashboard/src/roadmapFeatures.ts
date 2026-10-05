/**
 * Client-side parser for `docs/roadmap/00-index.md` — the canonical roadmap
 * index (see tech-stack rule). Used only to power a searchable feature picker
 * in the kickoff wizard; never treated as a source of truth for status.
 */

import {
  epicRefusalMessage,
  parseRoadmapIndex,
  pickCanonicalEntry,
  type RoadmapIndexSection,
  type RoadmapReadinessReport,
} from "@lca/shared";
import { formatReadinessFindingLine } from "./roadmapReadinessUi";

export type RoadmapFeatureSection = "backlog" | "completed" | "ideas";

export type RoadmapFeatureSummary = {
  id: string;
  title: string;
  /** Index section — Backlog order is the priority order. */
  section: RoadmapFeatureSection;
  /** False for epic parent briefs (visible but not kickoff-selectable). */
  selectable: boolean;
  disabledReason?: string;
};

function sectionFromIndex(section: RoadmapIndexSection): RoadmapFeatureSection {
  switch (section) {
    case "backlog":
      return "backlog";
    case "documented-ideas":
      return "ideas";
    case "completed":
      return "completed";
  }
}

function sectionRank(section: RoadmapFeatureSection): number {
  switch (section) {
    case "backlog":
      return 0;
    case "ideas":
      return 1;
    case "completed":
      return 2;
  }
}

/**
 * Parse `{id, title, section, selectable}` from canonical resolver sections.
 * Throws on malformed format declarations (same as the daemon resolver).
 */
export function parseRoadmapFeatures(markdown: string): RoadmapFeatureSummary[] {
  const parsed = parseRoadmapIndex(markdown);
  const seen = new Set<string>();
  const out: RoadmapFeatureSummary[] = [];

  for (const entry of parsed.entries) {
    if (seen.has(entry.featureId)) continue;
    seen.add(entry.featureId);
    const canonical = pickCanonicalEntry(parsed.entries, entry.featureId);
    out.push({
      id: canonical.featureId,
      title: canonical.title,
      section: sectionFromIndex(canonical.section),
      selectable: true,
    });
  }

  for (const epic of parsed.epics) {
    if (seen.has(epic.epicId)) continue;
    seen.add(epic.epicId);
    out.push({
      id: epic.epicId,
      title: epic.title,
      section: "backlog",
      selectable: false,
      disabledReason: epicRefusalMessage(epic.epicId),
    });
  }

  return out;
}

/**
 * Filter/rank roadmap features by a free-text query against id or title.
 * Empty query → Backlog only, in index order (priority). Search keeps
 * Backlog hits above Ideas/Completed while preserving relative order.
 */
export function filterRoadmapFeatures(
  features: RoadmapFeatureSummary[],
  query: string,
  limit = 24
): RoadmapFeatureSummary[] {
  const q = query.trim().toLowerCase();
  const matched = !q
    ? features.filter((f) => f.section === "backlog")
    : features.filter(
        (f) =>
          f.id.toLowerCase().includes(q) || f.title.toLowerCase().includes(q)
      );

  return matched
    .slice()
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section))
    .slice(0, limit);
}

/**
 * Add or mark disabled picker rows from readiness findings (ignored sections,
 * format violations) without a second parser.
 */
export function mergeReadinessDisabledFeatures(
  features: RoadmapFeatureSummary[],
  report: RoadmapReadinessReport | undefined
): RoadmapFeatureSummary[] {
  if (!report) return features;

  const disabledById = new Map<string, string>();
  for (const finding of report.findings) {
    if (
      finding.code !== "ignored-section-ids" &&
      finding.code !== "format-violation"
    ) {
      continue;
    }
    const reason = formatReadinessFindingLine(finding);
    for (const id of finding.featureIds ?? []) {
      disabledById.set(id, reason);
    }
  }

  if (disabledById.size === 0) return features;

  const out = features.map((feature) => {
    const reason = disabledById.get(feature.id);
    if (!reason) return feature;
    if (feature.section === "completed" && feature.selectable) {
      disabledById.delete(feature.id);
      return feature;
    }
    return {
      ...feature,
      selectable: false,
      disabledReason: reason,
    };
  });

  for (const [id, reason] of disabledById) {
    if (out.some((feature) => feature.id === id)) continue;
    out.push({
      id,
      title: id,
      section: "backlog",
      selectable: false,
      disabledReason: reason,
    });
  }

  return out;
}
