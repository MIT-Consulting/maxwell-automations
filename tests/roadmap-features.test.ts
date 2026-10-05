import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterRoadmapFeatures,
  mergeReadinessDisabledFeatures,
  parseRoadmapFeatures,
} from "../packages/dashboard/src/roadmapFeatures.ts";
import type { RoadmapReadinessReport } from "@lca/shared";
import { analyzeRoadmapReadiness, parseRoadmapIndex } from "@lca/shared";

const PRIORITY_TABLES_INDEX = readFileSync(
  join(
    process.cwd(),
    "tests/fixtures/roadmap-corpus/priority-tables/docs/roadmap/00-index.md"
  ),
  "utf8"
);

const NBBA_STYLE_INDEX = `# Roadmap

<!-- next: b68 -->

## Documented Ideas

| ID | Idea | Status | File |
| --- | -------------------------- | -------- | ---- |
| b21 | Commercialization discovery | Planned | [x](./commercial.md) |

## Backlog (prioritized)

### P3 — Public-Facing & Data

- **b67** Include playoff games in player GP / season totals — count final playoff boxes.

## Completed

| ID | Feature | Description | Docs |
| --- | -------------------------- | ----------- | ---- |
| b65 | Team pages | Roster and schedule | [docs](./done/b65-team-pages/00-index.md) |
`;

const PER_PERSON_FIXTURE_INDEX = `# Roadmap

<!-- next: b-xy64 -->
<!-- next: b-qr57 -->

## Documented Ideas

| ID | Idea | Status | File |
| ---- | ---- | ------ | ---- |
| b-xy58 | Thin per-person feature | Planned | [child](./b-xy58-thin-feature.md#child-section) |

## Epics

| ID | Epic | Children |
| --- | ---- | -------- |
| e-xy1 | Parent epic | b-xy58 |

### P1 — Unrelated priority table

| ID | Item | Notes |
| --- | ---- | ----- |
| b99 | Should not appear | ignored |
| p99 | Also ignored | ignored |
`;

