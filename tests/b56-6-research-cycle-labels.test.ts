import { describe, expect, it } from "vitest";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  describePipelineStep,
  describePipelineWaveStep,
  formatPipelineWaveChipLabel,
  type Automation,
  type Run,
} from "@lca/shared";
import {
  buildPipelineLineage,
  formatLineageBlockLines,
} from "../packages/cli/src/doctor.ts";
import { formatPipelineChipLabel } from "../packages/dashboard/src/pipelineGrouping.ts";

const gk = (worker: string) => `${GENERATED_CONFIG_KEY_PREFIX}${worker}`;

function automation(configKey: string): Automation {
  return {
    id: `ws::${configKey}`,
    workspaceId: "ws-1",
    name: configKey,
    enabled: true,
    status: "enabled",
    origin: "generated",
    trigger: { type: "manual" },
    prompt: "x",
    model: null,
    modelSelection: null,
    modelRole: "implementer",
    chain: null,
    configPath: "generated.yaml",
    configKey,
    archivedAt: null,
    createdAt: "2026-07-10 12:00:00",
    updatedAt: "2026-07-10 12:00:00",
  };
}

function listRun(
  id: string,
  opts: { depth: number; configKey: string; status?: Run["status"] }
): Run {
  return {
    id,
    automationId: `ws::${opts.configKey}`,
    workspaceId: "ws-1",
    status: opts.status ?? "completed",
    agentId: null,
    sdkRunId: null,
    triggerKind: "chain",
    parentRunId: null,
    title: null,
    summary: null,
    model: null,
    modelSelection: null,
    chainRootRunId: "root-research",
    chainDepth: opts.depth,
    chainMaxDepth: 19,
    chainHandledAt: null,
    pipeline: {
      pipelineId: "implement-fully",
      featureId: "b56",
      featureSlug: "b56-optional-researcher-gatekeeper",
    },
    startedAt: null,
    endedAt: null,
    createdAt: `2026-07-10 12:0${opts.depth}:00`,
    updatedAt: `2026-07-10 12:0${opts.depth}:00`,
  };
}

