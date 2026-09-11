import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  type ModelSelection,
} from "@lca/shared";
import {
  IMPLEMENT_FULLY_DEFINITION,
  toPipelineIntrospection,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import {
  assembleKickoffPayload,
  describeKickoffReviewFacts,
} from "../packages/dashboard/src/pipelineKickoff.ts";

const ROOT = join(import.meta.dirname, "..");

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

const FOUR_ROLE_DEFAULTS: Partial<Record<string, ModelSelection>> = {
  planner: { id: "planner-default" },
  implementer: { id: "implementer-default" },
  reviewer: { id: "reviewer-default" },
  docs: { id: "docs-default" },
};

const ARCHITECT_SELECTION: ModelSelection = {
  id: "architect-frontier",
  params: [{ id: "thinking", value: "max" }],
};

const RESEARCHER_SELECTION: ModelSelection = { id: "fable-research" };

function kickoffFixtures(roleModels: Partial<Record<string, ModelSelection>>) {
  const introspection = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
    pipelineRoleModels: roleModels,
    pipelineRoleModelProfiles: {},
    defaultPipelineRoleModelProfile: null,
  });
  const plan = {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    missingSkills: [],
    plan: {
      workspaceId: "ws",
      dryRun: true,
      applied: false,
      items: [
        {
          key: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
          configKey: `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
          automationId: `ws::generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
          action: "unchanged" as const,
        },
        {
          key: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
          configKey: `generated:${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
          automationId: `ws::generated:${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
          action: "create" as const,
        },
      ],
    },
  };
  return { introspection, plan };
}

describe("b59.4 describeKickoffReviewFacts architect binding", () => {
  it("reports planner fallback when architect is omitted", () => {
    const { introspection } = kickoffFixtures(FOUR_ROLE_DEFAULTS);
    const facts = describeKickoffReviewFacts({
      introspection,
      roleModels: FOUR_ROLE_DEFAULTS,
    });
    expect(facts.architect).toEqual(FOUR_ROLE_DEFAULTS.planner);
    expect(facts.architectSource).toBe("planner-fallback");
  });

  it("reports explicit architect when set", () => {
    const withArchitect = {
      ...FOUR_ROLE_DEFAULTS,
      architect: ARCHITECT_SELECTION,
    };
    const { introspection } = kickoffFixtures(withArchitect);
    const facts = describeKickoffReviewFacts({
      introspection,
      roleModels: withArchitect,
    });
    expect(facts.architect).toEqual(ARCHITECT_SELECTION);
    expect(facts.architectSource).toBe("explicit");
  });
});

describe("b59.4 assembleKickoffPayload entry modelSelection", () => {
  it("uses planner fallback for plan-skeleton entry when architect is omitted", () => {
    const { introspection, plan } = kickoffFixtures(FOUR_ROLE_DEFAULTS);
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b59",
      slug: "b59-architect-role-split",
      idea: "Architect kickoff surfaces.",
      roleOverrides: {},
    });
    expect(payload.modelSelection).toEqual(FOUR_ROLE_DEFAULTS.planner);
    expect(payload.roleModels.architect).toBeUndefined();
  });

  it("uses explicit architect for plan-skeleton entry when set", () => {
    const { introspection, plan } = kickoffFixtures(FOUR_ROLE_DEFAULTS);
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b59",
      slug: "b59-architect-role-split",
      idea: "Architect kickoff surfaces.",
      roleOverrides: { architect: ARCHITECT_SELECTION.id },
    });
    expect(payload.modelSelection).toEqual({ id: ARCHITECT_SELECTION.id });
    expect(payload.roleModels.architect).toEqual({ id: ARCHITECT_SELECTION.id });
  });

  it("keeps researcher modelSelection for research entry kickoffs", () => {
    const { introspection, plan } = kickoffFixtures(FOUR_ROLE_DEFAULTS);
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b59",
      slug: "b59-architect-role-split",
      idea: "Architect kickoff surfaces.",
      roleOverrides: { researcher: RESEARCHER_SELECTION.id },
    });
    expect(payload.modelSelection).toEqual({ id: RESEARCHER_SELECTION.id });
  });
});

describe("b59.4 kickoff UI source contracts", () => {
  const modalSrc = readSrc("packages/dashboard/src/PipelineKickoffModal.tsx");
  const cliSrc = readSrc("packages/cli/src/implement-fully.ts");
  const helperSrc = readSrc("packages/dashboard/src/pipelineKickoff.ts");

  it("dashboard optional picker and review expose architect surfaces", () => {
    expect(modalSrc).toContain("Planner fallback");
    expect(modalSrc).toContain('typedRole === "architect"');
    expect(modalSrc).toContain('data-review-fact="architect"');
    expect(modalSrc).toContain("planner fallback");
  });

  it("shared helpers resolve architect for review and assemble", () => {
    expect(helperSrc).toContain("resolveArchitectSelection");
    expect(helperSrc).toContain("architectSource");
    expect(helperSrc).toContain("IMPLEMENT_FULLY_ENTRY_WORKER_KEY");
  });

  it("CLI resolves architect for plan-skeleton entry and prints binding", () => {
    expect(cliSrc).toContain("resolveArchitectSelection");
    expect(cliSrc).toContain("IMPLEMENT_FULLY_ENTRY_WORKER_KEY");
    expect(cliSrc).toContain("Architect:");
    expect(cliSrc).toContain("planner fallback");
  });
});
