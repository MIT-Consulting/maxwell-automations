import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRoadmapReadiness,
  assertKickoffReadinessAllowed,
  KickoffReadinessError,
  roadmapReadinessHasBlockers,
  type RoadmapReadinessInputs,
} from "@lca/shared";
import { gatherRoadmapReadinessInputs } from "../packages/daemon/src/roadmap/readiness.ts";

const GATHER_BOUNDS = { maxBytes: 10_000_000, maxEntries: 10_000 };

// docs/roadmap/ is private and not exported; the two self-index tests below
// are skipped on the public snapshot.
const REPO_INDEX_PATH = join(process.cwd(), "docs/roadmap/00-index.md");
const HAS_REPO_INDEX = existsSync(REPO_INDEX_PATH);
const REPO_INDEX = HAS_REPO_INDEX ? readFileSync(REPO_INDEX_PATH, "utf8") : null;

const READY_INDEX = readFileSync(
  join(
    process.cwd(),
    "tests/fixtures/roadmap-corpus/ready-max-native/docs/roadmap/00-index.md"
  ),
  "utf8"
);

const MALFORMED_INDEX = readFileSync(
  join(
    process.cwd(),
    "tests/fixtures/roadmap-corpus/malformed-ignored/docs/roadmap/00-index.md"
  ),
  "utf8"
);

const PER_PERSON_INDEX = readFileSync(
  join(
    process.cwd(),
    "tests/fixtures/roadmap-corpus/per-person/docs/roadmap/00-index.md"
  ),
  "utf8"
);

const PRIORITY_TABLES_INDEX = readFileSync(
  join(
    process.cwd(),
    "tests/fixtures/roadmap-corpus/priority-tables/docs/roadmap/00-index.md"
  ),
  "utf8"
);

const PRIORITY_TABLES_CHILDREN: RoadmapReadinessInputs["roadmapChildren"] = [
  { name: "b-xy57-dual.md", kind: "file" },
  { name: "b-xy58-thin-feature", kind: "dir" },
];

function baseInputs(
  overrides: Partial<RoadmapReadinessInputs> = {}
): RoadmapReadinessInputs {
  return {
    gitRepo: true,
    indexMarkdown: null,
    roadmapChildren: [],
    trackerMarkdownBySlug: {},
    candidateFiles: [],
    ...overrides,
  };
}

