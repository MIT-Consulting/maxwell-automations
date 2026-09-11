import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveRun, Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import {
  RunEngine,
  RunMessageError,
} from "../packages/daemon/src/runs/engine.ts";
import { buildPauseResumePrompt } from "../packages/daemon/src/runs/pause-resume-prompt.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

type Db = ReturnType<typeof openDatabase>;

function followUpText(message: string | { text: string }): string {
  return typeof message === "string" ? message : message.text;
}

function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("until() timed out"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function seedRun(
  db: Db,
  workspace: string,
  input: {
    runId: string;
    status: string;
    agentId?: string | null;
    sdkRunId?: string | null;
    chainRootRunId?: string | null;
    chainDepth?: number | null;
    chainMaxDepth?: number | null;
    chainContextJson?: string | null;
    automationId?: string;
  }
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    workspace
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key, chain_json
    ) VALUES (
      'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Original prompt',
      'config.yaml', 'auto', ?
    )`
  ).run(
    JSON.stringify({ next: "ws::child", when: "completed" })
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      'ws::child', 'ws', 'Child', 0, 'enabled', '{"type":"manual"}', 'Child prompt',
      'child.yaml', 'child'
    )`
  ).run();
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, agent_id, sdk_run_id,
      chain_root_run_id, chain_depth, chain_max_depth, chain_context_json
    ) VALUES (
      @runId, @automationId, 'ws', @status, 'manual', 'Stored prompt', @agentId, @sdkRunId,
      @chainRootRunId, @chainDepth, @chainMaxDepth, @chainContextJson
    )`
  ).run({
    runId: input.runId,
    status: input.status,
    agentId: input.agentId ?? null,
    sdkRunId: input.sdkRunId ?? null,
    chainRootRunId: input.chainRootRunId ?? null,
    chainDepth: input.chainDepth ?? null,
    chainMaxDepth: input.chainMaxDepth ?? null,
    chainContextJson: input.chainContextJson ?? null,
    automationId: input.automationId ?? "auto",
  });
}

function statusOf(db: Db, runId: string): string | undefined {
  const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function endedAtOf(db: Db, runId: string): string | null | undefined {
  const row = db.prepare("SELECT ended_at FROM runs WHERE id = ?").get(runId) as
    | { ended_at: string | null }
    | undefined;
  return row?.ended_at;
}

function eventTypes(db: Db, runId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ event_type: string }>
  ).map((event) => event.event_type);
}

function runCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

function queuedMessageRows(
  db: Db,
  runId: string
): Array<{ message: string; status: string }> {
  return db
    .prepare(
      `SELECT message, status FROM run_queued_messages
       WHERE run_id = ?
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(runId) as Array<{ message: string; status: string }>;
}

function inputHubFor(db: Db): InputHub {
  return new InputHub(new InputStore(db), {
    onNeedsInput: (runId) => {
      if (statusOf(db, runId) === "running") {
        db.prepare("UPDATE runs SET status = 'needs_input' WHERE id = ?").run(runId);
      }
    },
    onAnswered: (runId) => {
      if (statusOf(db, runId) === "needs_input") {
        db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
      }
    },
  });
}

type EngineInternals = {
  activeRuns: Map<string, ActiveRun>;
  inFlight: Map<string, AbortController>;
};

function engineInternals(engine: RunEngine): EngineInternals {
  return engine as unknown as EngineInternals;
}

function installRunningActiveRun(
  engine: RunEngine,
  runId: string,
  activeRun: ActiveRun
): { cancelCalls: () => number } {
  let calls = 0;
  const tracked: ActiveRun = {
    ...activeRun,
    cancel: async () => {
      calls += 1;
      await activeRun.cancel();
    },
  };
  const internals = engineInternals(engine);
  internals.activeRuns.set(runId, tracked);
  internals.inFlight.set(runId, new AbortController());
  return { cancelCalls: () => calls };
}

