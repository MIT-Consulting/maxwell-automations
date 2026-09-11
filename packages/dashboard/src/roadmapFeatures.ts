/**
 * Client-side parser for `docs/roadmap/00-index.md` — the canonical roadmap
 * index (see tech-stack rule). Used only to power a searchable feature picker
 * in the kickoff wizard; never treated as a source of truth for status.
 */

export type RoadmapFeatureSection = "backlog" | "completed" | "ideas" | "other";

export type RoadmapFeatureSummary = {
  id: string;
  title: string;
  /** Index section — Backlog order is the priority order. */
  section: RoadmapFeatureSection;
};

// Backlog bullets: `- **b17** Title text — description...`
const BACKLOG_BULLET_RE = /^-\s+\*\*(b\d+)\*\*\s+(.+?)\s+—/;
// Completed / Documented Ideas table rows: `| b50 | Title | ... |`
const TABLE_ROW_RE = /^\|\s*(b\d+)\s*\|\s*([^|]+?)\s*\|/;
const SECTION_HEADER_RE =
  /^##\s+(Backlog|Completed|Documented Ideas)\s*$/i;

function sectionFromHeader(name: string): RoadmapFeatureSection {
  const key = name.trim().toLowerCase();
  if (key === "backlog") return "backlog";
  if (key === "completed") return "completed";
  if (key === "documented ideas") return "ideas";
  return "other";
}

function sectionRank(section: RoadmapFeatureSection): number {
  switch (section) {
    case "backlog":
      return 0;
    case "ideas":
      return 1;
    case "other":
      return 2;
    case "completed":
      return 3;
  }
}

/** Parse `{id, title, section}` pairs from Backlog bullets and
 *  Completed/Documented Ideas table rows. Tolerant of missing sections or an
 *  unexpected format — returns whatever it can match, never throws. First
 *  occurrence wins (Backlog before Completed/Ideas in the index). */
export function parseRoadmapFeatures(markdown: string): RoadmapFeatureSummary[] {
  const seen = new Set<string>();
  const out: RoadmapFeatureSummary[] = [];
  let section: RoadmapFeatureSection = "other";

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const header = SECTION_HEADER_RE.exec(line);
    if (header?.[1]) {
      section = sectionFromHeader(header[1]);
      continue;
    }

    const match = BACKLOG_BULLET_RE.exec(line) ?? TABLE_ROW_RE.exec(line);
    if (!match) continue;
    const id = match[1];
    const title = match[2]?.trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title, section });
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

  // Stable sort: backlog → ideas → other → completed; file order within.
  return matched
    .slice()
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section))
    .slice(0, limit);
}
