import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChainRunContext, PipelineWaveControlResponse } from "@lca/shared";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
} from "@lca/shared";
import { pipelineWaveDaemon } from "../packages/automations-io/src/server.ts";
import { DaemonClient, DaemonError } from "../packages/cli/src/client.ts";
import {
  formatWaveOperatorResponse,
  parseWaveArgs,
} from "../packages/cli/src/pipeline-wave.ts";
import { freeListenPort } from "./helpers/free-port.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import {
  addWorktree,
  runGit,
  trackBranchName,
  trackWorktreePath,
} from "../packages/daemon/src/git/worktrees.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { PipelineWaveCoordinator } from "../packages/daemon/src/runs/pipeline-wave-coordinator.ts";
import { PipelineWaveStore } from "../packages/daemon/src/runs/pipeline-wave-store.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b36",
    featureSlug: "b36-wave-actions",
    featureDir: "docs/roadmap/b36-wave-actions",
    featureIndex: "docs/roadmap/b36-wave-actions/00-index.md",
    idea: "wave actions",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "LCA Test",
  GIT_AUTHOR_EMAIL: "lca-test@example.com",
  GIT_COMMITTER_NAME: "LCA Test",
  GIT_COMMITTER_EMAIL: "lca-test@example.com",
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
  writeFileSync(join(repoPath, "README.md"), "# actions\n");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

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

describe("b36.06 pipelineWaveDaemon bridge", () => {
  type Handler = (
    req: IncomingMessage,
    body: string
  ) => { status: number; json?: unknown; raw?: string };

  let server: Server;
  let baseUrl = "";
  let lastRequest:
    | {
        method?: string;
        url?: string;
        headers: NodeJS.Dict<string | string[]>;
        body: string;
      }
    | undefined;
  let requestCount = 0;
  const savedEnv: Record<string, string | undefined> = {};

  function startStub(handler: Handler): Promise<void> {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requestCount += 1;
        lastRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        };
        const result = handler(req, body);
        res.statusCode = result.status;
        if ("json" in result && result.json !== undefined) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result.json));
        } else {
          res.end(result.raw ?? "");
        }
      });
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  beforeEach(() => {
    requestCount = 0;
    lastRequest = undefined;
    for (const key of ["LCA_RUN_ID", "LCA_DAEMON_URL", "LCA_RUN_TOKEN"]) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of ["LCA_RUN_ID", "LCA_DAEMON_URL", "LCA_RUN_TOKEN"]) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("posts fan-out/finalize/block with run token and URL-encoded id", async () => {
    await startStub(() => ({
      status: 200,
      json: {
        outcome: "parallel",
        reason: "parallel",
        waveId: "wave-1",
        accepted: [],
        deferred: [],
      } satisfies PipelineWaveControlResponse,
    }));
    process.env.LCA_RUN_ID = "run/with spaces";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok-xyz";

    await pipelineWaveDaemon({
      action: "fan-out",
      candidates: [
        { phaseRef: "6.1", phaseFile: "docs/a.md" },
        { phaseRef: "6.2", phaseFile: "docs/b.md" },
      ],
    });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.url).toBe(
      `/api/runs/${encodeURIComponent("run/with spaces")}/pipeline-wave`
    );
    expect(lastRequest?.headers["x-lca-run-token"]).toBe("tok-xyz");
    expect(JSON.parse(lastRequest!.body)).toEqual({
      action: "fan-out",
      candidates: [
        { phaseRef: "6.1", phaseFile: "docs/a.md" },
        { phaseRef: "6.2", phaseFile: "docs/b.md" },
      ],
    });

    await pipelineWaveDaemon({ action: "finalize" });
    expect(JSON.parse(lastRequest!.body)).toEqual({ action: "finalize" });

    await pipelineWaveDaemon({ action: "block", reason: "  merge fail  " });
    expect(JSON.parse(lastRequest!.body)).toEqual({
      action: "block",
      reason: "merge fail",
    });
  });

  it("rejects malformed fan-out / blank block before any request", async () => {
    await startStub(() => ({ status: 200, json: {} }));
    process.env.LCA_RUN_ID = "run-1";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok";

    await expect(
      pipelineWaveDaemon({
        action: "fan-out",
        candidates: [{ phaseRef: "6.1", phaseFile: "docs/a.md" }],
      })
    ).rejects.toThrow(/validation failed|requires candidates/i);
    expect(requestCount).toBe(0);

    await expect(
      pipelineWaveDaemon({ action: "block", reason: "   " })
    ).rejects.toThrow(/non-empty reason/i);
    expect(requestCount).toBe(0);
  });

  it("surfaces non-2xx status and body", async () => {
    await startStub(() => ({
      status: 409,
      raw: '{"error":"dirty-checkout"}',
    }));
    process.env.LCA_RUN_ID = "run-1";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok";

    await expect(
      pipelineWaveDaemon({ action: "finalize" })
    ).rejects.toThrow(/daemon pipeline_wave failed \(409\):.*dirty-checkout/i);
  });
});

