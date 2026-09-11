import { describe, expect, it } from "vitest";
import type {
  PipelineHaltRecoveryDecision,
  PipelineHaltRecoveryDeclineCode,
  RunEscalationRefusal,
} from "@lca/shared";
import {
  classifyPipelineHaltRecovery,
  interpretLineage,
  ladderActionFor,
  type AutoEscalationEventFact,
  type AutoEscalationInput,
  type AutoEscalationLineageFact,
  type AutoEscalationPolicy,
} from "../packages/daemon/src/runs/auto-escalation.ts";
import type { RunRow } from "../packages/daemon/src/runs/store.ts";

const ROOT = "root-aaaaaaaa";
const RUN_ID = "run-bbbbbbbb";

const VALID_CONTEXT = JSON.stringify({
  variables: {
    pipelineId: "implement-fully",
    featureId: "b43",
    featureSlug: "b43-unattended-halt-recovery",
    featureDir: "docs/roadmap/b43-unattended-halt-recovery",
    featureIndex: "docs/roadmap/b43-unattended-halt-recovery/00-index.md",
    idea: "classify safe halts",
    planningDepth: "jit",
    approvalPolicy: "none",
  },
  roleModels: {
    planner: { id: "planner-model" },
  },
});

function baseRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: RUN_ID,
    automation_id: "ws::generated:implement",
    workspace_id: "ws-1",
    status: "failed",
    agent_id: "agent-1",
    sdk_run_id: "sdk-1",
    trigger_kind: "chain",
    prompt: "do the work",
    title: null,
    summary: null,
    parent_run_id: ROOT,
    model: null,
    model_params_json: null,
    chain_root_run_id: ROOT,
    chain_depth: 2,
    chain_max_depth: 9,
    chain_context_json: VALID_CONTEXT,
    chain_stop_requested_at: null,
    chain_stop_reason: null,
    chain_max_depth_override: null,
    chain_handled_at: null,
    pipeline_wave_id: null,
    pipeline_track_id: null,
    execution_cwd: null,
    started_at: "2026-08-06 12:00:00",
    ended_at: "2026-08-06 12:05:00",
    created_at: "2026-08-06 12:00:00",
    updated_at: "2026-08-06 12:05:00",
    ...overrides,
  };
}

