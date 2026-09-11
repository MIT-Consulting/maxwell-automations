import { describe, expect, it } from "vitest";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  describePipelineStep,
  workerKeyFromConfigKey,
  type Run,
  type RunPipelineSummary,
} from "@lca/shared";
import {
  defaultExpandedPipelineRootId,
  escalationActionGates,
  formatPipelineChipLabel,
  formatPipelineGroupStatus,
  indexRunsByPipelineRoot,
  isHaltedPipelineRun,
  isPipelineGroupActive,
  layoutColumnRuns,
  pipelineGroupAggregateElapsed,
  pipelineGroupStatus,
} from "../packages/dashboard/src/pipelineGrouping.ts";

function summary(
  overrides?: Partial<RunPipelineSummary>
): RunPipelineSummary {
  return {
    pipelineId: "implement-fully",
    featureId: "b42",
    featureSlug: "b42-example",
    ...overrides,
  };
}

function run(partial: Partial<Run> & Pick<Run, "id">): Run {
  return {
    automationId: "auto",
    workspaceId: "ws",
    status: "completed",
    agentId: null,
    sdkRunId: null,
    triggerKind: "manual",
    parentRunId: null,
    title: null,
    summary: null,
    model: null,
    modelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    ...partial,
  };
}

describe("b36.05c board grouping", () => {
  it("forms groups by chainRootRunId; null roots stay ungrouped", () => {
    const runs = [
      run({
        id: "a1",
        chainRootRunId: "root-a",
        pipeline: summary(),
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      run({
        id: "b1",
        chainRootRunId: "root-b",
        pipeline: summary({ featureId: "b99" }),
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
      run({ id: "u1", chainRootRunId: null }),
      run({
        id: "a0",
        chainRootRunId: "root-a",
        pipeline: summary(),
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ];
    const layout = layoutColumnRuns(runs);
    expect(layout.groups).toHaveLength(2);
    expect(layout.groups.map((g) => g.rootRunId)).toEqual([
      "root-b",
      "root-a",
    ]);
    expect(layout.ungrouped.map((r) => r.id)).toEqual(["u1"]);
  });

  it("keeps a single-run group with its summary", () => {
    const layout = layoutColumnRuns([
      run({
        id: "solo",
        chainRootRunId: "solo",
        pipeline: summary(),
        chainDepth: 0,
      }),
    ]);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]!.runs).toHaveLength(1);
    expect(layout.groups[0]!.summary?.featureId).toBe("b42");
    expect(layout.groups[0]!.waveSummary).toBeNull();
  });

  it("orders within a group by depth ascending, then createdAt", () => {
    const layout = layoutColumnRuns([
      run({
        id: "d2-late",
        chainRootRunId: "r",
        chainDepth: 2,
        createdAt: "2026-01-01T02:00:00.000Z",
        pipeline: summary(),
      }),
      run({
        id: "d1",
        chainRootRunId: "r",
        chainDepth: 1,
        createdAt: "2026-01-01T03:00:00.000Z",
        pipeline: summary(),
      }),
      run({
        id: "d2-early",
        chainRootRunId: "r",
        chainDepth: 2,
        createdAt: "2026-01-01T01:00:00.000Z",
        pipeline: summary(),
      }),
      run({
        id: "d-null-early",
        chainRootRunId: "r",
        chainDepth: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        pipeline: summary(),
      }),
      run({
        id: "d-null-late",
        chainRootRunId: "r",
        chainDepth: null,
        createdAt: "2026-01-01T04:00:00.000Z",
        pipeline: summary(),
      }),
    ]);
    expect(layout.groups[0]!.runs.map((r) => r.id)).toEqual([
      "d1",
      "d2-early",
      "d2-late",
      "d-null-early",
      "d-null-late",
    ]);
  });

  it("orders groups by newest member descending; ungrouped keeps input order", () => {
    const layout = layoutColumnRuns([
      run({
        id: "old",
        chainRootRunId: "old-root",
        createdAt: "2026-01-01T00:00:00.000Z",
        pipeline: summary(),
      }),
      run({ id: "u-first", chainRootRunId: null }),
      run({
        id: "new",
        chainRootRunId: "new-root",
        createdAt: "2026-01-05T00:00:00.000Z",
        pipeline: summary({ featureId: "b50" }),
      }),
      run({ id: "u-second", chainRootRunId: null }),
    ]);
    expect(layout.groups.map((g) => g.rootRunId)).toEqual([
      "new-root",
      "old-root",
    ]);
    expect(layout.ungrouped.map((r) => r.id)).toEqual(["u-first", "u-second"]);
  });

  it("takes summary from the first non-null pipeline in the group", () => {
    const withChild = layoutColumnRuns([
      run({
        id: "root",
        chainRootRunId: "r",
        chainDepth: 0,
        pipeline: null,
      }),
      run({
        id: "child",
        chainRootRunId: "r",
        chainDepth: 1,
        pipeline: summary({ featureId: "b77" }),
      }),
    ]);
    expect(withChild.groups[0]!.summary?.featureId).toBe("b77");

    const firstWins = layoutColumnRuns([
      run({
        id: "child",
        chainRootRunId: "r",
        chainDepth: 1,
        pipeline: summary({ featureId: "b99" }),
      }),
      run({
        id: "root",
        chainRootRunId: "r",
        chainDepth: 0,
        pipeline: summary({ featureId: "b42" }),
      }),
    ]);
    expect(firstWins.groups[0]!.summary?.featureId).toBe("b42");

    const none = layoutColumnRuns([
      run({ id: "a", chainRootRunId: "r", pipeline: null }),
    ]);
    expect(none.groups[0]!.summary).toBeNull();
  });

  it("prefers chainMaxDepthOverride for budget", () => {
    const layout = layoutColumnRuns([
      run({
        id: "deep",
        chainRootRunId: "r",
        chainDepth: 3,
        chainMaxDepth: 10,
        chainMaxDepthOverride: 17,
        pipeline: summary(),
      }),
      run({
        id: "shallow",
        chainRootRunId: "r",
        chainDepth: 1,
        chainMaxDepth: 10,
        pipeline: summary(),
      }),
    ]);
    expect(layout.groups[0]!.budget).toBe(17);
    expect(layout.groups[0]!.maxDepthSeen).toBe(3);
  });

  it("composes chip labels for each worker key without undefined/NaN", () => {
    const featureId = "b42";
    const entryConfigKey =
      `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`;
    expect(workerKeyFromConfigKey(entryConfigKey)).toBe(
      IMPLEMENT_FULLY_ENTRY_WORKER_KEY
    );
    expect(describePipelineStep(entryConfigKey, 0)).toEqual({
      workerKey: IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
      stepInCycle: null,
      cycle: null,
    });
    const entry = formatPipelineChipLabel(
      featureId,
      entryConfigKey,
      0
    );
    expect(entry).toBe("b42 · plan-skeleton");
    expect(entry).not.toMatch(/undefined|null|NaN/);

    for (const [i, key] of IMPLEMENT_FULLY_LOOP_WORKER_KEYS.entries()) {
      const depth = i + 1;
      const configKey = `${GENERATED_CONFIG_KEY_PREFIX}${key}`;
      expect(describePipelineStep(configKey, depth)).toEqual({
        workerKey: key,
        stepInCycle: i + 1,
        cycle: 1,
      });
      const label = formatPipelineChipLabel(
        featureId,
        configKey,
        depth
      );
      expect(label).toBe(`b42 · ${key} · 1`);
      expect(label).not.toMatch(/undefined|null|NaN/);
    }

    const unknown = formatPipelineChipLabel(
      featureId,
      `${GENERATED_CONFIG_KEY_PREFIX}unknown-key`,
      2
    );
    expect(
      describePipelineStep(`${GENERATED_CONFIG_KEY_PREFIX}unknown-key`, 2)
    ).toEqual({
      workerKey: "unknown-key",
      stepInCycle: null,
      cycle: null,
    });
    expect(unknown).toBe("b42");
    expect(unknown).not.toMatch(/undefined|null|NaN/);

    const secondCycle = formatPipelineChipLabel(
      featureId,
      `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_LOOP_WORKER_KEYS[0]}`,
      IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length + 1
    );
    expect(secondCycle).toBe(
      `b42 · ${IMPLEMENT_FULLY_LOOP_WORKER_KEYS[0]} · 2`
    );
  });

  it("mixed column: two pipelines + three ungrouped, every run once", () => {
    const runs = [
      run({
        id: "p1-a",
        chainRootRunId: "p1",
        pipeline: summary(),
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      run({ id: "u1", chainRootRunId: null }),
      run({
        id: "p2-a",
        chainRootRunId: "p2",
        pipeline: summary({ featureId: "b50" }),
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
      run({ id: "u2", chainRootRunId: null }),
      run({
        id: "p1-b",
        chainRootRunId: "p1",
        pipeline: summary(),
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      run({ id: "u3", chainRootRunId: null }),
    ];
    const layout = layoutColumnRuns(runs);
    expect(layout.groups).toHaveLength(2);
    expect(layout.ungrouped).toHaveLength(3);
    const ids = [
      ...layout.groups.flatMap((g) => g.runs.map((r) => r.id)),
      ...layout.ungrouped.map((r) => r.id),
    ];
    expect(ids.sort()).toEqual(runs.map((r) => r.id).sort());
    expect(new Set(ids).size).toBe(runs.length);
  });

  it("halted predicate is true only for terminal + pipeline + unclaimed", () => {
    expect(
      isHaltedPipelineRun(
        run({
          id: "h",
          status: "failed",
          pipeline: summary(),
          chainHandledAt: null,
        })
      )
    ).toBe(true);
    expect(
      isHaltedPipelineRun(
        run({
          id: "h2",
          status: "cancelled",
          pipeline: summary(),
          chainHandledAt: null,
        })
      )
    ).toBe(true);
    expect(
      isHaltedPipelineRun(
        run({
          id: "running",
          status: "running",
          pipeline: summary(),
          chainHandledAt: null,
        })
      )
    ).toBe(false);
    expect(
      isHaltedPipelineRun(
        run({
          id: "legacy",
          status: "failed",
          pipeline: null,
          chainHandledAt: null,
        })
      )
    ).toBe(false);
    expect(
      isHaltedPipelineRun(
        run({
          id: "claimed",
          status: "failed",
          pipeline: summary(),
          chainHandledAt: "2026-01-01T00:00:00.000Z",
        })
      )
    ).toBe(false);
  });

  it("gates retry and skip with the server refusal reasons", () => {
    const root = run({
      id: "root",
      status: "failed",
      pipeline: summary(),
      chainHandledAt: null,
      chainDepth: 0,
      chainMaxDepth: 4,
    });
    expect(escalationActionGates(root, true)).toMatchObject({
      retry: { enabled: false, title: expect.stringContaining("fresh kickoff") },
      skip: { enabled: true },
      abort: { enabled: true },
    });

    const exhausted = run({
      ...root,
      id: "exhausted",
      chainDepth: 4,
    });
    expect(escalationActionGates(exhausted, true).skip).toEqual({
      enabled: false,
      title: expect.stringContaining("budget exhausted"),
    });
    expect(
      escalationActionGates({ ...exhausted, chainDepth: 2 }, false).skip
    ).toEqual({
      enabled: false,
      title: expect.stringContaining("No configured successor"),
    });
  });
});

describe("pipeline group collapse helpers", () => {
  it("aggregates status with needs_input over running over terminal", () => {
    expect(
      pipelineGroupStatus([
        run({ id: "a", status: "completed" }),
        run({ id: "b", status: "running" }),
        run({ id: "c", status: "needs_input" }),
      ])
    ).toBe("needs_input");
    expect(
      pipelineGroupStatus([
        run({ id: "a", status: "completed" }),
        run({ id: "b", status: "failed" }),
      ])
    ).toBe("failed");
    expect(formatPipelineGroupStatus("needs_input")).toBe("needs input");
  });

  it("treats a group as active when any member is non-terminal", () => {
    expect(
      isPipelineGroupActive([
        run({ id: "a", status: "completed" }),
        run({ id: "b", status: "queued" }),
      ])
    ).toBe(true);
    expect(
      isPipelineGroupActive([
        run({ id: "a", status: "completed" }),
        run({ id: "b", status: "failed" }),
      ])
    ).toBe(false);
  });

  it("defaults expand to the newest active group, else newest overall", () => {
    const layout = layoutColumnRuns([
      run({
        id: "old-active",
        chainRootRunId: "old",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        pipeline: summary(),
      }),
      run({
        id: "new-done",
        chainRootRunId: "new",
        status: "completed",
        createdAt: "2026-01-05T00:00:00.000Z",
        pipeline: summary({ featureId: "b50" }),
      }),
    ]);
    // newest-first: new, old — but old is active
    expect(defaultExpandedPipelineRootId(layout.groups)).toBe("old");

    const allDone = layoutColumnRuns([
      run({
        id: "a",
        chainRootRunId: "a-root",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        pipeline: summary(),
      }),
      run({
        id: "b",
        chainRootRunId: "b-root",
        status: "completed",
        createdAt: "2026-01-05T00:00:00.000Z",
        pipeline: summary({ featureId: "b50" }),
      }),
    ]);
    expect(defaultExpandedPipelineRootId(allDone.groups)).toBe("b-root");
  });

  it("uses whole-pipeline members for status when column slice is completed", () => {
    const completedSlice = [
      run({
        id: "step-1",
        chainRootRunId: "root",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:10:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        pipeline: summary(),
      }),
    ];
    const wholePipeline = [
      ...completedSlice,
      run({
        id: "step-2",
        chainRootRunId: "root",
        status: "running",
        startedAt: "2026-01-01T00:10:00.000Z",
        createdAt: "2026-01-01T00:10:00.000Z",
        pipeline: summary(),
      }),
    ];
    expect(pipelineGroupStatus(completedSlice)).toBe("completed");
    expect(pipelineGroupStatus(wholePipeline)).toBe("running");

    const byRoot = indexRunsByPipelineRoot(wholePipeline);
    const layout = layoutColumnRuns(completedSlice);
    expect(defaultExpandedPipelineRootId(layout.groups, byRoot)).toBe("root");
    expect(defaultExpandedPipelineRootId(layout.groups)).toBe("root");
  });

  it("aggregates wall-clock elapsed across the group", () => {
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    expect(
      pipelineGroupAggregateElapsed(
        [
          run({
            id: "a",
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:10:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
          run({
            id: "b",
            status: "completed",
            startedAt: "2026-01-01T00:10:00.000Z",
            endedAt: "2026-01-01T00:25:00.000Z",
            createdAt: "2026-01-01T00:10:00.000Z",
          }),
        ],
        now
      )
    ).toBe("25:00");

    expect(
      pipelineGroupAggregateElapsed(
        [
          run({
            id: "live",
            status: "running",
            startedAt: "2026-01-01T00:50:00.000Z",
            createdAt: "2026-01-01T00:50:00.000Z",
          }),
        ],
        now
      )
    ).toBe("10:00");
  });
});
