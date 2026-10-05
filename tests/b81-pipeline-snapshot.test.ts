import { describe, expect, it } from "vitest";
import type { Automation } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_VARIABLES,
  buildPipelineSnapshot,
  classifyPipelineOutcome,
  normalizeImplementFullyChainVariables,
  type BuildPipelineSnapshotInput,
  type PipelineSnapshotRunInput,
} from "@lca/shared";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  collectPipelineDoctorFacts,
  formatPipelineBlockLines,
} from "../packages/cli/src/doctor.ts";

const NOW = Date.parse("2026-07-10T14:00:00.000Z");

const CHAIN_CONTEXT = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b81",
    featureSlug: "b81-snapshot",
    featureDir: "docs/roadmap/b81-snapshot",
    featureIndex: "docs/roadmap/b81-snapshot/00-index.md",
    idea: "SECRET_IDEA",
    planningDepth: "full",
    approvalPolicy: "none",
    researchApprovalPolicy: "none",
    loopMode: "normal",
    roleModelProfileId: "balanced",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

function runInput(
  overrides: Partial<PipelineSnapshotRunInput> & { id: string }
): PipelineSnapshotRunInput {
  return {
    id: overrides.id,
    automationId: overrides.automationId ?? "ws::generated:implement",
    workspaceId: overrides.workspaceId ?? "ws-1",
    status: overrides.status ?? "running",
    parentRunId: overrides.parentRunId ?? null,
    chainRootRunId: overrides.chainRootRunId ?? "root-11111111",
    chainDepth: overrides.chainDepth ?? 1,
    chainMaxDepth: overrides.chainMaxDepth ?? 9,
    chainMaxDepthOverride: overrides.chainMaxDepthOverride ?? null,
    chainStopRequestedAt: overrides.chainStopRequestedAt ?? null,
    chainStopReason: overrides.chainStopReason ?? null,
    chainHandledAt: overrides.chainHandledAt ?? null,
    chainContext: overrides.chainContext,
    pipeline: overrides.pipeline ?? null,
    pipelineWave: overrides.pipelineWave ?? null,
    pipelineTrack: overrides.pipelineTrack ?? null,
    triggerKind: overrides.triggerKind ?? "chain",
    model: overrides.model ?? "implementer-model",
    startedAt: overrides.startedAt ?? "2026-07-10 12:00:00",
    endedAt: overrides.endedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-07-10 12:00:00",
  };
}

