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
import type { ChainRunContext, PipelineWaveCandidate } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { runGit } from "../packages/daemon/src/git/worktrees.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
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
    featureSlug: "b36-fanout-join",
    featureDir: "docs/roadmap/b36-fanout-join",
    featureIndex: "docs/roadmap/b36-fanout-join/00-index.md",
    idea: "fanout join durable",
    planningDepth: "jit",
    approvalPolicy: "none",
    researchApprovalPolicy: "none",
    loopMode: "normal",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

const TRACK_TERMINAL_DEPTH_OFFSET = IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length;
const INTEGRATION_DEPTH_OFFSET = IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length + 1;

const CANDIDATES: PipelineWaveCandidate[] = [
  { phaseRef: "6.1", phaseFile: "docs/roadmap/b36/06a.md" },
  { phaseRef: "6.2", phaseFile: "docs/roadmap/b36/06b.md" },
  { phaseRef: "6.3", phaseFile: "docs/roadmap/b36/06c.md" },
];

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
  // Detached default branch names vary; pin to main.
  await git(repoPath, ["checkout", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# fanout\n");
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
  events: DaemonEventBus;
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
      worker.modelRole
    );
  }
  return autoIds;
}

async function makeHarness(opts?: {
  maxConcurrentRuns?: number;
}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "lca b36-6 fanout-"));
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
    maxConcurrentRuns: opts?.maxConcurrentRuns ?? 4,
  });
  const waveStore = new PipelineWaveStore(db);
  engine.setPipelineWaveStore(waveStore);
  const coordinator = new PipelineWaveCoordinator({
    store,
    waveStore,
    engine,
    onLog: () => {},
    maxConcurrentRuns: opts?.maxConcurrentRuns ?? 4,
    pipelineResumeLookbackMs: 0,
  });
  engine.setPipelineWaveCoordinator(coordinator);

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
    events,
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
  try {
    await runGit({ cwd: h.repoPath, args: ["worktree", "prune"] });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(h.root, { recursive: true, force: true });
  } catch {
    /* tolerate Windows worktree/WAL locks */
  }
}