function makePauseLifecycleExecutor(): {
  executor: Executor;
  followUps: string[];
  releaseInitialStream: () => void;
  waitRunning: () => Promise<void>;
} {
  const followUps: string[] = [];
  let releaseInitialStream!: () => void;
  const initialStreamGate = new Promise<void>((resolve) => {
    releaseInitialStream = resolve;
  });
  let running = false;

  const followUpRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-follow-up",
    sdkRunId: "sdk-follow-up",
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "follow-up reply" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "follow-up done" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async (message) => {
      followUps.push(followUpText(message));
      return followUpRun;
    },
  };

  const shell: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-shell",
    sdkRunId: "sdk-shell",
    async *stream() {},
    wait: async () => ({ status: "finished", result: null }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async (message) => {
      followUps.push(followUpText(message));
      return followUpRun;
    },
  };

  const initialRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-initial",
    sdkRunId: "sdk-initial",
    async *stream() {
      running = true;
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "working" }] },
      } as never;
      await initialStreamGate;
    },
    wait: async () => ({ status: "finished", result: "first turn" }) as never,
    cancel: async () => {
      releaseInitialStream();
    },
    dispose: async () => undefined,
    sendFollowUp: async (message) => {
      followUps.push(followUpText(message));
      return followUpRun;
    },
  };

  return {
    executor: {
      kind: "sdk-local",
      spawn: async () => initialRun,
      resume: async () => shell,
    },
    followUps,
    releaseInitialStream,
    waitRunning: () => until(() => running),
  };
}