describe("b36.06 CLI wave parser/formatter", () => {
  it("maps retry aliases and formats responses", () => {
    expect(parseWaveArgs(["wave-1", "retry"])).toEqual({
      waveId: "wave-1",
      action: "retry-integration",
    });
    expect(
      parseWaveArgs(["wave-1", "retry-integration", "--reason", "again"])
    ).toEqual({
      waveId: "wave-1",
      action: "retry-integration",
      reason: "again",
    });
    expect(parseWaveArgs(["wave-1", "abort", "--reason", "stop"])).toEqual({
      waveId: "wave-1",
      action: "abort",
      reason: "stop",
    });

    expect(() => parseWaveArgs(["wave-1"])).toThrow(DaemonError);
    expect(() => parseWaveArgs(["wave-1", "nope"])).toThrow(/Invalid action/);
    expect(() => parseWaveArgs(["wave-1", "abort", "--weird"])).toThrow(
      /Unknown flag/
    );
    expect(() => parseWaveArgs(["wave-1", "abort", "--reason"])).toThrow(
      /Usage/
    );

    expect(
      formatWaveOperatorResponse({
        action: "retry-integration",
        waveId: "abcdefgh-ijkl",
        status: "integrating",
        integrationRunId: "12345678-aaaa",
      })
    ).toMatch(/retry accepted → integration run 12345678/);

    expect(
      formatWaveOperatorResponse({
        action: "abort",
        waveId: "abcdefgh-ijkl",
        status: "aborted",
        integrationRunId: null,
        retained: [
          {
            branch: "lca/x/w1-t1",
            worktreePath: "/tmp/wt",
            reason: "dirty",
          },
        ],
      })
    ).toMatch(/Retained resources:[\s\S]*dirty/);
  });
});

