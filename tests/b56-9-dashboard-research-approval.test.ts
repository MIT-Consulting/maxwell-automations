import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  DEFAULT_ROLE_MODEL_PROFILE_ID,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  IMPLEMENT_FULLY_VARIABLES,
  type ModelSelection,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
} from "@lca/shared";
import {
  assembleKickoffPayload,
  describeKickoffReviewFacts,
  describeResearchApprovalControlState,
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

const RESEARCHER_SELECTION: ModelSelection = {
  id: "fable-research",
  params: [{ id: "thinking", value: "high" }],
};

const GATEKEEPER_SELECTION: ModelSelection = { id: "fable-gate" };

const SIX_ROLE_DEFAULTS = {
  ...FOUR_ROLE_DEFAULTS,
  researcher: RESEARCHER_SELECTION,
  gatekeeper: GATEKEEPER_SELECTION,
};

function kickoffFixtures(opts?: {
  roleDefaults?: Partial<Record<string, ModelSelection>>;
}): {
  introspection: PipelineIntrospectionResponse;
  plan: ProvisionPipelineWorkersResponse;
} {
  const roleDefaults = opts?.roleDefaults ?? FOUR_ROLE_DEFAULTS;
  const introspection: PipelineIntrospectionResponse = {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    entryWorkerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
    entryWorkerConfigKey: `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
    roleContract: {
      required: ["planner", "implementer", "reviewer", "docs"],
      optional: ["researcher", "gatekeeper", "architect"],
      conditionalEntryRole: "researcher",
      conditionalEntryWorkerKey: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
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
        key: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
        name: "Plan skeleton",
        modelRole: "planner",
        chain: { next: "plan-phase", when: "completed" },
      },
      {
        key: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
        name: "Research",
        modelRole: "researcher",
        chain: { next: IMPLEMENT_FULLY_ENTRY_WORKER_KEY, when: "completed" },
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
    roleDefaults: { ...roleDefaults },
    roleModelProfiles: [
      {
        id: DEFAULT_ROLE_MODEL_PROFILE_ID,
        label: "Default",
        roleModels: { ...roleDefaults },
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
          key: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
          configKey: `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
          automationId: `ws::generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
          action: "unchanged",
        },
        {
          key: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
          configKey: `generated:${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
          automationId: `ws::generated:${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
          action: "create",
        },
      ],
    },
  };
  return { introspection, plan };
}

describe("b56.9 describeResearchApprovalControlState", () => {
  it("resolves researcher via override and preserves an armed policy", () => {
    const state = describeResearchApprovalControlState({
      roleOverrides: { researcher: "fable-research" },
      roleDefaults: FOUR_ROLE_DEFAULTS,
      researchApprovalPolicy: "before-planning",
    });
    expect(state).toEqual({
      researcherResolved: true,
      enabled: true,
      effectivePolicy: "before-planning",
    });
  });

  it("resolves researcher via profile default and preserves an armed policy", () => {
    const state = describeResearchApprovalControlState({
      roleOverrides: {},
      roleDefaults: SIX_ROLE_DEFAULTS,
      researchApprovalPolicy: "before-planning",
    });
    expect(state).toEqual({
      researcherResolved: true,
      enabled: true,
      effectivePolicy: "before-planning",
    });
  });

  it("disables the control and coerces before-planning to none without a researcher", () => {
    const state = describeResearchApprovalControlState({
      roleOverrides: {},
      roleDefaults: FOUR_ROLE_DEFAULTS,
      researchApprovalPolicy: "before-planning",
    });
    expect(state).toEqual({
      researcherResolved: false,
      enabled: false,
      effectivePolicy: "none",
    });
  });

  it("treats null roleDefaults as no researcher unless override supplies one", () => {
    expect(
      describeResearchApprovalControlState({
        roleOverrides: {},
        roleDefaults: null,
        researchApprovalPolicy: "before-planning",
      }).effectivePolicy
    ).toBe("none");
    expect(
      describeResearchApprovalControlState({
        roleOverrides: { researcher: "fable" },
        roleDefaults: null,
        researchApprovalPolicy: "before-planning",
      })
    ).toEqual({
      researcherResolved: true,
      enabled: true,
      effectivePolicy: "before-planning",
    });
  });
});

describe("b56.9 assembleKickoffPayload research approval wiring", () => {
  it("six-role armed policy puts before-planning on research entry", () => {
    const { introspection, plan } = kickoffFixtures({
      roleDefaults: SIX_ROLE_DEFAULTS,
    });
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b56",
      slug: "b56-optional-researcher-gatekeeper",
      idea: "Optional researcher and gatekeeper.",
      roleOverrides: {},
      researchApprovalPolicy: "before-planning",
    });
    expect(payload.automationId).toBe(
      `ws::generated:${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`
    );
    expect(payload.variables?.researchApprovalPolicy).toBe("before-planning");
    expect(payload.modelSelection).toEqual(RESEARCHER_SELECTION);
  });

  it("four-role kickoff stays none on plan-skeleton", () => {
    const { introspection, plan } = kickoffFixtures();
    const payload = assembleKickoffPayload({
      introspection,
      plan,
      feature: "b56",
      slug: "b56-optional-researcher-gatekeeper",
      idea: "Optional researcher and gatekeeper.",
      roleOverrides: {},
    });
    expect(payload.automationId).toBe(
      `ws::generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
    );
    expect(payload.variables?.researchApprovalPolicy).toBe("none");
    expect(payload.modelSelection).toEqual(FOUR_ROLE_DEFAULTS.planner);
  });
});

