import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChainRunContext } from "@lca/shared";
import {
  addWorktree,
  deleteMergedBranch,
  pipelineWorktreesDir,
  preflightMainCheckout,
  removeWorktreeSafe,
  runGit,
  trackBranchName,
  trackWorktreePath,
  type WorktreeIdentity,
} from "../packages/daemon/src/git/worktrees.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { escalateRun } from "../packages/daemon/src/runs/escalation.ts";
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

async function git(
  cwd: string,
  args: string[],
  env?: Record<string, string>
): Promise<string> {
  const result = await runGit({
    cwd,
    args,
    env: { ...GIT_IDENTITY, ...env },
  });
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
  writeFileSync(join(repoPath, "README.md"), "# temp\n");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return (await git(repoPath, ["rev-parse", "HEAD"])).trim();
}

describe("b36.06 worktree manager (real git)", () => {
  let root: string;
  let repoPath: string;
  let lcaHome: string;
  let prevLcaHome: string | undefined;
  let head: string;

  beforeEach(async () => {
    // Path with a space — Windows + git argv safety.
    root = mkdtempSync(join(tmpdir(), "lca b36-6 wt-"));
    lcaHome = join(root, "lca home");
    repoPath = join(root, "main repo");
    mkdirSync(lcaHome, { recursive: true });
    prevLcaHome = process.env.LCA_HOME;
    process.env.LCA_HOME = lcaHome;
    head = await initRepo(repoPath);
  });

  afterEach(() => {
    if (prevLcaHome === undefined) {
      delete process.env.LCA_HOME;
    } else {
      process.env.LCA_HOME = prevLcaHome;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function identity(trackOrdinal = 1): WorktreeIdentity {
    return {
      featureSlug: "b36-implement-fully",
      rootRunId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      waveOrdinal: 1,
      trackOrdinal,
    };
  }

  it("adds a worktree under PIPELINE_WORKTREES_DIR / LCA_HOME", async () => {
    const id = identity();
    const worktreePath = trackWorktreePath(id);
    const branch = trackBranchName(id);

    // Anchored on the temp LCA_HOME: asserting only
    // `startsWith(pipelineWorktreesDir())` would still pass if the override
    // stopped working and worktrees landed in the operator's real home.
    expect(pipelineWorktreesDir()).toBe(join(lcaHome, "worktrees"));
    expect(worktreePath).toBe(
      join(lcaHome, "worktrees", id.rootRunId, "w1", "t1")
    );

    // The boundary is enforced, not merely produced by the path helper.
    await expect(
      addWorktree({
        repoPath,
        worktreePath: join(root, "outside", "t1"),
        branchName: `${branch}-outside`,
        startPoint: head,
      })
    ).rejects.toMatchObject({ operation: "path-escape" });

    await addWorktree({
      repoPath,
      worktreePath,
      branchName: branch,
      startPoint: head,
    });

    expect(existsSync(worktreePath)).toBe(true);
    const wtHead = await git(worktreePath, ["rev-parse", "HEAD"]);
    expect(wtHead).toBe(head);
    const wtBranch = await git(worktreePath, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    expect(wtBranch).toBe(branch);
  });

  it("refuses duplicate worktree path or branch", async () => {
    const id = identity();
    const worktreePath = trackWorktreePath(id);
    const branch = trackBranchName(id);

    await addWorktree({
      repoPath,
      worktreePath,
      branchName: branch,
      startPoint: head,
    });

    await expect(
      addWorktree({
        repoPath,
        worktreePath,
        branchName: `${branch}-alt`,
        startPoint: head,
      })
    ).rejects.toMatchObject({ operation: "worktree-add" });

    const otherPath = trackWorktreePath(identity(2));
    await expect(
      addWorktree({
        repoPath,
        worktreePath: otherPath,
        branchName: branch,
        startPoint: head,
      })
    ).rejects.toMatchObject({ operation: "worktree-add" });
  });

  it("preflight refuses a dirty main checkout", async () => {
    const clean = await preflightMainCheckout(repoPath);
    expect(clean).toMatchObject({ ok: true, headCommit: head });

    writeFileSync(join(repoPath, "dirty.txt"), "nope\n");
    const dirty = await preflightMainCheckout(repoPath);
    expect(dirty).toEqual({
      ok: false,
      reason: "dirty-checkout",
      detail: "working tree is dirty",
    });
  });

  it("removes a clean worktree and deletes a merged branch; retains unmerged", async () => {
    const id = identity();
    const worktreePath = trackWorktreePath(id);
    const branch = trackBranchName(id);

    await addWorktree({
      repoPath,
      worktreePath,
      branchName: branch,
      startPoint: head,
    });

    // Unmerged tip: commit only on the track branch.
    writeFileSync(join(worktreePath, "track.txt"), "track work\n");
    await git(worktreePath, ["add", "track.txt"]);
    await git(worktreePath, ["commit", "-m", "track commit"]);
    const tip = await git(worktreePath, ["rev-parse", "HEAD"]);

    const unmergedDelete = await deleteMergedBranch({
      repoPath,
      branchName: branch,
      intoCommit: head,
    });
    expect(unmergedDelete).toEqual({ deleted: false, reason: "unmerged" });

    // Still listed as a worktree; remove without force-delete of dirty would
    // keep it — make it clean first then remove, then prove unmerged retention
    // of the branch until main advances past the tip.
    const removedWhileClean = await removeWorktreeSafe({
      repoPath,
      worktreePath,
      forceCleanOnly: true,
    });
    expect(removedWhileClean.removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);

    // Branch tip still exists (unmerged into main HEAD).
    const stillThere = await runGit({
      cwd: repoPath,
      args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    });
    expect(stillThere.exitCode).toBe(0);

    // Fast-forward main to the tip so the branch is merge-base ancestor.
    await git(repoPath, ["merge", "--ff-only", tip]);
    const mainHead = await git(repoPath, ["rev-parse", "HEAD"]);
    const mergedDelete = await deleteMergedBranch({
      repoPath,
      branchName: branch,
      intoCommit: mainHead,
    });
    expect(mergedDelete).toEqual({ deleted: true });
  });

  it("retains a dirty worktree when forceCleanOnly is set (no --force delete)", async () => {
    const id = identity();
    const worktreePath = trackWorktreePath(id);
    const branch = trackBranchName(id);

    await addWorktree({
      repoPath,
      worktreePath,
      branchName: branch,
      startPoint: head,
    });
    writeFileSync(join(worktreePath, "scratch.txt"), "dirty\n");

    const result = await removeWorktreeSafe({
      repoPath,
      worktreePath,
      forceCleanOnly: true,
    });
    expect(result).toEqual({ removed: false, reason: "dirty" });
    expect(existsSync(worktreePath)).toBe(true);
  });
});

describe("b36.06 escalate abort aborts wave siblings", () => {
  const CONTEXT: ChainRunContext = {
    variables: {
      pipelineId: "implement-fully",
      featureId: "b36",
      featureSlug: "b36-worktrees",
      featureDir: "docs/roadmap/b36-worktrees",
      featureIndex: "docs/roadmap/b36-worktrees/00-index.md",
      idea: "escalate abort wave",
    },
    roleModels: {
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
      docs: { id: "docs-model" },
    },
  };

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

  it("track-scoped escalate abort marks wave aborted and stops siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-6-esc-wave-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
    ).run("ws", workspace, "Workspace");
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, ?)`
    ).run(
      "ws::impl",
      "Implement",
      JSON.stringify({ type: "manual" }),
      "implement {{featureId}}",
      "generated:implement",
      "implementer"
    );

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
      inputHub,
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
      pipelineResumeLookbackMs: 0,
    });
    engine.setPipelineWaveCoordinator(coordinator);

    const { wave, tracks } = waveStore.createWaveIdempotent({
      rootRunId: "root-wave",
      coordinatorRunId: "coord-1",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: "abc123",
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/p1.md",
          branchName: "lca/b36/root/w1-t1",
          worktreePath: join(root, "wt1"),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/p2.md",
          branchName: "lca/b36/root/w1-t2",
          worktreePath: join(root, "wt2"),
          ordinal: 2,
        },
      ],
    });
    waveStore.markWaveRunning(wave.id);

    store.insertRun({
      id: "track-a",
      automationId: "ws::impl",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "track a",
      chainContext: CONTEXT,
      chainRootRunId: "root-wave",
      chainDepth: 2,
      chainMaxDepth: 20,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[0]!.id,
      executionCwd: join(root, "wt1"),
    });
    store.setStatus("track-a", "failed");

    store.insertRun({
      id: "track-b-queued",
      automationId: "ws::impl",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "track b queued",
      chainContext: CONTEXT,
      chainRootRunId: "root-wave",
      chainDepth: 2,
      chainMaxDepth: 20,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[1]!.id,
      executionCwd: join(root, "wt2"),
    });

    store.insertRun({
      id: "track-b-active",
      automationId: "ws::impl",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "track b active",
      chainContext: CONTEXT,
      chainRootRunId: "root-wave",
      chainDepth: 3,
      chainMaxDepth: 20,
      pipelineWaveId: wave.id,
      pipelineTrackId: tracks[1]!.id,
      executionCwd: join(root, "wt2"),
    });
    store.setStatus("track-b-active", "running");
    db.prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`).run(
      "track-b-active"
    );

    const first = await escalateRun(
      {
        store,
        engine,
        onLog: () => {},
        abortTrackWave: (id, reason) =>
          coordinator.abortWaveForTrackRun(id, reason),
      },
      "track-a",
      { action: "abort", reason: "operator kill track" }
    );
    expect(first.ok).toBe(true);

    const abortedWave = waveStore.getWave(wave.id)!;
    expect(abortedWave.status).toBe("aborted");

    const queued = store.getRun("track-b-queued")!;
    expect(queued.status).toBe("cancelled");

    const active = store.getRun("track-b-active")!;
    expect(active.chain_stop_requested_at).toBeTruthy();
    expect(active.chain_stop_reason).toMatch(/wave-sibling-stop/);

    // Non-track abort semantics unchanged path: second abort is idempotent.
    const second = await escalateRun(
      {
        store,
        engine,
        onLog: () => {},
        abortTrackWave: (id, reason) =>
          coordinator.abortWaveForTrackRun(id, reason),
      },
      "track-a",
      { action: "abort", reason: "again" }
    );
    expect(second.ok).toBe(true);
    expect(waveStore.getWave(wave.id)!.status).toBe("aborted");

    await engine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("non-track escalate abort does not touch waves", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-6-esc-plain-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
    ).run("ws", workspace, "Workspace");
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, ?)`
    ).run(
      "ws::impl",
      "Implement",
      JSON.stringify({ type: "manual" }),
      "implement {{featureId}}",
      "generated:implement",
      "implementer"
    );

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
      inputHub,
      maxConcurrentRuns: 4,
    });
    const waveStore = new PipelineWaveStore(db);
    const coordinator = new PipelineWaveCoordinator({
      store,
      waveStore,
      engine,
      onLog: () => {},
      maxConcurrentRuns: 4,
      pipelineResumeLookbackMs: 0,
    });

    const { wave } = waveStore.createWaveIdempotent({
      rootRunId: "root-other",
      coordinatorRunId: "coord-plain",
      workspaceId: "ws",
      ordinal: 1,
      baseCommit: "abc",
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/p1.md",
          branchName: "lca/b36/x/w1-t1",
          worktreePath: join(root, "wt"),
          ordinal: 1,
        },
      ],
    });
    waveStore.markWaveRunning(wave.id);

    store.insertRun({
      id: "plain-failed",
      automationId: "ws::impl",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "plain",
      chainContext: CONTEXT,
      chainRootRunId: "root-plain",
      chainDepth: 2,
      chainMaxDepth: 10,
    });
    store.setStatus("plain-failed", "failed");

    const result = await escalateRun(
      {
        store,
        engine,
        onLog: () => {},
        abortTrackWave: (id, reason) =>
          coordinator.abortWaveForTrackRun(id, reason),
      },
      "plain-failed",
      { action: "abort", reason: "no wave" }
    );
    expect(result.ok).toBe(true);
    expect(waveStore.getWave(wave.id)!.status).toBe("running");

    await engine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
