import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_VARIABLES,
  assertThenTargetAllowed,
  buildKickoffVariables,
  normalizeImplementFullyChainVariables,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
  type ThenTargetAutomation,
} from "@lca/shared";
import {
  buildImplementFullyKickoff,
  parseImplementFullyArgs,
} from "../packages/cli/src/implement-fully.ts";

const WORKSPACE_ID = "ws-test";
const FEATURE_ID = "b66";
const FEATURE_SLUG = "b66-pipeline-then-chaining";

const MANUAL_AUTOMATIONS: ThenTargetAutomation[] = [
  {
    configKey: "ship",
    archivedAt: null,
    workspaceId: WORKSPACE_ID,
  },
  {
    configKey: "none",
    archivedAt: null,
    workspaceId: WORKSPACE_ID,
  },
  {
    configKey: `${GENERATED_CONFIG_KEY_PREFIX}final-gate`,
    archivedAt: null,
    workspaceId: WORKSPACE_ID,
  },
  {
    configKey: "archived-ship",
    archivedAt: "2026-01-01T00:00:00.000Z",
    workspaceId: WORKSPACE_ID,
  },
];

function fakeAutomationList(): ThenTargetAutomation[] {
  return MANUAL_AUTOMATIONS;
}

describe("b66 then variable and kickoff resolve", () => {
  describe("parseImplementFullyArgs", () => {
    it("defaults omitted --then to none", () => {
      const parsed = parseImplementFullyArgs(["--feature", FEATURE_ID]);
      expect(parsed.then).toBe("none");
    });

    it("accepts explicit --then none", () => {
      const parsed = parseImplementFullyArgs([
        "--feature",
        FEATURE_ID,
        "--then",
        "none",
      ]);
      expect(parsed.then).toBe("none");
    });

    it("stores a named --then value", () => {
      const parsed = parseImplementFullyArgs([
        "--feature",
        FEATURE_ID,
        "--then",
        "ship",
      ]);
      expect(parsed.then).toBe("ship");
    });

    it("rejects a second --then", () => {
      expect(() =>
        parseImplementFullyArgs([
          "--feature",
          FEATURE_ID,
          "--then",
          "ship",
          "--then",
          "other",
        ])
      ).toThrow(/--then may only be specified once/);
    });

    it("requires a value for --then", () => {
      expect(() =>
        parseImplementFullyArgs(["--feature", FEATURE_ID, "--then"])
      ).toThrow(/--then requires a value/);
    });
  });

  describe("buildKickoffVariables", () => {
    it("defaults then to none and forwards explicit values", () => {
      const omitted = buildKickoffVariables(FEATURE_ID, FEATURE_SLUG, "idea");
      expect(omitted.then).toBe("none");

      const named = buildKickoffVariables(
        FEATURE_ID,
        FEATURE_SLUG,
        "idea",
        "deep",
        "none",
        "normal",
        "ship"
      );
      expect(named.then).toBe("ship");
    });
  });

  describe("normalizeImplementFullyChainVariables", () => {
    it("defaults missing then to none and rejects invalid values", () => {
      const base = {
        pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
        featureId: FEATURE_ID,
        featureSlug: FEATURE_SLUG,
        featureDir: `docs/roadmap/${FEATURE_SLUG}`,
        featureIndex: `docs/roadmap/${FEATURE_SLUG}/00-index.md`,
        idea: "idea",
        planningDepth: "full",
        approvalPolicy: "none",
        researchApprovalPolicy: "none",
        loopMode: "normal",
      };
      expect(normalizeImplementFullyChainVariables(base).then).toBe("none");

      expect(() =>
        normalizeImplementFullyChainVariables({ ...base, then: "" })
      ).toThrow(/Invalid then/);

      expect(() =>
        normalizeImplementFullyChainVariables({ ...base, then: 1 })
      ).toThrow(/Invalid then/);
    });
  });

  describe("assertThenTargetAllowed", () => {
    it("allows none without lookup", () => {
      expect(() =>
        assertThenTargetAllowed("none", fakeAutomationList(), WORKSPACE_ID)
      ).not.toThrow();
    });

    it("rejects generated worker keys", () => {
      expect(() =>
        assertThenTargetAllowed(
          `${GENERATED_CONFIG_KEY_PREFIX}final-gate`,
          fakeAutomationList(),
          WORKSPACE_ID
        )
      ).toThrow(/generated worker/);
    });

    it("rejects missing keys", () => {
      expect(() =>
        assertThenTargetAllowed(
          "missing-key",
          fakeAutomationList(),
          WORKSPACE_ID
        )
      ).toThrow(/not an automation/);
    });

    it("rejects archived automations", () => {
      expect(() =>
        assertThenTargetAllowed(
          "archived-ship",
          fakeAutomationList(),
          WORKSPACE_ID
        )
      ).toThrow(/not an automation/);
    });

    it("allows a real manual key and never maps none to the none automation", () => {
      expect(() =>
        assertThenTargetAllowed("ship", fakeAutomationList(), WORKSPACE_ID)
      ).not.toThrow();

      expect(() =>
        assertThenTargetAllowed("none", fakeAutomationList(), WORKSPACE_ID)
      ).not.toThrow();
    });
  });

  describe("buildImplementFullyKickoff resolve", () => {
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
      ],
      roleDefaults: {
        planner: { id: "planner-default" },
        implementer: { id: "implementer-default" },
        reviewer: { id: "reviewer-default" },
        docs: { id: "docs-default" },
      },
      roleModelProfiles: [
        {
          id: "default",
          label: "Default",
          roleModels: {
            planner: { id: "planner-default" },
            implementer: { id: "implementer-default" },
            reviewer: { id: "reviewer-default" },
            docs: { id: "docs-default" },
          },
        },
      ],
      defaultRoleModelProfileId: "default",
      planningProfiles: [...IMPLEMENT_FULLY_PLANNING_PROFILES],
      defaultPlanningProfileId: DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
    };

    const dryProvision: ProvisionPipelineWorkersResponse = {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      missingSkills: [],
      plan: {
        workspaceId: WORKSPACE_ID,
        dryRun: true,
        applied: false,
        items: [
          {
            key: "plan-skeleton",
            configKey: "generated:plan-skeleton",
            automationId: `${WORKSPACE_ID}::generated:plan-skeleton`,
            action: "unchanged",
          },
        ],
      },
    };

    function mockClient(listAutomations = vi.fn()) {
      return {
        listWorkspaces: vi.fn().mockResolvedValue([
          {
            id: WORKSPACE_ID,
            path: "C:\\Code\\test",
            name: "test",
          },
        ]),
        resolveImplementFullyKickoff: vi.fn().mockResolvedValue({
          featureId: FEATURE_ID,
          featureSlug: FEATURE_SLUG,
          idea: "idea text",
        }),
        getPipeline: vi.fn().mockResolvedValue(introspection),
        listAutomations,
        provisionPipelineWorkers: vi.fn().mockResolvedValue(dryProvision),
      };
    }

    it("stores then none without listing automations", async () => {
      const listAutomations = vi.fn();
      const client = mockClient(listAutomations);
      const built = await buildImplementFullyKickoff(client as never, {
        input: { kind: "feature-id", featureId: FEATURE_ID },
        workspaceQuery: WORKSPACE_ID,
        roleOverrides: {},
        profile: "deep",
        dryRun: true,
        force: false,
        prune: false,
        execute: false,
        then: "none",
      });
      expect(built.kickoff.variables.then).toBe("none");
      expect(listAutomations).not.toHaveBeenCalled();
    });

    it("stores a resolved manual key", async () => {
      const listAutomations = vi
        .fn()
        .mockResolvedValue(
          MANUAL_AUTOMATIONS.map((a) => ({
            ...a,
            id: `${a.workspaceId}::${a.configKey}`,
            name: a.configKey,
            enabled: true,
            status: "enabled",
            origin: "config",
            trigger: { kind: "manual" },
            prompt: "",
            model: null,
            modelSelection: null,
            chain: null,
            configPath: "",
            createdAt: "",
            updatedAt: "",
          }))
        );
      const client = mockClient(listAutomations);
      const built = await buildImplementFullyKickoff(client as never, {
        input: { kind: "feature-id", featureId: FEATURE_ID },
        workspaceQuery: WORKSPACE_ID,
        roleOverrides: {},
        profile: "deep",
        dryRun: true,
        force: false,
        prune: false,
        execute: false,
        then: "ship",
      });
      expect(built.kickoff.variables.then).toBe("ship");
      expect(listAutomations).toHaveBeenCalledOnce();
    });

    it("throws for generated worker keys before provision", async () => {
      const client = mockClient(vi.fn());
      await expect(
        buildImplementFullyKickoff(client as never, {
          input: { kind: "feature-id", featureId: FEATURE_ID },
          workspaceQuery: WORKSPACE_ID,
          roleOverrides: {},
          profile: "deep",
          dryRun: true,
          force: false,
          prune: false,
          execute: false,
          then: `${GENERATED_CONFIG_KEY_PREFIX}final-gate`,
        })
      ).rejects.toThrow(/generated worker/);
      expect(client.provisionPipelineWorkers).not.toHaveBeenCalled();
    });

    it("throws for missing keys before provision", async () => {
      const client = mockClient(
        vi.fn().mockResolvedValue([
          {
            id: `${WORKSPACE_ID}::ship`,
            workspaceId: WORKSPACE_ID,
            configKey: "ship",
            archivedAt: null,
            name: "ship",
            enabled: true,
            status: "enabled",
            origin: "config",
            trigger: { kind: "manual" },
            prompt: "",
            model: null,
            modelSelection: null,
            chain: null,
            configPath: "",
            createdAt: "",
            updatedAt: "",
          },
        ])
      );
      await expect(
        buildImplementFullyKickoff(client as never, {
          input: { kind: "feature-id", featureId: FEATURE_ID },
          workspaceQuery: WORKSPACE_ID,
          roleOverrides: {},
          profile: "deep",
          dryRun: true,
          force: false,
          prune: false,
          execute: false,
          then: "missing-key",
        })
      ).rejects.toThrow(/not an automation/);
      expect(client.provisionPipelineWorkers).not.toHaveBeenCalled();
    });
  });
});