function baseInput(
  runs: PipelineSnapshotRunInput[],
  overrides: Partial<BuildPipelineSnapshotInput> = {}
): BuildPipelineSnapshotInput {
  return {
    rootRunId: "root-11111111",
    runs,
    automations: [
      {
        id: "ws::generated:plan-skeleton",
        configKey: `${GENERATED_CONFIG_KEY_PREFIX}plan-skeleton`,
        modelRole: "architect",
      },
      {
        id: "ws::generated:implement",
        configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
        modelRole: "implementer",
      },
      {
        id: "ws::generated:final-gate",
        configKey: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY}`,
        modelRole: "gatekeeper",
      },
    ],
    events: [],
    inputRequests: [],
    cursor: 42,
    ...overrides,
  };
}

describe("buildPipelineSnapshot projection", () => {
  it("reports feature metadata, role profile id, and current step", () => {
    const snapshot = buildPipelineSnapshot(
      baseInput([
        runInput({
          id: "root-11111111",
          automationId: "ws::generated:plan-skeleton",
          chainRootRunId: null,
          chainDepth: 0,
          status: "completed",
          endedAt: "2026-07-10 12:30:00",
          chainContext: CHAIN_CONTEXT,
          pipeline: {
            pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
            featureId: "b81",
            featureSlug: "b81-snapshot",
          },
        }),
        runInput({
          id: "child-22222222",
          parentRunId: "root-11111111",
          chainDepth: 1,
          status: "running",
        }),
      ]),
      NOW
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot!.featureId).toBe("b81");
    expect(snapshot!.featureSlug).toBe("b81-snapshot");
    expect(snapshot!.pipelineId).toBe(IMPLEMENT_FULLY_PIPELINE_ID);
    expect(snapshot!.roleModelProfileId).toBe("balanced");
    expect(snapshot!.current?.runId).toBe("child-22222222");
    expect(snapshot!.current?.lastActivity).toBeNull();
    expect(snapshot!.steps).toHaveLength(2);
    expect(snapshot!.steps[1]?.stepLabel).toMatch(/implement/);
    expect(snapshot!.outcome).toBe("running");
    expect(JSON.stringify(snapshot)).not.toContain("SECRET_IDEA");
  });

  it("projects waiting input without requiring lifecycle events", () => {
    const snapshot = buildPipelineSnapshot(
      baseInput(
        [
          runInput({
            id: "root-11111111",
            automationId: "ws::generated:implement",
            chainRootRunId: null,
            chainDepth: 0,
            status: "needs_input",
            chainContext: CHAIN_CONTEXT,
          }),
        ],
        {
          events: [],
          inputRequests: [
            {
              id: "in-1",
              runId: "root-11111111",
              status: "pending",
              question: "Continue?",
              metadata: { kind: "approval" },
              createdAt: "2026-07-10 13:00:00",
            },
          ],
        }
      ),
      NOW
    );

    expect(snapshot!.waiting).toEqual({
      inputRequestId: "in-1",
      runId: "root-11111111",
      kind: "approval",
      question: "Continue?",
      createdAt: "2026-07-10 13:00:00",
    });
    expect(snapshot!.outcome).toBe("running");
    expect(snapshot!.halt).toBeNull();
  });

  it("projects a recoverable halt with a recovery command", () => {
    const snapshot = buildPipelineSnapshot(
      baseInput(
        [
          runInput({
            id: "root-11111111",
            automationId: "ws::generated:implement",
            chainRootRunId: null,
            chainDepth: 0,
            status: "failed",
            endedAt: "2026-07-10 12:20:00",
            chainHandledAt: null,
            chainContext: CHAIN_CONTEXT,
          }),
        ],
        { events: [] }
      ),
      NOW
    );

    expect(snapshot!.outcome).toBe("failed");
    expect(snapshot!.halt).toEqual({
      runId: "root-11111111",
      code: "failed",
      detail: null,
      recoveryCommand:
        "lca escalate root-111 retry|skip|abort [--reason <text>]",
    });
  });

  it("freezes terminal step duration at endedAt", () => {
    const snapshot = buildPipelineSnapshot(
      baseInput([
        runInput({
          id: "root-11111111",
          automationId: "ws::generated:plan-skeleton",
          chainRootRunId: null,
          chainDepth: 0,
          status: "completed",
          startedAt: "2026-07-10 12:00:00",
          endedAt: "2026-07-10 12:10:00",
          chainContext: CHAIN_CONTEXT,
        }),
      ]),
      NOW
    );

    const step = snapshot!.steps[0];
    expect(step?.durationMs).toBe(10 * 60 * 1000);
  });

  it("keeps running step duration open against injected now", () => {
    const snapshot = buildPipelineSnapshot(
      baseInput([
        runInput({
          id: "root-11111111",
          automationId: "ws::generated:implement",
          chainRootRunId: null,
          chainDepth: 0,
          status: "running",
          startedAt: "2026-07-10T13:00:00.000Z",
        }),
      ]),
      NOW
    );

    const step = snapshot!.steps[0];
    expect(step?.durationMs).toBe(60 * 60 * 1000);
  });
});

describe("classifyPipelineOutcome", () => {
  const finalGateKey = `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY}`;

  it("returns running while any lineage row is non-terminal", () => {
    expect(
      classifyPipelineOutcome({
        runs: [
          {
            status: "completed",
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
            chainStopRequestedAt: null,
            chainStopReason: null,
            chainHandledAt: "2026-07-10 12:10:00",
            createdAt: "2026-07-10 12:00:00",
          },
          {
            status: "running",
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}review`,
            chainStopRequestedAt: null,
            chainStopReason: null,
            chainHandledAt: null,
            createdAt: "2026-07-10 12:05:00",
          },
        ],
        finalGateConfigKey: finalGateKey,
      })
    ).toBe("running");
  });

  it("returns green for completed final gate with complete: stop reason", () => {
    expect(
      classifyPipelineOutcome({
        runs: [
          {
            status: "completed",
            configKey: finalGateKey,
            chainStopRequestedAt: "2026-07-10 12:20:00",
            chainStopReason: "complete: tracker dry",
            chainHandledAt: null,
            createdAt: "2026-07-10 12:15:00",
          },
        ],
        finalGateConfigKey: finalGateKey,
      })
    ).toBe("green");
  });

  it("returns blocked and deadlock from stop reason prefixes", () => {
    expect(
      classifyPipelineOutcome({
        runs: [
          {
            status: "completed",
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
            chainStopRequestedAt: null,
            chainStopReason: "blocked: needs operator",
            chainHandledAt: null,
            createdAt: "2026-07-10 12:00:00",
          },
        ],
        finalGateConfigKey: finalGateKey,
      })
    ).toBe("blocked");

    expect(
      classifyPipelineOutcome({
        runs: [
          {
            status: "completed",
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
            chainStopRequestedAt: null,
            chainStopReason: "deadlock: tracker",
            chainHandledAt: null,
            createdAt: "2026-07-10 12:00:00",
          },
        ],
        finalGateConfigKey: finalGateKey,
      })
    ).toBe("deadlock");
  });

  it("returns aborted for operator stop reasons and failed for unrecovered halts", () => {
    expect(
      classifyPipelineOutcome({
        runs: [
          {
            status: "cancelled",
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
            chainStopRequestedAt: "2026-07-10 12:10:00",
            chainStopReason: "aborted: operator gave up",
            chainHandledAt: null,
            createdAt: "2026-07-10 12:00:00",
          },
        ],
        finalGateConfigKey: finalGateKey,
      })
    ).toBe("aborted");

    expect(
      classifyPipelineOutcome({
        runs: [
          {
            status: "failed",
            configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
            chainStopRequestedAt: null,
            chainStopReason: null,
            chainHandledAt: null,
            createdAt: "2026-07-10 12:00:00",
          },
        ],
        finalGateConfigKey: finalGateKey,
      })
    ).toBe("failed");
  });
});

