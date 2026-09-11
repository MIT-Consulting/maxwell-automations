import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  comparePipelineRunOrder,
  formatPipelineWaveChipLabel,
  formatWaveTrackProgress,
  latestWaveSummaryInRuns,
  waveOperatorActionGates,
  type Run,
  type RunPipelineWaveSummary,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { PipelineWaveStore } from "../packages/daemon/src/runs/pipeline-wave-store.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import {
  buildSuccessorMap,
  layoutColumnRuns,
  pipelineChipLabelForRun,
} from "../packages/dashboard/src/pipelineGrouping.ts";

function waveSummary(
  overrides: Partial<RunPipelineWaveSummary> = {}
): RunPipelineWaveSummary {
  return {
    id: "wave-1",
    ordinal: 1,
    status: "running",
    trackCount: 2,
    completedTrackCount: 1,
    joinClaimed: false,
    finalized: false,
    blockedCode: null,
    cleanupRequired: false,
    ...overrides,
  };
}

function run(partial: Partial<Run> & Pick<Run, "id">): Run {
  return {
    automationId: "auto",
    workspaceId: "ws",
    status: "running",
    agentId: null,
    sdkRunId: null,
    triggerKind: "chain",
    parentRunId: null,
    title: null,
    summary: null,
    model: null,
    modelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("b36.06 comparePipelineRunOrder", () => {
  it("orders by wave ordinal, then track, then depth, then createdAt", () => {
    const ordered = [
      run({
        id: "w1t2d3",
        chainDepth: 3,
        createdAt: "2026-01-01T03:00:00.000Z",
        pipelineWave: waveSummary({ ordinal: 1 }),
        pipelineTrack: {
          id: "t2",
          ordinal: 2,
          status: "running",
          phaseRef: "6.2",
          phaseFile: "docs/p6.md",
        },
      }),
      run({
        id: "w1t1d2",
        chainDepth: 2,
        createdAt: "2026-01-01T02:00:00.000Z",
        pipelineWave: waveSummary({ ordinal: 1 }),
        pipelineTrack: {
          id: "t1",
          ordinal: 1,
          status: "running",
          phaseRef: "6.1",
          phaseFile: "docs/p5.md",
        },
      }),
      run({
        id: "w2t1",
        chainDepth: 1,
        createdAt: "2026-01-01T01:00:00.000Z",
        pipelineWave: waveSummary({ id: "wave-2", ordinal: 2 }),
        pipelineTrack: {
          id: "t3",
          ordinal: 1,
          status: "running",
          phaseRef: "7.1",
          phaseFile: "docs/p7.md",
        },
      }),
    ].sort(comparePipelineRunOrder);

    expect(ordered.map((r) => r.id)).toEqual(["w1t1d2", "w1t2d3", "w2t1"]);
  });

  it("keeps sequential depth ordering when wave metadata is absent", () => {
    const ordered = [
      run({ id: "d2", chainDepth: 2, createdAt: "2026-01-02T00:00:00.000Z" }),
      run({ id: "d1", chainDepth: 1, createdAt: "2026-01-03T00:00:00.000Z" }),
    ].sort(comparePipelineRunOrder);
    expect(ordered.map((r) => r.id)).toEqual(["d1", "d2"]);
  });
});

describe("b36.06 wave labels and gates", () => {
  it("formats track chips without fabricated cycles", () => {
    expect(
      formatPipelineWaveChipLabel({
        featureId: "b42",
        configKey: "generated:implement",
        chainDepth: 2,
        waveOrdinal: 1,
        trackOrdinal: 2,
        phaseRef: "6.2",
      })
    ).toBe("b42 · 6.2 · implement · w1");
  });

  it("gates retry/abort only for blocked waves with complete tracks", () => {
    expect(
      waveOperatorActionGates(
        waveSummary({ status: "blocked", completedTrackCount: 2 })
      )
    ).toMatchObject({ retry: { enabled: true }, abort: { enabled: true } });
    expect(
      waveOperatorActionGates(
        waveSummary({ status: "blocked", completedTrackCount: 1 })
      ).retry.enabled
    ).toBe(false);
    expect(waveOperatorActionGates(null).abort.enabled).toBe(false);
  });

  it("summarizes wave progress for group headers", () => {
    expect(formatWaveTrackProgress(waveSummary())).toBe(
      "w1 running · 1/2 tracks"
    );
    expect(
      formatWaveTrackProgress(
        waveSummary({ status: "integrating", joinClaimed: true })
      )
    ).toBe("w1 integrating · 1/2 tracks");
  });
});

describe("b36.06 dashboard grouping", () => {
  it("picks the latest wave summary for the group header", () => {
    const layout = layoutColumnRuns([
      run({
        id: "a",
        chainRootRunId: "root",
        chainDepth: 1,
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b42",
          featureSlug: "b42-x",
        },
        pipelineWave: waveSummary({ ordinal: 1 }),
      }),
      run({
        id: "b",
        chainRootRunId: "root",
        chainDepth: 5,
        createdAt: "2026-01-02T00:00:00.000Z",
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b42",
          featureSlug: "b42-x",
        },
        pipelineWave: waveSummary({ id: "wave-2", ordinal: 2, status: "blocked", blockedCode: "merge-conflict" }),
      }),
    ]);
    expect(layout.groups[0]!.waveSummary?.ordinal).toBe(2);
    expect(latestWaveSummaryInRuns(layout.groups[0]!.runs)?.status).toBe(
      "blocked"
    );
  });

  it("builds multi-successor map sorted by wave/track order", () => {
    const parent = "parent-run";
    const map = buildSuccessorMap([
      run({
        id: "child-b",
        parentRunId: parent,
        chainDepth: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
        pipelineWave: waveSummary(),
        pipelineTrack: {
          id: "t2",
          ordinal: 2,
          status: "running",
          phaseRef: "6.2",
          phaseFile: "docs/p6.md",
        },
      }),
      run({
        id: "child-a",
        parentRunId: parent,
        chainDepth: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        pipelineWave: waveSummary(),
        pipelineTrack: {
          id: "t1",
          ordinal: 1,
          status: "running",
          phaseRef: "6.1",
          phaseFile: "docs/p5.md",
        },
      }),
    ]);
    expect(map.get(parent)?.map((r) => r.id)).toEqual(["child-a", "child-b"]);
  });

  it("uses pipelineChipLabelForRun on track metadata", () => {
    const label = pipelineChipLabelForRun(
      run({
        id: "x",
        chainDepth: 2,
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b42",
          featureSlug: "b42-x",
        },
        pipelineWave: waveSummary(),
        pipelineTrack: {
          id: "t1",
          ordinal: 1,
          status: "running",
          phaseRef: "6.1",
          phaseFile: "docs/p5.md",
        },
      }),
      "generated:implement"
    );
    expect(label).toBe("b42 · 6.1 · implement · w1");
  });
});

