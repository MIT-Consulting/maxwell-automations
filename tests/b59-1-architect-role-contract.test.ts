import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KickoffError,
  PIPELINE_MODEL_ROLES,
  PIPELINE_OPTIONAL_MODEL_ROLES,
  PIPELINE_REQUIRED_MODEL_ROLES,
  PIPELINE_SKELETON_FALLBACK_ROLE,
  PIPELINE_SKELETON_ROLE,
  PIPELINE_TERMINAL_FALLBACK_ROLE,
  PIPELINE_TERMINAL_ROLE,
  architectJitPlanningWarning,
  pipelineRoleModelProfilesSchema,
  pipelineRoleModelsSchema,
  resolveArchitectSelection,
  resolveGatekeeperSelection,
  resolveRoleRecipe,
  resolveRoleSelectionWithFallback,
  type ModelSelection,
  type PipelineModelRole,
} from "@lca/shared";
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

const introspection = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
  pipelineRoleModels: FOUR_ROLE_MODELS,
  pipelineRoleModelProfiles: {},
  defaultPipelineRoleModelProfile: null,
});

describe("b59.1 seven-role vocabulary", () => {
  it("partitions required and optional roles without overlap", () => {
    expect(PIPELINE_MODEL_ROLES).toHaveLength(7);
    expect(PIPELINE_MODEL_ROLES).toEqual([
      ...PIPELINE_REQUIRED_MODEL_ROLES,
      ...PIPELINE_OPTIONAL_MODEL_ROLES,
    ]);
    expect(PIPELINE_OPTIONAL_MODEL_ROLES).toContain("architect");
    expect(PIPELINE_REQUIRED_MODEL_ROLES).not.toContain("architect");
  });
});

describe("b59.1 architect settings and profiles", () => {
  it("accepts architect with structured params and rejects unknown keys", () => {
    const withArchitect = {
      ...Object.fromEntries(
        PIPELINE_REQUIRED_MODEL_ROLES.map((role) => [role, `${role}-model`])
      ),
      architect: {
        id: "architect-model",
        params: [{ id: "thinking", value: "max" }],
      },
    };

    expect(pipelineRoleModelsSchema.parse(withArchitect)).toEqual(withArchitect);
    expect(
      pipelineRoleModelProfilesSchema.parse({ deep: withArchitect }).deep
    ).toEqual(withArchitect);
    expect(() =>
      pipelineRoleModelsSchema.parse({
        ...withArchitect,
        inventedRole: "not-allowed",
      })
    ).toThrow();
  });

  it("copies recipes without synthesizing absent architect", () => {
    const parsed = pipelineRoleModelsSchema.parse(FOUR_ROLE_MODELS);
    expect(parsed.architect).toBeUndefined();
    expect("architect" in parsed).toBe(false);
  });
});

describe("b59.1 resolveRoleRecipe with architect", () => {
  it("includes architect from override or defaults and never in required errors", () => {
    const override = resolveRoleRecipe(
      PIPELINE_REQUIRED_MODEL_ROLES,
      { architect: "arch-override" },
      FOUR_ROLE_MODELS
    );
    expect(override.roleModels.architect).toEqual({ id: "arch-override" });
    expect(override.sources.architect).toBe("override");

    const fromDefault = resolveRoleRecipe(
      PIPELINE_REQUIRED_MODEL_ROLES,
      {},
      {
        ...FOUR_ROLE_MODELS,
        architect: { id: "arch-default" },
      }
    );
    expect(fromDefault.roleModels.architect).toEqual({ id: "arch-default" });
    expect(fromDefault.sources.architect).toBe("default");

    expect(() =>
      resolveRoleRecipe(PIPELINE_REQUIRED_MODEL_ROLES, {}, {})
    ).toThrow(/planner, implementer, reviewer, docs/);
    try {
      resolveRoleRecipe(PIPELINE_REQUIRED_MODEL_ROLES, {}, {});
    } catch (error) {
      expect(error).toBeInstanceOf(KickoffError);
      expect(String(error)).not.toMatch(/architect/);
    }
  });
});

describe("b59.1 resolveArchitectSelection", () => {
  it("returns explicit architect or planner fallback without mutating input", () => {
    const explicit = {
      ...FOUR_ROLE_MODELS,
      architect: {
        id: "arch-model",
        params: [{ id: "thinking", value: "high" }],
      },
    };
    expect(
      resolveArchitectSelection(explicit, introspection.roleContract)
    ).toEqual({
      selection: explicit.architect,
      source: "explicit",
    });

    const fallbackInput = { ...FOUR_ROLE_MODELS };
    expect(
      resolveArchitectSelection(fallbackInput, introspection.roleContract)
    ).toEqual({
      selection: FOUR_ROLE_MODELS.planner,
      source: "planner-fallback",
    });
    expect(fallbackInput.architect).toBeUndefined();
  });

  it("preserves planner params on fallback branch", () => {
    const withParams = {
      ...FOUR_ROLE_MODELS,
      planner: {
        id: "planner-model",
        params: [{ id: "thinking", value: "low" }],
      },
    };
    const resolved = resolveArchitectSelection(
      withParams,
      introspection.roleContract
    );
    expect(resolved.source).toBe("planner-fallback");
    expect(resolved.selection.params).toEqual([{ id: "thinking", value: "low" }]);
  });
});

describe("b59.1 gatekeeper fallback regression", () => {
  it("still reports reviewer-fallback for gatekeeper path", () => {
    expect(
      resolveRoleSelectionWithFallback(
        FOUR_ROLE_MODELS,
        PIPELINE_TERMINAL_ROLE,
        PIPELINE_TERMINAL_FALLBACK_ROLE
      )
    ).toEqual({
      selection: FOUR_ROLE_MODELS.reviewer,
      source: "reviewer-fallback",
    });
    expect(
      resolveGatekeeperSelection(FOUR_ROLE_MODELS, introspection.roleContract)
        .source
    ).toBe("reviewer-fallback");
  });
});

describe("b59.1 architectJitPlanningWarning", () => {
  const recipeWithArchitect = {
    ...FOUR_ROLE_MODELS,
    architect: { id: "arch-model" },
  };

  it("warns on jit with explicit architect", () => {
    const warning = architectJitPlanningWarning("jit", recipeWithArchitect);
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/architect/i);
    expect(warning).toMatch(/jit/i);
    expect(warning).not.toMatch(/refus/i);
  });

  it("returns null for full depth or absent architect", () => {
    expect(
      architectJitPlanningWarning("full", recipeWithArchitect)
    ).toBeNull();
    expect(architectJitPlanningWarning("jit", FOUR_ROLE_MODELS)).toBeNull();
  });
});

describe("b59.1 introspection roleContract", () => {
  it("includes skeleton fallback pair alongside terminal gatekeeper pair", () => {
    expect(introspection.roleContract).toMatchObject({
      fallbackRole: "gatekeeper",
      fallbackToRole: "reviewer",
      skeletonFallbackRole: PIPELINE_SKELETON_ROLE,
      skeletonFallbackToRole: PIPELINE_SKELETON_FALLBACK_ROLE,
    });
    expect(introspection.roleContract.optional).toContain("architect");
  });
});

describe("b59.1 CLI help mentions architect", () => {
  it("lists architect among optional roles in help text", () => {
    const helpPath = resolve(
      import.meta.dirname,
      "../packages/cli/src/index.ts"
    );
    const text = readFileSync(helpPath, "utf8");
    expect(text).toMatch(/optional researcher, gatekeeper, and architect/i);
  });
});