describe("parseRoadmapFeatures", () => {
  it("tags bullets under ## Backlog (prioritized) as backlog", () => {
    const features = parseRoadmapFeatures(NBBA_STYLE_INDEX);
    const b67 = features.find((f) => f.id === "b67");
    expect(b67).toEqual({
      id: "b67",
      title: "Include playoff games in player GP / season totals",
      section: "backlog",
      selectable: true,
    });
    expect(
      filterRoadmapFeatures(features, "").some((f) => f.id === "b67")
    ).toBe(true);
  });

  it("does not surface ids from unrelated P-tables", () => {
    const features = parseRoadmapFeatures(PER_PERSON_FIXTURE_INDEX);
    expect(features.some((f) => f.id === "p99")).toBe(false);
    expect(features.some((f) => f.id === "b99")).toBe(false);
  });

  it("prefers Documented Ideas over Completed for picker summaries", () => {
    const markdown = `# Roadmap

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
| b21 | Old completed title | shipped | [x](./old.md) |

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
| b21 | Active idea title | Planned | [x](./new.md) |
`;
    const features = parseRoadmapFeatures(markdown);
    expect(features.find((f) => f.id === "b21")).toMatchObject({
      title: "Active idea title",
      section: "ideas",
      selectable: true,
    });
  });

  it("throws on malformed format declarations instead of returning a partial list", () => {
    expect(() =>
      parseRoadmapFeatures(`# Roadmap
<!-- id-format: b.*<n> -->
`)
    ).toThrow(/regex syntax/i);
  });

  it("keeps the whole list when one id has two rows in the same section", () => {
    const features = parseRoadmapFeatures(`# Roadmap

<!-- next: b60 -->

## Documented Ideas

| ID | Idea | Status | File |
| --- | ---- | ------ | ---- |
| b-xy59 | Hooks service | Planned | [doc](./b-xy59-hooks.md) |

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
| b29 | Observability hookup | first | — |
| b29 | Observability hookup | second row | — |
| b30 | Pending RFIs list | done | — |
`);
    expect(features.map((f) => f.id).sort()).toEqual(["b-xy59", "b29", "b30"]);
    const b29 = features.find((f) => f.id === "b29");
    expect(b29).toMatchObject({ selectable: true, section: "completed" });
  });

  it("lists epics disabled with the resolver refusal reason", () => {
    const features = parseRoadmapFeatures(PER_PERSON_FIXTURE_INDEX);
    const epic = features.find((f) => f.id === "e-xy1");
    expect(epic).toMatchObject({
      id: "e-xy1",
      title: "Parent epic",
      selectable: false,
      disabledReason:
        "e-xy1 is an epic (parent brief), not a feature; kick off one of its children.",
    });
  });

  it("agrees with the shared parser on feature and epic ids", () => {
    const shared = parseRoadmapIndex(PER_PERSON_FIXTURE_INDEX);
    const picker = parseRoadmapFeatures(PER_PERSON_FIXTURE_INDEX);
    const sharedFeatureIds = shared.entries.map((e) => e.featureId).sort();
    const pickerFeatureIds = picker
      .filter((f) => f.selectable)
      .map((f) => f.id)
      .sort();
    expect(pickerFeatureIds).toEqual(sharedFeatureIds);
    expect(picker.some((f) => f.id === "e-xy1" && !f.selectable)).toBe(true);
    expect(shared.epics.map((e) => e.epicId)).toContain("e-xy1");
  });

  it("ranks backlog matches above ideas and completed", () => {
    const features = parseRoadmapFeatures(NBBA_STYLE_INDEX);
    const ranked = filterRoadmapFeatures(features, "b");
    expect(ranked.map((f) => f.id)).toEqual(["b67", "b21", "b65"]);
  });

  it("disables only P-table-only ids from a live readiness report", () => {
    const report = analyzeRoadmapReadiness({
      gitRepo: true,
      indexMarkdown: PRIORITY_TABLES_INDEX,
      roadmapChildren: [
        { name: "b-xy57-dual.md", kind: "file" },
        { name: "b-xy58-thin-feature", kind: "dir" },
      ],
      trackerMarkdownBySlug: {},
      candidateFiles: [],
    });
    const features = parseRoadmapFeatures(PRIORITY_TABLES_INDEX);
    const merged = mergeReadinessDisabledFeatures(features, report);
    expect(merged.find((f) => f.id === "b-xy57")?.selectable).toBe(true);
    expect(merged.find((f) => f.id === "b-xy58")?.selectable).toBe(true);
    expect(merged.find((f) => f.id === "b22")).toMatchObject({
      selectable: false,
      disabledReason: expect.stringMatching(/sections Max ignores/i),
    });
    expect(merged.find((f) => f.id === "b23")).toMatchObject({
      selectable: false,
      disabledReason: expect.stringMatching(/sections Max ignores/i),
    });
  });

  it("adds disabled rows for readiness ignored ids and format violations", () => {
    const features = parseRoadmapFeatures(NBBA_STYLE_INDEX);
    const report: RoadmapReadinessReport = {
      state: "adoptable",
      findings: [
        {
          code: "ignored-section-ids",
          impact: "blocks-some",
          message: "1 feature id(s) appear only in sections Max ignores",
          fix: "Move those ids into ## Backlog.",
          fixable_by: "agent",
          featureIds: ["p99"],
        },
      ],
      features: [],
      candidates: [],
    };
    const merged = mergeReadinessDisabledFeatures(features, report);
    const disabled = merged.find((f) => f.id === "p99");
    expect(disabled?.selectable).toBe(false);
    expect(disabled?.disabledReason).toMatch(/sections Max ignores/i);
    expect(merged.find((f) => f.id === "b65")?.selectable).toBe(true);
  });

  it("keeps epic rows disabled with shared refusal text", () => {
    const features = parseRoadmapFeatures(PER_PERSON_FIXTURE_INDEX);
    const epic = features.find((f) => f.id === "e-xy1");
    expect(epic?.selectable).toBe(false);
    expect(epic?.disabledReason).toMatch(/epic/i);
    const report: RoadmapReadinessReport = {
      state: "ready",
      findings: [
        {
          code: "epics-present",
          impact: "info",
          message: "1 epic(s) are not startable as features",
          fix: "Kick off a child feature.",
          fixable_by: "user",
          featureIds: ["e-xy1"],
        },
      ],
      features: [],
      candidates: [],
    };
    const merged = mergeReadinessDisabledFeatures(features, report);
    expect(merged.find((f) => f.id === "e-xy1")?.selectable).toBe(false);
  });
});
