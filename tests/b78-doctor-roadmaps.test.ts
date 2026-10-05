import { describe, expect, it } from "vitest";
import {
  assertKickoffReadinessAllowed,
  KickoffReadinessError,
  PER_PERSON_IDEA_REFUSAL,
  roadmapReadinessHasBlockers,
  type RoadmapReadinessReport,
  type RoadmapReadinessSummariesResponse,
} from "@lca/shared";
import { resolveExactWorkspaceTarget } from "../packages/cli/src/client.ts";
import {
  describeRoadmapFeaturePlan,
  formatRoadmapFullReportLines,
  formatRoadmapSummaryLines,
  roadmapDoctorExitCode,
  ROADMAP_DAEMON_DOWN_LINE,
} from "../packages/cli/src/doctor.ts";
import type { Workspace } from "@lca/shared";

function mockClient(workspaces: Workspace[]) {
  return {
    listWorkspaces: async () => workspaces,
  };
}

describe("b78 doctor roadmaps", () => {
  it("formats bare summary lines by workspace label", () => {
    const summaries: RoadmapReadinessSummariesResponse = {
      workspaces: [
        {
          workspaceId: "ws1",
          state: "ready",
          counts: {
            "blocks-all": 0,
            "blocks-some": 0,
            "idea-only": 0,
            info: 2,
          },
        },
        {
          workspaceId: "ws2",
          state: "adoptable",
          counts: {
            "blocks-all": 1,
            "blocks-some": 0,
            "idea-only": 0,
            info: 0,
          },
        },
      ],
    };
    const labels = new Map([
      ["ws1", "alpha"],
      ["ws2", "beta"],
    ]);
    const lines = formatRoadmapSummaryLines(summaries, labels);
    expect(lines[0]).toMatch(/alpha — ready, 2 info/);
    expect(lines[1]).toMatch(/beta — adoptable, 1 blocker/);
  });

  it("groups full report findings with fixes and feature plans", () => {
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
          code: "epics-present",
          impact: "info",
          message: "1 epic(s) are not startable as features",
          fix: "Kick off one of the epic's child features instead.",
          fixable_by: "user",
          featureIds: ["e1"],
        },
      ],
      features: [
        {
          id: "b42",
          section: "Backlog",
          slug: "b42-feature",
          kind: "dir",
          nextPhase: { n: 2, status: "Pending" },
        },
      ],
      candidates: [],
    };
    const text = formatRoadmapFullReportLines("demo", report).join("\n");
    expect(text).toMatch(/1 change\(s\) needed/);
    expect(text).toMatch(/blocked  Workspace is not a git repository/);
    expect(text).toMatch(/Run git init/);
    expect(text).toMatch(/info  1 epic/);
    expect(text).toMatch(/b42 → existing folder b42-feature, Phase 2 Pending/);
  });

  it("uses exit code 1 only for blocks-all and blocks-some", () => {
    const blocker: RoadmapReadinessReport = {
      state: "adoptable",
      findings: [
        {
          code: "not-git-repo",
          impact: "blocks-all",
          message: "x",
          fix: "y",
          fixable_by: "user",
        },
      ],
      features: [],
      candidates: [],
    };
    const ideaOnly: RoadmapReadinessReport = {
      state: "ready",
      findings: [
        {
          code: "missing-next-marker",
          impact: "idea-only",
          message: "x",
          fix: "y",
          fixable_by: "cli",
        },
      ],
      features: [],
      candidates: [],
    };
    expect(roadmapDoctorExitCode(blocker)).toBe(1);
    expect(roadmapDoctorExitCode(ideaOnly)).toBe(0);
    expect(roadmapReadinessHasBlockers(ideaOnly)).toBe(false);
  });

  it("resolves workspaces by exact id, name, or path tail only", async () => {
    const workspaces: Workspace[] = [
      {
        id: "abc123fullid",
        path: "C:\\Users\\dev\\projects\\alpha",
        name: "Alpha",
        createdAt: "",
        updatedAt: "",
      },
    ];
    const client = mockClient(workspaces) as never;
    expect(await resolveExactWorkspaceTarget(client, "abc123fullid")).toBe(
      "abc123fullid"
    );
    expect(await resolveExactWorkspaceTarget(client, "Alpha")).toBe("abc123fullid");
    expect(await resolveExactWorkspaceTarget(client, "alpha")).toBe("abc123fullid");
    expect(await resolveExactWorkspaceTarget(client, "abc123")).toBeNull();
  });

  it("documents daemon-down degrade line", () => {
    expect(ROADMAP_DAEMON_DOWN_LINE).toMatch(/run max up/);
  });

  it("describes derived and blocked feature plans", () => {
    expect(
      describeRoadmapFeaturePlan({
        id: "b99",
        section: "Backlog",
        kind: "derived",
        slug: "b99-new-idea",
      })
    ).toContain("derived slug b99-new-idea");
    expect(
      describeRoadmapFeaturePlan({
        id: "b77",
        section: "Backlog",
        kind: "blocked",
        reason: "ambiguous slug",
      })
    ).toContain("ambiguous slug");
  });

  it("includes the fix on kickoff blockers but keeps idea-only marker text", () => {
    const gitBlock: RoadmapReadinessReport = {
      state: "adoptable",
      findings: [
        {
          code: "not-git-repo",
          impact: "blocks-all",
          message: "Workspace is not a git repository",
          fix: "Run git init in the workspace root.",
          fixable_by: "user",
        },
      ],
      features: [],
      candidates: [],
    };
    expect(() =>
      assertKickoffReadinessAllowed(gitBlock, { kind: "idea", idea: "x" })
    ).toThrow(KickoffReadinessError);
    try {
      assertKickoffReadinessAllowed(gitBlock, { kind: "idea", idea: "x" });
    } catch (err) {
      expect((err as Error).message).toMatch(/git init/i);
    }

    const ideaOnly: RoadmapReadinessReport = {
      state: "ready",
      findings: [
        {
          code: "per-person-next-marker",
          impact: "idea-only",
          message: PER_PERSON_IDEA_REFUSAL,
          fix: "Add the item with your id to the index, then use --feature instead of --idea.",
          fixable_by: "user",
        },
      ],
      features: [],
      candidates: [],
    };
    expect(() =>
      assertKickoffReadinessAllowed(ideaOnly, {
        kind: "feature-id",
        featureId: "b-xy58",
      })
    ).not.toThrow();
    try {
      assertKickoffReadinessAllowed(ideaOnly, { kind: "idea", idea: "x" });
      expect.fail("expected idea-only refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(KickoffReadinessError);
      expect((err as Error).message).toBe(PER_PERSON_IDEA_REFUSAL);
    }
  });
});