describe("analyzeRoadmapReadiness", () => {
  it.skipIf(!HAS_REPO_INDEX)("reports the repository own index as ready with zero findings", () => {
    const inputs = gatherRoadmapReadinessInputs(process.cwd(), GATHER_BOUNDS);
    const report = analyzeRoadmapReadiness(inputs);
    expect(report.state).toBe("ready");
    expect(report.findings).toEqual([]);
    expect(roadmapReadinessHasBlockers(report)).toBe(false);
  });

  it.skipIf(!HAS_REPO_INDEX)("does not flag Agent Lookup or arc-order prose tables", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: REPO_INDEX!,
        roadmapChildren: listRepoRoadmapChildren(),
      })
    );
    expect(
      report.findings.filter((f) => f.code === "ignored-section-ids")
    ).toEqual([]);
  });

  it("reports empty when there is no index and no candidates", () => {
    const report = analyzeRoadmapReadiness(baseInputs({ gitRepo: true }));
    expect(report.state).toBe("empty");
    expect(report.findings.some((f) => f.code === "not-git-repo")).toBe(false);
  });

  it("reports adoptable when only conventional backlog files exist", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        candidateFiles: [
          {
            path: "ROADMAP.md",
            mtime: 1_700_000_000_000,
            estimatedItems: 40,
          },
        ],
      })
    );
    expect(report.state).toBe("adoptable");
    expect(report.findings.some((f) => f.code === "ignored-backlog-file")).toBe(
      true
    );
  });

  it("reports ready for a minimal Max-native index", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: READY_INDEX,
        roadmapChildren: [
          { name: "b41-shipped", kind: "dir" },
          { name: "b40-idea.md", kind: "file" },
        ],
      })
    );
    expect(report.state).toBe("ready");
    expect(report.findings.some((f) => f.code === "format-violation")).toBe(
      false
    );
    expect(report.features.some((f) => f.id === "b42" && f.kind === "derived")).toBe(
      true
    );
  });

  it("reports only P-table-only ids in ignored-section-ids on priority-table index", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: PRIORITY_TABLES_INDEX,
        roadmapChildren: PRIORITY_TABLES_CHILDREN,
      })
    );
    const ignored = report.findings.filter((f) => f.code === "ignored-section-ids");
    expect(ignored).toHaveLength(1);
    expect(ignored[0]!.featureIds).toEqual(["b22", "b23"]);
    expect(() =>
      assertKickoffReadinessAllowed(report, {
        kind: "feature-id",
        featureId: "b-xy57",
      })
    ).not.toThrow();
    try {
      assertKickoffReadinessAllowed(report, {
        kind: "feature-id",
        featureId: "b22",
      });
      expect.fail("expected kickoff refusal for P-table-only id");
    } catch (err) {
      expect(err).toBeInstanceOf(KickoffReadinessError);
      expect((err as Error).message).toMatch(/appear only in sections Max ignores/i);
    }
  });

  it("surfaces ignored-section ids and duplicate rows", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: MALFORMED_INDEX,
        roadmapChildren: [{ name: "b97-visible.md", kind: "file" }],
      })
    );
    expect(report.findings.some((f) => f.code === "ignored-section-ids")).toBe(
      true
    );
    expect(report.findings.some((f) => f.featureIds?.includes("b99"))).toBe(
      true
    );
    const duplicate = report.findings.find((f) => f.code === "duplicate-entry");
    expect(duplicate?.impact).toBe("info");
    expect(duplicate?.message).toMatch(/b98 more than once in ## Completed; Max uses the first row/);
    expect(report.findings.some((f) => f.code === "format-violation")).toBe(
      true
    );
    expect(report.findings.some((f) => f.featureIds?.includes("x99"))).toBe(
      true
    );
    expect(report.features.filter((f) => f.id === "b98")).toHaveLength(1);
    expect(report.state).toBe("adoptable");
    expect(roadmapReadinessHasBlockers(report)).toBe(true);
    expect(() =>
      assertKickoffReadinessAllowed(report, { kind: "feature-id", featureId: "b98" })
    ).not.toThrow();
  });

  it("lists each cross-section id once via canonical section priority", () => {
    const dualSectionIndex = `# Roadmap

<!-- next: b99 -->

## Backlog

- **b40** Backlog copy — no link.

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
| b54 | Completed copy | Done | — |

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
| b54 | Documented copy | Planned | — |
| b40 | Idea copy | Planned | — |
`;
    const report = analyzeRoadmapReadiness(
      baseInputs({ indexMarkdown: dualSectionIndex })
    );
    const b54 = report.features.filter((f) => f.id === "b54");
    expect(b54).toHaveLength(1);
    expect(b54[0]!.section).toBe("documented-ideas");
    const b40 = report.features.filter((f) => f.id === "b40");
    expect(b40).toHaveLength(1);
    expect(b40[0]!.section).toBe("backlog");
    expect(report.findings.some((f) => f.code === "duplicate-entry")).toBe(
      false
    );
  });

  it("notes same-section extras after a cross-section row without blocking", () => {
    const index = `# Roadmap

<!-- next: b99 -->

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
| b54 | Completed copy | Done | — |

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
| b54 | Documented copy | Planned | — |
| b54 | Documented extra | Planned | — |
`;
    const report = analyzeRoadmapReadiness(baseInputs({ indexMarkdown: index }));
    const duplicate = report.findings.find(
      (f) => f.code === "duplicate-entry" && f.featureIds?.includes("b54")
    );
    expect(duplicate?.impact).toBe("info");
    const b54 = report.features.filter((f) => f.id === "b54");
    expect(b54).toHaveLength(1);
    expect(b54[0]!.section).toBe("documented-ideas");
    expect(roadmapReadinessHasBlockers(report)).toBe(false);
  });

  it("accepts per-person ids without a declaration and flags --idea refusal", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: PER_PERSON_INDEX,
        roadmapChildren: [{ name: "b-xy58-thin-feature.md", kind: "file" }],
      })
    );
    expect(
      report.findings.some((f) => f.code === "format-violation")
    ).toBe(false);
    expect(
      report.findings.some((f) => f.code === "per-person-next-marker")
    ).toBe(true);
    expect(report.features.some((f) => f.id === "b-xy58")).toBe(true);
    expect(report.findings.some((f) => f.code === "epics-present")).toBe(true);
  });

  it("flags non-git workspaces as blocks-all", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        gitRepo: false,
        indexMarkdown: READY_INDEX,
      })
    );
    expect(report.findings.some((f) => f.code === "not-git-repo")).toBe(true);
    expect(roadmapReadinessHasBlockers(report)).toBe(true);
  });

  it("flags truncated index input as blocks-all", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: READY_INDEX,
        indexTruncated: true,
      })
    );
    expect(report.findings.some((f) => f.code === "index-truncated")).toBe(true);
  });

  it("flags missing and duplicate next-id markers as idea-only", () => {
    const missing = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: `# Roadmap

## Backlog

- **b42** Ready feature — no folder yet.
`,
      })
    );
    expect(missing.findings.some((f) => f.code === "missing-next-marker")).toBe(
      true
    );
    expect(missing.state).toBe("ready");

    const duplicate = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b99 -->
