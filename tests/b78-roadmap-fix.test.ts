import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRoadmapReadiness,
  buildRoadmapFixPlanDraft,
  isAdditiveRoadmapEdit,
  ROADMAP_INDEX_REL,
  type RoadmapReadinessInputs,
} from "@lca/shared";
import {
  applyRoadmapFixPlan,
  decideRoadmapFixWrite,
  formatRoadmapUnifiedDiff,
  hashRoadmapFileContent,
  isRoadmapFixAffirmative,
  type RoadmapFixPlan,
} from "../packages/cli/src/roadmap.ts";

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

function planFrom(
  workspaceRoot: string,
  baseContent: string,
  proposedContent: string,
  relativePath = ROADMAP_INDEX_REL
): RoadmapFixPlan {
  return {
    workspaceId: "ws-test",
    relativePath,
    baseContent,
    proposedContent,
    contentHash: hashRoadmapFileContent(baseContent),
  };
}

describe("b78 roadmap fix plan", () => {
  it("adds a plain next marker without rewriting existing backlog ids", () => {
    const base = `# Roadmap

## Backlog

- **b42** Ready feature — no folder yet.
`;
    const draft = buildRoadmapFixPlanDraft(baseInputs({ indexMarkdown: base }));
    expect(draft.kind).toBe("ready");
    if (draft.kind !== "ready") return;
    expect(draft.proposedContent).toContain("<!-- next: b43 -->");
    expect(draft.proposedContent).toContain("- **b42** Ready feature — no folder yet.");
    expect(isAdditiveRoadmapEdit(draft.baseContent, draft.proposedContent)).toBe(
      true
    );
  });

  it("adds missing canonical section scaffolds", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap
`,
      })
    );
    expect(draft.kind).toBe("ready");
    if (draft.kind !== "ready") return;
    expect(draft.proposedContent).toContain("## Backlog");
    expect(draft.proposedContent).toContain("## Completed");
    expect(draft.proposedContent).toContain("## Documented Ideas");
    expect(draft.proposedContent).toContain("<!-- next: b1 -->");
    expect(isAdditiveRoadmapEdit(draft.baseContent, draft.proposedContent)).toBe(
      true
    );
  });

  it("assigns b1…bn then next: b(n+1) for id-less backlog bullets", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap

## Backlog

- Ship telemetry
- Add doctor report
`,
      })
    );
    expect(draft.kind).toBe("ready");
    if (draft.kind !== "ready") return;
    expect(draft.proposedContent).toContain("- **b1** Ship telemetry");
    expect(draft.proposedContent).toContain("- **b2** Add doctor report");
    expect(draft.proposedContent).toContain("<!-- next: b3 -->");
    expect(isAdditiveRoadmapEdit(draft.baseContent, draft.proposedContent)).toBe(
      true
    );
  });

  it("inserts a self-consistent id-format declaration for non-default ids", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap

## Backlog

- **tk1** First
- **tk2** Second
`,
      })
    );
    expect(draft.kind).toBe("ready");
    if (draft.kind !== "ready") return;
    expect(draft.proposedContent).toContain("<!-- id-format: tk<n> -->");
    expect(draft.proposedContent).not.toMatch(/<!-- next: b\d+ -->/);
    expect(isAdditiveRoadmapEdit(draft.baseContent, draft.proposedContent)).toBe(
      true
    );
  });

  it("refuses duplicate next markers instead of rewriting them", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b1 -->
<!-- next: b2 -->

## Backlog
`,
      })
    );
    expect(draft.kind).toBe("refused");
    if (draft.kind !== "refused") return;
    expect(draft.message).toMatch(/Duplicate next-id markers/);
  });

  it("skips plain next marker when per-person markers are present", () => {
    const inputs = baseInputs({
      indexMarkdown: `# Roadmap

<!-- next: b-dm58 -->

## Backlog
`,
    });
    const draft = buildRoadmapFixPlanDraft(inputs);
    expect(draft.kind).not.toBe("refused");
    expect(draft.kind).toBe("noop");
    if (draft.kind !== "noop") return;
    const report = analyzeRoadmapReadiness(inputs);
    if (report.findings.length === 0) {
      expect(draft.message).toBe("No CLI-fixable roadmap changes.");
    } else {
      expect(draft.message).toBe(
        `No automatic edits available. ${report.findings.length} finding(s) need an agent or a person — see max doctor <workspace>.`
      );
    }
  });

  it("adds canonical sections without inserting a plain next marker beside per-person markers", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b-xy57 -->
<!-- next: b-qr58 -->
`,
      })
    );
    expect(draft.kind).toBe("ready");
    if (draft.kind !== "ready") return;
    expect(draft.proposedContent).toMatch(/## Backlog/);
    expect(draft.proposedContent).toMatch(/## Completed/);
    expect(draft.proposedContent).toMatch(/## Documented Ideas/);
    expect(draft.proposedContent).not.toMatch(/<!-- next: b\d+ -->/);
    expect(
      isAdditiveRoadmapEdit(draft.baseContent, draft.proposedContent)
    ).toBe(true);
  });

  it("refuses truncated index reads", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap

## Backlog
`,
        indexTruncated: true,
      })
    );
    expect(draft.kind).toBe("refused");
    if (draft.kind !== "refused") return;
    expect(draft.message).toMatch(/read limit/);
  });

  it("refuses when no index exists", () => {
    const draft = buildRoadmapFixPlanDraft(baseInputs());
    expect(draft.kind).toBe("refused");
    if (draft.kind !== "refused") return;
    expect(draft.message).toMatch(/roadmap init/);
  });

  it("refuses malformed user id-format declarations", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- id-format: b.*<n> -->

## Backlog
`,
      })
    );
    expect(draft.kind).toBe("refused");
  });

  it("does not assign ids when some already exist", () => {
    const draft = buildRoadmapFixPlanDraft(
      baseInputs({
        indexMarkdown: `# Roadmap

<!-- next: b2 -->

## Backlog

- **b1** Already numbered
- leftover prose
`,
      })
    );
    expect(draft.kind).toBe("noop");
  });

  it("returns noop when nothing is auto-fixable", () => {
    const inputs = baseInputs({
      indexMarkdown: `# Roadmap

<!-- next: b99 -->

## Backlog

- **b42** Ready feature — no folder yet.

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
`,
    });
    const draft = buildRoadmapFixPlanDraft(inputs);
    expect(draft.kind).toBe("noop");
    if (draft.kind !== "noop") return;
    const report = analyzeRoadmapReadiness(inputs);
    if (report.findings.length === 0) {
      expect(draft.message).toBe("No CLI-fixable roadmap changes.");
    } else {
      expect(draft.message).toBe(
        `No automatic edits available. ${report.findings.length} finding(s) need an agent or a person — see max doctor <workspace>.`
      );
    }
  });
});

describe("b78 roadmap fix write gate", () => {
  it("applies with --yes even without a TTY", () => {
    expect(decideRoadmapFixWrite({ yes: true, tty: false })).toEqual({
      action: "apply",
    });
  });

  it("refuses non-TTY without --yes", () => {
    const gate = decideRoadmapFixWrite({ yes: false, tty: false });
    expect(gate.action).toBe("need-yes");
  });

  it("requires confirmation on a TTY without --yes", () => {
    expect(decideRoadmapFixWrite({ yes: false, tty: true })).toEqual({
      action: "confirm",
    });
  });

  it("treats only y/yes as affirmative so cancel leaves files untouched", () => {
    expect(isRoadmapFixAffirmative("y")).toBe(true);
    expect(isRoadmapFixAffirmative("Yes")).toBe(true);
    expect(isRoadmapFixAffirmative("n")).toBe(false);
    expect(isRoadmapFixAffirmative("")).toBe(false);
  });
});

describe("b78 roadmap fix apply", () => {
  it("writes after stale-write guard passes and refuses stale content", () => {
    const dir = mkdtempSync(join(tmpdir(), "b78-fix-"));
    try {
      const rel = ROADMAP_INDEX_REL;
      const indexPath = join(dir, ...rel.split("/"));
      mkdirSync(join(dir, "docs", "roadmap"), { recursive: true });
      const live = `# Roadmap

## Backlog
`;
      writeFileSync(indexPath, live, "utf8");
      const proposed = `# Roadmap

<!-- next: b1 -->

## Backlog

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
`;
      const plan = planFrom(dir, live, proposed);

      const diff = formatRoadmapUnifiedDiff(rel, live, proposed);
      expect(diff).toContain("+<!-- next: b1 -->");

      const applied = applyRoadmapFixPlan(dir, plan);
      expect(applied.ok).toBe(true);
      expect(readFileSync(indexPath, "utf8")).toContain("<!-- next: b1 -->");

      writeFileSync(indexPath, "# mutated\n", "utf8");
      const stale = applyRoadmapFixPlan(dir, plan);
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.code).toBe("stale");
      expect(readFileSync(indexPath, "utf8")).toBe("# mutated\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies id assignment and preserves CRLF", () => {
    const dir = mkdtempSync(join(tmpdir(), "b78-fix-crlf-"));
    try {
      const rel = ROADMAP_INDEX_REL;
      const indexPath = join(dir, ...rel.split("/"));
      mkdirSync(join(dir, "docs", "roadmap"), { recursive: true });
      const live = "# Roadmap\r\n\r\n## Backlog\r\n\r\n- Ship telemetry\r\n";
      writeFileSync(indexPath, live, "utf8");
      const draft = buildRoadmapFixPlanDraft(baseInputs({ indexMarkdown: live }));
      expect(draft.kind).toBe("ready");
      if (draft.kind !== "ready") return;
      const applied = applyRoadmapFixPlan(dir, {
        workspaceId: "ws-test",
        relativePath: draft.relativePath,
        baseContent: draft.baseContent,
        proposedContent: draft.proposedContent,
        contentHash: hashRoadmapFileContent(live),
      });
      expect(applied.ok).toBe(true);
      const written = readFileSync(indexPath, "utf8");
      expect(written).toContain("\r\n");
      expect(written).toContain("- **b1** Ship telemetry");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates missing docs/roadmap parents for an approved empty-base plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "b78-fix-parents-"));
    try {
      const proposed = `# Roadmap

<!-- next: b1 -->

## Backlog
`;
      const applied = applyRoadmapFixPlan(
        dir,
        planFrom(dir, "", proposed)
      );
      expect(applied.ok).toBe(true);
      expect(
        readFileSync(join(dir, "docs", "roadmap", "00-index.md"), "utf8")
      ).toContain("<!-- next: b1 -->");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses path escape and leaves the workspace untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "b78-fix-escape-"));
    try {
      mkdirSync(join(dir, "docs", "roadmap"), { recursive: true });
      const indexPath = join(dir, "docs", "roadmap", "00-index.md");
      writeFileSync(indexPath, "# keep\n", "utf8");
      const escaped = applyRoadmapFixPlan(
        dir,
        planFrom(dir, "# keep\n", "# other\n", "../outside.md")
      );
      expect(escaped.ok).toBe(false);
      if (escaped.ok) return;
      expect(escaped.code).toBe("unsafe-path");
      expect(readFileSync(indexPath, "utf8")).toBe("# keep\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns write-failed when parents cannot be created and keeps the blocker", () => {
    const dir = mkdtempSync(join(tmpdir(), "b78-fix-write-"));
    try {
      writeFileSync(join(dir, "docs"), "not-a-directory", "utf8");
      const proposed = `# Roadmap

<!-- next: b1 -->
`;
      const failed = applyRoadmapFixPlan(dir, planFrom(dir, "", proposed));
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.code).toBe("write-failed");
      expect(readFileSync(join(dir, "docs"), "utf8")).toBe("not-a-directory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-additive rewrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "b78-fix-rewrite-"));
    try {
      mkdirSync(join(dir, "docs", "roadmap"), { recursive: true });
      const live = "# keep me\n";
      const indexPath = join(dir, "docs", "roadmap", "00-index.md");
      writeFileSync(indexPath, live, "utf8");
      const refused = applyRoadmapFixPlan(
        dir,
        planFrom(dir, live, "# replaced\n")
      );
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("not-additive");
      expect(readFileSync(indexPath, "utf8")).toBe(live);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