describe("doctor adapter and kickoff profile id", () => {
  function automation(): Automation {
    return {
      id: "ws::generated:implement",
      workspaceId: "ws-1",
      name: "implement",
      enabled: true,
      status: "enabled",
      origin: "generated",
      trigger: { type: "manual" },
      prompt: "x",
      model: null,
      modelSelection: null,
      modelRole: "implementer",
      chain: { next: "generated:review", when: "completed" },
      configPath: "generated.yaml",
      configKey: `${GENERATED_CONFIG_KEY_PREFIX}implement`,
      archivedAt: null,
      createdAt: "2026-07-10 12:00:00",
      updatedAt: "2026-07-10 12:00:00",
    };
  }

  function runSnapshot(run: PipelineSnapshotRunInput): RunSnapshot {
    return {
      run: {
        id: run.id,
        status: run.status,
        automation_id: run.automationId,
        workspace_id: run.workspaceId,
        trigger_kind: run.triggerKind ?? "chain",
        started_at: run.startedAt,
        ended_at: run.endedAt,
        created_at: run.createdAt,
        parent_run_id: run.parentRunId,
        chain_root_run_id: run.chainRootRunId ?? run.id,
        chain_depth: run.chainDepth,
        chain_max_depth: run.chainMaxDepth,
        chain_max_depth_override: run.chainMaxDepthOverride,
        chain_context_json: JSON.stringify(CHAIN_CONTEXT),
        chain_stop_requested_at: run.chainStopRequestedAt,
        chain_stop_reason: run.chainStopReason,
        chain_handled_at: run.chainHandledAt,
      },
      events: [],
      inputRequests: [],
    };
  }

  it("renders the same doctor pipeline block through the snapshot adapter", () => {
    const run = runInput({
      id: "child-22222222",
      parentRunId: "root-11111111",
      chainRootRunId: "root-11111111",
      chainDepth: 1,
      status: "running",
    });
    const pipeline = buildPipelineSnapshot(
      baseInput([
        runInput({
          id: "root-11111111",
          automationId: "ws::generated:plan-skeleton",
          chainRootRunId: null,
          chainDepth: 0,
          status: "completed",
          endedAt: "2026-07-10 12:30:00",
          chainContext: CHAIN_CONTEXT,
        }),
        run,
      ]),
      NOW
    );
    const detail = runSnapshot(run);
    const auto = automation();
    const legacy = collectPipelineDoctorFacts(detail, auto);
    const adapted = collectPipelineDoctorFacts(detail, auto, pipeline);
    expect(legacy).not.toBeNull();
    expect(adapted).not.toBeNull();
    expect(formatPipelineBlockLines(adapted!)).toEqual(
      formatPipelineBlockLines(legacy!)
    );
    expect(formatPipelineBlockLines(adapted!).join("\n")).not.toContain(
      "SECRET_IDEA"
    );
  });

  it("keeps roleModelProfileId optional and out of required kickoff variables", () => {
    expect(IMPLEMENT_FULLY_VARIABLES).not.toContain("roleModelProfileId");
    const required = {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId: "b81",
      featureSlug: "b81-snapshot",
      featureDir: "docs/roadmap/b81-snapshot",
      featureIndex: "docs/roadmap/b81-snapshot/00-index.md",
      idea: "idea",
      planningDepth: "full" as const,
      approvalPolicy: "none" as const,
      researchApprovalPolicy: "none" as const,
      loopMode: "normal" as const,
    };
    expect(normalizeImplementFullyChainVariables(required)).not.toHaveProperty(
      "roleModelProfileId"
    );
    expect(
      normalizeImplementFullyChainVariables({
        ...required,
        roleModelProfileId: "balanced",
      }).roleModelProfileId
    ).toBe("balanced");
  });
});