describe("b36.06 operator HTTP + run-token pipeline-wave", () => {
  type Harness = {
    root: string;
    repoPath: string;
    head: string;
    db: ReturnType<typeof openDatabase>;
    store: RunStore;
    waveStore: PipelineWaveStore;
    engine: RunEngine;
    coordinator: PipelineWaveCoordinator;
    client: DaemonClient;
    port: number;
    autoIds: Record<string, string>;
  };

  async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca b36-6 actions-"));
    const lcaHome = join(root, "lca home");
    const repoPath = join(root, "repo");
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
      pipelineResumeLookbackMs: 0,
    });
    engine.setPipelineWaveCoordinator(coordinator);

    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const triggers = new TriggerManager(db, engine, { port });
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      triggers,
      waveCoordinator: coordinator,
    });
    const client = new DaemonClient(`http://127.0.0.1:${port}`);

    try {
      await run({
        root,
        repoPath,
        head,
        db,
        store,
        waveStore,
        engine,
        coordinator,
        client,
        port,
        autoIds,
      });
    } finally {
      await http.close().catch(() => {});
      await engine.shutdown().catch(() => {});
      await chatEngine.shutdown().catch(() => {});
      try {
        db.close();
      } catch {
        /* already closed */
      }
      if (prevLcaHome === undefined) {
        delete process.env.LCA_HOME;
      } else {
        process.env.LCA_HOME = prevLcaHome;
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* tolerate Windows worktree/WAL locks */
      }
    }
  }

  function seedBlockedCompleteWave(h: Harness) {
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
      baseCommit: "abc",
      tracks: [
        {
          phaseRef: "6.1",
          phaseFile: "docs/a.md",
          branchName: "lca/b36/root/w1-t1",
          worktreePath: join(h.root, "wt1"),
          ordinal: 1,
        },
        {
          phaseRef: "6.2",
          phaseFile: "docs/b.md",
          branchName: "lca/b36/root/w1-t2",
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
    h.waveStore.assignIntegrationRun(wave.id, "int-old");
    h.store.insertRun({
      id: "int-old",
      automationId: h.autoIds[IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY]!,
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "old integrate",
      chainContext: CONTEXT,
      chainRootRunId: "root",
      chainDepth: 7,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
    });
    h.store.setStatus("int-old", "failed");
    h.waveStore.blockWave(wave.id, "integration-incomplete", "need retry");
    return { wave, tracks };
  }

  it("refuses operator retry with documented codes and succeeds when eligible", async () => {
    await withHarness(async (h) => {
      await expect(
        h.client.waveAction("missing", { action: "abort" })
      ).rejects.toThrow(/404/);

      // not-blocked
      const running = h.waveStore.createWaveIdempotent({
        rootRunId: "r2",
        coordinatorRunId: "c2",
        workspaceId: "ws",
        ordinal: 1,
        baseCommit: "abc",
        tracks: [
          {
            phaseRef: "6.1",
            phaseFile: "docs/a.md",
            branchName: "b1",
            worktreePath: join(h.root, "a"),
            ordinal: 1,
          },
          {
            phaseRef: "6.2",
            phaseFile: "docs/b.md",
            branchName: "b2",
            worktreePath: join(h.root, "b"),
            ordinal: 2,
          },
        ],
      });
      h.waveStore.markWaveRunning(running.wave.id);
      await expect(
        h.client.waveAction(running.wave.id, { action: "retry-integration" })
      ).rejects.toThrow(/409.*not-blocked/);

      // tracks-incomplete
      h.waveStore.blockWave(running.wave.id, "x", "y");
      await expect(
        h.client.waveAction(running.wave.id, { action: "retry-integration" })
      ).rejects.toThrow(/409.*tracks-incomplete/);

      const { wave } = seedBlockedCompleteWave(h);

      // dirty-checkout
      writeFileSync(join(h.repoPath, "dirty.txt"), "x\n");
      await expect(
        h.client.waveAction(wave.id, { action: "retry-integration" })
      ).rejects.toThrow(/409.*dirty-checkout/);
      rmSync(join(h.repoPath, "dirty.txt"), { force: true });

      // integration-active: blocked wave whose integration run is still live
      h.store.setStatus("int-old", "running");
      h.db.prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`).run("int-old");
      await expect(
        h.client.waveAction(wave.id, { action: "retry-integration" })
      ).rejects.toThrow(/409.*integration-active/);
      h.store.setStatus("int-old", "failed");

      const ok = await h.client.waveAction(wave.id, {
        action: "retry-integration",
      });
      expect(ok.action).toBe("retry-integration");
      expect(ok.integrationRunId).toBeTruthy();
      expect(ok.integrationRunId).not.toBe("int-old");
      const replacement = h.store.getRun(ok.integrationRunId!)!;
      expect(replacement.chain_depth).toBe(6);
      expect(h.waveStore.getWave(wave.id)!.status).toBe("integrating");
    });
  });

  it("operator abort is idempotent, retains dirty resources, refuses finalized", async () => {
    await withHarness(async (h) => {
      const head = h.head;
      const id1 = {
        featureSlug: "b36-wave-actions",
        rootRunId: "root",
        waveOrdinal: 1,
        trackOrdinal: 1,
      };
      const id2 = { ...id1, trackOrdinal: 2 };
      const wt1 = trackWorktreePath(id1);
      const wt2 = trackWorktreePath(id2);
      const br1 = trackBranchName(id1);
      const br2 = trackBranchName(id2);
      await addWorktree({
        repoPath: h.repoPath,
        worktreePath: wt1,
        branchName: br1,
        startPoint: head,
      });
      await addWorktree({
        repoPath: h.repoPath,
        worktreePath: wt2,
        branchName: br2,
        startPoint: head,
      });
      writeFileSync(join(wt1, "scratch.txt"), "dirty\n");

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
      const { wave, tracks } = h.waveStore.createWaveIdempotent({
        rootRunId: "root",
        coordinatorRunId: "coord",
        workspaceId: "ws",
        ordinal: 1,
        baseCommit: head,
        tracks: [
          {
            phaseRef: "6.1",
            phaseFile: "docs/a.md",
            branchName: br1,
            worktreePath: wt1,
            ordinal: 1,
          },
          {
            phaseRef: "6.2",
            phaseFile: "docs/b.md",
            branchName: br2,
            worktreePath: wt2,
            ordinal: 2,
          },
        ],
      });
      h.waveStore.markWaveRunning(wave.id);
      h.waveStore.assignTrackPlanner(tracks[0]!.id, "p1");
      h.waveStore.assignTrackPlanner(tracks[1]!.id, "p2");

      h.store.insertRun({
        id: "sib-queued",
        automationId: h.autoIds["implement"]!,
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "queued",
        chainContext: CONTEXT,
        chainRootRunId: "root",
        chainDepth: 3,
        chainMaxDepth: 40,
        pipelineWaveId: wave.id,
        pipelineTrackId: tracks[1]!.id,
      });
      h.store.insertRun({
        id: "sib-running",
        automationId: h.autoIds["implement"]!,
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "running",
        chainContext: CONTEXT,
        chainRootRunId: "root",
        chainDepth: 3,
        chainMaxDepth: 40,
        pipelineWaveId: wave.id,
        pipelineTrackId: tracks[1]!.id,
      });
      h.store.setStatus("sib-running", "running");
      h.db
        .prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`)
        .run("sib-running");

      const abort = await h.client.waveAction(wave.id, {
        action: "abort",
        reason: "operator stop",
      });
      expect(abort.status).toBe("aborted");
      expect(abort.retained?.some((r) => r.reason === "dirty")).toBe(true);
      expect(h.store.getRun("sib-queued")!.status).toBe("cancelled");
      expect(h.store.getRun("sib-running")!.chain_stop_requested_at).toBeTruthy();

      const again = await h.client.waveAction(wave.id, { action: "abort" });
      expect(again.status).toBe("aborted");

      // Finalized completed wave is not eligible.
      const done = h.waveStore.createWaveIdempotent({
        rootRunId: "root-done",
        coordinatorRunId: "coord-done",
        workspaceId: "ws",
        ordinal: 2,
        baseCommit: "abc",
        tracks: [
          {
            phaseRef: "7.1",
            phaseFile: "docs/c.md",
            branchName: "b3",
            worktreePath: join(h.root, "c"),
            ordinal: 1,
          },
          {
            phaseRef: "7.2",
            phaseFile: "docs/d.md",
            branchName: "b4",
            worktreePath: join(h.root, "d"),
            ordinal: 2,
          },
        ],
      });
      h.waveStore.markWaveRunning(done.wave.id);
      h.waveStore.assignTrackPlanner(done.tracks[0]!.id, "p1");
      h.waveStore.assignTrackPlanner(done.tracks[1]!.id, "p2");
      h.waveStore.completeTrack(done.tracks[0]!.id, "d1", "aaa");
      h.waveStore.completeTrack(done.tracks[1]!.id, "d2", "bbb");
      h.waveStore.claimJoin(done.wave.id);
      h.waveStore.assignIntegrationRun(done.wave.id, "int-done");
      expect(h.waveStore.finalizeWave(done.wave.id)).toBe(true);
      await expect(
        h.client.waveAction(done.wave.id, { action: "abort" })
      ).rejects.toThrow(/409.*not-eligible/);
    });
  });

  it("gates run-scoped pipeline-wave by token and delegates fan-out", async () => {
    await withHarness(async (h) => {
      h.store.insertRun({
        id: "coord-live",
        automationId: h.autoIds["plan-phase"]!,
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "coord",
        chainContext: CONTEXT,
        chainRootRunId: "root-live",
        chainDepth: 1,
        chainMaxDepth: 40,
      });
      h.store.setStatus("coord-live", "running");
      h.db
        .prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`)
        .run("coord-live");

      const internals = h.engine as unknown as {
        runTokens: Map<string, string>;
      };
      internals.runTokens.set("coord-live", "good-token");

      const base = `http://127.0.0.1:${h.port}`;
      const body = {
        action: "fan-out",
        candidates: [
          { phaseRef: "6.1", phaseFile: "docs/a.md" },
          { phaseRef: "6.2", phaseFile: "docs/b.md" },
        ],
      };

      const missing = await fetch(`${base}/api/runs/coord-live/pipeline-wave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(missing.status).toBe(403);

      const wrong = await fetch(`${base}/api/runs/coord-live/pipeline-wave`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "bad",
        },
        body: JSON.stringify(body),
      });
      expect(wrong.status).toBe(403);

      const invalid = await fetch(`${base}/api/runs/coord-live/pipeline-wave`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify({ action: "fan-out", candidates: [] }),
      });
      expect(invalid.status).toBe(400);

      const missingRun = await fetch(
        `${base}/api/runs/no-such/pipeline-wave`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-lca-run-token": "good-token",
          },
          body: JSON.stringify(body),
        }
      );
      // Token map has no entry for no-such → verify passes; route 404s on missing run.
      expect(missingRun.status).toBe(404);

      const ok = await fetch(`${base}/api/runs/coord-live/pipeline-wave`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-lca-run-token": "good-token",
        },
        body: JSON.stringify(body),
      });
      expect(ok.status).toBe(200);
      const json = (await ok.json()) as PipelineWaveControlResponse;
      expect(json).toMatchObject({ outcome: "parallel", reason: "parallel" });
      if ("waveId" in json) {
        expect(json.waveId).toBeTruthy();
      }
    });
  });
});
