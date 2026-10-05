import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exitCodeForWatchUntilReason,
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type PipelineSnapshot,
  watchUntilReasonFromSnapshot,
} from "@lca/shared";
import { DaemonClient } from "../packages/cli/src/client.ts";
import {
  cmdWatch,
  parseWatchArgs,
  type WatchJsonEnvelope,
} from "../packages/cli/src/watch.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { provisionGeneratedWorkers } from "../packages/daemon/src/config/generated-workers.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
});

type Db = ReturnType<typeof openDatabase>;

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn should not be called");
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function seedWorkspace(db: Db, workspacePath: string): string {
  mkdirSync(workspacePath, { recursive: true });
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");
  return workspaceId;
}

function chainContextJson(featureId: string): string {
  return JSON.stringify({
    variables: {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId,
      featureSlug: `b81-${featureId}`,
      featureDir: `docs/roadmap/b81-${featureId}`,
      featureIndex: `docs/roadmap/b81-${featureId}/00-index.md`,
      idea: "idea",
      planningDepth: "full",
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
  });
}

function insertPipelineRoot(
  db: Db,
  args: {
    id: string;
    automationId: string;
    workspaceId: string;
    featureId: string;
    createdAt: string;
    status?: string;
    chainStopReason?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status, trigger_kind, prompt,
       chain_root_run_id, chain_depth, chain_max_depth, chain_context_json,
       chain_stop_reason, created_at, updated_at, started_at, ended_at
     ) VALUES (?, ?, ?, ?, 'manual', 'prompt', ?, 0, 9, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.status ?? "running",
    args.id,
    chainContextJson(args.featureId),
    args.chainStopReason ?? null,
    args.createdAt,
    args.createdAt,
    args.createdAt,
    args.status === "completed" ? args.createdAt : null
  );
}

describe("b81 watch CLI", () => {
  async function withServer(
    run: (args: {
      port: number;
      db: Db;
      workspaceId: string;
      workspacePath: string;
      entryAutomationId: string;
      runStore: RunStore;
      client: DaemonClient;
    }) => Promise<void>
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca-b81-watch-cli-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    provisionGeneratedWorkers(db, workspaceId, IMPLEMENT_FULLY_WORKERS);
    const entryAutomationId = automationId(
      workspaceId,
      GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_ENTRY_WORKER_KEY
    );
    const events = new DaemonEventBus();
    const runStore = new RunStore(db, events);
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub,
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const triggers = new TriggerManager(db, engine, { port });
    vi.spyOn(triggers, "refresh").mockImplementation(() => {});
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      runStore,
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      triggers,
    });
    const client = new DaemonClient(`http://127.0.0.1:${port}`);
    try {
      await run({
        port,
        db,
        workspaceId,
        workspacePath,
        entryAutomationId,
        runStore,
        client,
      });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("parseWatchArgs validates usage and until reasons", () => {
    expect(parseWatchArgs([]).ok).toBe(false);
    expect(parseWatchArgs(["b81"]).ok).toBe(true);
    expect(parseWatchArgs(["b42"]).ok).toBe(true);
    expect(parseWatchArgs(["b-xy58"]).ok).toBe(true);
    expect(parseWatchArgs(["--feature", "b42"]).ok).toBe(true);
    expect(parseWatchArgs(["--feature", "b-xy58"]).ok).toBe(true);
    const badUntil = parseWatchArgs(["b81", "--until", "not-a-reason"]);
    expect(badUntil.ok).toBe(false);
    if (!badUntil.ok) {
      expect(badUntil.message).toContain("Unknown --until reason");
    }
  });

  it("usage errors exit 2 and write diagnostics to stderr", async () => {
    const client = new DaemonClient("http://127.0.0.1:9");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      stdout.push(args.join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      stderr.push(args.join(" "));
    });
    try {
      const code = await cmdWatch(client, ["b81", "--until", "not-a-reason"]);
      expect(code).toBe(2);
      expect(stdout).toHaveLength(0);
      expect(stderr.some((l) => l.includes("Unknown --until reason"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("maps every until reason to the frozen exit code", () => {
    const reasons = [
      "green",
      "needs_input",
      "halted",
      "blocked",
      "deadlock",
      "aborted",
      "failed",
      "paused",
      "step",
      "timeout",
    ] as const;
    expect(exitCodeForWatchUntilReason("green")).toBe(0);
    expect(exitCodeForWatchUntilReason("needs_input")).toBe(10);
    expect(exitCodeForWatchUntilReason("halted")).toBe(11);
    expect(exitCodeForWatchUntilReason("blocked")).toBe(12);
    expect(exitCodeForWatchUntilReason("deadlock")).toBe(12);
    expect(exitCodeForWatchUntilReason("aborted")).toBe(13);
    expect(exitCodeForWatchUntilReason("failed")).toBe(13);
    expect(exitCodeForWatchUntilReason("paused")).toBe(0);
    expect(exitCodeForWatchUntilReason("step")).toBe(0);
    expect(exitCodeForWatchUntilReason("timeout")).toBe(14);
    expect(reasons.length).toBe(10);
  });

  it("resolves bN via workspace and exits on --until green with JSON stdout", async () => {
    await withServer(async ({ db, workspaceId, workspacePath, entryAutomationId, client }) => {
      const rootId = randomUUID();
      const gateAutomationId = automationId(
        workspaceId,
        GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
      );
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
        status: "completed",
      });
      const gateId = randomUUID();
      db.prepare(
        `INSERT INTO runs (
           id, automation_id, workspace_id, status, trigger_kind, prompt,
           chain_root_run_id, chain_depth, chain_max_depth,
           chain_stop_reason, created_at, updated_at, started_at, ended_at
         ) VALUES (?, ?, ?, 'completed', 'manual', 'prompt', ?, 1, 9, ?, ?, ?, ?, ?)`
      ).run(
        gateId,
        gateAutomationId,
        workspaceId,
        rootId,
        "complete: shipped",
        "2026-07-10 12:05:00",
        "2026-07-10 12:05:00",
        "2026-07-10 12:05:00",
        "2026-07-10 12:05:00"
      );

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workspacePath);
      const stdout: string[] = [];
      const stderr: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        stdout.push(args.join(" "));
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
        stderr.push(args.join(" "));
      });

      try {
        const code = await cmdWatch(client, [
          "b81",
          "--until",
          "green",
          "--json",
          "--timeout",
          "5s",
        ]);
        expect(code).toBe(0);
        expect(stdout).toHaveLength(1);
        const parsed = JSON.parse(stdout[0]!) as WatchJsonEnvelope;
        expect(parsed.rootRunId).toBe(rootId);
        expect(parsed.reason).toBe("green");
        expect(parsed.snapshot.outcome).toBe("green");
      } finally {
        cwdSpy.mockRestore();
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });

  it("resolves per-person b-xy58 via positional and --feature", async () => {
    await withServer(async ({ db, workspaceId, workspacePath, entryAutomationId, client }) => {
      const rootId = randomUUID();
      const gateAutomationId = automationId(
        workspaceId,
        GENERATED_CONFIG_KEY_PREFIX + IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY
      );
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b-xy58",
        createdAt: "2026-07-10 12:00:00",
        status: "completed",
      });
      const gateId = randomUUID();
      db.prepare(
        `INSERT INTO runs (
           id, automation_id, workspace_id, status, trigger_kind, prompt,
           chain_root_run_id, chain_depth, chain_max_depth,
           chain_stop_reason, created_at, updated_at, started_at, ended_at
         ) VALUES (?, ?, ?, 'completed', 'manual', 'prompt', ?, 1, 9, ?, ?, ?, ?, ?)`
      ).run(
        gateId,
        gateAutomationId,
        workspaceId,
        rootId,
        "complete: shipped",
        "2026-07-10 12:05:00",
        "2026-07-10 12:05:00",
        "2026-07-10 12:05:00",
        "2026-07-10 12:05:00"
      );

      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workspacePath);
      const stdout: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        stdout.push(args.join(" "));
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        for (const argv of [["b-xy58"], ["--feature", "b-xy58"]] as const) {
          stdout.length = 0;
          const code = await cmdWatch(client, [
            ...argv,
            "--until",
            "green",
            "--json",
            "--timeout",
            "5s",
          ]);
          expect(code).toBe(0);
          expect(stdout).toHaveLength(1);
          const parsed = JSON.parse(stdout[0]!) as WatchJsonEnvelope;
          expect(parsed.rootRunId).toBe(rootId);
          expect(parsed.reason).toBe("green");
        }
      } finally {
        cwdSpy.mockRestore();
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });

  it("reconnects with returned cursor via --since", async () => {
    await withServer(async ({ db, workspaceId, entryAutomationId, runStore, client }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });
      const firstId = runStore.appendEvent(rootId, "run.started", {});
      runStore.appendEvent(rootId, "run.finished", {});

      const stdout: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        stdout.push(args.join(" "));
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const code = await cmdWatch(client, [
          rootId,
          "--since",
          String(firstId),
          "--until",
          "step",
          "--timeout",
          "5s",
        ]);
        expect(code).toBe(0);
        expect(stdout.some((l) => l.includes("run.finished"))).toBe(true);
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });

  it("exits 14 on --timeout with one JSON envelope", async () => {
    await withServer(async ({ db, workspaceId, entryAutomationId, client }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });

      const stdout: string[] = [];
      const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
        stdout.push(args.join(" "));
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const code = await cmdWatch(client, [
          rootId,
          "--until",
          "green",
          "--timeout",
          "200ms",
          "--json",
        ]);
        expect(code).toBe(14);
        expect(stdout).toHaveLength(1);
        const parsed = JSON.parse(stdout[0]!) as WatchJsonEnvelope;
        expect(parsed.rootRunId).toBe(rootId);
        expect(parsed.reason).toBe("timeout");
      } finally {
        logSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });

  it("client pollPipelineFeed honors abort signal", async () => {
    await withServer(async ({ db, workspaceId, entryAutomationId, client }) => {
      const rootId = randomUUID();
      insertPipelineRoot(db, {
        id: rootId,
        automationId: entryAutomationId,
        workspaceId,
        featureId: "b81",
        createdAt: "2026-07-10 12:00:00",
      });

      const ac = new AbortController();
      const pending = client.pollPipelineFeed(rootId, 0, 5, ac.signal);
      setTimeout(() => ac.abort(), 50);
      await expect(pending).rejects.toThrow();
    });
  });

  it("watchUntilReasonFromSnapshot maps halted waiting and terminal outcomes", () => {
    const halted: PipelineSnapshot = {
      featureId: "b81",
      featureSlug: null,
      pipelineId: null,
      workspaceId: "ws",
      rootRunId: "root",
      contextUnavailable: false,
      stopRequestedAt: null,
      stopReason: null,
      budgetOverrideInForce: false,
      loopMode: null,
      planningProfile: null,
      roleModelProfileId: null,
      current: null,
      steps: [],
      totals: { elapsedMs: 0, depth: 0, effectiveBudget: null },
      phase: null,
      waves: { summary: null, label: null },
      waiting: null,
      halt: {
        code: "halt",
        detail: "x",
        recoveryCommand: "max escalate root retry",
      },
      outcome: "failed",
      cursor: 1,
    };
    expect(watchUntilReasonFromSnapshot(halted)).toBe("halted");

    const needsInput = {
      ...halted,
      halt: null,
      waiting: {
        inputRequestId: "ir",
        runId: "root",
        kind: "plan-approval",
        question: "?",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    };
    expect(watchUntilReasonFromSnapshot(needsInput)).toBe("needs_input");
  });
});
