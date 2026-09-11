import { describe, expect, it } from "vitest";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  IMPLEMENT_FULLY_VARIABLES,
  PIPELINE_REQUIRED_MODEL_ROLES,
  assertVariablesMatchRequired,
  buildKickoffVariables,
  requiredRolesFromWorkers,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
} from "@lca/shared";
import { assembleKickoffPayload } from "../packages/dashboard/src/pipelineKickoff.ts";
import {
  IMPLEMENT_FULLY_DEFINITION,
  IMPLEMENT_FULLY_WORKERS,
  toPipelineIntrospection,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { extractImplementFullyHandoff } from "../packages/daemon/src/runs/pipeline-handoff.ts";

const FOUR_ROLE_DEFAULTS = {
  planner: { id: "planner-model" },
  implementer: { id: "implementer-model" },
  reviewer: { id: "reviewer-model" },
  docs: { id: "docs-model" },
};

const introspection = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
  pipelineRoleModels: FOUR_ROLE_DEFAULTS,
  pipelineRoleModelProfiles: {},
  defaultPipelineRoleModelProfile: null,
});

function researchPacket(overrides?: {
  worker?: string;
  outcome?: string;
}): string {
  const worker = overrides?.worker ?? IMPLEMENT_FULLY_RESEARCH_WORKER_KEY;
  const outcome = overrides?.outcome ?? "researched";
  return [
    "```text",
    "lca-handoff",
    "version: 1",
    `pipeline: ${IMPLEMENT_FULLY_PIPELINE_ID}`,
    `worker: ${worker}`,
    "feature: b56",
    "phase: -",
    `outcome: ${outcome}`,
    "summary: Durable research written",
    "artifacts:",
    "- docs/roadmap/b56-x/research.md",
    "decisions:",
    "- none",
    "deviations:",
    "- none",
    "verification:",
    "- none",
    "risks:",
    "- none",
    "downstream-effects:",
    "- plan-skeleton consumes research.md",
    "next: plan-skeleton drafts the PRD and tracker from research.md",
    "```",
  ].join("\n");
}

describe("b56.2 research worker registration", () => {
  it("registers research at the end with researcher role and plan-skeleton edge", () => {
    const research = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === IMPLEMENT_FULLY_RESEARCH_WORKER_KEY
    );
    expect(research).toBeDefined();
    expect(research!.modelRole).toBe("researcher");
    expect(research!.enabled).toBe(true);
    expect(research!.trigger).toEqual({ type: "manual" });
    expect(research!.chain).toEqual({
      next: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
      when: "completed",
      passResult: true,
    });

    expect(IMPLEMENT_FULLY_WORKERS[0]!.key).toBe(
      IMPLEMENT_FULLY_ENTRY_WORKER_KEY
    );
    expect(
      IMPLEMENT_FULLY_WORKERS.slice(
        1,
        1 + IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length
      ).map((w) => w.key)
    ).toEqual([...IMPLEMENT_FULLY_LOOP_WORKER_KEYS]);
    expect(IMPLEMENT_FULLY_WORKERS.at(-1)!.key).toBe(
      IMPLEMENT_FULLY_RESEARCH_WORKER_KEY
    );
    expect(
      (IMPLEMENT_FULLY_LOOP_WORKER_KEYS as readonly string[]).includes(
        IMPLEMENT_FULLY_RESEARCH_WORKER_KEY
      )
    ).toBe(false);
  });

  it("bounds the research prompt and forbids planning / control side effects", () => {
    const research = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === IMPLEMENT_FULLY_RESEARCH_WORKER_KEY
    )!;
    const prompt = research.prompt;
    expect(prompt).toContain("research.md");
    expect(prompt).toContain("## Findings");
    expect(prompt).toContain("## Recommendation");
    expect(prompt).toContain("## Risks");
    expect(prompt).toContain("## Open Questions");
    expect(prompt).toContain("{{researchApprovalPolicy}}");
    expect(prompt).toMatch(/prd\.md/);
    expect(prompt).toContain("00-index.md");
    expect(prompt).toMatch(/phase file/i);
    expect(prompt).toMatch(/[Cc]ommit/);
    expect(prompt).toContain("chain_control");
    expect(prompt).toContain("pipeline_wave");
  });
});

