import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isValidPipelinePhaseFile,
  normalizePipelinePhaseRef,
  partitionWaveCandidates,
  pipelineWaveCandidateSchema,
  pipelineWaveControlSchema,
  pipelineWaveOperatorSchema,
  sortWaveCandidates,
  type PipelineWaveCandidate,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { PipelineWaveStore } from "../packages/daemon/src/runs/pipeline-wave-store.ts";

const VALID: PipelineWaveCandidate = {
  phaseRef: "6.1",
  phaseFile: "docs/roadmap/x/06a.md",
};

function withStore(
  run: (waveStore: PipelineWaveStore, cleanup: () => void) => void
): void {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-6-contracts-"));
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
  ).run("ws", join(root, "workspace"), "ws");
  const waveStore = new PipelineWaveStore(db);
  const cleanup = () => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    run(waveStore, cleanup);
  } catch (err) {
    cleanup();
    throw err;
  }
}

function twoTracks(
  waveStore: PipelineWaveStore,
  coordinatorRunId: string,
  opts?: { rootRunId?: string; ordinal?: number }
) {
  const rootRunId = opts?.rootRunId ?? `root-${coordinatorRunId}`;
  const ordinal = opts?.ordinal ?? 1;
  return waveStore.createWaveIdempotent({
    rootRunId,
    coordinatorRunId,
    workspaceId: "ws",
    ordinal,
    baseCommit: "abc123",
    tracks: [
      {
        phaseRef: "6.1",
        phaseFile: "docs/a.md",
        branchName: `lca/b36/${rootRunId}/w${ordinal}-t1`,
        worktreePath: `/tmp/${coordinatorRunId}-wt1`,
        ordinal: 1,
      },
      {
        phaseRef: "6.2",
        phaseFile: "docs/b.md",
        branchName: `lca/b36/${rootRunId}/w${ordinal}-t2`,
        worktreePath: `/tmp/${coordinatorRunId}-wt2`,
        ordinal: 2,
      },
    ],
  });
}

describe("b36.06 pipeline wave schemas", () => {
  it("accepts 2–64 unique forward-slash relative .md candidates", () => {
    expect(pipelineWaveCandidateSchema.safeParse(VALID).success).toBe(true);
    const two = pipelineWaveControlSchema.safeParse({
      action: "fan-out",
      candidates: [
        VALID,
        { phaseRef: "6.2", phaseFile: "docs/b.md" },
      ],
    });
    expect(two.success).toBe(true);

    const sixtyFour = Array.from({ length: 64 }, (_, i) => ({
      phaseRef: `p${i}`,
      phaseFile: `docs/p${i}.md`,
    }));
    expect(
      pipelineWaveControlSchema.safeParse({
        action: "fan-out",
        candidates: sixtyFour,
      }).success
    ).toBe(true);
  });

  it("rejects undersized, oversized, duplicate, and invalid paths", () => {
    expect(
      pipelineWaveControlSchema.safeParse({
        action: "fan-out",
        candidates: [VALID],
      }).success
    ).toBe(false);

    const sixtyFive = Array.from({ length: 65 }, (_, i) => ({
      phaseRef: `p${i}`,
      phaseFile: `docs/p${i}.md`,
    }));
    expect(
      pipelineWaveControlSchema.safeParse({
        action: "fan-out",
        candidates: sixtyFive,
      }).success
    ).toBe(false);

    expect(
      pipelineWaveControlSchema.safeParse({
        action: "fan-out",
        candidates: [
          VALID,
          { phaseRef: " 6.1 ", phaseFile: "docs/other.md" },
        ],
      }).success
    ).toBe(false);

    for (const phaseFile of [
      "/abs/path.md",
      "C:/windows.md",
      "docs\\back.md",
      "docs/./x.md",
      "docs/../x.md",
      "docs//x.md",
      "docs/x.txt",
      "docs/x.md\0",
      "",
    ]) {
      expect(
        pipelineWaveCandidateSchema.safeParse({
          phaseRef: "6.1",
          phaseFile,
        }).success,
        phaseFile
      ).toBe(false);
    }

    expect(
      pipelineWaveControlSchema.safeParse({
        action: "fan-out",
        candidates: [VALID, { phaseRef: "6.2", phaseFile: "docs/b.md" }],
        extra: true,
      }).success
    ).toBe(false);
  });

  it("validates finalize/block/operator shapes", () => {
    expect(
      pipelineWaveControlSchema.safeParse({ action: "finalize" }).success
    ).toBe(true);
    expect(
      pipelineWaveControlSchema.safeParse({
        action: "finalize",
        reason: "nope",
      }).success
    ).toBe(false);

    expect(
      pipelineWaveControlSchema.safeParse({
        action: "block",
        reason: "  merge conflict  ",
      }).success
    ).toBe(true);
    expect(
      pipelineWaveControlSchema.safeParse({
        action: "block",
        reason: "   ",
      }).success
    ).toBe(false);
    expect(
      pipelineWaveControlSchema.safeParse({
        action: "block",
        reason: "x".repeat(257),
      }).success
    ).toBe(false);

    expect(
      pipelineWaveOperatorSchema.safeParse({ action: "retry-integration" })
        .success
    ).toBe(true);
    expect(
      pipelineWaveOperatorSchema.safeParse({
        action: "abort",
        reason: "stop",
      }).success
    ).toBe(true);
    expect(
      pipelineWaveOperatorSchema.safeParse({ action: "retry" }).success
    ).toBe(false);
    expect(
      pipelineWaveOperatorSchema.safeParse({
        action: "abort",
        reason: "   ",
      }).success
    ).toBe(false);
    expect(
      pipelineWaveOperatorSchema.safeParse({
        action: "abort",
        reason: "x".repeat(257),
      }).success
    ).toBe(false);
  });
});

