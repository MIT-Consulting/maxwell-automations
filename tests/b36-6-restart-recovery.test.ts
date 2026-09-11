import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainRunContext } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import {
  addWorktree,
  runGit,
  trackBranchName,
  trackWorktreePath,
} from "../packages/daemon/src/git/worktrees.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { PipelineWaveCoordinator } from "../packages/daemon/src/runs/pipeline-wave-coordinator.ts";
import { PipelineWaveStore } from "../packages/daemon/src/runs/pipeline-wave-store.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "LCA Test",
  GIT_AUTHOR_EMAIL: "lca-test@example.com",
  GIT_COMMITTER_NAME: "LCA Test",
  GIT_COMMITTER_EMAIL: "lca-test@example.com",
};

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b36",
    featureSlug: "b36-restart",
    featureDir: "docs/roadmap/b36-restart",
    featureIndex: "docs/roadmap/b36-restart/00-index.md",
    idea: "restart recovery",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit({ cwd, args, env: GIT_IDENTITY });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

async function initRepo(repoPath: string): Promise<string> {
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.name", "LCA Test"]);
  await git(repoPath, ["config", "user.email", "lca-test@example.com"]);
  await git(repoPath, ["checkout", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# restart\n");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        wait: async () => ({ status: "finished", result: "ok" }) as never,
        cancel: async () => {},
        dispose: async () => {},
      };
      return activeRun;
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

type Harness = {
  root: string;
  lcaHome: string;
  repoPath: string;
  head: string;
  db: ReturnType<typeof openDatabase>;
  store: RunStore;
  waveStore: PipelineWaveStore;
  engine: RunEngine;
  coordinator: PipelineWaveCoordinator;
  chainRunner: ChainRunner;
  autoIds: Record<string, string>;
  prevLcaHome: string | undefined;
};

function seedWorkers(
  db: ReturnType<typeof openDatabase>,
  workspaceId: string
): Record<string, string> {
  const autoIds: Record<string, string> = {};
  for (const worker of IMPLEMENT_FULLY_WORKERS) {
    const key = `${GENERATED_CONFIG_KEY_PREFIX}${worker.key}`;
    const id = `${workspaceId}::${key}`;
    autoIds[worker.key] = id;
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, origin, trigger_json, prompt,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, ?, ?, 1, 'enabled', 'generated', ?, ?, 'generated.yaml', ?, ?, ?)`
    ).run(
      id,
      workspaceId,
      worker.name,
      JSON.stringify({ type: "manual" }),
      worker.prompt,
      key,
      JSON.stringify(worker.chain),
      worker.modelRole ?? null
    );
  }
  return autoIds;
}

async function makeHarness(lookbackMs: number): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "lca b36-6 resume-"));
  const lcaHome = join(root, "lca home");
  const repoPath = join(root, "main repo");
  mkdirSync(lcaHome, { recursive: true });
  const prevLcaHome = process.env.LCA_HOME;
  process.env.LCA_HOME = lcaHome;
  const head = await initRepo(repoPath);

  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
  ).run("ws", repoPath, "Workspace");
  const autoIds = seedWorkers(db, "ws");

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    events,
    inputHub: new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    }),
    maxConcurrentRuns: 4,
  });
  const waveStore = new PipelineWaveStore(db);
  engine.setPipelineWaveStore(waveStore);
  const coordinator = new PipelineWaveCoordinator({
    store,
    waveStore,
    engine,
    onLog: () => {},
    maxConcurrentRuns: 4,
    pipelineResumeLookbackMs: lookbackMs,
  });
  engine.setPipelineWaveCoordinator(coordinator);
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: lookbackMs,
    waveCoordinator: coordinator,
  });

  return {
    root,
    lcaHome,
    repoPath,
    head,
    db,
    store,
    waveStore,
    engine,
    coordinator,
    chainRunner,
    autoIds,
    prevLcaHome,
  };
}

async function cleanup(h: Harness): Promise<void> {
  await h.engine.shutdown();
  h.db.close();
  if (h.prevLcaHome === undefined) {
    delete process.env.LCA_HOME;
  } else {
    process.env.LCA_HOME = h.prevLcaHome;
  }
  rmSync(h.root, { recursive: true, force: true });
}

function trackHandoffPacket(): string {
  return [
    "```text",
    "lca-handoff",
    "version: 1",
    "pipeline: implement-fully",
    "worker: implement",
    "feature: b36",
    "phase: docs/a.md",
    "outcome: implemented",
    "summary: track phase implemented",
    "artifacts:",
    "- docs/a.md",
    "decisions:",
    "- none",
    "deviations:",
    "- none",
    "verification:",
    "- npx vitest run => pass",
    "risks:",
    "- none",
    "downstream-effects:",
    "- none",
    "next: review the track phase",
    "```",
  ].join("\n");
}

function recoveryReasons(h: Harness): string[] {
  return (
    h.db
      .prepare(
        `SELECT payload FROM run_events
         WHERE event_type = 'run.pipeline-wave-recovered'
         ORDER BY id ASC`
      )
      .all() as Array<{ payload: string }>
  ).map((row) => (JSON.parse(row.payload) as { reason: string }).reason);
}

function countPlanners(h: Harness, waveId: string): number {
  return (
    h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs
         WHERE pipeline_wave_id = ? AND pipeline_track_id IS NOT NULL
           AND automation_id = ?`
      )
      .get(waveId, h.autoIds["plan-phase"]!) as { n: number }
  ).n;
}

function countIntegrations(h: Harness): number {
  return (
    h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs r
         JOIN automations a ON a.id = r.automation_id
         WHERE a.config_key = ?`
      )
      .get(
        `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY}`
      ) as { n: number }
  ).n;
}

