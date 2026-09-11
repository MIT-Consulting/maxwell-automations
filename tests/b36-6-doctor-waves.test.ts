import { describe, expect, it } from "vitest";
import type { Automation, Run } from "@lca/shared";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  buildPipelineLineage,
  collectPipelineDoctorFacts,
  DOCTOR_KEY_EVENTS,
  formatPipelineBlockLines,
  formatPipelineHealthLines,
  summarizePipelineHealth,
} from "../packages/cli/src/doctor.ts";

function snapshot(
  overrides: Partial<RunSnapshot> = {}
): RunSnapshot {
  return {
    run: {
      id: "run-track",
      status: "failed",
      automation_id: "ws::generated:implement",
      workspace_id: "ws-1",
      trigger_kind: "chain",
      started_at: "2026-07-10 12:00:00",
      ended_at: "2026-07-10 12:01:00",
      created_at: "2026-07-10 12:00:00",
      chain_root_run_id: "root-bbbbbbbb",
      chain_depth: 2,
      chain_max_depth: 25,
      chain_context_json: JSON.stringify({
        variables: {
          pipelineId: "implement-fully",
          featureId: "b42",
          featureSlug: "b42-wave",
          featureDir: "docs/roadmap/b42-wave",
          featureIndex: "docs/roadmap/b42-wave/00-index.md",
          idea: "SECRET",
        },
        roleModels: {},
      }),
      pipeline_wave_id: "wave-11111111",
      pipeline_track_id: "track-22222222",
      ...overrides.run,
    },
    events: overrides.events ?? [],
    inputRequests: overrides.inputRequests ?? [],
    pipelineWave: overrides.pipelineWave ?? {
      id: "wave-11111111",
      ordinal: 1,
      status: "blocked",
      trackCount: 2,
      completedTrackCount: 2,
      joinClaimed: true,
      finalized: false,
      blockedCode: "merge-conflict",
      cleanupRequired: false,
    },
    pipelineTrack: overrides.pipelineTrack ?? {
      id: "track-22222222",
      ordinal: 1,
      status: "completed",
      phaseRef: "6.1",
      phaseFile: "docs/p1.md",
    },
    pipelineWaveDetail: overrides.pipelineWaveDetail ?? {
      id: "wave-11111111",
      ordinal: 1,
      status: "blocked",
      trackCount: 2,
      completedTrackCount: 2,
      joinClaimed: true,
      finalized: false,
      blockedCode: "merge-conflict",
      cleanupRequired: false,
      baseCommit: "base0001",
      integrationRunId: "integrate-run",
      blockedDetail: "conflict in src/foo.ts",
    },
    pipelineTrackDetail: overrides.pipelineTrackDetail ?? {
      id: "track-22222222",
      ordinal: 1,
      status: "completed",
      phaseRef: "6.1",
      phaseFile: "docs/p1.md",
      branchName: "lca/b42/root/w1-t1",
      headCommit: "tip00001",
      blockedDetail: null,
    },
  };
}

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
    configKey: "generated:implement",
    archivedAt: null,
    createdAt: "2026-07-10 12:00:00",
    updatedAt: "2026-07-10 12:00:00",
  };
}

describe("DOCTOR_KEY_EVENTS wave vocabulary", () => {
  it("includes all eight wave lifecycle events", () => {
    for (const ev of [
      "run.pipeline-fanout",
      "run.pipeline-track-completed",
      "run.pipeline-join-ready",
      "run.pipeline-integration-enqueued",
      "run.pipeline-wave-finalized",
      "run.pipeline-wave-blocked",
      "run.pipeline-wave-recovered",
      "run.pipeline-wave-cleanup",
    ]) {
      expect(DOCTOR_KEY_EVENTS.has(ev)).toBe(true);
    }
  });
});

describe("collectPipelineDoctorFacts wave detail", () => {
  it("reports wave/track/barrier/branch/tip and recovery commands", () => {
    const facts = collectPipelineDoctorFacts(snapshot(), automation());
    expect(facts).not.toBeNull();
    expect(facts!.waveOrdinal).toBe(1);
    expect(facts!.trackOrdinal).toBe(1);
    expect(facts!.phaseRef).toBe("6.1");
    expect(facts!.barrierProgress).toContain("2/2 tracks");
    expect(facts!.integrationRunId).toBe("integrate-run");
    expect(facts!.branchName).toBe("lca/b42/root/w1-t1");
    expect(facts!.headCommit).toBe("tip00001");
    expect(facts!.baseCommit).toBe("base0001");
    expect(facts!.waveRecoveryCommand).toMatch(/lca wave wave-111 retry/);
    expect(facts!.waveRecoveryCommand).toMatch(/abort/);

    const block = formatPipelineBlockLines(facts!).join("\n");
    expect(block).toMatch(/wave:/);
    expect(block).toMatch(/track:/);
    expect(block).toMatch(/barrier:/);
    expect(block).toMatch(/branch:/);
    expect(block).toMatch(/tip:/);
    expect(block).not.toContain("SECRET");
  });

  it("returns null for non-pipeline runs unchanged", () => {
    const snap = snapshot({
      run: { chain_root_run_id: null, pipeline_wave_id: null },
      pipelineWave: null,
      pipelineTrack: null,
      pipelineWaveDetail: null,
      pipelineTrackDetail: null,
    });
    expect(collectPipelineDoctorFacts(snap, automation())).toBeNull();
  });
});