describe("b36.06 pipeline wave helpers", () => {
  it("normalizes phase refs and validates phase files", () => {
    expect(normalizePipelinePhaseRef(" 6.1 ")).toBe("6.1");
    expect(normalizePipelinePhaseRef("")).toBeNull();
    expect(normalizePipelinePhaseRef("x".repeat(65))).toBeNull();
    expect(isValidPipelinePhaseFile("docs/a.md")).toBe(true);
    expect(isValidPipelinePhaseFile("../a.md")).toBe(false);
  });

  it("preserves tracker order, capacity-defers, and rejects low concurrency", () => {
    // Deliberately not in lexical order: tracker submission order is authority.
    const candidates: PipelineWaveCandidate[] = [
      { phaseRef: "6.3", phaseFile: "docs/c.md" },
      { phaseRef: "6.1", phaseFile: "docs/a.md" },
      { phaseRef: "6.2", phaseFile: "docs/b.md" },
    ];
    expect(sortWaveCandidates(candidates).map((c) => c.phaseRef)).toEqual([
      "6.3",
      "6.1",
      "6.2",
    ]);

    const partitioned = partitionWaveCandidates(candidates, 2);
    expect(partitioned.accepted.map((c) => c.phaseRef)).toEqual(["6.3", "6.1"]);
    expect(partitioned.deferred.map((c) => c.phaseRef)).toEqual(["6.2"]);

    for (const concurrency of [1, 0, -1, 2.5, Number.NaN]) {
      const none = partitionWaveCandidates(candidates, concurrency);
      expect(none.accepted, String(concurrency)).toEqual([]);
      expect(none.deferred.map((c) => c.phaseRef), String(concurrency)).toEqual(
        ["6.3", "6.1", "6.2"]
      );
    }
  });
});

