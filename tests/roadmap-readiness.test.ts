import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRoadmapReadiness,
  roadmapReadinessHasBlockers,
  type RoadmapReadinessInputs,
} from "@lca/shared";
import { gatherRoadmapReadinessInputs } from "../packages/daemon/src/roadmap/readiness.ts";

const GATHER_BOUNDS = { maxBytes: 10_000_000, maxEntries: 10_000 };

const REPO_INDEX = readFileSync(
  join(process.cwd(), "docs/roadmap/00-index.md"),
  "utf8"
);

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
  it("reports the repository own index as ready with zero findings", () => {
    const inputs = gatherRoadmapReadinessInputs(process.cwd(), GATHER_BOUNDS);
    const report = analyzeRoadmapReadiness(inputs);
    expect(report.state).toBe("ready");
    expect(report.findings).toEqual([]);
    expect(roadmapReadinessHasBlockers(report)).toBe(false);
  });

  it("does not flag Agent Lookup or arc-order prose tables", () => {
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: REPO_INDEX,
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
    expect(report.findings.some((f) => f.code === "duplicate-entry")).toBe(
      true
    );
    expect(report.findings.some((f) => f.code === "format-violation")).toBe(
      true
    );
    expect(report.findings.some((f) => f.featureIds?.includes("x99"))).toBe(
      true
    );
    expect(report.state).toBe("adoptable");
    expect(roadmapReadinessHasBlockers(report)).toBe(true);
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
});

function listRepoRoadmapChildren(): RoadmapReadinessInputs["roadmapChildren"] {
  const roadmapDir = join(process.cwd(), "docs/roadmap");
  return readdirSync(roadmapDir).map((name) => {
    const full = join(roadmapDir, name);
    const kind = statSync(full).isDirectory() ? ("dir" as const) : ("file" as const);
    return { name, kind };
  });
}

