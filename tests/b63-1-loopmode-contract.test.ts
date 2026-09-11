import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_VARIABLES,
  buildKickoffVariables,
  normalizeImplementFullyChainVariables,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
} from "@lca/shared";
import {
  assertVariablesMatchRequired,
  buildKickoffVariables as cliBuildKickoffVariables,
  parseImplementFullyArgs,
} from "../packages/cli/src/implement-fully.ts";
import {
  assembleKickoffPayload,
  describeLoopModeControlState,
} from "../packages/dashboard/src/pipelineKickoff.ts";

const FEATURE_ID = "b63";
const FEATURE_SLUG = "b63-implement-fully-execute-mode";
const IDEA = "Implement-fully execute mode tests";

const INTROSPECTION: PipelineIntrospectionResponse = {
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
      id: "default",
      label: "Default",
      roleModels: {
        planner: { id: "planner-model" },
        implementer: { id: "implementer-model" },
        reviewer: { id: "reviewer-model" },
        docs: { id: "docs-model" },
      },
    },
  ],
  defaultRoleModelProfileId: "default",
  planningProfiles: [...IMPLEMENT_FULLY_PLANNING_PROFILES],
  defaultPlanningProfileId: DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
};

const PLAN: ProvisionPipelineWorkersResponse = {
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

describe("b63.1 loopMode kickoff contract", () => {
  it("buildKickoffVariables yields ten keys with loopMode default normal or execute", () => {
    const normal = buildKickoffVariables(FEATURE_ID, FEATURE_SLUG, IDEA);
    expect(Object.keys(normal).sort()).toEqual(
      [...IMPLEMENT_FULLY_VARIABLES].sort()
    );
    expect(normal.loopMode).toBe("normal");

    const execute = buildKickoffVariables(
      FEATURE_ID,
      FEATURE_SLUG,
      IDEA,
      "deep",
      "none",
      "execute"
    );
    expect(Object.keys(execute)).toHaveLength(10);
    expect(execute.loopMode).toBe("execute");

    const cliNormal = cliBuildKickoffVariables(FEATURE_ID, FEATURE_SLUG, IDEA);
    expect(cliNormal.loopMode).toBe("normal");
    assertVariablesMatchRequired(cliNormal, [...IMPLEMENT_FULLY_VARIABLES]);
  });

  it("normalizeImplementFullyChainVariables defaults, validates, and refuses execute+jit", () => {
    const nineKey = {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: FEATURE_ID,
      featureSlug: FEATURE_SLUG,
      featureDir: `docs/roadmap/done/${FEATURE_SLUG}`,
      featureIndex: `docs/roadmap/done/${FEATURE_SLUG}/00-index.md`,
      idea: IDEA,
      planningDepth: "full",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
    };
    const before = { ...nineKey };
    const normalized = normalizeImplementFullyChainVariables(nineKey);
    expect(nineKey).toEqual(before);
    expect(normalized).not.toBe(nineKey);
    expect(normalized.loopMode).toBe("normal");

    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        loopMode: 1,
      })
    ).toThrow(/Invalid loopMode/);

    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        loopMode: "turbo",
      })
    ).toThrow(/Invalid loopMode/);

    expect(() =>
      normalizeImplementFullyChainVariables({
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        loopMode: "execute",
        planningDepth: "jit",
      })
    ).toThrow(/loopMode "execute" with planningDepth "jit"/);

    const other = { pipelineId: "other-pipe", foo: "bar" };
    expect(normalizeImplementFullyChainVariables(other)).toBe(other);
  });

  it("parseImplementFullyArgs accepts --execute with deep/guided and rejects Quick/JIT", () => {
    expect(() =>
      parseImplementFullyArgs(["--feature", FEATURE_ID, "--execute"])
    ).toThrow(/--execute requires full upfront planning/);
    expect(() =>
      parseImplementFullyArgs([
        "--feature",
        FEATURE_ID,
        "--execute",
        "--profile",
        "quick",
      ])
    ).toThrow(/--execute requires full upfront planning/);

    const deep = parseImplementFullyArgs([
      "--feature",
      FEATURE_ID,
      "--execute",
      "--profile",
      "deep",
    ]);
    expect(deep.execute).toBe(true);
    expect(deep.profile).toBe("deep");

    const guided = parseImplementFullyArgs([
      "--feature",
      FEATURE_ID,
      "--execute",
      "--profile",
      "guided",
    ]);
    expect(guided.execute).toBe(true);
    expect(guided.profile).toBe("guided");
  });

  it("dashboard assembleKickoffPayload and loopMode control parity", () => {
    const payload = assembleKickoffPayload({
      introspection: INTROSPECTION,
      plan: PLAN,
      feature: FEATURE_ID,
      slug: FEATURE_SLUG,
      idea: IDEA,
      roleOverrides: {},
      profileId: "deep",
      loopMode: "execute",
    });
    expect(payload.variables?.loopMode).toBe("execute");

    const jitControl = describeLoopModeControlState({
      profileId: "quick",
      execute: true,
    });
    expect(jitControl.enabled).toBe(false);
    expect(jitControl.effectiveLoopMode).toBe("normal");
    expect(jitControl.disabledReason).toMatch(/full upfront planning/i);

    const deepControl = describeLoopModeControlState({
      profileId: "deep",
      execute: true,
    });
    expect(deepControl.enabled).toBe(true);
    expect(deepControl.effectiveLoopMode).toBe("execute");
  });
});