<!-- next: b100 -->

## Backlog

- **b42** Ready feature — no folder yet.
`,
      })
    );
    expect(
      duplicate.findings.some((f) => f.code === "duplicate-next-marker")
    ).toBe(true);
    expect(duplicate.state).toBe("ready");
  });

  it("flags declared-template violations without scanning id-less bullets", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b99 -->
<!-- id-format: b<n> -->

## Backlog

- **b-xy58** Per-person id under a plain declaration.
- Ship an unlabeled follow-up without an id.
`,
      })
    );
    expect(report.findings.some((f) => f.code === "format-violation")).toBe(
      true
    );
    expect(report.findings.some((f) => f.featureIds?.includes("b-xy58"))).toBe(
      true
    );
    expect(report.state).toBe("adoptable");
  });

  it("flags truncated trackers, ambiguous files, and symlink candidates", () => {
    const truncated = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: READY_INDEX,
        roadmapChildren: [{ name: "b41-shipped", kind: "dir" }],
        trackerTruncatedSlugs: ["b41-shipped"],
      })
    );
    expect(truncated.findings.some((f) => f.code === "tracker-truncated")).toBe(
      true
    );

    const ambiguous = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b99 -->

## Backlog

- **b11** Ambiguous files.
`,
        roadmapChildren: [
          { name: "b11-alpha.md", kind: "file" },
          { name: "b11-beta.md", kind: "file" },
        ],
      })
    );
    expect(ambiguous.findings.some((f) => f.code === "ambiguous-slug")).toBe(
      true
    );
    expect(ambiguous.features.some((f) => f.kind === "ambiguous")).toBe(true);

    const symlink = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b99 -->

## Backlog

- **b50** Symlink feature.
`,
        roadmapChildren: [{ name: "b50-link-slug", kind: "symlink" }],
      })
    );
    expect(symlink.findings.some((f) => f.code === "symlink-candidate")).toBe(
      true
    );
    expect(symlink.features.some((f) => f.kind === "blocked")).toBe(true);
  });

  it("maps bad-tracker-header message and fix from parser error code", () => {
    const missingLinkTracker = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 — First | [first]( ) | Pending | — | — |
`;
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b99 -->

## Backlog

- **b55** Missing link — [docs](./b55-missing-link/00-index.md)
`,
        roadmapChildren: [{ name: "b55-missing-link", kind: "dir" }],
        trackerMarkdownBySlug: {
          "b55-missing-link": missingLinkTracker,
        },
      })
    );

    const finding = report.findings.find((f) => f.code === "bad-tracker-header");
    expect(finding?.message).toContain("Max cannot read:");
    expect(finding?.message).toContain("missing a linked file");
    expect(finding?.fix).toMatch(/phase file/i);
    expect(finding?.fixable_by).toBe("agent");
  });
});

function listRepoRoadmapChildren(): RoadmapReadinessInputs["roadmapChildren"] {
  const roadmapDir = join(process.cwd(), "docs/roadmap");
  return readdirSync(roadmapDir).map((name) => {
    const full = join(roadmapDir, name);
    const kind = statSync(full).isDirectory() ? ("dir" as const) : ("file" as const);
    return { name, kind };
  });
}