describe("b36.06 dashboard-store wave projection", () => {
  it("projects board-safe wave/track summaries and omits execution_cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-6-vis-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const workspaceId = workspaceIdFromPath(workspacePath);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, workspacePath, "ws");

    const automationId = `${workspaceId}::generated:implement`;
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, ?, ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, ?)`
    ).run(
      automationId,
      workspaceId,
      "Implement",
      JSON.stringify({ type: "manual" }),
      "implement {{featureId}}",
      "generated:implement",
      "implementer"
    );

    const waveStore = new PipelineWaveStore(db);
    const { wave, tracks } = waveStore.createWaveIdempotent({
      rootRunId: "root-run",
      coordinatorRunId: "coord-run",
      workspaceId,
      ordinal: 1,
      baseCommit: "abc123",
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/p1.md",
          branchName: "lca/b42/root/w1-t1",
          worktreePath: join(root, "wt1"),
          ordinal: 1,
        },
      ],
    });

    const events = new DaemonEventBus();
    const runStore = new RunStore(db, events);
    runStore.insertRun({
      id: "track-run",
      automationId,
      workspaceId,
      triggerKind: "chain",
      prompt: "track",
      chainRootRunId: "root-run",
      chainDepth: 2,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[0]!.id,
      executionCwd: join(root, "wt1"),
    });

    const listed = new DashboardStore(db).listRuns();
    const row = listed.find((r) => r.id === "track-run");
    expect(row).toBeDefined();
    expect(row!.pipelineWave).toMatchObject({
      ordinal: 1,
      status: wave.status,
      trackCount: 1,
    });
    expect(row!.pipelineTrack).toMatchObject({
      ordinal: 1,
      phaseRef: "6.1",
    });
    expect(row).not.toHaveProperty("executionCwd");
    expect(JSON.stringify(listed)).not.toContain("wt1");

    const legacy = runStore.insertRun({
      id: "legacy-run",
      automationId,
      workspaceId,
      triggerKind: "manual",
      prompt: "legacy",
    });
    void legacy;
    const legacyListed = new DashboardStore(db).getRun("legacy-run");
    expect(legacyListed!.pipelineWave).toBeNull();
    expect(legacyListed!.pipelineTrack).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