function insertCoordinator(
  h: Harness,
  id = "coord-run",
  depth = 1
): void {
  h.store.insertRun({
    id,
    automationId: h.autoIds["plan-phase"]!,
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: "coordinate",
    chainContext: CONTEXT,
    chainRootRunId: "root-run",
    chainDepth: depth,
    chainMaxDepth: 40,
  });
  h.store.setStatus(id, "running");
  h.db
    .prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`)
    .run(id);
}

function eventTypes(h: Harness, runId: string): string[] {
  return (
    h.db
      .prepare(
        `SELECT event_type FROM run_events WHERE run_id = ? ORDER BY id ASC`
      )
      .all(runId) as Array<{ event_type: string }>
  ).map((r) => r.event_type);
}

function countWaves(h: Harness): number {
  return (
    h.db.prepare(`SELECT COUNT(*) AS n FROM pipeline_waves`).get() as {
      n: number;
    }
  ).n;
}

function listRunsByKey(h: Harness, workerKey: string) {
  return h.db
    .prepare(
      `SELECT r.* FROM runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE a.config_key = ?
       ORDER BY r.created_at ASC`
    )
    .all(`${GENERATED_CONFIG_KEY_PREFIX}${workerKey}`) as Array<{
    id: string;
    chain_depth: number | null;
    chain_root_run_id: string | null;
    chain_max_depth: number | null;
    chain_handled_at: string | null;
    chain_context_json: string | null;
    pipeline_wave_id: string | null;
    pipeline_track_id: string | null;
    execution_cwd: string | null;
    prompt: string;
    model: string | null;
    parent_run_id: string | null;
  }>;
}

async function commitInWorktree(
  worktreePath: string,
  fileName: string
): Promise<string> {
  writeFileSync(join(worktreePath, fileName), `${fileName}\n`);
  await git(worktreePath, ["add", fileName]);
  await git(worktreePath, ["commit", "-m", `track ${fileName}`]);
  return git(worktreePath, ["rev-parse", "HEAD"]);
}

describe("b36.06 fan-out join finalize", () => {
  const harnesses: Harness[] = [];
  afterEach(async () => {
    while (harnesses.length > 0) {
      const h = harnesses.pop()!;
      await cleanup(h);
    }
  });

  it(
    "sequential fallback leaves chain unclaimed and creates no wave/worktree",
    async () => {
    const h = await makeHarness({ maxConcurrentRuns: 1 });
    harnesses.push(h);
    insertCoordinator(h);

    const result = await h.coordinator.fanOut("coord-run", CANDIDATES);
    expect(result.outcome).toBe("sequential-fallback");
    expect(result.reason).toBe("max-concurrent-one");
    expect(result.waveId).toBeNull();
    expect(countWaves(h)).toBe(0);
    expect(h.store.getRun("coord-run")!.chain_handled_at).toBeNull();
    expect(existsSync(join(h.lcaHome, "worktrees"))).toBe(false);

    const direct = await makeHarness({ maxConcurrentRuns: 4 });
    harnesses.push(direct);
    insertCoordinator(direct, "coord-2");
    const one = await direct.coordinator.fanOut("coord-2", [CANDIDATES[0]!]);
    // Schema normally requires 2+, but direct coordinator call with <2 accepted.
    expect(one.outcome).toBe("sequential-fallback");
    expect(one.reason).toBe("insufficient-candidates");
    expect(countWaves(direct)).toBe(0);
    expect(direct.store.getRun("coord-2")!.chain_handled_at).toBeNull();
    expect(existsSync(join(direct.lcaHome, "worktrees"))).toBe(false);

    const dirty = await makeHarness();
    harnesses.push(dirty);
    insertCoordinator(dirty, "coord-3");
    writeFileSync(join(dirty.repoPath, "dirty.txt"), "nope\n");
    const dirtyResult = await dirty.coordinator.fanOut("coord-3", CANDIDATES);
    expect(dirtyResult.outcome).toBe("sequential-fallback");
    expect(dirtyResult.reason).toBe("dirty-checkout");
    expect(countWaves(dirty)).toBe(0);
    expect(dirty.store.getRun("coord-3")!.chain_handled_at).toBeNull();
    expect(existsSync(join(dirty.lcaHome, "worktrees"))).toBe(false);
  },
    60_000
  );

  it(
    "fan-out provisions ordered tracks, join enqueues one integrate-wave, finalize cleans up",
    async () => {
    const h = await makeHarness({ maxConcurrentRuns: 2 });
    harnesses.push(h);
    insertCoordinator(h, "coord-run", 2);

    const first = await h.coordinator.fanOut("coord-run", CANDIDATES);
    expect(first).toMatchObject({
      outcome: "parallel",
      reason: "parallel",
      accepted: [CANDIDATES[0], CANDIDATES[1]],
      deferred: [CANDIDATES[2]],
    });
    expect(first.waveId).toBeTruthy();

    const wave = h.waveStore.getWave(first.waveId!)!;
    expect(wave.status).toBe("running");
    expect(wave.base_commit).toBe(h.head);
    const tracks = h.waveStore.listTracks(wave.id);
    expect(tracks.map((t) => t.phase_ref)).toEqual(["6.1", "6.2"]);
    expect(tracks.every((t) => t.planner_run_id != null)).toBe(true);

    for (const track of tracks) {
      expect(track.worktree_path).toBe(
        join(h.lcaHome, "worktrees", "root-run", `w${wave.ordinal}`, `t${track.ordinal}`)
      );
      expect(existsSync(track.worktree_path)).toBe(true);
      expect(track.branch_name).toMatch(/^lca\/b36-fanout-join\//);
    }

    const cwdByTrackId = new Map(tracks.map((t) => [t.id, t.worktree_path]));
    const planners = listRunsByKey(h, "plan-phase").filter(
      (r) => r.id !== "coord-run"
    );
    expect(planners).toHaveLength(2);
    for (const planner of planners) {
      expect(planner.chain_depth).toBe(3);
      expect(planner.chain_root_run_id).toBe("root-run");
      expect(planner.chain_max_depth).toBe(40);
      expect(planner.pipeline_wave_id).toBe(wave.id);
      expect(cwdByTrackId.has(planner.pipeline_track_id ?? "")).toBe(true);
      expect(planner.execution_cwd).toBe(
        cwdByTrackId.get(planner.pipeline_track_id!)
      );
      expect(planner.prompt).toContain("lca-track-context");
      expect(planner.model).toBe("planner-model");
      expect(planner.parent_run_id).toBe("coord-run");
      expect(JSON.parse(planner.chain_context_json!)).toEqual(CONTEXT);
    }

    expect(h.store.getRun("coord-run")!.chain_handled_at).toBeTruthy();
    expect(eventTypes(h, "coord-run")).toContain("run.pipeline-fanout");

    const replay = await h.coordinator.fanOut("coord-run", CANDIDATES);
    expect(replay.waveId).toBe(wave.id);
    expect(listRunsByKey(h, "plan-phase").filter((r) => r.id !== "coord-run")).toHaveLength(
      2
    );
    expect(
      eventTypes(h, "coord-run").filter((t) => t === "run.pipeline-fanout")
    ).toHaveLength(1);

    // First track review terminal — only that track completes.
    const tip1 = await commitInWorktree(tracks[0]!.worktree_path, "t1.md");
    h.store.insertRun({
      id: "review-t1",
      automationId: h.autoIds["review"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "review t1",
      chainContext: CONTEXT,
      chainRootRunId: "root-run",
      chainDepth: 2 + TRACK_TERMINAL_DEPTH_OFFSET,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[0]!.id,
      executionCwd: tracks[0]!.worktree_path,
    });
    h.store.setStatus("review-t1", "completed");
    await h.coordinator.handleTerminalHook("review-t1", "completed");
    expect(h.waveStore.getTrack(tracks[0]!.id)!.status).toBe("completed");
    expect(h.waveStore.getTrack(tracks[0]!.id)!.head_commit).toBe(tip1);
    expect(h.waveStore.getWave(wave.id)!.status).toBe("running");
    expect(listRunsByKey(h, IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY)).toHaveLength(
      0
    );

    // Second track completes → join + one integrate-wave.
    const tip2 = await commitInWorktree(tracks[1]!.worktree_path, "t2.md");
    h.store.insertRun({
      id: "review-t2",
      automationId: h.autoIds["review"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "review t2",
      chainContext: CONTEXT,
      chainRootRunId: "root-run",
      chainDepth: 2 + TRACK_TERMINAL_DEPTH_OFFSET,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[1]!.id,
      executionCwd: tracks[1]!.worktree_path,
    });
    h.store.setStatus("review-t2", "completed");
    await h.coordinator.handleTerminalHook("review-t2", "completed");

    const integrations = listRunsByKey(h, IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY);
    expect(integrations).toHaveLength(1);
    const integration = integrations[0]!;
    expect(integration.chain_depth).toBe(2 + INTEGRATION_DEPTH_OFFSET);
    expect(integration.pipeline_track_id).toBeNull();
    expect(integration.execution_cwd).toBeNull();
    expect(integration.chain_root_run_id).toBe("root-run");
    expect(integration.chain_max_depth).toBe(40);
    expect(JSON.parse(integration.chain_context_json!)).toEqual(CONTEXT);
    expect(integration.model).toBe("reviewer-model");
    expect(integration.prompt).toContain("lca-integration-context");
    expect(integration.prompt).toContain("lca-track-outcomes");
    expect(integration.prompt).toContain("track-outcomes:");
    expect(integration.prompt.indexOf("6.1")).toBeLessThan(
      integration.prompt.indexOf("6.2")
    );
    // Trusted branch/tip facts remain even when handoff summaries are unavailable.
    expect(integration.prompt).toContain(`tip: ${tip1}`);
    expect(integration.prompt).toContain(`tip: ${tip2}`);
    expect(integration.prompt).toContain("(handoff unavailable)");
    expect(h.waveStore.getWave(wave.id)!.status).toBe("integrating");
    expect(eventTypes(h, "coord-run")).toEqual(
      expect.arrayContaining([
        "run.pipeline-fanout",
        "run.pipeline-join-ready",
        "run.pipeline-integration-enqueued",
      ])
    );

    // Replay review terminal / race join — no second integration.
    await h.coordinator.handleTerminalHook("review-t2", "completed");
    expect(listRunsByKey(h, IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY)).toHaveLength(
      1
    );

    // Finalize refuses unmerged tips.
    const refuse = await h.coordinator.finalize(integration.id);
    expect(refuse.ok).toBe(false);
    if (!refuse.ok) {
      expect(refuse.reason).toBe("track-tip-not-merged");
    }

    // Merge both track branches into main in ordinal order, then finalize.
    for (const track of tracks) {
      await git(h.repoPath, [
        "merge",
        "--no-ff",
        "--no-edit",
        track.branch_name,
      ]);
    }
    const fin1 = await h.coordinator.finalize(integration.id);
    expect(fin1.ok).toBe(true);
    const finalized = h.waveStore.getWave(wave.id)!;
    expect(finalized.status).toBe("completed");
    expect(finalized.finalized_at).toBeTruthy();
    expect(
      h.waveStore.listTracks(wave.id).every((t) => t.status === "integrated")
    ).toBe(true);
    for (const track of tracks) {
      expect(existsSync(track.worktree_path)).toBe(false);
      const branchCheck = await runGit({
        cwd: h.repoPath,
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${track.branch_name}`],
      });
      expect(branchCheck.exitCode).not.toBe(0);
    }
    expect(eventTypes(h, integration.id)).toEqual(
      expect.arrayContaining([
        "run.pipeline-wave-finalized",
        "run.pipeline-wave-cleanup",
      ])
    );

    const fin2 = await h.coordinator.finalize(integration.id);
    expect(fin2.ok).toBe(true);
    expect(h.waveStore.getWave(wave.id)!.status).toBe("completed");
  },
    60_000
  );

  it(
    "blocks dirty track worktrees and incomplete integration",
    async () => {
    const h = await makeHarness({ maxConcurrentRuns: 2 });
    harnesses.push(h);
    insertCoordinator(h, "coord-dirty", 1);
    const fan = await h.coordinator.fanOut("coord-dirty", CANDIDATES.slice(0, 2));
    const wave = h.waveStore.getWave(fan.waveId!)!;
    const tracks = h.waveStore.listTracks(wave.id);

    await commitInWorktree(tracks[0]!.worktree_path, "t1.md");
    writeFileSync(join(tracks[0]!.worktree_path, "scratch.txt"), "dirty\n");
    h.store.insertRun({
      id: "review-dirty",
      automationId: h.autoIds["review"]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "review dirty",
      chainContext: CONTEXT,
      chainRootRunId: "root-run",
      chainDepth: 1 + TRACK_TERMINAL_DEPTH_OFFSET,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[0]!.id,
      executionCwd: tracks[0]!.worktree_path,
    });
    h.store.setStatus("review-dirty", "completed");
    await h.coordinator.handleTerminalHook("review-dirty", "completed");
    expect(h.waveStore.getWave(wave.id)!.blocked_code).toBe(
      "dirty-track-worktree"
    );

    const h2 = await makeHarness({ maxConcurrentRuns: 2 });
    harnesses.push(h2);
    insertCoordinator(h2, "coord-int", 1);
    const fan2 = await h2.coordinator.fanOut(
      "coord-int",
      CANDIDATES.slice(0, 2)
    );
    const wave2 = h2.waveStore.getWave(fan2.waveId!)!;
    const tracks2 = h2.waveStore.listTracks(wave2.id);
    for (const [i, track] of tracks2.entries()) {
      await commitInWorktree(track.worktree_path, `t${i + 1}.md`);
      const reviewId = `review-ok-${i}`;
      h2.store.insertRun({
        id: reviewId,
        automationId: h2.autoIds["review"]!,
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "review",
        chainContext: CONTEXT,
        chainRootRunId: "root-run",
        chainDepth: 1 + TRACK_TERMINAL_DEPTH_OFFSET,
        chainMaxDepth: 40,
        pipelineWaveId: wave2.id,
        pipelineTrackId: track.id,
        executionCwd: track.worktree_path,
      });
      h2.store.setStatus(reviewId, "completed");
      await h2.coordinator.handleTerminalHook(reviewId, "completed");
    }
    const integration = listRunsByKey(
      h2,
      IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY
    )[0]!;
    h2.store.setStatus(integration.id, "completed");
    await h2.coordinator.handleTerminalHook(integration.id, "completed");
    expect(h2.waveStore.getWave(wave2.id)!.blocked_code).toBe(
      "integration-incomplete"
    );
  },
    60_000
  );

  it(
    "accepts legacy docs-commit track terminal",
    async () => {
      const h = await makeHarness({ maxConcurrentRuns: 2 });
      harnesses.push(h);
      insertCoordinator(h, "coord-legacy", 2);
      const fan = await h.coordinator.fanOut(
        "coord-legacy",
        CANDIDATES.slice(0, 2)
      );
      const wave = h.waveStore.getWave(fan.waveId!)!;
      const track = h.waveStore.listTracks(wave.id)[0]!;
      await commitInWorktree(track.worktree_path, "legacy.md");
      h.store.insertRun({
        id: "docs-legacy",
        automationId: h.autoIds["docs-commit"]!,
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "docs legacy",
        chainContext: CONTEXT,
        chainRootRunId: "root-run",
        chainDepth: 2 + TRACK_TERMINAL_DEPTH_OFFSET,
        chainMaxDepth: 40,
        pipelineWaveId: wave.id,
        pipelineTrackId: track.id,
        executionCwd: track.worktree_path,
      });
      h.store.setStatus("docs-legacy", "completed");
      await h.coordinator.handleTerminalHook("docs-legacy", "completed");
      expect(h.waveStore.getTrack(track.id)!.status).toBe("completed");
      expect(h.waveStore.getWave(wave.id)!.status).toBe("running");
      expect(listRunsByKey(h, IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY)).toHaveLength(
        0
      );
    },
    60_000
  );
});
