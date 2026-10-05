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

const B29_TRACKER_PATH = join(
  process.cwd(),
  "docs/roadmap/done/b29-file-viewer-deep-links/00-index.md"
);
const B29_TRACKER = existsSync(B29_TRACKER_PATH)
  ? readFileSync(B29_TRACKER_PATH, "utf8")
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

  it("parses five-column bare phase numbers", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| 1 | [01-docs-migration.md](./01-docs-migration.md) | Done | — | |
| 2 | [02-publish-pr.md](./02-publish-pr.md) | Pending | 1 | |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.phases[0]).toMatchObject({
      number: 1,
      title: "",
      status: "Done",
      dependsOn: [],
      file: "./01-docs-migration.md",
    });
    expect(parsed.phases[1]).toMatchObject({
      number: 2,
      dependsOn: ["1"],
      status: "Pending",
    });
    expect(parsed.nextExecutable).toEqual({ number: 2, status: "Pending" });
  });

  it("parses numbered, P-prefixed, and Phase-prefixed phase cells", () => {
    const markdown = `# Feature

| Phase | File | Status | Commit |
| --- | --- | --- | --- |
| 1. Player playoff aggregates | [01-a.md](./01-a.md) | Complete | abc |
| P2 — League history + timeline | [02-b.md](./02-b.md) | In Progress | |
| Phase 3: Route engine | [03-c.md](./03-c.md) | Pending | |
| P0 — Shared slot library | [00-d.md](./00-d.md) | Pending | |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases.map((p) => [p.number, p.title])).toEqual([
      [1, "Player playoff aggregates"],
      [2, "League history + timeline"],
      [3, "Route engine"],
      [0, "Shared slot library"],
    ]);
    expect(parsed.nextExecutable).toEqual({ number: 2, status: "In Progress" });
  });

  it("reads P-prefixed dependencies and rows without a file", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| P0 - Shared slot library | [00-slot-library.md](./00-slot-library.md) | Done (this pass) | - | |
| P1 - Studio occupies pool | - | Done | P0 | |
| P2 - Curveball well | - | Pending | P1, Phase 0 | |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases.map((p) => [p.number, p.file, p.dependsOn])).toEqual([
      [0, "./00-slot-library.md", []],
      [1, "", ["0"]],
      [2, "", ["1", "0"]],
    ]);
    expect(parsed.nextExecutable).toEqual({ number: 2, status: "Pending" });
  });

  it("reports a phase cell it cannot read with its own code", () => {
    const markdown = `# Feature

| Phase | File | Status | Depends on | Commit |
| --- | --- | --- | --- | --- |
| Kickoff | [01-a.md](./01-a.md) | Pending | — | |
`;
    try {
      parseRoadmapTracker(markdown);
      expect.fail("expected malformed-phase");
    } catch (err) {
      expect((err as RoadmapTrackerError).code).toBe("malformed-phase");
      expect((err as RoadmapTrackerError).message).toMatch(/phase cell "Kickoff"/);
    }
  });

  it("parses four-column status-with-note trackers", () => {
    const markdown = `# Feature

| Phase | File | Status | Commit |
| --- | --- | --- | --- |
| 1 | Upstream schema (DDL) | In Progress — applied to staging; prod pending | — |
| 2 | EF mapping (entities + \`ApplicationDbContext\`) | Complete — verified against staging | — |
| 3 | [03.md](./03.md) | Pending: waiting on upstream | — |
| 4 | [04.md](./04.md) | Done (blocked by review) | — |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases[0]).toMatchObject({
      number: 1,
      status: "In Progress",
      dependsOn: [],
      file: "Upstream schema (DDL)",
    });
    expect(parsed.phases[1]).toMatchObject({
      number: 2,
      status: "Complete",
      dependsOn: [],
    });
    expect(parsed.phases[2]!.status).toBe("Pending");
    expect(parsed.phases[3]!.status).toBe("Done");
    expect(parsed.nextExecutable).toEqual({ number: 1, status: "In Progress" });
  });

  it("accepts case-insensitive five-column headers", () => {
    const markdown = `# Feature

| phase | file | status | depends on | commit |
| --- | --- | --- | --- | --- |
| 1 — First | [01.md](./01.md) | Pending | — | |
`;
    const parsed = parseRoadmapTracker(markdown);
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0]!.number).toBe(1);
  });

  it("rejects unknown statuses and malformed headers", () => {
    const emptyFourColumn = `# Feature

| Phase | File | Status | Commit |
| --- | --- | --- | --- |
`;
    const parsed = parseRoadmapTracker(emptyFourColumn);
    expect(parsed.phases).toEqual([]);

    expect(() =>
      parseRoadmapTracker(`| Phase | File | Status |
| --- | --- | --- |`)
    ).toThrow(RoadmapTrackerError);
    try {
      parseRoadmapTracker(`| Phase | File | Status |
| --- | --- | --- |`);
    } catch (err) {
      expect((err as RoadmapTrackerError).code).toBe("misordered-header");
    }

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

  it.skipIf(B29_TRACKER === null)(
    "parses the b29 four-column tracker with titled phase cells",
    () => {
      const parsed = parseRoadmapTracker(B29_TRACKER!);
      expect(parsed.phases.length).toBeGreaterThanOrEqual(4);
      expect(parsed.nextExecutable).toBeNull();
    }
  );

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
| 1 — First | [first]( ) | Pending | — | — |
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
