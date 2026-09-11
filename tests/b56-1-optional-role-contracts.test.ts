import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES,
  IMPLEMENT_FULLY_VARIABLES,
  KickoffError,
  PIPELINE_MODEL_ROLES,
  PIPELINE_OPTIONAL_MODEL_ROLES,
  PIPELINE_REQUIRED_MODEL_ROLES,
  assertVariablesMatchRequired,
  buildKickoffVariables,
  normalizeImplementFullyChainVariables,
  pipelineRoleModelProfilesSchema,
  pipelineRoleModelsSchema,
  resolveEntryWorkerKey,
  resolveGatekeeperSelection,
  resolveResearchApprovalPolicy,
  resolveRoleModelProfileDefaults,
  resolveRoleRecipe,
  type ModelSelection,
  type PipelineModelRole,
} from "@lca/shared";
import type { ChainVariables } from "../packages/shared/src/types/config.ts";
import {
  IMPLEMENT_FULLY_DEFINITION,
  toPipelineIntrospection,
} from "../packages/daemon/src/pipelines/implement-fully.ts";

const FOUR_ROLE_MODELS: Partial<Record<PipelineModelRole, ModelSelection>> = {
  planner: { id: "planner-model" },
  implementer: { id: "implementer-model" },
  reviewer: { id: "reviewer-model" },
  docs: { id: "docs-model" },
};

const MAX_ROLE_MODELS: Partial<Record<PipelineModelRole, ModelSelection>> = {
  ...FOUR_ROLE_MODELS,
  researcher: {
    id: "research-model",
    params: [{ id: "thinking", value: "high" }],
  },
  gatekeeper: { id: "gate-model", params: [{ id: "thinking", value: "max" }] },
  architect: { id: "arch-model", params: [{ id: "thinking", value: "max" }] },
};

const introspection = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
  pipelineRoleModels: FOUR_ROLE_MODELS,
  pipelineRoleModelProfiles: {},
  defaultPipelineRoleModelProfile: null,
});

describe("b56.1 optional role settings contracts", () => {
  it("accepts six-role settings and named profiles with structured params", () => {
    const sixRoles = {
      planner: "planner-model",
      implementer: "implementer-model",
      reviewer: "reviewer-model",
      docs: "docs-model",
      researcher: {
        id: "research-model",
        params: [{ id: "thinking", value: "high" }],
      },
      gatekeeper: {
        id: "gate-model",
        params: [{ id: "thinking", value: "max" }],
      },
    };

    expect(pipelineRoleModelsSchema.parse(sixRoles)).toEqual(sixRoles);
    expect(
      pipelineRoleModelProfilesSchema.parse({ max: sixRoles }).max
    ).toEqual(sixRoles);
    expect(() =>
      pipelineRoleModelsSchema.parse({
        ...sixRoles,
        inventedRole: "not-allowed",
      })
    ).toThrow();
  });

  it("keeps four-role profiles sparse and returns fresh selection copies", () => {
    const parsed = pipelineRoleModelProfilesSchema.parse({
      legacy: {
        planner: "planner-model",
        implementer: { id: "implementer-model" },
        reviewer: "reviewer-model",
        docs: "docs-model",
      },
    });
    expect(Object.keys(parsed.legacy ?? {}).sort()).toEqual(
      [...PIPELINE_REQUIRED_MODEL_ROLES].sort()
    );

    const first = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
      pipelineRoleModels: FOUR_ROLE_MODELS,
      pipelineRoleModelProfiles: { legacy: FOUR_ROLE_MODELS },
      defaultPipelineRoleModelProfile: "legacy",
    });
    expect(Object.keys(first.roleDefaults).sort()).toEqual(
      [...PIPELINE_REQUIRED_MODEL_ROLES].sort()
    );
    expect(first.roleDefaults.planner).not.toBe(FOUR_ROLE_MODELS.planner);
    expect(first.roleModelProfiles[1]?.roleModels.planner).not.toBe(
      FOUR_ROLE_MODELS.planner
    );
  });
});