describe("b36.06 PipelineWaveStore transitions", () => {
  it("createWaveIdempotent replays the same wave/tracks", () => {
    withStore((waveStore, cleanup) => {
      const first = twoTracks(waveStore, "coord-1");
      expect(first.created).toBe(true);
      expect(first.tracks).toHaveLength(2);

      const second = twoTracks(waveStore, "coord-1");
      expect(second.created).toBe(false);
      expect(second.wave.id).toBe(first.wave.id);
      expect(second.tracks.map((t) => t.id)).toEqual(
        first.tracks.map((t) => t.id)
      );
      cleanup();
    });
  });

  it("planner assignment and markWaveRunning are compare-and-set", () => {
    withStore((waveStore, cleanup) => {
      const { wave, tracks } = twoTracks(waveStore, "coord-2");
      expect(waveStore.assignTrackPlanner(tracks[0]!.id, "planner-1")).toBe(
        true
      );
      expect(waveStore.assignTrackPlanner(tracks[0]!.id, "planner-2")).toBe(
        false
      );
      expect(waveStore.getTrack(tracks[0]!.id)!.planner_run_id).toBe(
        "planner-1"
      );
      expect(waveStore.getTrack(tracks[0]!.id)!.status).toBe("running");

      expect(waveStore.markWaveRunning(wave.id)).toBe(true);
      expect(waveStore.markWaveRunning(wave.id)).toBe(false);
      expect(waveStore.getWave(wave.id)!.status).toBe("running");
      cleanup();
    });
  });

  it("track completion is idempotent and rejected after block/abort", () => {
    withStore((waveStore, cleanup) => {
      const { tracks } = twoTracks(waveStore, "coord-3");
      waveStore.assignTrackPlanner(tracks[0]!.id, "p1");
      const first = waveStore.completeTrack(tracks[0]!.id, "docs-1", "deadbeef");
      expect(first).toEqual({ ok: true, newlyCompleted: true });
      const replay = waveStore.completeTrack(
        tracks[0]!.id,
        "docs-1b",
        "deadbeef"
      );
      expect(replay).toEqual({ ok: true, newlyCompleted: false });

      waveStore.assignTrackPlanner(tracks[1]!.id, "p2");
      waveStore.abortWave(waveStore.getTrack(tracks[1]!.id)!.wave_id, "stop");
      const afterAbort = waveStore.completeTrack(
        tracks[1]!.id,
        "docs-2",
        "cafe"
      );
      expect(afterAbort.ok).toBe(false);
      cleanup();
    });
  });

  it("join claim requires all tracks complete and is won once", () => {
    withStore((waveStore, cleanup) => {
      const { wave, tracks } = twoTracks(waveStore, "coord-4");
      waveStore.markWaveRunning(wave.id);
      expect(waveStore.claimJoin(wave.id)).toBe(false);

      waveStore.assignTrackPlanner(tracks[0]!.id, "p1");
      waveStore.assignTrackPlanner(tracks[1]!.id, "p2");
      waveStore.completeTrack(tracks[0]!.id, "d1", "aaa");
      expect(waveStore.claimJoin(wave.id)).toBe(false);
      waveStore.completeTrack(tracks[1]!.id, "d2", "bbb");

      expect(waveStore.claimJoin(wave.id)).toBe(true);
      expect(waveStore.claimJoin(wave.id)).toBe(false);
      expect(waveStore.getWave(wave.id)!.status).toBe("integrating");
      expect(waveStore.getWave(wave.id)!.join_claimed_at).toBeTruthy();
      cleanup();
    });
  });

  it("finalization and prepareIntegrationRetry follow CAS rules", () => {
    withStore((waveStore, cleanup) => {
      const { wave, tracks } = twoTracks(waveStore, "coord-5");
      waveStore.markWaveRunning(wave.id);
      waveStore.assignTrackPlanner(tracks[0]!.id, "p1");
      waveStore.assignTrackPlanner(tracks[1]!.id, "p2");
      waveStore.completeTrack(tracks[0]!.id, "d1", "aaa");
      waveStore.completeTrack(tracks[1]!.id, "d2", "bbb");
      expect(waveStore.finalizeWave(wave.id)).toBe(false);

      expect(waveStore.claimJoin(wave.id)).toBe(true);
      waveStore.assignIntegrationRun(wave.id, "int-1");
      expect(waveStore.finalizeWave(wave.id)).toBe(true);
      expect(waveStore.finalizeWave(wave.id)).toBe(false);
      expect(waveStore.getWave(wave.id)!.status).toBe("completed");
      expect(
        waveStore.listTracks(wave.id).every((t) => t.status === "integrated")
      ).toBe(true);
      expect(waveStore.prepareIntegrationRetry(wave.id)).toBe(false);

      const blocked = twoTracks(waveStore, "coord-5b");
      waveStore.markWaveRunning(blocked.wave.id);
      waveStore.assignTrackPlanner(blocked.tracks[0]!.id, "p1");
      waveStore.assignTrackPlanner(blocked.tracks[1]!.id, "p2");
      waveStore.completeTrack(blocked.tracks[0]!.id, "d1", "aaa");
      waveStore.completeTrack(blocked.tracks[1]!.id, "d2", "bbb");
      waveStore.claimJoin(blocked.wave.id);
      waveStore.assignIntegrationRun(blocked.wave.id, "int-old");
      waveStore.blockWave(blocked.wave.id, "integration-incomplete", "no finalize");
      expect(waveStore.prepareIntegrationRetry(blocked.wave.id)).toBe(true);
      const prepared = waveStore.getWave(blocked.wave.id)!;
      expect(prepared.status).toBe("running");
      expect(prepared.join_claimed_at).toBeNull();
      expect(prepared.integration_run_id).toBeNull();
      expect(prepared.blocked_code).toBeNull();
      cleanup();
    });
  });

  it("abort is idempotent, skips finalized waves, and aborts nonterminal tracks", () => {
    withStore((waveStore, cleanup) => {
      const { wave, tracks } = twoTracks(waveStore, "coord-6");
      waveStore.markWaveRunning(wave.id);
      waveStore.assignTrackPlanner(tracks[0]!.id, "p1");
      waveStore.completeTrack(tracks[0]!.id, "d1", "aaa");
      waveStore.assignTrackPlanner(tracks[1]!.id, "p2");

      expect(waveStore.abortWave(wave.id, "operator")).toBe(true);
      expect(waveStore.abortWave(wave.id, "again")).toBe(true);
      expect(waveStore.getWave(wave.id)!.status).toBe("aborted");
      expect(waveStore.getTrack(tracks[0]!.id)!.status).toBe("completed");
      expect(waveStore.getTrack(tracks[1]!.id)!.status).toBe("aborted");

      const done = twoTracks(waveStore, "coord-6b");
      waveStore.markWaveRunning(done.wave.id);
      waveStore.assignTrackPlanner(done.tracks[0]!.id, "p1");
      waveStore.assignTrackPlanner(done.tracks[1]!.id, "p2");
      waveStore.completeTrack(done.tracks[0]!.id, "d1", "aaa");
      waveStore.completeTrack(done.tracks[1]!.id, "d2", "bbb");
      waveStore.claimJoin(done.wave.id);
      waveStore.assignIntegrationRun(done.wave.id, "int");
      expect(waveStore.finalizeWave(done.wave.id)).toBe(true);
      expect(waveStore.abortWave(done.wave.id, "too late")).toBe(false);
      expect(waveStore.getWave(done.wave.id)!.status).toBe("completed");
      cleanup();
    });
  });
});
