import { describe, expect, it } from "vitest";
import {
  filterRoadmapFeatures,
  parseRoadmapFeatures,
} from "../packages/dashboard/src/roadmapFeatures.ts";

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

describe("parseRoadmapFeatures", () => {
  it("tags bullets under ## Backlog (prioritized) as backlog", () => {
    const features = parseRoadmapFeatures(NBBA_STYLE_INDEX);
    const b67 = features.find((f) => f.id === "b67");
    expect(b67).toEqual({
      id: "b67",
      title: "Include playoff games in player GP / season totals",
      section: "backlog",
    });
    expect(
      filterRoadmapFeatures(features, "").some((f) => f.id === "b67")
    ).toBe(true);
  });
});