describe("b56.06 legacy cycle matrix (byte-identical)", () => {
  it("plan-skeleton @0 → null/null", () => {
    expect(describePipelineStep(gk(IMPLEMENT_FULLY_ENTRY_WORKER_KEY), 0)).toEqual({
      workerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
  });

  it("loop workers: depths 1–3 are cycle 1; depth 4/6 are cycle 2", () => {
    const [planPhase, implement, review] = IMPLEMENT_FULLY_LOOP_WORKER_KEYS;
    expect(describePipelineStep(gk(planPhase!), 1)).toEqual({
      workerKey: planPhase,
      stepInCycle: 1,
      cycle: 1,
    });
    expect(describePipelineStep(gk(implement!), 2)).toEqual({
      workerKey: implement,
      stepInCycle: 2,
      cycle: 1,
    });
    expect(describePipelineStep(gk(review!), 3)).toEqual({
      workerKey: review,
      stepInCycle: 3,
      cycle: 1,
    });
    expect(describePipelineStep(gk(planPhase!), 4)).toEqual({
      workerKey: planPhase,
      stepInCycle: 1,
      cycle: 2,
    });
    expect(describePipelineStep(gk(review!), 6)).toEqual({
      workerKey: review,
      stepInCycle: 3,
      cycle: 2,
    });
  });
});

describe("b56.06 researched cycle matrix", () => {
  it("research @0 and plan-skeleton @1 are null/null; loop cycles ignore the prelude", () => {
    const [planPhase, , review] = IMPLEMENT_FULLY_LOOP_WORKER_KEYS;
    expect(
      describePipelineStep(gk(IMPLEMENT_FULLY_RESEARCH_WORKER_KEY), 0)
    ).toEqual({
      workerKey: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    expect(describePipelineStep(gk(IMPLEMENT_FULLY_ENTRY_WORKER_KEY), 1)).toEqual({
      workerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    expect(describePipelineStep(gk(planPhase!), 2)).toEqual({
      workerKey: planPhase,
      stepInCycle: 1,
      cycle: 1,
    });
    expect(describePipelineStep(gk(review!), 4)).toEqual({
      workerKey: review,
      stepInCycle: 3,
      cycle: 1,
    });
    expect(describePipelineStep(gk(planPhase!), 5)).toEqual({
      workerKey: planPhase,
      stepInCycle: 1,
      cycle: 2,
    });
  });
});

describe("b56.06 off-cycle / unknown / docs-commit", () => {
  it("off-cycle workers stay null/null at non-zero and large depths", () => {
    expect(describePipelineStep(gk(IMPLEMENT_FULLY_ENTRY_WORKER_KEY), 1)).toEqual({
      workerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    expect(
      describePipelineStep(gk(IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY), 99)
    ).toEqual({
      workerKey: IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    expect(
      describePipelineStep(gk(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY), 7)
    ).toEqual({
      workerKey: IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    expect(
      describePipelineStep(gk(IMPLEMENT_FULLY_RESEARCH_WORKER_KEY), 3)
    ).toEqual({
      workerKey: IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
  });

  it("unknown worker and null depth return nulls without throwing", () => {
    expect(describePipelineStep(gk("totally-unknown"), 5)).toEqual({
      workerKey: "totally-unknown",
      stepInCycle: null,
      cycle: null,
    });
    expect(describePipelineStep(gk("implement"), null)).toEqual({
      workerKey: "implement",
      stepInCycle: 2,
      cycle: null,
    });
    expect(describePipelineStep(undefined, undefined)).toEqual({
      workerKey: null,
      stepInCycle: null,
      cycle: null,
    });
  });

  it("legacy docs-commit preserves workerKey; cycle and step stay null", () => {
    expect(
      describePipelineStep(gk(IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY), 4)
    ).toEqual({
      workerKey: IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    // Board chip and wave/doctor-style labels stay feature-only / key-only
    // (no fabricated cycle) — same as before this phase.
    expect(
      formatPipelineChipLabel(
        "b56",
        gk(IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY),
        4
      )
    ).toBe("b56");
    const docsKey = gk(IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY);
    const docsRun = listRun("r-docs", { depth: 4, configKey: docsKey });
    const docsLineage = buildPipelineLineage(
      "r-docs",
      "root-research",
      [docsRun],
      new Map([[docsRun.automationId, automation(docsKey)]])
    );
    expect(docsLineage.entries[0]?.stepLabel).toBe(
      IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY
    );
  });
});

describe("b56.06 surface labels", () => {
  it("research renders as a named prelude on board, doctor lineage, and wave chip", () => {
    const researchKey = gk(IMPLEMENT_FULLY_RESEARCH_WORKER_KEY);
    expect(formatPipelineChipLabel("b56", researchKey, 0)).toBe(
      "b56 · research"
    );
    expect(
      formatPipelineWaveChipLabel({
        featureId: "b56",
        configKey: researchKey,
        chainDepth: 0,
      })
    ).toBe("b56 · research");

    const listed = [
      listRun("root-research", { depth: 0, configKey: researchKey }),
      listRun("r-skel", {
        depth: 1,
        configKey: gk(IMPLEMENT_FULLY_ENTRY_WORKER_KEY),
      }),
      listRun("r-plan", {
        depth: 2,
        configKey: gk(IMPLEMENT_FULLY_LOOP_WORKER_KEYS[0]!),
        status: "failed",
      }),
    ];
    const autoById = new Map(
      listed.map((r) => {
        const key = r.automationId.replace(/^ws::/, "");
        return [r.automationId, automation(key)] as const;
      })
    );
    const lineage = buildPipelineLineage(
      "r-plan",
      "root-research",
      listed,
      autoById
    );
    expect(lineage.entries[0]?.stepLabel).toBe(
      "research (pre-planning prelude)"
    );
    expect(lineage.entries[1]?.stepLabel).toBe("plan-skeleton");
    expect(lineage.entries[2]?.stepLabel).toBe(
      "plan-phase (step 1, cycle 1)"
    );
    const text = formatLineageBlockLines(lineage).join("\n");
    expect(text).toMatch(/research \(pre-planning prelude\)/);
    expect(text).not.toMatch(/research \(step/);
  });

  it("integrate-wave and final-gate labels stay unchanged", () => {
    expect(
      describePipelineWaveStep({
        configKey: gk(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY),
        chainDepth: 8,
        waveOrdinal: 1,
      })
    ).toMatchObject({
      workerKey: IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    expect(
      formatPipelineWaveChipLabel({
        featureId: "b56",
        configKey: gk(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY),
        chainDepth: 8,
        waveOrdinal: 1,
      })
    ).toBe("b56 · integrate-wave · w1");
    expect(
      formatPipelineWaveChipLabel({
        featureId: "b56",
        configKey: gk(IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY),
        chainDepth: 12,
      })
    ).toBe("b56 · final-gate");
  });

  it("legacy board chips for entry and loop workers stay byte-identical", () => {
    expect(
      formatPipelineChipLabel("b42", gk(IMPLEMENT_FULLY_ENTRY_WORKER_KEY), 0)
    ).toBe("b42 · plan-skeleton");
    expect(
      formatPipelineChipLabel(
        "b42",
        gk(IMPLEMENT_FULLY_LOOP_WORKER_KEYS[0]!),
        1
      )
    ).toBe("b42 · plan-phase · 1");
    expect(
      formatPipelineChipLabel(
        "b42",
        gk(IMPLEMENT_FULLY_LOOP_WORKER_KEYS[0]!),
        4
      )
    ).toBe("b42 · plan-phase · 2");
  });
});