describe("b56.9 describeKickoffReviewFacts for review screen", () => {
  it("four-role recipe reports disabled researcher and reviewer-fallback", () => {
    const { introspection } = kickoffFixtures();
    const facts = describeKickoffReviewFacts({
      introspection,
      roleModels: FOUR_ROLE_DEFAULTS,
    });
    expect(facts).toEqual({
      entryWorkerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      rootRole: "planner",
      researcher: null,
      researchApprovalPolicy: "none",
      architect: FOUR_ROLE_DEFAULTS.planner,
      architectSource: "planner-fallback",
      gatekeeper: FOUR_ROLE_DEFAULTS.reviewer,
      gatekeeperSource: "reviewer-fallback",
    });
  });

  it("six-role recipe reports researcher, before-planning, and explicit gatekeeper", () => {
    const { introspection } = kickoffFixtures({
      roleDefaults: SIX_ROLE_DEFAULTS,
    });
    const facts = describeKickoffReviewFacts({
      introspection,
      roleModels: SIX_ROLE_DEFAULTS,
      researchApprovalPolicy: "before-planning",
    });
    expect(facts.entryWorkerKey).toBe(IMPLEMENT_FULLY_RESEARCH_WORKER_KEY);
    expect(facts.researcher).toEqual(RESEARCHER_SELECTION);
    expect(facts.researchApprovalPolicy).toBe("before-planning");
    expect(facts.architect).toEqual(SIX_ROLE_DEFAULTS.planner);
    expect(facts.architectSource).toBe("planner-fallback");
    expect(facts.gatekeeper).toEqual(GATEKEEPER_SELECTION);
    expect(facts.gatekeeperSource).toBe("explicit");
  });
});

describe("b56.9 PipelineKickoffModal source contracts", () => {
  const modalSrc = readSrc("packages/dashboard/src/PipelineKickoffModal.tsx");
  const helperSrc = readSrc("packages/dashboard/src/pipelineKickoff.ts");

  it("reads roleContract required/optional via the ordered Models rows", () => {
    expect(modalSrc).toContain("roleContract.required");
    expect(modalSrc).toContain("roleContract.optional");
    expect(modalSrc).toContain("ROLE_DISPLAY_ORDER.map");
    // Rows are gated by contract membership — not a bare PIPELINE_MODEL_ROLES loop.
    expect(modalSrc).toMatch(
      /ROLE_DISPLAY_ORDER\.map\(\(typedRole\)[\s\S]*roleContract\.required[\s\S]*roleContract\.optional/
    );
    expect(modalSrc).not.toMatch(/PIPELINE_MODEL_ROLES\.map\(\(role\)/);
    // Shared ModelSelect (same control as chat) owns catalog params.
    expect(modalSrc).toContain("<ModelSelect");
    expect(modalSrc).toContain('from "./ModelSelect"');
  });

  it("imports and calls describeKickoffReviewFacts and the control-state helper", () => {
    expect(helperSrc).toContain("export function describeResearchApprovalControlState");
    expect(modalSrc).toContain("describeKickoffReviewFacts");
    expect(modalSrc).toContain("describeResearchApprovalControlState");
    expect(modalSrc).toMatch(/describeKickoffReviewFacts\(\{/);
    expect(modalSrc).toMatch(/describeResearchApprovalControlState\(\{/);
  });

  it("passes research approval policy into assembleKickoffPayload and pre-validation", () => {
    expect(modalSrc).toMatch(
      /assembleKickoffPayload\(\{[\s\S]*researchApprovalPolicy:\s*effectivePolicy/
    );
    expect(modalSrc).toMatch(
      /buildKickoffVariables\(\s*resolvedTriple\.featureId,\s*resolvedTriple\.featureSlug,\s*resolvedTriple\.idea,\s*profileId,\s*effectivePolicy,\s*loopModeControl\.effectiveLoopMode\s*\)/
    );
  });

  it("contains exact option labels and optional default labels", () => {
    expect(modalSrc).toContain("Auto-continue");
    expect(modalSrc).toContain("Review first");
    expect(modalSrc).toContain("Disabled");
    expect(modalSrc).toContain("Reviewer fallback");
    expect(modalSrc).toContain("Planner fallback");
  });

  it("exposes every stable data-* hook for Phase 10", () => {
    expect(modalSrc).toContain("data-pipeline-role={typedRole}");
    expect(modalSrc).toContain("data-role-active={isOn}");
    expect(modalSrc).toContain('data-review-fact="entry-worker"');
    expect(modalSrc).toContain('data-review-fact="researcher"');
    expect(modalSrc).toContain('data-review-fact="research-approval"');
    expect(modalSrc).toContain('data-review-fact="architect"');
    expect(modalSrc).toContain('data-review-fact="gatekeeper"');
  });

  it("drives the control from the effective policy and resets a stale armed policy", () => {
    expect(modalSrc).toContain("researchApprovalControl.effectivePolicy");
    expect(modalSrc).toContain("researchApprovalControl.enabled");
    expect(modalSrc).toMatch(
      /!researchApprovalControl\.enabled &&[\s\S]{0,120}researchApprovalPolicy !== "none"[\s\S]{0,120}setResearchApprovalPolicy\("none"\)/
    );
  });

  it("resets research approval on workspace change and clears review facts", () => {
    expect(modalSrc).toContain('setResearchApprovalPolicy("none")');
    expect(modalSrc).toContain("setReviewFacts(null)");
    expect(modalSrc).toMatch(
      /const clearReviewArtifacts = \(\): void => \{[\s\S]*setReviewFacts\(null\)/
    );
  });
});
