import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveRun, Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine, SpawnTimeoutError } from "../packages/daemon/src/runs/engine.ts";

function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
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

function seedWorkspaceAndAutomation(
  db: ReturnType<typeof openDatabase>,
  workspace: string
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    workspace
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Original prompt',
      'config.yaml', 'auto'
    )`
  ).run();
}

function seedRun(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  input: {
    runId: string;
    status: string;
    agentId?: string | null;
    sdkRunId?: string | null;
  }
): void {
  seedWorkspaceAndAutomation(db, workspace);
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, agent_id, sdk_run_id
    ) VALUES (
      @runId, 'auto', 'ws', @status, 'manual', 'Stored prompt', @agentId, @sdkRunId
    )`
  ).run({
    runId: input.runId,
    status: input.status,
    agentId: input.agentId ?? null,
    sdkRunId: input.sdkRunId ?? null,
  });
}

function eventTypes(db: ReturnType<typeof openDatabase>, runId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Array<{ event_type: string }>
  ).map((event) => event.event_type);
}

function statusOf(db: ReturnType<typeof openDatabase>, runId: string): string | undefined {
  const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function inputHubFor(db: ReturnType<typeof openDatabase>): InputHub {
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

function insertSpawnAttemptEvents(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    const seqRow = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM run_events WHERE run_id = ?`
      )
      .get(runId) as { nextSeq: number };
    db.prepare(
      `INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, ?, 'run.spawn.attempt', '{}')`
    ).run(runId, seqRow.nextSeq);
  }
}

function engineFor(
  db: ReturnType<typeof openDatabase>,
  executor: Executor,
  opts?: {
    spawnTimeoutMs?: number;
    runStallTimeoutMs?: number;
    maxSpawnAttempts?: number;
    retryBackoffMs?: number;
  }
): RunEngine {
  return new RunEngine(db, {
    apiKey: "test-key",
    executor,
    inputHub: inputHubFor(db),
    maxSpawnAttempts: opts?.maxSpawnAttempts ?? 3,
    spawnTimeoutMs: opts?.spawnTimeoutMs,
    runStallTimeoutMs: opts?.runStallTimeoutMs,
    retryBackoffMs: opts?.retryBackoffMs,
  });
}

function completingSpawnExecutor(): Executor {
  const spawnedRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-spawn",
    sdkRunId: "sdk-spawn",
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "ok" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return {
    kind: "sdk-local",
    spawn: async () => spawnedRun,
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

describe("SpawnTimeoutError", () => {
  it("formats the timeout message", () => {
    const err = new SpawnTimeoutError("spawn", 120000);
    expect(err.message).toBe("spawn exceeded 120000ms");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("b16 boot reconciliation", () => {
  it("requeues an orphaned running run and re-runs it on resumeInterruptedRuns", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b16-reconcile-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = engineFor(db, completingSpawnExecutor());

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "orphan",
        status: "running",
        agentId: null,
        sdkRunId: null,
      });

      await engine.resumeInterruptedRuns();

      const types = eventTypes(db, "orphan");
      expect(types).toContain("run.reconciled");
      expect(types).toContain("run.retry.scheduled");

      await until(() => statusOf(db, "orphan") === "completed");
      expect(eventTypes(db, "orphan")).toContain("run.started");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks an orphaned run failed when spawn attempts are exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b16-exhausted-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = engineFor(db, completingSpawnExecutor());

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "orphan",
        status: "running",
        agentId: null,
        sdkRunId: null,
      });
      insertSpawnAttemptEvents(db, "orphan", 3);

      await engine.resumeInterruptedRuns();

      await until(() => statusOf(db, "orphan") === "failed");

      const errorPayload = db
        .prepare(
          `SELECT payload FROM run_events
           WHERE run_id = 'orphan' AND event_type = 'run.error'
           ORDER BY seq DESC LIMIT 1`
        )
        .get() as { payload: string };
      const parsed = JSON.parse(errorPayload.payload) as {
        reason: string;
        cause: string;
      };

      expect(parsed).toMatchObject({
        reason: "retries_exhausted",
        cause: "orphaned_no_agent",
      });
      expect(eventTypes(db, "orphan")).toContain("run.reconciled");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b16 spawn timeout and retry", () => {
  it(
    "retries a hung spawn until attempts exhaust, then fails with retries_exhausted",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b16-spawn-timeout-"));
      const db = openDatabase(join(root, "state.sqlite"));
      const engine = engineFor(
        db,
        {
          kind: "sdk-local",
          spawn: () => new Promise<ActiveRun>(() => {}),
          resume: async () => {
            throw new Error("resume should not be called");
          },
        },
        { spawnTimeoutMs: 50, maxSpawnAttempts: 2, retryBackoffMs: 1 }
      );

      try {
        seedWorkspaceAndAutomation(db, join(root, "workspace"));
        const runId = await engine.triggerRun("auto");

        await until(() => statusOf(db, runId) === "failed", 25000);

        const types = eventTypes(db, runId);
        expect(types.filter((t) => t === "run.spawn.attempt")).toHaveLength(2);
        expect(types).toContain("run.retry.scheduled");

        const spawnErrors = db
          .prepare(
            `SELECT payload FROM run_events
             WHERE run_id = ? AND event_type = 'run.error'`
          )
          .all(runId) as Array<{ payload: string }>;
        expect(
          spawnErrors.some((row) => {
            const parsed = JSON.parse(row.payload) as { reason?: string };
            return parsed.reason === "spawn_timeout";
          })
        ).toBe(true);

        const terminalError = db
          .prepare(
            `SELECT payload FROM run_events
             WHERE run_id = ? AND event_type = 'run.error'
             ORDER BY seq DESC LIMIT 1`
          )
          .get(runId) as { payload: string };
        expect(JSON.parse(terminalError.payload)).toMatchObject({
          reason: "retries_exhausted",
          cause: "spawn_timeout",
        });
      } finally {
        await engine.shutdown();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000
  );

  it("completes after a transient spawn error on the second attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b16-spawn-retry-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let spawnCalls = 0;
    const engine = engineFor(
      db,
      {
        kind: "sdk-local",
        spawn: async () => {
          spawnCalls += 1;
          if (spawnCalls === 1) {
            throw new Error("transient spawn failure");
          }
          return {
            kind: "sdk-local",
            agentId: "agent-retry",
            sdkRunId: "sdk-retry",
            async *stream() {
              yield {
                type: "assistant",
                message: { content: [{ type: "text", text: "ok" }] },
              } as never;
            },
            wait: async () => ({ status: "finished", result: "ok" }) as never,
            cancel: async () => undefined,
            dispose: async () => undefined,
          };
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      },
      { maxSpawnAttempts: 3, retryBackoffMs: 1 }
    );

    try {
      seedWorkspaceAndAutomation(db, join(root, "workspace"));
      const runId = await engine.triggerRun("auto");

      await until(() => statusOf(db, runId) === "completed", 10000);
      expect(eventTypes(db, runId).filter((t) => t === "run.spawn.attempt")).toHaveLength(
        2
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disposes a spawn that resolves after the timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b16-late-spawn-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let disposed = false;
    const lateRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-late",
      sdkRunId: "sdk-late",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "late" }] },
        } as never;
      },
      wait: async () => ({ status: "finished" }) as never,
      cancel: async () => undefined,
      dispose: async () => {
        disposed = true;
      },
    };

    const engine = engineFor(
      db,
      {
        kind: "sdk-local",
        spawn: () =>
          new Promise<ActiveRun>((resolve) => {
            setTimeout(() => resolve(lateRun), 12_000);
          }),
        resume: async () => {
          throw new Error("resume should not be called");
        },
      },
      { spawnTimeoutMs: 50, maxSpawnAttempts: 2, retryBackoffMs: 1 }
    );

    try {
      seedWorkspaceAndAutomation(db, join(root, "workspace"));
      await engine.triggerRun("auto");

      await until(() => disposed, 20_000);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});

describe("b16 stall watchdog", () => {
  it("recovers a stalled running run and fails when spawn attempts are exhausted", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b16-stall-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = engineFor(db, completingSpawnExecutor(), {
      runStallTimeoutMs: 1000,
      maxSpawnAttempts: 1,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "stalled",
        status: "running",
        agentId: "agent-1",
        sdkRunId: "sdk-1",
      });
      insertSpawnAttemptEvents(db, "stalled", 1);
      db.prepare(
        `UPDATE runs SET updated_at = datetime('now','-3600 seconds') WHERE id = ?`
      ).run("stalled");

      engine.runStallSweep();

      expect(eventTypes(db, "stalled")).toContain("run.stalled");
      expect(statusOf(db, "stalled")).toBe("failed");

      const terminalError = db
        .prepare(
          `SELECT payload FROM run_events
           WHERE run_id = 'stalled' AND event_type = 'run.error'
           ORDER BY seq DESC LIMIT 1`
        )
        .get() as { payload: string };
      expect(JSON.parse(terminalError.payload)).toMatchObject({
        reason: "retries_exhausted",
        cause: "stalled_idle",
      });
    } finally {
      void engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves a running run with a fresh heartbeat untouched", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b16-stall-fresh-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = engineFor(db, completingSpawnExecutor(), {
      runStallTimeoutMs: 1000,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "fresh",
        status: "running",
        agentId: "agent-1",
        sdkRunId: "sdk-1",
      });

      engine.runStallSweep();

      expect(statusOf(db, "fresh")).toBe("running");
      expect(eventTypes(db, "fresh")).not.toContain("run.stalled");
    } finally {
      void engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not touch a needs_input run regardless of idle time", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b16-stall-needs-input-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = engineFor(db, completingSpawnExecutor(), {
      runStallTimeoutMs: 1000,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "waiting",
        status: "needs_input",
        agentId: "agent-1",
        sdkRunId: "sdk-1",
      });
      db.prepare(
        `UPDATE runs SET updated_at = datetime('now','-3600 seconds') WHERE id = ?`
      ).run("waiting");

      engine.runStallSweep();

      expect(statusOf(db, "waiting")).toBe("needs_input");
      expect(eventTypes(db, "waiting")).not.toContain("run.stalled");
    } finally {
      void engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
