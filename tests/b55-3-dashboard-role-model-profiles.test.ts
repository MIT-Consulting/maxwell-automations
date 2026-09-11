import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  DEFAULT_ROLE_MODEL_PROFILE_ID,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_VARIABLES,
  KickoffError,
  type ModelSelection,
  type PipelineIntrospectionResponse,
  type PipelineModelRole,
  type ProvisionPipelineWorkersResponse,
} from "@lca/shared";
import { assembleKickoffPayload } from "../packages/dashboard/src/pipelineKickoff.ts";

const QUALITY_DEFAULTS: Partial<Record<PipelineModelRole, ModelSelection>> = {
  planner: { id: "gpt-5.6-sol" },
  implementer: { id: "grok-4.5" },
  reviewer: { id: "claude-opus-5" },
  docs: { id: "composer-2.5" },
};

const CHEAP_PROFILE: Partial<Record<PipelineModelRole, ModelSelection>> = {
  planner: { id: "grok-4.5" },
  implementer: { id: "composer-2.5" },
  reviewer: { id: "grok-4.5" },
  docs: { id: "composer-2.5" },
};

function buildIntrospection(
  args: {
    roleDefaults: Partial<Record<PipelineModelRole, ModelSelection>>;
    defaultRoleModelProfileId?: string;
    includeCheap?: boolean;
  }
): PipelineIntrospectionResponse {
  const roleModelProfiles = [
    {
      id: DEFAULT_ROLE_MODEL_PROFILE_ID,
      label: "Default",
      roleModels: args.roleDefaults,
    },
    ...(args.includeCheap
      ? [{ id: "cheap", label: "Cheap", roleModels: CHEAP_PROFILE }]
      : []),
  ];
  return {
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
    roleDefaults: args.roleDefaults,
    roleModelProfiles,
    defaultRoleModelProfileId:
      args.defaultRoleModelProfileId ?? DEFAULT_ROLE_MODEL_PROFILE_ID,
    planningProfiles: [...IMPLEMENT_FULLY_PLANNING_PROFILES],
    defaultPlanningProfileId: DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  };
}

function buildPlan(): ProvisionPipelineWorkersResponse {
  return {
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
}

describe("b55.3 dashboard assemble role model profiles", () => {
  const introspection = buildIntrospection({
    roleDefaults: QUALITY_DEFAULTS,
    includeCheap: true,
    defaultRoleModelProfileId: "cheap",
  });
  const plan = buildPlan();

  it("uses cheap recipe when roleProfileId is cheap", () => {
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b55",
      slug: "b55-named-pipeline-role-model-profiles",
      idea: "Named profiles",
      roleOverrides: {},
      roleProfileId: "cheap",
    });
    expect(payload.roleModels).toEqual(CHEAP_PROFILE);
    expect(payload.modelSelection).toEqual({ id: "grok-4.5" });
  });

  it("uses defaultRoleModelProfileId when roleProfileId is omitted", () => {
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b55",
      slug: "b55-named-pipeline-role-model-profiles",
      idea: "Named profiles",
      roleOverrides: {},
    });
    expect(payload.roleModels).toEqual(CHEAP_PROFILE);
  });

  it("uses synthetic default when roleProfileId is default", () => {
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b55",
      slug: "b55-named-pipeline-role-model-profiles",
      idea: "Named profiles",
      roleOverrides: {},
      roleProfileId: "default",
    });
    expect(payload.roleModels).toEqual(QUALITY_DEFAULTS);
    expect(payload.modelSelection).toEqual({ id: "gpt-5.6-sol" });
  });

  it("lets per-role override beat the selected profile", () => {
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b55",
      slug: "b55-named-pipeline-role-model-profiles",
      idea: "Named profiles",
      roleOverrides: { planner: "override-model" },
      roleProfileId: "cheap",
    });
    expect(payload.roleModels?.planner).toEqual({ id: "override-model" });
    expect(payload.roleModels?.implementer).toEqual(CHEAP_PROFILE.implementer);
    expect(payload.modelSelection).toEqual({ id: "override-model" });
  });

  it("throws for unknown roleProfileId", () => {
    expect(() =>
      assembleKickoffPayload({
        introspection,
        plan,
        feature: "b55",
        slug: "b55-named-pipeline-role-model-profiles",
        idea: "Named profiles",
        roleOverrides: {},
        roleProfileId: "missing",
      })
    ).toThrow(KickoffError);
    expect(() =>
      assembleKickoffPayload({
        introspection,
        plan,
        feature: "b55",
        slug: "b55-named-pipeline-role-model-profiles",
        idea: "Named profiles",
        roleOverrides: {},
        roleProfileId: "missing",
      })
    ).toThrow(/Unknown role model profile "missing"/);
  });

  it("does not add roleProfileId to trigger payload", () => {
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b55",
      slug: "b55-named-pipeline-role-model-profiles",
      idea: "Named profiles",
      roleOverrides: {},
      roleProfileId: "cheap",
    });
    expect("roleProfileId" in payload).toBe(false);
    expect(payload.roleModels).toEqual(CHEAP_PROFILE);
  });
});