describe("buildPipelineLineage wave ordering", () => {
  it("orders peers by wave/track/depth", () => {
    const root = "root-bbbbbbbb";
    const listed: Run[] = [
      {
        id: "w1t2",
        automationId: "ws::generated:implement",
        workspaceId: "ws-1",
        status: "running",
        agentId: null,
        sdkRunId: null,
        triggerKind: "chain",
        parentRunId: root,
        title: null,
        summary: null,
        model: null,
        modelSelection: null,
        chainRootRunId: root,
        chainDepth: 2,
        createdAt: "2026-07-10 12:02:00",
        startedAt: null,
        endedAt: null,
        updatedAt: "2026-07-10 12:02:00",
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b42",
          featureSlug: "b42-wave",
        },
        pipelineWave: {
          id: "wave-1",
          ordinal: 1,
          status: "running",
          trackCount: 2,
          completedTrackCount: 0,
          joinClaimed: false,
          finalized: false,
          blockedCode: null,
          cleanupRequired: false,
        },
        pipelineTrack: {
          id: "t2",
          ordinal: 2,
          status: "running",
          phaseRef: "6.2",
          phaseFile: "docs/p2.md",
        },
      },
      {
        id: "w1t1",
        automationId: "ws::generated:plan-phase",
        workspaceId: "ws-1",
        status: "completed",
        agentId: null,
        sdkRunId: null,
        triggerKind: "chain",
        parentRunId: root,
        title: null,
        summary: null,
        model: null,
        modelSelection: null,
        chainRootRunId: root,
        chainDepth: 1,
        createdAt: "2026-07-10 12:01:00",
        startedAt: null,
        endedAt: null,
        updatedAt: "2026-07-10 12:01:00",
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b42",
          featureSlug: "b42-wave",
        },
        pipelineWave: {
          id: "wave-1",
          ordinal: 1,
          status: "running",
          trackCount: 2,
          completedTrackCount: 0,
          joinClaimed: false,
          finalized: false,
          blockedCode: null,
          cleanupRequired: false,
        },
        pipelineTrack: {
          id: "t1",
          ordinal: 1,
          status: "running",
          phaseRef: "6.1",
          phaseFile: "docs/p1.md",
        },
      },
    ];
    const autoById = new Map([
      ["ws::generated:implement", { ...automation(), configKey: "generated:implement" }],
      ["ws::generated:plan-phase", { ...automation(), configKey: "generated:plan-phase", id: "ws::generated:plan-phase" }],
    ]);
    const lineage = buildPipelineLineage("w1t2", root, listed, autoById);
    expect(lineage.entries.map((e) => e.id)).toEqual(["w1t1", "w1t2"]);
    expect(lineage.entries[1]?.stepLabel).toContain("6.2");
  });
});

describe("summarizePipelineHealth wave summaries", () => {
  it("counts running tracks, barrier waits, blocked waves, and cleanup", () => {
    const runs: Run[] = [
      {
        id: "track-run",
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
        chainRootRunId: "root-1",
        chainDepth: 2,
        createdAt: "2026-07-10 12:00:00",
        startedAt: "2026-07-10 12:00:00",
        endedAt: null,
        updatedAt: "2026-07-10 12:00:00",
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b42",
          featureSlug: "b42-x",
        },
        pipelineWave: {
          id: "wave-run",
          ordinal: 1,
          status: "running",
          trackCount: 2,
          completedTrackCount: 0,
          joinClaimed: false,
          finalized: false,
          blockedCode: null,
          cleanupRequired: false,
        },
        pipelineTrack: {
          id: "track-1",
          ordinal: 1,
          status: "running",
          phaseRef: "6.1",
          phaseFile: "docs/p1.md",
        },
      },
      {
        id: "barrier-run",
        automationId: "auto",
        workspaceId: "ws",
        status: "completed",
        agentId: null,
        sdkRunId: null,
        triggerKind: "chain",
        parentRunId: null,
        title: null,
        summary: null,
        model: null,
        modelSelection: null,
        chainRootRunId: "root-2",
        chainDepth: 4,
        createdAt: "2026-07-10 12:05:00",
        startedAt: null,
        endedAt: "2026-07-10 12:06:00",
        updatedAt: "2026-07-10 12:06:00",
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b77",
          featureSlug: "b77-x",
        },
        pipelineWave: {
          id: "wave-barrier",
          ordinal: 1,
          status: "running",
          trackCount: 2,
          completedTrackCount: 2,
          joinClaimed: false,
          finalized: false,
          blockedCode: null,
          cleanupRequired: false,
        },
      },
      {
        id: "blocked-run",
        automationId: "auto",
        workspaceId: "ws",
        status: "failed",
        agentId: null,
        sdkRunId: null,
        triggerKind: "chain",
        parentRunId: null,
        title: null,
        summary: null,
        model: null,
        modelSelection: null,
        chainRootRunId: "root-3",
        chainDepth: 5,
        chainHandledAt: null,
        createdAt: "2026-07-10 12:10:00",
        startedAt: null,
        endedAt: "2026-07-10 12:11:00",
        updatedAt: "2026-07-10 12:11:00",
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b99",
          featureSlug: "b99-x",
        },
        pipelineWave: {
          id: "wave-blocked",
          ordinal: 1,
          status: "blocked",
          trackCount: 2,
          completedTrackCount: 2,
          joinClaimed: true,
          finalized: false,
          blockedCode: "merge-conflict",
          cleanupRequired: true,
        },
      },
    ];

    const summary = summarizePipelineHealth(runs);
    expect(summary.runningTracks).toHaveLength(1);
    expect(summary.barrierWaits).toHaveLength(1);
    expect(summary.blockedWaves).toHaveLength(1);
    expect(summary.cleanupRequired).toHaveLength(1);

    const lines = formatPipelineHealthLines(summary).join("\n");
    expect(lines).toMatch(/tracks running/);
    expect(lines).toMatch(/barrier wait/);
    expect(lines).toMatch(/blocked waves/);
    expect(lines).toMatch(/cleanup required/);
    expect(lines).toMatch(/lca wave/);
  });
});