describe("b56.2 handoff validation", () => {
  it("accepts research / researched and keeps unknown workers refused", () => {
    const researchOk = extractImplementFullyHandoff(researchPacket(), {
      expectedWorker: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
    });
    expect(researchOk.ok).toBe(true);

    const researchedOnImplement = extractImplementFullyHandoff(
      researchPacket({ worker: "implement", outcome: "researched" }),
      { expectedWorker: "implement" }
    );
    expect(researchedOnImplement.ok).toBe(true);

    const unknown = extractImplementFullyHandoff(
      researchPacket({ worker: "not-a-worker" }),
      { expectedWorker: "not-a-worker" }
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe("wrong-worker");
    }
  });
});

describe("b56.2 kickoff variables and inertness", () => {
  it("defaults researchApprovalPolicy and keeps ten-key required match", () => {
    const defaults = buildKickoffVariables(
      "b56",
      "b56-optional-researcher-gatekeeper",
      "optional researcher"
    );
    expect(defaults.researchApprovalPolicy).toBe("none");
    expect(
      buildKickoffVariables(
        "b56",
        "b56-optional-researcher-gatekeeper",
        "optional researcher",
        "quick",
        "before-planning"
      ).researchApprovalPolicy
    ).toBe("before-planning");
    assertVariablesMatchRequired(defaults, introspection.requiredVariables);
    expect(Object.keys(defaults)).toHaveLength(10);
    expect(IMPLEMENT_FULLY_VARIABLES).toHaveLength(10);
  });

  it("keeps introspection entry at plan-skeleton with eight workers", () => {
    expect(introspection.workers).toHaveLength(8);
    expect(introspection.entryWorkerKey).toBe(IMPLEMENT_FULLY_ENTRY_WORKER_KEY);
    expect(introspection.roleContract.conditionalEntryWorkerKey).toBe(
      IMPLEMENT_FULLY_RESEARCH_WORKER_KEY
    );
  });

  it("keeps researcher out of required roles now that a researcher worker exists", () => {
    expect(requiredRolesFromWorkers(introspection.workers)).toContain(
      "researcher"
    );
    expect(introspection.roleContract.required).not.toContain("researcher");
    expect([...introspection.roleContract.required]).toEqual([
      ...PIPELINE_REQUIRED_MODEL_ROLES,
    ]);
  });

  it("four-role assembleKickoffPayload still targets plan-skeleton planner", () => {
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
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
            automationId: `ws::${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`,
            action: "unchanged",
          },
          {
            key: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
            automationId: `ws::${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_RESEARCH_WORKER_KEY}`,
            action: "create",
          },
        ],
      },
    };
    const live: PipelineIntrospectionResponse = introspection;
    const payload = assembleKickoffPayload({
      introspection: live,
      plan,
      feature: "b56",
      slug: "b56-optional-researcher-gatekeeper",
      idea: "optional researcher",
      roleOverrides: {},
    });
    expect(payload.automationId).toBe(
      `ws::${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
    );
    expect(payload.modelSelection).toEqual(FOUR_ROLE_DEFAULTS.planner);
    expect(payload.variables?.researchApprovalPolicy).toBe("none");
  });
});

describe("b56.2 planner prompt consumes research.md", () => {
  it("instructs plan-skeleton to read and preserve research.md", () => {
    const skeleton = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === IMPLEMENT_FULLY_ENTRY_WORKER_KEY
    )!;
    expect(skeleton.prompt).toContain("research.md");
    expect(skeleton.prompt).toMatch(/[Nn]ever delete|[Nn]ever.*rewrite|preserve/);
    expect(skeleton.prompt).toMatch(/[Nn]ever paste/);
  });
});
