import type {
  PipelineTrackStatus,
  PipelineWaveCandidate,
  PipelineWaveStatus,
  RunPipelineTrackDoctorDetail,
  RunPipelineWaveDoctorDetail,
} from "@lca/shared";
import { randomUUID } from "node:crypto";
import type { LcaDatabase } from "../db/index.js";

export type PipelineWaveRow = {
  id: string;
  root_run_id: string;
  coordinator_run_id: string;
  workspace_id: string;
  ordinal: number;
  status: PipelineWaveStatus;
  base_commit: string;
  integration_run_id: string | null;
  join_claimed_at: string | null;
  finalized_at: string | null;
  blocked_code: string | null;
  blocked_detail: string | null;
  cleanup_state: string | null;
  created_at: string;
  updated_at: string;
};

export type PipelineTrackRow = {
  id: string;
  wave_id: string;
  ordinal: number;
  phase_ref: string;
  phase_file: string;
  branch_name: string;
  worktree_path: string;
  status: PipelineTrackStatus;
  planner_run_id: string | null;
  terminal_run_id: string | null;
  head_commit: string | null;
  blocked_detail: string | null;
  integrated_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateWaveInput = {
  rootRunId: string;
  coordinatorRunId: string;
  workspaceId: string;
  ordinal: number;
  baseCommit: string;
  tracks: Array<{
    phaseRef: string;
    phaseFile: string;
    branchName: string;
    worktreePath: string;
    ordinal: number;
  }>;
};

export type WaveCleanupOutcome = {
  removedWorktrees: string[];
  deletedBranches: string[];
  retained: Array<{ branch: string; worktreePath: string; reason: string }>;
};

const ACTIVE_WAVE_STATUSES: PipelineWaveStatus[] = [
  "provisioning",
  "running",
  "integrating",
  "blocked",
];

export class PipelineWaveStore {
  constructor(private readonly db: LcaDatabase) {}

  getWave(id: string): PipelineWaveRow | undefined {
    return this.db
      .prepare(`SELECT * FROM pipeline_waves WHERE id = ?`)
      .get(id) as PipelineWaveRow | undefined;
  }

  getWaveByCoordinator(coordinatorRunId: string): PipelineWaveRow | undefined {
    return this.db
      .prepare(`SELECT * FROM pipeline_waves WHERE coordinator_run_id = ?`)
      .get(coordinatorRunId) as PipelineWaveRow | undefined;
  }

  getTrack(id: string): PipelineTrackRow | undefined {
    return this.db
      .prepare(`SELECT * FROM pipeline_tracks WHERE id = ?`)
      .get(id) as PipelineTrackRow | undefined;
  }

  listTracks(waveId: string): PipelineTrackRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pipeline_tracks WHERE wave_id = ? ORDER BY ordinal ASC`
      )
      .all(waveId) as PipelineTrackRow[];
  }

  nextWaveOrdinal(rootRunId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), 0) AS n FROM pipeline_waves WHERE root_run_id = ?`
      )
      .get(rootRunId) as { n: number };
    return row.n + 1;
  }

  /**
   * Idempotent wave creation keyed by coordinator_run_id.
   * Duplicate calls return the existing wave + tracks.
   */
  createWaveIdempotent(input: CreateWaveInput): {
    wave: PipelineWaveRow;
    tracks: PipelineTrackRow[];
    created: boolean;
  } {
    const existing = this.getWaveByCoordinator(input.coordinatorRunId);
    if (existing) {
      return {
        wave: existing,
        tracks: this.listTracks(existing.id),
        created: false,
      };
    }

    const waveId = randomUUID();
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO pipeline_waves (
             id, root_run_id, coordinator_run_id, workspace_id, ordinal,
             status, base_commit
           ) VALUES (?, ?, ?, ?, ?, 'provisioning', ?)`
        )
        .run(
          waveId,
          input.rootRunId,
          input.coordinatorRunId,
          input.workspaceId,
          input.ordinal,
          input.baseCommit
        );

      for (const track of input.tracks) {
        this.db
          .prepare(
            `INSERT INTO pipeline_tracks (
               id, wave_id, ordinal, phase_ref, phase_file,
               branch_name, worktree_path, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning')`
          )
          .run(
            randomUUID(),
            waveId,
            track.ordinal,
            track.phaseRef,
            track.phaseFile,
            track.branchName,
            track.worktreePath
          );
      }
    });

    try {
      create();
    } catch (err) {
      // Unique coordinator race — return the winner.
      const raced = this.getWaveByCoordinator(input.coordinatorRunId);
      if (raced) {
        return {
          wave: raced,
          tracks: this.listTracks(raced.id),
          created: false,
        };
      }
      throw err;
    }

    const wave = this.getWave(waveId)!;
    return { wave, tracks: this.listTracks(waveId), created: true };
  }

  assignTrackPlanner(
    trackId: string,
    plannerRunId: string
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_tracks SET
           planner_run_id = ?,
           status = CASE WHEN status = 'provisioning' THEN 'running' ELSE status END,
           updated_at = datetime('now')
         WHERE id = ? AND planner_run_id IS NULL`
      )
      .run(plannerRunId, trackId);
    return result.changes === 1;
  }

  markWaveRunning(waveId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_waves SET status = 'running', updated_at = datetime('now')
         WHERE id = ? AND status = 'provisioning'`
      )
      .run(waveId);
    return result.changes === 1;
  }

  /**
   * Mark a track complete after its terminal worker (review or legacy docs-commit).
   * Duplicate terminals are no-ops.
   */
  completeTrack(
    trackId: string,
    terminalRunId: string,
    headCommit: string
  ): { ok: true; newlyCompleted: boolean } | { ok: false; reason: string } {
    const track = this.getTrack(trackId);
    if (!track) {
      return { ok: false, reason: "not-found" };
    }
    if (track.status === "completed" || track.status === "integrated") {
      return { ok: true, newlyCompleted: false };
    }
    if (track.status === "aborted" || track.status === "blocked") {
      return { ok: false, reason: `track-${track.status}` };
    }

    const result = this.db
      .prepare(
        `UPDATE pipeline_tracks SET
           status = 'completed',
           terminal_run_id = ?,
           head_commit = ?,
           updated_at = datetime('now')
         WHERE id = ? AND status IN ('provisioning', 'running')`
      )
      .run(terminalRunId, headCommit, trackId);
    return { ok: true, newlyCompleted: result.changes === 1 };
  }

  allTracksComplete(waveId: string): boolean {
    const tracks = this.listTracks(waveId);
    if (tracks.length === 0) return false;
    return tracks.every(
      (t) => t.status === "completed" || t.status === "integrated"
    );
  }

  /**
   * Claim the join barrier once. Returns true iff this caller won.
   */
  claimJoin(waveId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_waves SET
           join_claimed_at = datetime('now'),
           status = 'integrating',
           updated_at = datetime('now')
         WHERE id = ?
           AND join_claimed_at IS NULL
           AND status = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM pipeline_tracks
             WHERE wave_id = ? AND status NOT IN ('completed', 'integrated')
           )`
      )
      .run(waveId, waveId);
    return result.changes === 1;
  }

  assignIntegrationRun(waveId: string, integrationRunId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_waves SET
           integration_run_id = ?,
           updated_at = datetime('now')
         WHERE id = ? AND integration_run_id IS NULL AND join_claimed_at IS NOT NULL`
      )
      .run(integrationRunId, waveId);
    return result.changes === 1;
  }

  clearIntegrationRunForRetry(waveId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_waves SET
           integration_run_id = NULL,
           join_claimed_at = NULL,
           status = 'blocked',
           updated_at = datetime('now')
         WHERE id = ? AND status = 'blocked'`
      )
      .run(waveId);
    // Leave status blocked; caller re-claims join for retry.
    return result.changes === 1 || this.getWave(waveId)?.status === "blocked";
  }

  /**
   * Prepare a blocked wave for depth-neutral integration retry.
   * Clears join/integration claims so a new integration run can be claimed.
   */
  prepareIntegrationRetry(waveId: string): boolean {
    const wave = this.getWave(waveId);
    if (!wave || wave.status !== "blocked") return false;
    if (!this.allTracksComplete(waveId)) return false;
    if (wave.finalized_at != null) return false;

    this.db
      .prepare(
        `UPDATE pipeline_waves SET
           integration_run_id = NULL,
           join_claimed_at = NULL,
           blocked_code = NULL,
           blocked_detail = NULL,
           status = 'running',
           updated_at = datetime('now')
         WHERE id = ? AND status = 'blocked' AND finalized_at IS NULL`
      )
      .run(waveId);
    return this.getWave(waveId)?.status === "running";
  }

  finalizeWave(waveId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_waves SET
           finalized_at = datetime('now'),
           status = 'completed',
           updated_at = datetime('now')
         WHERE id = ?
           AND finalized_at IS NULL
           AND status = 'integrating'
           AND join_claimed_at IS NOT NULL`
      )
      .run(waveId);
    if (result.changes === 1) {
      this.db
        .prepare(
          `UPDATE pipeline_tracks SET
             status = 'integrated',
             integrated_at = datetime('now'),
             updated_at = datetime('now')
           WHERE wave_id = ? AND status = 'completed'`
        )
        .run(waveId);
      return true;
    }
    return false;
  }

  blockWave(
    waveId: string,
    code: string,
    detail: string
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_waves SET
           status = 'blocked',
           blocked_code = ?,
           blocked_detail = ?,
           updated_at = datetime('now')
         WHERE id = ?
           AND status IN ('provisioning', 'running', 'integrating')
           AND finalized_at IS NULL`
      )
      .run(code, detail, waveId);
    return result.changes === 1;
  }

  abortWave(waveId: string, detail: string): boolean {
    const apply = this.db.transaction(() => {
      const wave = this.getWave(waveId);
      if (!wave) return false;
      if (wave.status === "aborted") return true;
      if (wave.status === "completed" && wave.finalized_at != null) return false;

      this.db
        .prepare(
          `UPDATE pipeline_waves SET
             status = 'aborted',
             blocked_code = 'aborted',
             blocked_detail = ?,
             updated_at = datetime('now')
           WHERE id = ? AND status != 'completed'`
        )
        .run(detail, waveId);

      this.db
        .prepare(
          `UPDATE pipeline_tracks SET
             status = 'aborted',
             blocked_detail = ?,
             updated_at = datetime('now')
           WHERE wave_id = ?
             AND status NOT IN ('completed', 'integrated', 'aborted')`
        )
        .run(detail, waveId);
      return true;
    });
    return apply();
  }

  recordCleanup(waveId: string, outcome: WaveCleanupOutcome): void {
    this.db
      .prepare(
        `UPDATE pipeline_waves SET
           cleanup_state = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(JSON.stringify(outcome), waveId);
  }

  /** Waves needing boot reconciliation within a lookback window. */
  listResumableWaves(lookbackMs: number, nowMs = Date.now()): PipelineWaveRow[] {
    const cutoffIso = new Date(nowMs - lookbackMs).toISOString();
    const placeholders = ACTIVE_WAVE_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT * FROM pipeline_waves
         WHERE status IN (${placeholders})
           AND updated_at >= ?
         ORDER BY updated_at ASC
         LIMIT 100`
      )
      .all(...ACTIVE_WAVE_STATUSES, cutoffIso) as PipelineWaveRow[];
  }

  /** Finalized waves whose integration successor may be missing. */
  listFinalizedWithoutSuccessor(
    lookbackMs: number,
    nowMs = Date.now()
  ): PipelineWaveRow[] {
    const cutoffIso = new Date(nowMs - lookbackMs).toISOString();
    return this.db
      .prepare(
        `SELECT w.* FROM pipeline_waves w
         WHERE w.status = 'completed'
           AND w.finalized_at IS NOT NULL
           AND w.finalized_at >= ?
           AND w.integration_run_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM runs r
             WHERE r.id = w.integration_run_id
               AND r.chain_handled_at IS NULL
               AND r.status = 'completed'
           )
         ORDER BY w.finalized_at ASC
         LIMIT 100`
      )
      .all(cutoffIso) as PipelineWaveRow[];
  }

  trackCandidates(waveId: string): PipelineWaveCandidate[] {
    return this.listTracks(waveId).map((t) => ({
      phaseRef: t.phase_ref,
      phaseFile: t.phase_file,
    }));
  }

  boardWaveSummary(waveId: string): {
    id: string;
    ordinal: number;
    status: PipelineWaveStatus;
    trackCount: number;
    completedTrackCount: number;
    joinClaimed: boolean;
    finalized: boolean;
    blockedCode: string | null;
    cleanupRequired: boolean;
  } | null {
    const wave = this.getWave(waveId);
    if (!wave) return null;
    const tracks = this.listTracks(waveId);
    const completedTrackCount = tracks.filter(
      (t) =>
        t.status === "completed" ||
        t.status === "integrated"
    ).length;
    let cleanupRequired = false;
    if (wave.cleanup_state) {
      try {
        const parsed = JSON.parse(wave.cleanup_state) as WaveCleanupOutcome;
        cleanupRequired = (parsed.retained?.length ?? 0) > 0;
      } catch {
        cleanupRequired = true;
      }
    }
    return {
      id: wave.id,
      ordinal: wave.ordinal,
      status: wave.status,
      trackCount: tracks.length,
      completedTrackCount,
      joinClaimed: wave.join_claimed_at != null,
      finalized: wave.finalized_at != null,
      blockedCode: wave.blocked_code,
      cleanupRequired,
    };
  }

  boardTrackSummary(trackId: string): {
    id: string;
    ordinal: number;
    status: PipelineTrackStatus;
    phaseRef: string;
    phaseFile: string;
  } | null {
    const track = this.getTrack(trackId);
    if (!track) return null;
    return {
      id: track.id,
      ordinal: track.ordinal,
      status: track.status,
      phaseRef: track.phase_ref,
      phaseFile: track.phase_file,
    };
  }

  /** Doctor/detail wave projection — includes branch/base/integration, not worktree paths. */
  doctorWaveDetail(waveId: string): RunPipelineWaveDoctorDetail | null {
    const summary = this.boardWaveSummary(waveId);
    if (!summary) return null;
    const wave = this.getWave(waveId)!;
    return {
      ...summary,
      baseCommit: wave.base_commit,
      integrationRunId: wave.integration_run_id,
      blockedDetail: wave.blocked_detail,
    };
  }

  /** Doctor/detail track projection — branch and tip; never exposes worktree path on list. */
  doctorTrackDetail(trackId: string): RunPipelineTrackDoctorDetail | null {
    const summary = this.boardTrackSummary(trackId);
    if (!summary) return null;
    const track = this.getTrack(trackId)!;
    return {
      ...summary,
      branchName: track.branch_name,
      headCommit: track.head_commit,
      blockedDetail: track.blocked_detail,
    };
  }
}