describe("b56.1 required and optional role resolution", () => {
  it("partitions the seven-role vocabulary without overlap", () => {
    expect(PIPELINE_MODEL_ROLES).toEqual([
      ...PIPELINE_REQUIRED_MODEL_ROLES,
      ...PIPELINE_OPTIONAL_MODEL_ROLES,
    ]);
    expect(introspection.roleContract).toEqual({
      required: PIPELINE_REQUIRED_MODEL_ROLES,
      optional: PIPELINE_OPTIONAL_MODEL_ROLES,
      conditionalEntryRole: "researcher",
      conditionalEntryWorkerKey: "research",
      fallbackRole: "gatekeeper",
      fallbackToRole: "reviewer",
      skeletonFallbackRole: "architect",
      skeletonFallbackToRole: "planner",
    });
  });

  it("reports all missing required roles but never missing optional roles", () => {
    expect(() => resolveRoleRecipe(PIPELINE_REQUIRED_MODEL_ROLES, {}, {})).toThrow(
      /planner, implementer, reviewer, docs/
    );
    try {
      resolveRoleRecipe(PIPELINE_REQUIRED_MODEL_ROLES, {}, {});
    } catch (error) {
      expect(error).toBeInstanceOf(KickoffError);
      expect(String(error)).not.toMatch(/researcher|gatekeeper|architect/);
    }
  });

  it("includes configured optional roles and omits absent optional roles", () => {
    const legacy = resolveRoleRecipe(
      PIPELINE_REQUIRED_MODEL_ROLES,
      {},
      FOUR_ROLE_MODELS
    );
    expect(legacy.roleModels.researcher).toBeUndefined();
    expect(legacy.roleModels.gatekeeper).toBeUndefined();

    const expanded = resolveRoleRecipe(
      PIPELINE_REQUIRED_MODEL_ROLES,
      { researcher: "research-override" },
      { ...FOUR_ROLE_MODELS, gatekeeper: { id: "gate-default" } }
    );
    expect(expanded.roleModels.researcher).toEqual({ id: "research-override" });
    expect(expanded.sources.researcher).toBe("override");
    expect(expanded.roleModels.gatekeeper).toEqual({ id: "gate-default" });
    expect(expanded.sources.gatekeeper).toBe("default");
  });

  it("selects research entry only when researcher resolves", () => {
    expect(
      resolveEntryWorkerKey(
        { ...FOUR_ROLE_MODELS, researcher: { id: "research-model" } },
        introspection.roleContract,
        introspection.entryWorkerKey
      )
    ).toEqual({ entryWorkerKey: "research", rootRole: "researcher" });
    expect(
      resolveEntryWorkerKey(
        FOUR_ROLE_MODELS,
        introspection.roleContract,
        introspection.entryWorkerKey
      )
    ).toEqual({ entryWorkerKey: "plan-skeleton", rootRole: "planner" });
  });

  it("uses explicit gatekeeper or reviewer fallback without persisting fallback", () => {
    const explicit = { ...FOUR_ROLE_MODELS, gatekeeper: { id: "gate-model" } };
    expect(
      resolveGatekeeperSelection(explicit, introspection.roleContract)
    ).toEqual({ selection: { id: "gate-model" }, source: "explicit" });

    const fallback = { ...FOUR_ROLE_MODELS };
    expect(
      resolveGatekeeperSelection(fallback, introspection.roleContract)
    ).toEqual({
      selection: FOUR_ROLE_MODELS.reviewer,
      source: "reviewer-fallback",
    });
    expect(fallback.gatekeeper).toBeUndefined();
  });
});

