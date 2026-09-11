import { describe, expect, it } from "vitest";
import {
  CHAIN_VALUE_MAX_LENGTH,
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  DEFAULT_ROLE_MODEL_PROFILE_ID,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_VARIABLES,
  KickoffError,
  requiredRolesFromWorkers,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
  type ResolveImplementFullyKickoffResponse,
} from "@lca/shared";
import {
  assembleKickoffPayload,
  buildResolveImplementFullyKickoffRequest,
} from "../packages/dashboard/src/pipelineKickoff.ts";

function kickoffFixtures(): {
  introspection: PipelineIntrospectionResponse;
  plan: ProvisionPipelineWorkersResponse;
} {
  const introspection: PipelineIntrospectionResponse = {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    entryWorkerKey: "plan-skeleton",
    entryWorkerConfigKey: "generated:plan-skeleton",
    roleContract: {
      required: ["planner", "implementer", "reviewer", "docs"],
      optional: ["researcher", "gatekeeper", "architect"],
      conditionalEntryRole: "researcher",
      conditionalEntryWorkerKey: "research",
      fallbackRole: "gatekeeper",
      fallbackToRole: "reviewer",
      skeletonFallbackRole: "architect",
      skeletonFallbackToRole: "planner",
    },
    requiredVariables: IMPLEMENT_FULLY_VARIABLES,
    requiredSkills: [],
    budgetFormula: "6 × phaseCount + 1",
    executeBudgetFormula: "3 × phaseCount + 2",
    workers: [
      {
        key: "plan-skeleton",
        name: "Plan skeleton",
        modelRole: "planner",
        chain: { next: "plan-phase", when: "completed" },
      },
      {
        key: "plan-phase",
        name: "Plan phase",
        modelRole: "planner",
        chain: { next: "implement", when: "completed" },
      },
      {
        key: "implement",
        name: "Implement",
        modelRole: "implementer",
        chain: { next: "review", when: "completed" },
      },
      {
        key: "review",
        name: "Review",
        modelRole: "reviewer",
        chain: { next: "update-docs", when: "completed" },
      },
      {
        key: "update-docs",
        name: "Update docs",
        modelRole: "docs",
        chain: { next: "plan-phase", when: "completed" },
      },
    ],
    roleDefaults: {
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
      docs: { id: "docs-model" },
    },
    roleModelProfiles: [
      {
        id: DEFAULT_ROLE_MODEL_PROFILE_ID,
        label: "Default",
        roleModels: {
          planner: { id: "planner-model" },
          implementer: { id: "implementer-model" },
          reviewer: { id: "reviewer-model" },
          docs: { id: "docs-model" },
        },
      },
    ],
    defaultRoleModelProfileId: DEFAULT_ROLE_MODEL_PROFILE_ID,
    planningProfiles: [...IMPLEMENT_FULLY_PLANNING_PROFILES],
    defaultPlanningProfileId: DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  };
  const plan: ProvisionPipelineWorkersResponse = {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    missingSkills: [],
    plan: {
      workspaceId: "ws",
      dryRun: true,
      applied: false,
      items: [
        {
          key: "plan-skeleton",
          configKey: "generated:plan-skeleton",
          automationId: "ws::generated:plan-skeleton",
          action: "unchanged",
        },
      ],
    },
  };
  return { introspection, plan };
}