function ev(
  seq: number,
  event_type: string,
  payload: unknown
): AutoEscalationEventFact {
  return {
    seq,
    event_type,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

function safeEvents(): AutoEscalationEventFact[] {
  return [
    ev(1, "run.started", {}),
    ev(2, "thinking", { text: "planning" }),
    ev(3, "assistant", { message: { content: [{ type: "text", text: "hi" }] } }),
    ev(4, "tool_call", { name: "Shell" }),
    ev(5, "run.error", { reason: "sdk_error", sdkStatus: "error" }),
    ev(6, "run.chain-skipped", {
      reason: "status-mismatch",
      next: "generated:review",
      status: "failed",
      when: "completed",
    }),
  ];
}

function basePolicy(
  overrides: Partial<AutoEscalationPolicy> = {}
): AutoEscalationPolicy {
  return { enabled: true, maxPerPipeline: 2, ...overrides };
}

function baseInput(
  overrides: Partial<AutoEscalationInput> = {}
): AutoEscalationInput {
  return {
    run: baseRun(),
    workerKey: "implement",
    events: safeEvents(),
    lineage: [],
    policy: basePolicy(),
    selectedActionEligibility: {
      ok: true,
      eligibility: {
        row: baseRun(),
        context: JSON.parse(VALID_CONTEXT),
        effectiveMaxDepth: 9,
        successorAutomationId: null,
      },
    },
    ...overrides,
  };
}

function expectNone(
  decision: PipelineHaltRecoveryDecision,
  code: PipelineHaltRecoveryDeclineCode,
  observedReason?: string
): void {
  expect(decision.action).toBe("none");
  if (decision.action !== "none") return;
  expect(decision.code).toBe(code);
  expect(decision.detail.length).toBeGreaterThan(0);
  if (observedReason !== undefined) {
    expect(decision.observedReason).toBe(observedReason);
  }
}

describe("classifyPipelineHaltRecovery — safe baseline", () => {
  it("returns retry for implement on rung 1", () => {
    const decision = classifyPipelineHaltRecovery(baseInput());
    expect(decision).toEqual({
      action: "retry",
      code: "safe-class",
      detail: expect.stringMatching(/retry.*implement.*rung 1/i),
    });
  });

  it("does not mutate events or lineage arrays", () => {
    const events = safeEvents();
    const lineage: AutoEscalationLineageFact[] = [
      { chainRootRunId: ROOT, chainDepth: 1, actor: "operator" },
    ];
    const eventsSnapshot = structuredClone(events);
    const lineageSnapshot = structuredClone(lineage);
    classifyPipelineHaltRecovery(baseInput({ events, lineage }));
    expect(events).toEqual(eventsSnapshot);
    expect(lineage).toEqual(lineageSnapshot);
  });
});

describe("classifyPipelineHaltRecovery — policy and scope gates", () => {
  it.each([
    {
      name: "disabled policy",
      input: () => baseInput({ policy: basePolicy({ enabled: false }) }),
      code: "disabled" as const,
    },
    {
      name: "wave scoped",
      input: () =>
        baseInput({ run: baseRun({ pipeline_wave_id: "wave-1" }) }),
      code: "wave-scoped" as const,
    },
    {
      name: "track scoped",
      input: () =>
        baseInput({ run: baseRun({ pipeline_track_id: "track-1" }) }),
      code: "wave-scoped" as const,
    },
  ])("$name", ({ input, code }) => {
    expectNone(classifyPipelineHaltRecovery(input()), code);
  });
});

describe("classifyPipelineHaltRecovery — structural refusals", () => {
  it.each([
    {
      name: "missing chain root",
      run: { chain_root_run_id: null },
      code: "not-pipeline" as const,
    },
    {
      name: "missing chain depth",
      run: { chain_depth: null },
      code: "not-pipeline" as const,
    },
    {
      name: "missing chain max depth",
      run: { chain_max_depth: null },
      code: "not-pipeline" as const,
    },
    {
      name: "null context",
      run: { chain_context_json: null },
      code: "not-pipeline" as const,
    },
    {
      name: "malformed context json",
      run: { chain_context_json: "{not-json" },
      code: "not-pipeline" as const,
    },
    {
      name: "invalid context shape",
      run: { chain_context_json: JSON.stringify({ variables: {} }) },
      code: "not-pipeline" as const,
    },
    {
      name: "already claimed",
      run: { chain_handled_at: "2026-08-06 12:06:00" },
      code: "already-chained" as const,
    },
    {
      name: "root depth",
      run: { chain_depth: 0 },
      code: "root-run" as const,
    },
  ])("$name → $code", ({ run, code }) => {
    expectNone(
      classifyPipelineHaltRecovery(baseInput({ run: baseRun(run) })),
      code
    );
  });
});

describe("classifyPipelineHaltRecovery — safe-class gates", () => {
  it.each([
    {
      name: "cancelled status",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        run: baseRun({ status: "cancelled" }),
      }),
      code: "not-safe-class" as const,
      observed: "cancelled",
    },
    {
      name: "completed status",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        run: baseRun({ status: "completed" }),
      }),
      code: "not-safe-class" as const,
      observed: "completed",
    },
    {
      name: "missing chain-skipped",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        events: safeEvents().filter((e) => e.event_type !== "run.chain-skipped"),
      }),
      code: "not-safe-class" as const,
      observed: "missing-chain-skipped",
    },
    {
      name: "malformed chain-skipped",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        events: [
          ...safeEvents().filter((e) => e.event_type !== "run.chain-skipped"),
          ev(6, "run.chain-skipped", "{bad"),
        ],
      }),
      code: "not-safe-class" as const,
      observed: "malformed-chain-skipped",
    },
    {
      name: "missing run.error",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        events: safeEvents().filter((e) => e.event_type !== "run.error"),
      }),
      code: "not-safe-class" as const,
      observed: "missing-run-error",
    },
    {
      name: "malformed run.error",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        events: [
          ev(1, "assistant", {}),
          ev(2, "run.error", "{bad"),
          ev(3, "run.chain-skipped", { reason: "status-mismatch" }),
        ],
      }),
      code: "not-safe-class" as const,
      observed: "malformed-run-error",
    },
    {
      name: "thinking-only activity",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        events: [
          ev(1, "thinking", {}),
          ev(2, "status", {}),
          ev(3, "user", {}),
          ev(4, "run.started", {}),
          ev(5, "run.error", { reason: "sdk_error" }),
          ev(6, "run.chain-skipped", { reason: "status-mismatch" }),
        ],
      }),
      code: "not-safe-class" as const,
      observed: "no-substantive-activity",
    },
    {
      name: "activity after error only",
      mutate: (input: AutoEscalationInput): AutoEscalationInput => ({
        ...input,
        events: [
          ev(1, "run.error", { reason: "sdk_error" }),
          ev(2, "assistant", {}),
          ev(3, "run.chain-skipped", { reason: "status-mismatch" }),
        ],
      }),
      code: "not-safe-class" as const,
      observed: "no-substantive-activity",
    },
  ])("$name", ({ mutate, code, observed }) => {
    expectNone(classifyPipelineHaltRecovery(mutate(baseInput())), code, observed);
  });

  const HALT_REASONS = [
    "stopped",
    "template-error",
    "max-depth",
    "unresolved",
    "already-chained",
    "enqueue-failed",
  ] as const;

  it.each(HALT_REASONS)("unsafe halt reason %s", (reason) => {
    const events = [
      ...safeEvents().filter((e) => e.event_type !== "run.chain-skipped"),
      ev(6, "run.chain-skipped", { reason }),
    ];
    expectNone(
      classifyPipelineHaltRecovery(baseInput({ events })),
      "not-safe-class",
      reason
    );
  });

  const FAILURE_REASONS = [
    "spawn_timeout",
    "spawn_error",
    "orphaned_no_agent",
    "agent_gone",
    "stalled_idle",
    "retries_exhausted",
    "auth_expired",
  ] as const;

  it.each(FAILURE_REASONS)("unsafe failure reason %s", (reason) => {
    const events = [
      ...safeEvents().filter((e) => e.event_type !== "run.error"),
      ev(5, "run.error", { reason }),
    ];
    expectNone(
      classifyPipelineHaltRecovery(baseInput({ events })),
      "not-safe-class",
      reason
    );
  });

  it("uses latest chain-skipped / run.error by seq", () => {
    const events = [
      ev(1, "assistant", {}),
      ev(2, "run.error", { reason: "sdk_error" }),
      ev(3, "run.chain-skipped", { reason: "status-mismatch" }),
      ev(4, "run.error", { reason: "stalled_idle" }),
      ev(5, "run.chain-skipped", { reason: "max-depth" }),
    ];
    expectNone(
      classifyPipelineHaltRecovery(baseInput({ events })),
      "not-safe-class",
      "max-depth"
    );
  });

  it("returns a decision instead of throwing on malformed payloads", () => {
    expect(() =>
      classifyPipelineHaltRecovery(
        baseInput({
          events: [
            ev(1, "assistant", {}),
            ev(2, "run.error", "not-json"),
            ev(3, "run.chain-skipped", "also-bad"),
          ],
        })
      )
    ).not.toThrow();
  });
});