describe("b56.1 introspection compatibility", () => {
  it("keeps a four-role kickoff at ten variables and four role models", () => {
    const variables = buildKickoffVariables(
      "b56",
      "b56-optional-researcher-gatekeeper",
      "optional researcher and gatekeeper roles"
    );
    assertVariablesMatchRequired(variables, introspection.requiredVariables);
    expect(Object.keys(variables).sort()).toEqual(
      [...IMPLEMENT_FULLY_VARIABLES].sort()
    );

    expect(introspection.entryWorkerKey).toBe("plan-skeleton");
    const recipe = resolveRoleRecipe(
      introspection.roleContract.required,
      {},
      resolveRoleModelProfileDefaults(undefined, introspection)
    );
    expect(Object.keys(recipe.roleModels).sort()).toEqual(
      [...PIPELINE_REQUIRED_MODEL_ROLES].sort()
    );
    expect(
      resolveEntryWorkerKey(
        recipe.roleModels,
        introspection.roleContract,
        introspection.entryWorkerKey
      )
    ).toEqual({ entryWorkerKey: "plan-skeleton", rootRole: "planner" });
  });

  it("surfaces a seven-role profile with structured params through introspection", () => {
    const maxIntrospection = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
      pipelineRoleModels: FOUR_ROLE_MODELS,
      pipelineRoleModelProfiles: { max: MAX_ROLE_MODELS },
      defaultPipelineRoleModelProfile: "max",
    });

    expect(maxIntrospection.defaultRoleModelProfileId).toBe("max");
    expect(Object.keys(maxIntrospection.roleDefaults).sort()).toEqual(
      [...PIPELINE_MODEL_ROLES].sort()
    );
    expect(maxIntrospection.roleDefaults.researcher).toEqual(
      MAX_ROLE_MODELS.researcher
    );
    expect(maxIntrospection.roleDefaults.gatekeeper).toEqual(
      MAX_ROLE_MODELS.gatekeeper
    );
    expect(maxIntrospection.roleDefaults.researcher?.params).not.toBe(
      MAX_ROLE_MODELS.researcher?.params
    );

    const defaults = resolveRoleModelProfileDefaults("max", maxIntrospection);
    const recipe = resolveRoleRecipe(
      maxIntrospection.roleContract.required,
      {},
      defaults
    );
    expect(Object.keys(recipe.roleModels).sort()).toEqual(
      [...PIPELINE_MODEL_ROLES].sort()
    );
    expect(recipe.roleModels.researcher?.params).toEqual([
      { id: "thinking", value: "high" },
    ]);
    expect(
      resolveEntryWorkerKey(
        recipe.roleModels,
        maxIntrospection.roleContract,
        maxIntrospection.entryWorkerKey
      )
    ).toEqual({ entryWorkerKey: "research", rootRole: "researcher" });
    expect(
      resolveGatekeeperSelection(
        recipe.roleModels,
        maxIntrospection.roleContract
      ).source
    ).toBe("explicit");
    expect(
      resolveResearchApprovalPolicy("before-planning", recipe.roleModels)
    ).toBe("before-planning");
  });
});

describe("b56.1 research approval compatibility", () => {
  it("defaults absent policy and accepts guarded approval with researcher", () => {
    expect(resolveResearchApprovalPolicy(undefined, FOUR_ROLE_MODELS)).toBe(
      "none"
    );
    expect(
      resolveResearchApprovalPolicy("before-planning", {
        ...FOUR_ROLE_MODELS,
        researcher: { id: "research-model" },
      })
    ).toBe("before-planning");
  });

  it("rejects guarded approval without researcher and lists valid unknown values", () => {
    expect(() =>
      resolveResearchApprovalPolicy("before-planning", FOUR_ROLE_MODELS)
    ).toThrow(/before-planning.*researcher/);

    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: "implement-fully",
        researchApprovalPolicy: "later",
      })
    ).toThrow(
      new RegExp(IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES.join(".*"))
    );
  });

  it("normalizes a legacy context without mutation and requires researchApprovalPolicy", () => {
    const legacy: ChainVariables = {
      pipelineId: "implement-fully",
      planningDepth: "jit",
      approvalPolicy: "none",
    };
    const normalized = normalizeImplementFullyChainVariables(legacy);
    expect(normalized).toEqual({
      ...legacy,
      researchApprovalPolicy: "none",
      loopMode: "normal",
    });
    expect(legacy.researchApprovalPolicy).toBeUndefined();
    expect(IMPLEMENT_FULLY_VARIABLES).toContain("researchApprovalPolicy");
    expect(IMPLEMENT_FULLY_VARIABLES).toContain("loopMode");
    expect(IMPLEMENT_FULLY_VARIABLES).toHaveLength(10);
  });
});