describe("b36.06 restart reconciliation", () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    while (harnesses.length > 0) {
      await cleanup(harnesses.pop()!);
    }
  });

  it("disables reconciliation when lookback is non-positive", async () => {
    const h = await makeHarness(0);
    harnesses.push(h);

    // A wave that a positive lookback would repair (provisioning, no planners).
    h.store.insertRun({
      id: "coord",
      automationId: h.autoIds["plan-phase"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "coord",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 1,
      chainMaxDepth: 40,
    });
    h.store.setStatus("coord", "running");
    h.db.prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`).run("coord");
    const { wave } = h.waveStore.createWaveIdempotent({
      rootRunId: "root",
      coordinatorRunId: "coord",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: h.head,
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: "lca/b36-restart/root/w1-t1",
          worktreePath: join(h.root, "wt1"),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/b.md",
          branchName: "lca/b36-restart/root/w1-t2",
          worktreePath: join(h.root, "wt2"),
          ordinal: 2,
        },
      ],
    });
    expect(wave.status).toBe("provisioning");

    expect(await h.coordinator.resumeWaves()).toBe(0);
    expect(countPlanners(h, wave.id)).toBe(0);
    expect(recoveryReasons(h)).toEqual([]);
    expect(
      h.waveStore.listTracks(wave.id).every((t) => t.planner_run_id == null)
    ).toBe(true);
  });

  it("repairs missing planner assignment exactly once", async () => {
    const h = await makeHarness(86_400_000);
    harnesses.push(h);

    h.store.insertRun({
      id: "coord",
      automationId: h.autoIds["plan-phase"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "coord",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 1,
      chainMaxDepth: 40,
    });
    h.store.setStatus("coord", "running");
    h.db.prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`).run("coord");

    const identity1 = {
      featureSlug: "b36-restart",
      rootRunId: "root",
      waveOrdinal: 1,
      trackOrdinal: 1,
    };
    const identity2 = { ...identity1, trackOrdinal: 2 };
    const { wave, tracks } = h.waveStore.createWaveIdempotent({
      rootRunId: "root",
      coordinatorRunId: "coord",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: h.head,
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: trackBranchName(identity1),
          worktreePath: trackWorktreePath(identity1),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/b.md",
          branchName: trackBranchName(identity2),
          worktreePath: trackWorktreePath(identity2),
          ordinal: 2,
        },
      ],
    });
    // Leave wave in provisioning with no planners assigned.
    expect(wave.status).toBe("provisioning");

    const repaired = await h.coordinator.resumeWaves();
    expect(repaired).toBeGreaterThan(0);
    expect(recoveryReasons(h)).toContain("provisioning-planner");
    expect(countPlanners(h, wave.id)).toBe(2);
    expect(
      h.waveStore.listTracks(wave.id).every((t) => t.planner_run_id != null)
    ).toBe(true);
    expect(existsSync(tracks[0]!.worktree_path)).toBe(true);

    const second = await h.coordinator.resumeWaves();
    expect(second).toBe(0);
    expect(countPlanners(h, wave.id)).toBe(2);
    expect(
      recoveryReasons(h).filter((r) => r === "provisioning-planner")
    ).toHaveLength(2); // one event per track on first sweep
  });

  it("replays a missed track terminal once", async () => {
    const h = await makeHarness(86_400_000);
    harnesses.push(h);

    h.store.insertRun({
      id: "coord",
      automationId: h.autoIds["plan-phase"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "coord",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 1,
      chainMaxDepth: 40,
    });
    h.store.setStatus("coord", "completed");
    h.db
      .prepare(`UPDATE runs SET chain_handled_at = datetime('now') WHERE id = ?`)
      .run("coord");

    const id1 = {
      featureSlug: "b36-restart",
      rootRunId: "root",
      waveOrdinal: 1,
      trackOrdinal: 1,
    };
    const id2 = { ...id1, trackOrdinal: 2 };
    const { wave, tracks } = h.waveStore.createWaveIdempotent({
      rootRunId: "root",
      coordinatorRunId: "coord",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: h.head,
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: trackBranchName(id1),
          worktreePath: trackWorktreePath(id1),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/b.md",
          branchName: trackBranchName(id2),
          worktreePath: trackWorktreePath(id2),
          ordinal: 2,
        },
      ],
    });
    h.waveStore.markWaveRunning(wave.id);
    h.waveStore.assignTrackPlanner(tracks[0]!.id, "planner-1");
    h.waveStore.assignTrackPlanner(tracks[1]!.id, "planner-2");

    await addWorktree({
      repoPath: h.repoPath,
      worktreePath: tracks[0]!.worktree_path,
      branchName: tracks[0]!.branch_name,
      startPoint: h.head,
    });
    writeFileSync(join(tracks[0]!.worktree_path, "t1.md"), "t1\n");
    await git(tracks[0]!.worktree_path, ["add", "t1.md"]);
    await git(tracks[0]!.worktree_path, ["commit", "-m", "t1"]);
    const tip = await git(tracks[0]!.worktree_path, ["rev-parse", "HEAD"]);

    h.store.insertRun({
      id: "review-missed",
      automationId: h.autoIds["review"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "review",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 4,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[0]!.id,
      executionCwd: tracks[0]!.worktree_path,
    });
    h.store.setStatus("review-missed", "completed");
    // chain_handled_at remains null — crash before claim.

    const repaired = await h.coordinator.resumeWaves();
    expect(repaired).toBeGreaterThan(0);
    expect(recoveryReasons(h)).toContain("missed-track-terminal");
    const track = h.waveStore.getTrack(tracks[0]!.id)!;
    expect(track.status).toBe("completed");
    expect(track.head_commit).toBe(tip);
    expect(h.store.getRun("review-missed")!.chain_handled_at).toBeTruthy();

    await h.coordinator.resumeWaves();
    expect(
      recoveryReasons(h).filter((r) => r === "missed-track-terminal")
    ).toHaveLength(1);
  });

  it("enqueues integration once for an all-complete unclaimed join", async () => {
    const h = await makeHarness(86_400_000);
    harnesses.push(h);

    h.store.insertRun({
      id: "coord",
      automationId: h.autoIds["plan-phase"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "coord",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 2,
      chainMaxDepth: 40,
    });
    h.store.setStatus("coord", "completed");
    h.db
      .prepare(`UPDATE runs SET chain_handled_at = datetime('now') WHERE id = ?`)
      .run("coord");

    const { wave, tracks } = h.waveStore.createWaveIdempotent({
      rootRunId: "root",
      coordinatorRunId: "coord",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: h.head,
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: "lca/b36-restart/root/w1-t1",
          worktreePath: join(h.root, "wt1"),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/b.md",
          branchName: "lca/b36-restart/root/w1-t2",
          worktreePath: join(h.root, "wt2"),
          ordinal: 2,
        },
      ],
    });
    h.waveStore.markWaveRunning(wave.id);
    h.waveStore.assignTrackPlanner(tracks[0]!.id, "p1");
    h.waveStore.assignTrackPlanner(tracks[1]!.id, "p2");
    h.waveStore.completeTrack(tracks[0]!.id, "d1", "aaa");
    h.waveStore.completeTrack(tracks[1]!.id, "d2", "bbb");

    const repaired = await h.coordinator.resumeWaves();
    expect(repaired).toBeGreaterThan(0);
    expect(recoveryReasons(h)).toContain("ready-join");
    expect(countIntegrations(h)).toBe(1);
    expect(h.waveStore.getWave(wave.id)!.status).toBe("integrating");

    await h.coordinator.resumeWaves();
    expect(countIntegrations(h)).toBe(1);
    expect(recoveryReasons(h).filter((r) => r === "ready-join")).toHaveLength(
      1
    );
  });

  it("boot order resumes finalized integration into main plan-phase once", async () => {
    const h = await makeHarness(86_400_000);
    harnesses.push(h);

    h.store.insertRun({
      id: "coord",
      automationId: h.autoIds["plan-phase"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "coord",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 2,
      chainMaxDepth: 40,
    });
    h.store.setStatus("coord", "completed");
    h.db
      .prepare(`UPDATE runs SET chain_handled_at = datetime('now') WHERE id = ?`)
      .run("coord");

    const { wave, tracks } = h.waveStore.createWaveIdempotent({
      rootRunId: "root",
      coordinatorRunId: "coord",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: h.head,
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: "lca/b36-restart/root/w1-t1",
          worktreePath: join(h.root, "wt1"),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/b.md",
          branchName: "lca/b36-restart/root/w1-t2",
          worktreePath: join(h.root, "wt2"),
          ordinal: 2,
        },
      ],
    });
    h.waveStore.markWaveRunning(wave.id);
    h.waveStore.assignTrackPlanner(tracks[0]!.id, "p1");
    h.waveStore.assignTrackPlanner(tracks[1]!.id, "p2");
    h.waveStore.completeTrack(tracks[0]!.id, "d1", "aaa");
    h.waveStore.completeTrack(tracks[1]!.id, "d2", "bbb");
    h.waveStore.claimJoin(wave.id);
    h.store.insertRun({
      id: "integration",
      automationId: h.autoIds[IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "integrate",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 6,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
      parentRunId: "coord",
    });
    h.waveStore.assignIntegrationRun(wave.id, "integration");
    expect(h.waveStore.finalizeWave(wave.id)).toBe(true);
    h.store.setStatus("integration", "completed");
    // chain_handled_at null — crash after finalize, before successor.

    await h.coordinator.resumeWaves();
    expect(recoveryReasons(h)).toContain("finalized-successor");
    await h.chainRunner.resumeMissedTransitions();

    const successors = h.db
      .prepare(
        `SELECT r.id, r.chain_depth, r.pipeline_wave_id, r.pipeline_track_id,
                r.execution_cwd, r.chain_root_run_id, r.chain_max_depth
         FROM runs r
         JOIN automations a ON a.id = r.automation_id
         WHERE r.parent_run_id = 'integration'
           AND a.config_key = 'generated:plan-phase'`
      )
      .all() as Array<{
      id: string;
      chain_depth: number | null;
      pipeline_wave_id: string | null;
      pipeline_track_id: string | null;
      execution_cwd: string | null;
      chain_root_run_id: string | null;
      chain_max_depth: number | null;
    }>;
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({
      chain_depth: 7, // integration 6 + 1 == coordinator 2 + 4
      pipeline_wave_id: null,
      pipeline_track_id: null,
      execution_cwd: null,
      chain_root_run_id: "root",
      chain_max_depth: 40,
    });

    await h.coordinator.resumeWaves();
    await h.chainRunner.resumeMissedTransitions();
    expect(
      h.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs WHERE parent_run_id = 'integration'`
        )
        .get() as { n: number }
    ).toEqual({ n: 1 });
  });

  it("re-injects trusted track assignment into chained track children", async () => {
    const h = await makeHarness(0);
    harnesses.push(h);

    h.store.insertRun({
      id: "coord",
      automationId: h.autoIds["plan-phase"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "coord",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 2,
      chainMaxDepth: 40,
    });
    h.store.setStatus("coord", "completed");

    const worktreePath = join(h.root, "wt1");
    mkdirSync(worktreePath, { recursive: true });
    const { wave, tracks } = h.waveStore.createWaveIdempotent({
      rootRunId: "root",
      coordinatorRunId: "coord",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: h.head,
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: "lca/b36-restart/root/w1-t1",
          worktreePath,
          ordinal: 1,
        },
      ],
    });
    h.waveStore.markWaveRunning(wave.id);
    h.waveStore.assignTrackPlanner(tracks[0]!.id, "p1");

    h.store.insertRun({
      id: "impl-1",
      automationId: h.autoIds["implement"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "implement",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 4,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[0]!.id,
      executionCwd: worktreePath,
    });
    h.store.setStatus("impl-1", "completed");
    h.store.appendEvent("impl-1", "run.finished", {
      result: trackHandoffPacket(),
    });

    await h.chainRunner.handleTerminal("impl-1", "completed");

    const child = h.db
      .prepare(
        `SELECT r.prompt, r.pipeline_track_id FROM runs r
         JOIN automations a ON a.id = r.automation_id
         WHERE r.parent_run_id = 'impl-1' AND a.config_key = 'generated:review'`
      )
      .get() as { prompt: string; pipeline_track_id: string | null };

    expect(child.pipeline_track_id).toBe(tracks[0]!.id);
    expect(child.prompt).toContain("lca-track-context");
    expect(child.prompt).toContain("waveOrdinal: 1");
    expect(child.prompt).toContain("trackOrdinal: 1");
    expect(child.prompt).toContain("phaseRef: 6.1");
    expect(child.prompt).toContain("phaseFile: docs/a.md");
    // Predecessor packet is present but cannot outrank the trusted block.
    expect(child.prompt).toContain("lca-handoff");
    expect(
      child.prompt.lastIndexOf("--- lca-track-context (trusted; do not edit) ---")
    ).toBeGreaterThan(child.prompt.indexOf("lca-handoff"));
  });

  it("skips waves outside the lookback window", async () => {
    const h = await makeHarness(1_000);
    harnesses.push(h);

    h.store.insertRun({
      id: "coord",
      automationId: h.autoIds["plan-phase"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "coord",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 1,
      chainMaxDepth: 40,
    });
    const { wave, tracks } = h.waveStore.createWaveIdempotent({
      rootRunId: "root",
      coordinatorRunId: "coord",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: h.head,
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: "lca/b36-restart/root/w1-t1",
          worktreePath: join(h.root, "wt1"),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/b.md",
          branchName: "lca/b36-restart/root/w1-t2",
          worktreePath: join(h.root, "wt2"),
          ordinal: 2,
        },
      ],
    });
    h.db
      .prepare(
        `UPDATE pipeline_waves SET updated_at = datetime('now', '-2 days') WHERE id = ?`
      )
      .run(wave.id);
    void tracks;

    expect(await h.coordinator.resumeWaves()).toBe(0);
    expect(countPlanners(h, wave.id)).toBe(0);
  });
});