describe("classifyPipelineHaltRecovery — lineage budget and rung", () => {
  it("declines non-positive maxPerPipeline as budget-spent", () => {
    expectNone(
      classifyPipelineHaltRecovery(
        baseInput({ policy: basePolicy({ maxPerPipeline: 0 }) })
      ),
      "budget-spent"
    );
    expectNone(
      classifyPipelineHaltRecovery(
        baseInput({ policy: basePolicy({ maxPerPipeline: -1 }) })
      ),
      "budget-spent"
    );
  });

  it("counts only same-root daemon facts toward the cap", () => {
    const lineage: AutoEscalationLineageFact[] = [
      { chainRootRunId: ROOT, chainDepth: 1, actor: "daemon" },
      { chainRootRunId: ROOT, chainDepth: 2, actor: "operator" },
      { chainRootRunId: "other-root", chainDepth: 2, actor: "daemon" },
    ];
    // one daemon fact, cap 2 → still eligible
    const decision = classifyPipelineHaltRecovery(baseInput({ lineage }));
    expect(decision.action).toBe("retry");

    const spent: AutoEscalationLineageFact[] = [
      ...lineage,
      { chainRootRunId: ROOT, chainDepth: 3, actor: "daemon" },
    ];
    expectNone(
      classifyPipelineHaltRecovery(baseInput({ lineage: spent })),
      "budget-spent"
    );
  });

  it("ignores operator and foreign-root facts for rung progression", () => {
    const lineage: AutoEscalationLineageFact[] = [
      { chainRootRunId: ROOT, chainDepth: 2, actor: "operator" },
      { chainRootRunId: "other-root", chainDepth: 2, actor: "daemon" },
    ];
    const { rung, daemonCount } = interpretLineage(lineage, ROOT, 2);
    expect(rung).toBe(1);
    expect(daemonCount).toBe(0);
  });

  it("trigger_kind escalation alone does not spend budget or advance rung", () => {
    const decision = classifyPipelineHaltRecovery(
      baseInput({
        run: baseRun({ trigger_kind: "escalation" }),
        lineage: [],
      })
    );
    expect(decision.action).toBe("retry");
    expect(decision).toMatchObject({ code: "safe-class" });
  });
});