describe("b50 pause lifecycle", () => {
  it("pauseRun on running sets paused with run.paused and no successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-pause-basic-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      installRunningActiveRun(engine, "run", {
        kind: "sdk-local",
        agentId: "agent",
        sdkRunId: "sdk",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
      });

      await engine.pauseRun("run");

      expect(statusOf(db, "run")).toBe("paused");
      expect(endedAtOf(db, "run")).toBeNull();
      expect(eventTypes(db, "run")).toContain("run.paused");
      expect(runCount(db)).toBe(1);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects pause from needs_input and terminal statuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-pause-reject-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "needs",
        status: "needs_input",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      await expect(engine.pauseRun("needs")).rejects.toMatchObject({
        code: "needs_input",
      } satisfies Partial<RunMessageError>);

      db.prepare(
        `INSERT INTO runs (
          id, automation_id, workspace_id, status, trigger_kind, prompt, agent_id, sdk_run_id
        ) VALUES (
          'done', 'auto', 'ws', 'completed', 'manual', 'Stored prompt', 'agent2', 'sdk2'
        )`
      ).run();
      await expect(engine.pauseRun("done")).rejects.toMatchObject({
        code: "busy",
      } satisfies Partial<RunMessageError>);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discards a pending interrupt when pause wins", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-pause-interrupt-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const { executor, followUps, waitRunning } = makePauseLifecycleExecutor();
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "placeholder",
        status: "completed",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

      const runId = await engine.triggerRun("auto");
      await waitRunning();
      await engine.interruptRun(runId, "interrupt now");
      await engine.pauseRun(runId);

      await until(() => statusOf(db, runId) === "paused", 8000);
      expect(followUps).not.toContain("interrupt now");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "sendMessage while paused settles without terminalizing",
    async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-pause-steer-turn-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const { executor, waitRunning } = makePauseLifecycleExecutor();
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "placeholder",
        status: "completed",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

      const runId = await engine.triggerRun("auto");
      await waitRunning();
      await engine.pauseRun(runId);
      await until(() => statusOf(db, runId) === "paused", 8000);
      await until(() => !engineInternals(engine).inFlight.has(runId), 8000);

      await engine.sendMessage(runId, "operator steer while parked");
      await until(
        () => eventTypes(db, runId).includes("run.paused.turn.settled"),
        8000
      );

      expect(statusOf(db, runId)).toBe("paused");
      expect(eventTypes(db, runId)).not.toContain("run.finished");
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM run_events
             WHERE run_id = ? AND event_type = 'run.error'`
          )
          .get(runId) as { n: number }
      ).toMatchObject({ n: 0 });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
    15000
  );

  it("rejects queueMessage while paused but keeps pre-pause rows pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-pause-queue-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      installRunningActiveRun(engine, "run", {
        kind: "sdk-local",
        agentId: "agent",
        sdkRunId: "sdk",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
      });

      await engine.queueMessage("run", "deliver after resume");
      await engine.pauseRun("run");

      await expect(engine.queueMessage("run", "while paused")).rejects.toMatchObject({
        code: "busy",
      });
      expect(queuedMessageRows(db, "run")).toEqual([
        { message: "deliver after resume", status: "pending" },
      ]);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "resumeRun delivers resume prompt then pre-pause queued message",
    async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-resume-queue-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const { executor, followUps, waitRunning } = makePauseLifecycleExecutor();
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "placeholder",
        status: "completed",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

      const runId = await engine.triggerRun("auto");
      await waitRunning();
      await engine.queueMessage(runId, "deliver after resume");
      await engine.pauseRun(runId);
      await until(() => statusOf(db, runId) === "paused", 8000);
      await until(() => !engineInternals(engine).inFlight.has(runId), 8000);

      await engine.resumeRun(runId, "  keep going  ");
      expect(statusOf(db, runId)).toBe("running");
      await until(
        () =>
          followUps.some((m) => m.includes("Resume the automation goal")) &&
          followUps.some((m) => m.includes("deliver after resume")),
        10000
      );

      expect(eventTypes(db, runId)).toContain("run.pause.resumed");
      expect(followUps.some((m) => m.includes("Operator note:"))).toBe(true);
      expect(followUps.some((m) => m.includes("keep going"))).toBe(true);
      expect(queuedMessageRows(db, runId)).toEqual([
        { message: "deliver after resume", status: "delivered" },
      ]);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
    20000
  );

  it("buildPauseResumePrompt covers null and pipeline chain context", () => {
    const generic = buildPauseResumePrompt({ chainContext: null });
    expect(generic).toContain("Resume the automation goal");
    expect(generic).not.toContain("Feature id:");

    const contextual = buildPauseResumePrompt({
      chainContext: {
        variables: {
          pipelineId: "implement-fully",
          featureId: "b50",
          featureSlug: "b50-steer",
          workerRole: "implement",
        },
        roleModels: {},
      },
    });
    expect(contextual).toContain("Feature id: b50");
    expect(contextual).toContain("Worker role: implement");
  });

  it("pausing a chained run does not spawn a successor via ChainRunner", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-pause-chain-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    let spawnCalls = 0;
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          spawnCalls += 1;
          throw new Error("chain child spawn should not run during pause test");
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      },
      events,
      inputHub: inputHubFor(db),
    });
    const chainRunner = new ChainRunner({ store, engine, events, onLog: () => {} });
    chainRunner.start();

    try {
      seedRun(db, workspace, {
        runId: "chain-run",
        status: "running",
        agentId: "agent",
        sdkRunId: "sdk",
        chainRootRunId: "chain-run",
        chainDepth: 0,
        chainMaxDepth: 5,
        chainContextJson: JSON.stringify({
          variables: { featureId: "b50", pipelineId: "implement-fully" },
          roleModels: {},
        }),
      });
      installRunningActiveRun(engine, "chain-run", {
        kind: "sdk-local",
        agentId: "agent",
        sdkRunId: "sdk",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
      });

      await engine.pauseRun("chain-run");
      await new Promise((r) => setTimeout(r, 50));

      expect(statusOf(db, "chain-run")).toBe("paused");
      expect(runCount(db)).toBe(1);
      expect(spawnCalls).toBe(0);
    } finally {
      chainRunner.stop();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
