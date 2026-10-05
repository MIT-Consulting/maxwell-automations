import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRoadmapTracker,
  RoadmapTrackerError,
} from "@lca/shared";

// docs/roadmap/ is private and not exported; the live-tracker test is skipped
// on the public snapshot.
const B77_TRACKER_PATH = join(
  process.cwd(),
  "docs/roadmap/done/b77-backlog-feature-id-format/00-index.md"
);
const B77_TRACKER = existsSync(B77_TRACKER_PATH)
  ? readFileSync(B77_TRACKER_PATH, "utf8")
  : null;

describe("parseRoadmapTracker", () => {
  it.skipIf(B77_TRACKER === null)("parses the b77 five-column tracker including Done status", () => {
    const parsed = parseRoadmapTracker(B77_TRACKER!);
    expect(parsed.phases.length).toBeGreaterThanOrEqual(3);
    expect(parsed.phases.some((p) => p.status === "Done")).toBe(true);
    expect(parsed.nextExecutable).toBeNull();
  });

  it("accepts legacy Complete status", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 — First | [01.md](./01.md) | Complete | — | abc |
| 2 — Second | [02.md](./02.md) | Pending | 1 | — |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases[0]!.status).toBe("Complete");
    expect(parsed.nextExecutable).toEqual({ number: 2, status: "Pending" });
  });

  it("finds In Progress as next executable before Pending", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 — First | [01.md](./01.md) | Done | — | abc |
| 2 — Second | [02.md](./02.md) | In Progress | 1 | — |
| 3 — Third | [03.md](./03.md) | Pending | 2 | — |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.nextExecutable).toEqual({ number: 2, status: "In Progress" });
  });

  it("parses dependency lists", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 2 — Second | [02.md](./02.md) | Pending | 1 | — |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases[0]!.dependsOn).toEqual(["1"]);
  });

  it("rejects duplicate phase numbers", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 — First | [01.md](./01.md) | Pending | — | — |
| 1 — Duplicate | [01b.md](./01b.md) | Pending | — | — |
`;
    expect(() => parseRoadmapTracker(markdown)).toThrow(RoadmapTrackerError);
    try {
      parseRoadmapTracker(markdown);
    } catch (err) {
      expect((err as RoadmapTrackerError).code).toBe("duplicate-phase");
    }
  });

  it("rejects unknown statuses and malformed headers", () => {
    expect(() =>
      parseRoadmapTracker(`| Phase | File | Status | Commit |
| --- | --- | --- | --- |`)
    ).toThrow(RoadmapTrackerError);

    const badStatus = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 — First | [01.md](./01.md) | Queued | — | — |
`;
    expect(() => parseRoadmapTracker(badStatus)).toThrow(RoadmapTrackerError);
    try {
      parseRoadmapTracker(badStatus);
    } catch (err) {
      expect((err as RoadmapTrackerError).code).toBe("unknown-status");
    }
  });

  it("rejects extra headers, missing links, and malformed dependencies", () => {
    try {
      parseRoadmapTracker(`| Phase | File | Status | Depends on | Commit | Extra |
| --- | --- | --- | --- | --- | --- |`);
      expect.fail("expected extra-header");
    } catch (err) {
      expect((err as RoadmapTrackerError).code).toBe("extra-header");
    }

    const missingLink = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 — First | — | Pending | — | — |
`;
    try {
      parseRoadmapTracker(missingLink);
      expect.fail("expected missing-link");
    } catch (err) {
      expect((err as RoadmapTrackerError).code).toBe("missing-link");
    }

    const badDep = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 — First | [01.md](./01.md) | Pending | phase-one | — |
`;
    try {
      parseRoadmapTracker(badDep);
      expect.fail("expected malformed-dependency");
    } catch (err) {
      expect((err as RoadmapTrackerError).code).toBe("malformed-dependency");
    }
  });

  it("treats an empty valid tracker as valid", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |

`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases).toEqual([]);
    expect(parsed.nextExecutable).toBeNull();
  });
});