describe("classifyPipelineHaltRecovery — worker ladder", () => {
  const workers: Array<{
    workerKey: string;
    rung1: "retry" | "skip" | null;
    rung2: "retry" | "skip" | null;
  }> = [
    { workerKey: "plan-phase", rung1: "retry", rung2: null },
    { workerKey: "implement", rung1: "retry", rung2: null },
    { workerKey: "review", rung1: "retry", rung2: null },
    { workerKey: "docs-commit", rung1: "skip", rung2: null },
    { workerKey: "plan-skeleton", rung1: null, rung2: null },
    { workerKey: "integrate-wave", rung1: null, rung2: null },
    { workerKey: "final-gate", rung1: null, rung2: null },
    { workerKey: "unknown-worker", rung1: null, rung2: null },
  ];

  it.each(workers)(
    "$workerKey rung1=$rung1 rung2=$rung2",
    ({ workerKey, rung1, rung2 }) => {
      expect(ladderActionFor(workerKey, 1)).toBe(rung1);
      expect(ladderActionFor(workerKey, 2)).toBe(rung2);
      expect(ladderActionFor(workerKey, 3)).toBeNull();

      // plan-skeleton at depth 0 is caught by root-run before the ladder.
      if (workerKey === "plan-skeleton") {
        expectNone(
          classifyPipelineHaltRecovery(
            baseInput({
              workerKey,
              run: baseRun({ chain_depth: 0 }),
            })
          ),
          "root-run"
        );
        return;
      }

      const rung1Decision = classifyPipelineHaltRecovery(
        baseInput({ workerKey })
      );
      if (rung1 == null) {
        expectNone(rung1Decision, "ladder-exhausted");
      } else {
        expect(rung1Decision).toMatchObject({
          action: rung1,
          code: "safe-class",
        });
      }

      const rung2Lineage: AutoEscalationLineageFact[] = [
        { chainRootRunId: ROOT, chainDepth: 2, actor: "daemon" },
      ];
      const rung2Decision = classifyPipelineHaltRecovery(
        baseInput({
          workerKey,
          lineage: rung2Lineage,
          policy: basePolicy({ maxPerPipeline: 3 }),
        })
      );
      if (rung2 == null) {
        expectNone(rung2Decision, "ladder-exhausted");
      } else {
        expect(rung2Decision).toMatchObject({
          action: rung2,
          code: "safe-class",
        });
      }
    }
  );

  it("review retries then halts; docs-commit is skip then halt", () => {
    expect(
      classifyPipelineHaltRecovery(baseInput({ workerKey: "review" }))
    ).toMatchObject({ action: "retry", code: "safe-class" });

    expectNone(
      classifyPipelineHaltRecovery(
        baseInput({
          workerKey: "review",
          lineage: [{ chainRootRunId: ROOT, chainDepth: 2, actor: "daemon" }],
          policy: basePolicy({ maxPerPipeline: 3 }),
        })
      ),
      "ladder-exhausted"
    );

    expect(
      classifyPipelineHaltRecovery(baseInput({ workerKey: "docs-commit" }))
    ).toMatchObject({ action: "skip", code: "safe-class" });

    expectNone(
      classifyPipelineHaltRecovery(
        baseInput({
          workerKey: "docs-commit",
          lineage: [{ chainRootRunId: ROOT, chainDepth: 2, actor: "daemon" }],
          policy: basePolicy({ maxPerPipeline: 3 }),
        })
      ),
      "ladder-exhausted"
    );
  });

  it("unknown worker key null declines ladder-exhausted", () => {
    expectNone(
      classifyPipelineHaltRecovery(baseInput({ workerKey: null })),
      "ladder-exhausted"
    );
  });
});

describe("classifyPipelineHaltRecovery — selected-action eligibility", () => {
  const refusals: RunEscalationRefusal[] = [
    "not-found",
    "not-pipeline",
    "not-halted",
    "already-chained",
    "root-run",
    "no-successor",
    "budget-exhausted",
  ];

  it.each(refusals)("surfaces refusal %s unchanged", (reason) => {
    const decision = classifyPipelineHaltRecovery(
      baseInput({
        selectedActionEligibility: { ok: false, reason },
      })
    );
    expectNone(decision, reason);
  });
});
