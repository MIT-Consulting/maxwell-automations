import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RoadmapReadinessReport } from "@lca/shared";
import {
  describeKickoffReadinessBlockers,
  describeReadinessSummaryLabel,
  formatPostRegisterReadinessLine,
  formatReadinessFindingLine,
} from "../packages/dashboard/src/roadmapReadinessUi.ts";
import { mergeReadinessDisabledFeatures } from "../packages/dashboard/src/roadmapFeatures.ts";
import { workspaceReadinessSummaryKey } from "../packages/dashboard/src/useRoadmapReadinessSummaries.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

describe("b78 dashboard readiness UI helpers", () => {
  it("labels ready, empty, adoptable, and blocked summaries", () => {
    expect(
      describeReadinessSummaryLabel({
        workspaceId: "ws",
        state: "ready",
        counts: {
          "blocks-all": 0,
          "blocks-some": 0,
          "idea-only": 0,
          info: 0,
        },
      })
    ).toBe("Roadmap ready");

    expect(
      describeReadinessSummaryLabel({
        workspaceId: "ws",
        state: "empty",
        counts: {
          "blocks-all": 0,
          "blocks-some": 0,
          "idea-only": 0,
          info: 0,
        },
      })
    ).toBe("Roadmap empty");

    expect(
      describeReadinessSummaryLabel({
        workspaceId: "ws",
        state: "adoptable",
        counts: {
          "blocks-all": 1,
          "blocks-some": 0,
          "idea-only": 0,
          info: 0,
        },
      })
    ).toBe("Roadmap adoptable, 1 blocker(s)");

    expect(formatPostRegisterReadinessLine({
      workspaceId: "ws",
      state: "ready",
      counts: {
        "blocks-all": 0,
        "blocks-some": 0,
        "idea-only": 0,
        info: 1,
      },
    })).toMatch(/Roadmap readiness:/);

    expect(
      formatReadinessFindingLine({
        code: "per-person-idea",
        impact: "idea-only",
        message: "Per-person idea markers present",
        fix: "Use a canonical feature id instead.",
        fixable_by: "agent",
      })
    ).toBe("Per-person idea markers present");
  });

  it("groups kickoff blockers by impact semantics", () => {
    const report: RoadmapReadinessReport = {
      state: "adoptable",
      findings: [
        {
          code: "not-git-repo",
          impact: "blocks-all",
          message: "Workspace is not a git repository",
          fix: "Run git init in the workspace root.",
          fixable_by: "user",
        },
        {
          code: "ignored-section-ids",
          impact: "blocks-some",
          message: "2 feature id(s) appear only in sections Max ignores",
          fix: "Move those ids into ## Backlog.",
          fixable_by: "agent",
          featureIds: ["b99"],
        },
        {
          code: "per-person-idea",
          impact: "idea-only",
          message: "Per-person idea markers present",
          fix: "Use a canonical feature id instead.",
          fixable_by: "agent",
        },
        {
          code: "epics-present",
          impact: "info",
          message: "1 epic(s) are not startable as features",
          fix: "Kick off one of the epic's child features instead.",
          fixable_by: "user",
        },
      ],
      features: [],
      candidates: [],
    };

    const allBlocked = describeKickoffReadinessBlockers({
      report,
      roadmapIndexPresent: true,
      inputKind: "idea",
      featureId: "",
    });
    expect(allBlocked.blockers.some((line) => /git/i.test(line))).toBe(true);
    expect(allBlocked.blockers).toContain("Per-person idea markers present");
    expect(
      allBlocked.blockers.some((line) => /canonical feature id/i.test(line))
    ).toBe(false);
    expect(allBlocked.notes.some((line) => /epic/i.test(line))).toBe(true);

    const featureScoped = describeKickoffReadinessBlockers({
      report,
      roadmapIndexPresent: true,
      inputKind: "feature-id",
      featureId: "b99",
    });
    expect(featureScoped.blockers.some((line) => /sections Max ignores/i.test(line))).toBe(
      true
    );
    expect(
      featureScoped.blockers.some((line) => /Per-person/i.test(line))
    ).toBe(false);

    const otherFeature = describeKickoffReadinessBlockers({
      report,
      roadmapIndexPresent: true,
      inputKind: "feature-id",
      featureId: "b1",
    });
    expect(otherFeature.blockers.some((line) => /git/i.test(line))).toBe(true);
    expect(
      otherFeature.blockers.some((line) => /sections Max ignores/i.test(line))
    ).toBe(false);

    const missingIndex = describeKickoffReadinessBlockers({
      report: { state: "empty", findings: [], features: [], candidates: [] },
      roadmapIndexPresent: false,
      inputKind: "feature-id",
      featureId: "b1",
    });
    expect(missingIndex.blockers[0]).toMatch(/Missing roadmap index/i);
  });

  it("dedupes summary fetch on stable workspace id keys", () => {
    expect(
      workspaceReadinessSummaryKey(["b", "__global__", "a"])
    ).toBe("a\0b");
    expect(workspaceReadinessSummaryKey(["a"])).toBe(
      workspaceReadinessSummaryKey(["a", "__global__"])
    );

    const src = readSrc("packages/dashboard/src/useRoadmapReadinessSummaries.ts");
    expect(src).toContain("workspaceReadinessSummaryKey");
    expect(src).toContain("getRoadmapReadinessSummaries");
    expect(src).toContain('id !== "__global__"');
    expect(src).toMatch(/}, \[key\]\);/);
    expect(src).not.toContain("prevKeyRef");
    expect(src).not.toContain("[key, workspaceIds]");
  });

  it("wires readiness APIs, badges, and hook from App", () => {
    const api = readSrc("packages/dashboard/src/api.ts");
    expect(api).toContain("getRoadmapReadinessSummaries");
    expect(api).toContain("getWorkspaceRoadmapReadiness");
    expect(api).toContain("/api/roadmap-readiness");

    const app = readSrc("packages/dashboard/src/App.tsx");
    expect(app).toContain("useRoadmapReadinessSummaries");
    expect(app).toContain("roadmapSummaries={roadmapSummaries}");

    const badge = readSrc("packages/dashboard/src/RoadmapReadinessBadge.tsx");
    expect(badge).toContain('aria-label="Roadmap readiness unavailable"');
    expect(badge).toContain("ready");
    expect(badge).toContain("adoptable");
  });

  it("keeps registration when readiness follow-up fails", () => {
    const form = readSrc("packages/dashboard/src/AddWorkspaceForm.tsx");
    expect(form).toContain("api.createWorkspace");
    expect(form).toContain("getRoadmapReadinessSummaries");
    expect(form).toContain("registration stands");
    expect(form).toContain("post-register-readiness");
  });

  it("uses introspection readiness in kickoff without legacy booleans", () => {
    const modal = readSrc("packages/dashboard/src/PipelineKickoffModal.tsx");
    expect(modal).toContain("describeKickoffReadinessBlockers");
    expect(modal).toContain("mergeReadinessDisabledFeatures");
    expect(modal).toContain("pre.roadmapReadiness");
    expect(modal).toContain("disabled={!f.selectable}");
    expect(modal).toContain("whitespace-pre-wrap");
    expect(modal).not.toContain(
      "Workspace is not a git repository (missing .git). Refuse to kick off."
    );
    expect(modal).not.toContain(
      "Missing roadmap index (docs/roadmap/00-index.md). Create it before kicking off."
    );
  });
});

