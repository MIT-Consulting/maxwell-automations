import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRoadmapReadiness,
  ROADMAP_DIR,
  type RoadmapReadinessInputs,
} from "@lca/shared";
import {
  analyzeWorkspaceRoadmapReadiness,
  gatherRoadmapReadinessInputs,
} from "../packages/daemon/src/roadmap/readiness.ts";

const GATHER_BOUNDS = { maxBytes: 10_000_000, maxEntries: 10_000 };

// docs/roadmap/ is private and not exported; the self-repository check below
// is skipped on the public snapshot.
const HAS_REPO_INDEX = existsSync(
  join(process.cwd(), ROADMAP_DIR, "00-index.md")
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

function makeTempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "b90-readiness-"));
  mkdirSync(join(root, ROADMAP_DIR), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  return root;
}

describe("b90 readiness candidate rules", () => {
  it("skips index-linked docs/roadmap single-doc plans (D2)", () => {
    const root = makeTempWorkspace();
    try {
      writeFileSync(
        join(root, ROADMAP_DIR, "00-index.md"),
        `# Roadmap

<!-- next: b99 -->

## Backlog

- **b23** Remote daemon — [detailed plan](./b23-remote-daemon-on-server.md)
`,
        "utf8"
      );
      writeFileSync(
        join(root, ROADMAP_DIR, "b23-remote-daemon-on-server.md"),
        `# b23 plan

## Backlog

- **b23** work item
`,
        "utf8"
      );

      const inputs = gatherRoadmapReadinessInputs(root, GATHER_BOUNDS);
      expect(
        inputs.candidateFiles.some(
          (c) => c.path === `${ROADMAP_DIR}/b23-remote-daemon-on-server.md`
        )
      ).toBe(false);

      const report = analyzeRoadmapReadiness(inputs);
      expect(
        report.findings.filter((f) => f.code === "ignored-backlog-file")
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still reports unlinked docs/roadmap stray with backlog heading (D2/D3)", () => {
    const root = makeTempWorkspace();
    try {
      writeFileSync(
        join(root, ROADMAP_DIR, "00-index.md"),
        `# Roadmap

<!-- next: b99 -->

## Backlog

- **b42** Ready feature — no folder yet.
`,
        "utf8"
      );
      writeFileSync(
        join(root, ROADMAP_DIR, "stray.md"),
        `# Stray backlog

## Backlog

- **b99** Unlinked item
`,
        "utf8"
      );

      const inputs = gatherRoadmapReadinessInputs(root, GATHER_BOUNDS);
      const report = analyzeRoadmapReadiness(inputs);
      expect(
        report.findings.some(
          (f) =>
            f.code === "ignored-backlog-file" &&
            f.path === `${ROADMAP_DIR}/stray.md`
        )
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat docs/*.md with ids-only head as candidates (D3)", () => {
    const root = makeTempWorkspace();
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(
        join(root, ROADMAP_DIR, "00-index.md"),
        `# Roadmap

<!-- next: b99 -->

## Backlog

- **b42** Ready feature — no folder yet.
`,
        "utf8"
      );
      writeFileSync(
        join(root, "docs", "some-format.md"),
        `# Format reference

- **b1** First
- **b2** Second
- **b3** Third
`,
        "utf8"
      );

      const inputs = gatherRoadmapReadinessInputs(root, GATHER_BOUNDS);
      expect(inputs.candidateFiles.some((c) => c.path === "docs/some-format.md")).toBe(
        false
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits one bad-tracker-header per slug with fixable_by agent (D4/D6)", () => {
    const badTracker = `# Feature

## Phases

| Phase | File | Status | Commit |
| --- | --- | --- | --- |
| 1 | [01-a.md](./01-a.md) | Pending | |
`;
    const report = analyzeRoadmapReadiness(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b99 -->

## Backlog

- **b17** First — [docs](./b17-sdk-ui-context-handoff/00-index.md)

## Documented Ideas

- **b17** Second — [docs](./b17-sdk-ui-context-handoff/00-index.md)
`,
        roadmapChildren: [{ name: "b17-sdk-ui-context-handoff", kind: "dir" }],
        trackerMarkdownBySlug: {
          "b17-sdk-ui-context-handoff": badTracker,
        },
      })
    );

    const trackerFindings = report.findings.filter(
      (f) => f.code === "bad-tracker-header"
    );
    expect(trackerFindings).toHaveLength(1);
    expect(trackerFindings[0]?.fixable_by).toBe("agent");
    expect(trackerFindings[0]?.fix).toContain("Depends on");
    expect(trackerFindings[0]?.featureIds).toEqual(
      expect.arrayContaining(["b17"])
    );
  });

  it.skipIf(!HAS_REPO_INDEX)("gather+analyze on this repository is ready with zero findings (e)", () => {
    const report = analyzeWorkspaceRoadmapReadiness(process.cwd(), GATHER_BOUNDS);
    expect(report.state).toBe("ready");
    expect(report.findings).toEqual([]);
  });
});