describe("b42.2 buildResolveImplementFullyKickoffRequest", () => {
  it("builds feature-id requests without idea and trims whitespace", () => {
    const req = buildResolveImplementFullyKickoffRequest({
      workspaceId: "  ws-1  ",
      kind: "feature-id",
      featureId: "  b42  ",
      idea: "should not appear",
    });
    expect(req).toEqual({
      workspaceId: "ws-1",
      input: { kind: "feature-id", featureId: "b42" },
    });
    expect("idea" in req.input).toBe(false);
  });

  it("builds idea requests without featureId and trims whitespace", () => {
    const req = buildResolveImplementFullyKickoffRequest({
      workspaceId: "ws-1",
      kind: "idea",
      featureId: "b99",
      idea: "  Ship thinner kickoff  ",
    });
    expect(req).toEqual({
      workspaceId: "ws-1",
      input: { kind: "idea", idea: "Ship thinner kickoff" },
    });
    expect("featureId" in req.input).toBe(false);
  });

  it("throws concise KickoffError for invalid feature id", () => {
    expect(() =>
      buildResolveImplementFullyKickoffRequest({
        workspaceId: "ws",
        kind: "feature-id",
        featureId: "feature-42",
        idea: "",
      })
    ).toThrow(KickoffError);
    expect(() =>
      buildResolveImplementFullyKickoffRequest({
        workspaceId: "ws",
        kind: "feature-id",
        featureId: "feature-42",
        idea: "",
      })
    ).toThrow(/featureId must match/);
  });

  it("throws concise KickoffError for blank idea", () => {
    expect(() =>
      buildResolveImplementFullyKickoffRequest({
        workspaceId: "ws",
        kind: "idea",
        featureId: "",
        idea: "   ",
      })
    ).toThrow(/idea must be non-empty/);
  });

  it("throws concise KickoffError for over-limit multibyte idea", () => {
    const over = "é".repeat(CHAIN_VALUE_MAX_LENGTH);
    expect(new TextEncoder().encode(over).length).toBeGreaterThan(
      CHAIN_VALUE_MAX_LENGTH
    );
    expect(() =>
      buildResolveImplementFullyKickoffRequest({
        workspaceId: "ws",
        kind: "idea",
        featureId: "",
        idea: over,
      })
    ).toThrow(
      new RegExp(`idea is .* bytes; max is ${CHAIN_VALUE_MAX_LENGTH}`)
    );
  });
});

describe("b42.2 resolved metadata drives kickoff payload", () => {
  it("uses existing-feature resolve response, not raw form values", () => {
    const { introspection, plan } = kickoffFixtures();
    const resolved: ResolveImplementFullyKickoffResponse = {
      featureId: "b36",
      featureSlug: "b36-verify-gate",
      idea: "Canonical idea from roadmap — Prior art: docs/roadmap/b36-verify-gate/prd.md.",
    };
    const roles = requiredRolesFromWorkers(introspection.workers);
    expect(roles).toEqual(["planner", "implementer", "reviewer", "docs"]);

    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: resolved.featureId,
      slug: resolved.featureSlug,
      idea: resolved.idea,
      roleOverrides: { planner: "override-planner" },
    });

    expect(payload.maxDepth).toBe(1);
    expect(payload.automationId).toBe("ws::generated:plan-skeleton");
    expect(payload.variables).toEqual({
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b36",
      featureSlug: "b36-verify-gate",
      featureDir: "docs/roadmap/b36-verify-gate",
      featureIndex: "docs/roadmap/b36-verify-gate/00-index.md",
      idea: resolved.idea,
      planningDepth: "jit",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode: "normal",
    });
    expect(payload.variables?.featureDir.includes("\\")).toBe(false);
    expect(payload.variables?.featureIndex.includes("\\")).toBe(false);
    expect(payload.roleModels?.planner).toEqual({ id: "override-planner" });
    expect(payload.roleModels?.implementer).toEqual({
      id: "implementer-model",
    });
    expect(payload.modelSelection).toEqual({ id: "override-planner" });
  });

  it("uses new-idea resolve response for the ten kickoff variables", () => {
    const { introspection, plan } = kickoffFixtures();
    const resolved: ResolveImplementFullyKickoffResponse = {
      featureId: "b99",
      featureSlug: "b99-brand-new-thinner-kickoff",
      idea: "Brand new thinner kickoff",
    };

    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: resolved.featureId,
      slug: resolved.featureSlug,
      idea: resolved.idea,
      roleOverrides: {},
    });

    expect(payload.maxDepth).toBe(1);
    expect(payload.automationId).toBe("ws::generated:plan-skeleton");
    expect(Object.keys(payload.variables ?? {}).sort()).toEqual(
      [...IMPLEMENT_FULLY_VARIABLES].sort()
    );
    expect(payload.variables).toEqual({
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b99",
      featureSlug: "b99-brand-new-thinner-kickoff",
      featureDir: "docs/roadmap/b99-brand-new-thinner-kickoff",
      featureIndex: "docs/roadmap/b99-brand-new-thinner-kickoff/00-index.md",
      idea: "Brand new thinner kickoff",
      planningDepth: "jit",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
      loopMode: "normal",
    });
  });
});