describe("mergeReadinessDisabledFeatures", () => {
  it("marks ignored and invalid ids disabled while keeping completed selectable", () => {
    const base = [
      {
        id: "b65",
        title: "Done feature",
        section: "completed" as const,
        selectable: true,
      },
      {
        id: "b67",
        title: "Backlog feature",
        section: "backlog" as const,
        selectable: true,
      },
    ];
    const report: RoadmapReadinessReport = {
      state: "adoptable",
      findings: [
        {
          code: "ignored-section-ids",
          impact: "blocks-some",
          message: "1 feature id(s) appear only in sections Max ignores",
          fix: "Move those ids into ## Backlog.",
          fixable_by: "agent",
          featureIds: ["b99", "b67"],
        },
        {
          code: "format-violation",
          impact: "blocks-some",
          message: "1 feature id(s) do not match the declared format",
          fix: "Fix ids to match the declared format.",
          fixable_by: "agent",
          featureIds: ["bad-id"],
        },
      ],
      features: [],
      candidates: [],
    };

    const merged = mergeReadinessDisabledFeatures(base, report);
    expect(merged.find((f) => f.id === "b65")?.selectable).toBe(true);
    expect(merged.find((f) => f.id === "b67")?.selectable).toBe(false);
    expect(merged.find((f) => f.id === "b99")?.selectable).toBe(false);
    expect(merged.find((f) => f.id === "bad-id")?.disabledReason).toMatch(
      /declared format/i
    );
  });
});
