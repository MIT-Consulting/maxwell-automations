import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import type { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  RunEngine,
  RunMessageError,
} from "../packages/daemon/src/runs/engine.ts";

function followUpText(message: string | { text: string }): string {
  return typeof message === "string" ? message : message.text;
}

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

function seedArtifactWorkspace(workspace: string): void {
  mkdirSync(join(workspace, ".cursor", "rules"), { recursive: true });
  mkdirSync(join(workspace, ".cursor", "skills", "lca-dev"), { recursive: true });
  writeFileSync(
    join(workspace, ".cursor", "rules", "tech-stack.mdc"),
    ["---", "description: Project stack", "---", "# Tech Stack"].join("\n")
  );
  writeFileSync(
    join(workspace, ".cursor", "skills", "lca-dev", "SKILL.md"),
    ["---", "name: lca-dev", "description: Start dev", "---", "# LCA Dev"].join("\n")
  );
}

function eventPayload(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  eventType: string
): unknown {
  const row = db
    .prepare(
      "SELECT payload FROM run_events WHERE run_id = ? AND event_type = ? ORDER BY seq DESC LIMIT 1"
    )
    .get(runId, eventType) as { payload: string } | undefined;
  expect(row).toBeDefined();
  return JSON.parse(row!.payload);
}

function queuedMessageRows(
  db: ReturnType<typeof openDatabase>,
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

function makeBlockingSpawnExecutor(
  onFollowUp?: (message: string | { text: string }) => void
): {
  executor: Executor;
  releaseInitialStream: () => void;
  waitRunning: () => Promise<void>;
} {
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
  };

  const resumedShell: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-resumed",
    sdkRunId: "sdk-resumed",
    async *stream() {},
    wait: async () => ({ status: "finished", result: null }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async (message) => {
      onFollowUp?.(message);
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
      onFollowUp?.(message);
      return followUpRun;
    },
  };

  return {
    executor: {
      kind: "sdk-local",
      spawn: async () => initialRun,
      resume: async () => resumedShell,
    },
    releaseInitialStream,
    waitRunning: async () => until(() => running),
  };
}

describe("RunEngine interactive messages", () => {
  it("reopens a terminal resumable run and streams the verbatim message", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b4-engine-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let resumeParams: ResumeParams | undefined;
    let followUpMessage: string | undefined;
    let disposed = false;

    const nextRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-next",
      sdkRunId: "sdk-next",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "reply" }] },
        } as never;
      },
      wait: async () => ({ status: "finished", result: "reply" }) as never,
      cancel: async () => undefined,
      dispose: async () => {
        disposed = true;
      },
      sendFollowUp: async () => {
        throw new Error("second follow-up should not be called");
      },
    };
    const resumedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async (message) => {
        followUpMessage = followUpText(message);
        return nextRun;
      },
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async (params) => {
        resumeParams = params;
        return resumedRun;
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      await engine.sendMessage("run", "follow up question");

      const reopened = db.prepare("SELECT status FROM runs WHERE id = 'run'").get() as {
        status: string;
      };
      expect(reopened.status).toBe("running");

      await until(() => {
        const row = db.prepare("SELECT status FROM runs WHERE id = 'run'").get() as
          | { status: string }
          | undefined;
        return row?.status === "completed";
      });

      const row = db
        .prepare("SELECT status, agent_id, sdk_run_id FROM runs WHERE id = 'run'")
        .get() as { status: string; agent_id: string; sdk_run_id: string };
      const messagePayload = db
        .prepare(
          "SELECT payload FROM run_events WHERE run_id = 'run' AND event_type = 'run.message'"
        )
        .get() as { payload: string };

      expect(resumeParams).toMatchObject({
        cwd: join(root, "workspace"),
        prompt: "Stored prompt",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });
      expect(resumeParams?.runToken).toBeTruthy();
      expect(followUpMessage).toBe("follow up question");
      expect(row).toMatchObject({
        status: "completed",
        agent_id: "agent-next",
        sdk_run_id: "sdk-next",
      });
      expect(JSON.parse(messagePayload.payload)).toEqual({
        role: "user",
        text: "follow up question",
      });
      expect(eventTypes(db, "run")).toEqual([
        "run.message",
        "run.resumed",
        "assistant",
        "run.finished",
      ]);
      expect(disposed).toBe(false);

      const internals = engine as unknown as {
        activeRuns: Map<string, ActiveRun>;
        inFlight: Map<string, AbortController>;
        retainedRuns: Map<string, { activeRun: ActiveRun; runToken: string }>;
        runTokens: Map<string, string>;
      };
      expect(internals.activeRuns.size).toBe(0);
      expect(internals.inFlight.size).toBe(0);
      expect(internals.retainedRuns.size).toBe(1);
      expect(internals.runTokens.size).toBe(1);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps ask_user working during the resumed interactive turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b4-ask-user-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let resumeParams: ResumeParams | undefined;
    let followUpMessage: string | undefined;
    let streamStarted = false;
    let releaseStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const nextRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-after-ask",
      sdkRunId: "sdk-after-ask",
      async *stream() {
        streamStarted = true;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Need operator input." }] },
        } as never;
        await streamDone;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Continuing after answer." }] },
        } as never;
      },
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async () => {
        throw new Error("second follow-up should not be called");
      },
    };
    const resumedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async (message) => {
        followUpMessage = followUpText(message);
        return nextRun;
      },
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async (params) => {
        resumeParams = params;
        return resumedRun;
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      await engine.sendMessage("run", "continue and ask me");
      await until(() => streamStarted && Boolean(resumeParams?.runToken));

      const answerPromise = engine.askAndWait(
        "run",
        "Which option should I use?",
        resumeParams?.runToken
      );
      await until(() => statusOf(db, "run") === "needs_input");
      expect(
        db.prepare("SELECT question, status FROM input_requests WHERE run_id = 'run'").get()
      ).toMatchObject({
        question: "Which option should I use?",
        status: "pending",
      });

      await engine.submitAnswer("run", "option A");
      await expect(answerPromise).resolves.toBe("option A");
      expect(statusOf(db, "run")).toBe("running");
      releaseStream();

      await until(() => statusOf(db, "run") === "completed");
      expect(followUpMessage).toBe("continue and ask me");
      expect(eventTypes(db, "run")).toEqual([
        "run.message",
        "run.resumed",
        "assistant",
        "input.asked",
        "input.delivered",
        "assistant",
        "run.finished",
      ]);
      expect(
        db.prepare("SELECT answer, status FROM input_requests WHERE run_id = 'run'").get()
      ).toMatchObject({
        answer: "option A",
        status: "answered",
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists structured ask metadata and enforces choice ids", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b4-structured-ask-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let resumeParams: ResumeParams | undefined;
    let streamStarted = false;
    let releaseStream!: () => void;
    const streamDone = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const nextRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-after-ask",
      sdkRunId: "sdk-after-ask",
      async *stream() {
        streamStarted = true;
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "Need structured input." }] },
        } as never;
        await streamDone;
      },
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async () => {
        throw new Error("second follow-up should not be called");
      },
    };
    const resumedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async () => nextRun,
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async (params) => {
        resumeParams = params;
        return resumedRun;
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      await engine.sendMessage("run", "ask structured");
      await until(() => streamStarted && Boolean(resumeParams?.runToken));

      const metadata = {
        kind: "approval",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "abort", label: "Abort" },
        ],
        recommendedChoiceId: "approve",
      };
      const answerPromise = engine.askAndWait(
        "run",
        "Approve?",
        resumeParams?.runToken,
        metadata
      );
      await until(() => statusOf(db, "run") === "needs_input");

      const snapshot = engine.getRun("run");
      const pending = snapshot?.inputRequests.find((r) => r.status === "pending");
      expect(pending?.metadata).toMatchObject({
        kind: "approval",
        recommendedChoiceId: "approve",
      });

      await expect(engine.submitAnswer("run", "Approve")).rejects.toThrow(
        /declared choice ids/
      );
      expect(statusOf(db, "run")).toBe("needs_input");
      expect(
        db
          .prepare(
            "SELECT status FROM input_requests WHERE run_id = 'run' AND status = 'pending'"
          )
          .get()
      ).toBeTruthy();

      await engine.submitAnswer("run", "approve");
      await expect(answerPromise).resolves.toBe("approve");
      expect(statusOf(db, "run")).toBe("running");
      releaseStream();
      await until(() => statusOf(db, "run") === "completed");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, busy, and non-resumable runs before reopening", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b4-guards-"));
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
        runId: "running-run",
        status: "running",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      db.prepare(
        `INSERT INTO runs (
          id, automation_id, workspace_id, status, trigger_kind, agent_id, sdk_run_id
        ) VALUES (
          'cloud-run', 'auto', 'ws', 'completed', 'manual', 'bc-agent', 'sdk'
        )`
      ).run();

      await expect(engine.sendMessage("missing", "hello")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(
        engine.sendMessage("running-run", "hello")
      ).rejects.toMatchObject({ code: "busy" });
      await expect(engine.sendMessage("cloud-run", "hello")).rejects.toMatchObject({
        code: "not_resumable",
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("RunEngine queue, interrupt, and stop", () => {
  it("queues a message during running without calling active cancel", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b24-queue-"));
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
      const { cancelCalls } = installRunningActiveRun(engine, "run", {
        kind: "sdk-local",
        agentId: "agent",
        sdkRunId: "sdk",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
      });

      const queuedMessageId = await engine.queueMessage("run", "  queue me  ");

      expect(queuedMessageRows(db, "run")).toEqual([
        { message: "queue me", status: "pending" },
      ]);
      expect(cancelCalls()).toBe(0);
      expect(eventTypes(db, "run")).toContain("run.message.queued");
      expect(
        JSON.parse(
          (
            db
              .prepare(
                "SELECT payload FROM run_events WHERE run_id = 'run' AND event_type = 'run.message.queued'"
              )
              .get() as { payload: string }
          ).payload
        )
      ).toMatchObject({
        role: "user",
        text: "queue me",
        queuedMessageId,
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers the oldest queued message after a naturally completed turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b24-deliver-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    let deliveredMessage: string | undefined;
    const { executor, releaseInitialStream, waitRunning } = makeBlockingSpawnExecutor(
      (message) => {
        deliveredMessage = followUpText(message);
      }
    );
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
      await engine.queueMessage(runId, "deliver after finish");
      releaseInitialStream();

      await until(
        () => statusOf(db, runId) === "completed" && deliveredMessage !== undefined
      );
      expect(deliveredMessage).toBe("deliver after finish");
      expect(queuedMessageRows(db, runId)).toEqual([
        { message: "deliver after finish", status: "delivered" },
      ]);
      expect(eventTypes(db, runId)).toEqual(
        expect.arrayContaining(["run.message.queued", "run.message", "run.finished"])
      );
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancels a running run, active cancel, and pending queued messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b24-cancel-"));
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
      const { cancelCalls } = installRunningActiveRun(engine, "run", {
        kind: "sdk-local",
        agentId: "agent",
        sdkRunId: "sdk",
        async *stream() {},
        wait: async () => ({ status: "finished", result: null }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
      });

      await engine.queueMessage("run", "should not deliver");
      await engine.cancelRun("run");

      expect(statusOf(db, "run")).toBe("cancelled");
      expect(cancelCalls()).toBe(1);
      expect(queuedMessageRows(db, "run")).toEqual([
        { message: "should not deliver", status: "cancelled" },
      ]);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("interrupts a running run and sends the interrupt message as follow-up", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b24-interrupt-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let interruptFollowUp: string | undefined;
    const { executor, waitRunning } = makeBlockingSpawnExecutor((message) => {
      interruptFollowUp = followUpText(message);
    });
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "placeholder",
        status: "completed",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

      const runId = await engine.triggerRun("auto");

      await waitRunning();
      await engine.interruptRun(runId, "send now instead");

      await until(
        () =>
          interruptFollowUp === "send now instead" && statusOf(db, runId) === "completed"
      );

      expect(eventTypes(db, runId)).toContain("run.interrupted");
      expect(
        JSON.parse(
          (
            db
              .prepare(
                "SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'run.interrupted'"
              )
              .get(runId) as { payload: string }
          ).payload
        )
      ).toMatchObject({
        role: "user",
        text: "send now instead",
      });
      expect(
        db
          .prepare(
            "SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'run.message'"
          )
          .get(runId) as { payload: string }
      ).toBeDefined();
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects queue and interrupt while needs_input", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b24-needs-input-"));
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
        status: "needs_input",
        agentId: "agent",
        sdkRunId: "sdk",
      });

      await expect(engine.queueMessage("run", "hello")).rejects.toMatchObject({
        code: "needs_input",
      });
      await expect(engine.interruptRun("run", "hello")).rejects.toMatchObject({
        code: "needs_input",
      });
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM run_queued_messages").get() as {
            count: number;
          }
        ).count
      ).toBe(0);
      expect(eventTypes(db, "run")).toEqual([]);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("RunEngine operator message reference resolution", () => {
  it("expands known references on terminal sendMessage while keeping transcript raw", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b25-send-"));
    const workspace = join(root, "workspace");
    seedArtifactWorkspace(workspace);
    const db = openDatabase(join(root, "state.sqlite"));
    let followUpMessage: string | undefined;
    const nextRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-next",
      sdkRunId: "sdk-next",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        } as never;
      },
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
    };
    const resumedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async (message) => {
        followUpMessage = followUpText(message);
        return nextRun;
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => resumedRun,
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      await engine.sendMessage("run", "please run /lca-dev");

      await until(() => statusOf(db, "run") === "completed");

      expect(followUpMessage).toContain(
        "Use the `lca-dev` skill (.cursor/skills/lca-dev/SKILL.md)"
      );
      expect(followUpMessage).not.toMatch(/(^|\s)\/lca-dev([\s,.]|$)/);
      expect(eventPayload(db, "run", "run.message")).toEqual({
        role: "user",
        text: "please run /lca-dev",
      });
      expect(eventPayload(db, "run", "run.references")).toMatchObject({
        resolved: 1,
        unknown: 0,
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers unknown references unchanged and logs run.references", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b25-unknown-"));
    const workspace = join(root, "workspace");
    seedArtifactWorkspace(workspace);
    const db = openDatabase(join(root, "state.sqlite"));
    let followUpMessage: string | undefined;
    const nextRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-next",
      sdkRunId: "sdk-next",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        } as never;
      },
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
    };
    const resumedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async (message) => {
        followUpMessage = followUpText(message);
        return nextRun;
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => resumedRun,
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      await engine.sendMessage("run", "try @nope next");
      await until(() => statusOf(db, "run") === "completed");

      expect(followUpMessage).toBe("try @nope next");
      expect(eventPayload(db, "run", "run.message")).toEqual({
        role: "user",
        text: "try @nope next",
      });
      expect(eventPayload(db, "run", "run.references")).toMatchObject({
        resolved: 0,
        unknown: 1,
        unknownReferences: [{ raw: "@nope" }],
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers reference-free messages unchanged without run.references", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b25-plain-"));
    const workspace = join(root, "workspace");
    seedArtifactWorkspace(workspace);
    const db = openDatabase(join(root, "state.sqlite"));
    const plainText = "follow up question";
    let followUpMessage: string | undefined;
    const nextRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-next",
      sdkRunId: "sdk-next",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "done" }] },
        } as never;
      },
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
    };
    const resumedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async (message) => {
        followUpMessage = followUpText(message);
        return nextRun;
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => resumedRun,
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      await engine.sendMessage("run", plainText);
      await until(() => statusOf(db, "run") === "completed");

      expect(followUpMessage).toBe(plainText);
      expect(eventTypes(db, "run")).not.toContain("run.references");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands queued delivery while run.message.queued stays raw", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b25-queue-resolve-"));
    const workspace = join(root, "workspace");
    seedArtifactWorkspace(workspace);
    const db = openDatabase(join(root, "state.sqlite"));
    let deliveredMessage: string | undefined;
    const { executor, releaseInitialStream, waitRunning } = makeBlockingSpawnExecutor(
      (message) => {
        deliveredMessage = followUpText(message);
      }
    );
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
      await engine.queueMessage(runId, "queue /lca-dev please");
      releaseInitialStream();

      await until(
        () => statusOf(db, runId) === "completed" && deliveredMessage !== undefined
      );

      expect(deliveredMessage).toContain(
        "Use the `lca-dev` skill (.cursor/skills/lca-dev/SKILL.md)"
      );
      expect(eventPayload(db, runId, "run.message.queued")).toMatchObject({
        role: "user",
        text: "queue /lca-dev please",
      });
      expect(eventPayload(db, runId, "run.message")).toMatchObject({
        role: "user",
        text: "queue /lca-dev please",
      });
      expect(eventPayload(db, runId, "run.references")).toMatchObject({
        resolved: 1,
        unknown: 0,
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands interrupt follow-up while run.interrupted stays raw", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b25-interrupt-resolve-"));
    const workspace = join(root, "workspace");
    seedArtifactWorkspace(workspace);
    const db = openDatabase(join(root, "state.sqlite"));
    let interruptFollowUp: string | undefined;
    const { executor, waitRunning } = makeBlockingSpawnExecutor((message) => {
      interruptFollowUp = followUpText(message);
    });
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
      await engine.interruptRun(runId, "use @tech-stack now");

      await until(
        () =>
          interruptFollowUp !== undefined && statusOf(db, runId) === "completed"
      );

      expect(interruptFollowUp).toContain(
        "Apply the `tech-stack` rule (.cursor/rules/tech-stack.mdc)"
      );
      expect(eventPayload(db, runId, "run.interrupted")).toMatchObject({
        role: "user",
        text: "use @tech-stack now",
      });
      expect(eventPayload(db, runId, "run.references")).toMatchObject({
        resolved: 1,
        unknown: 0,
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /api/runs/:id/message", () => {
  it("returns 202 and forwards the trimmed message to the engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b4-http-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const calls: Array<{ runId: string; message: string }> = [];
    const http = await startHttpServer({
      engine: {
        sendMessage: async (runId: string, message: string) => {
          calls.push({ runId, message });
        },
      } as unknown as RunEngine,
      chatEngine: {} as unknown as ChatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/run-1/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "  hello agent  " }),
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true });
      expect(calls).toEqual([{ runId: "run-1", message: "hello agent" }]);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps empty, missing, busy, and non-resumable outcomes to REST statuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b4-http-errors-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    let error: Error | undefined;
    const http = await startHttpServer({
      engine: {
        sendMessage: async () => {
          if (error) {
            throw error;
          }
        },
      } as unknown as RunEngine,
      chatEngine: {} as unknown as ChatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    async function post(message: string) {
      return fetch(`http://127.0.0.1:${port}/api/runs/run-1/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
    }

    try {
      expect((await post("   ")).status).toBe(400);

      error = new RunMessageError("not_found", "Run not found: run-1");
      expect((await post("hello")).status).toBe(404);

      error = new RunMessageError("busy", "Run run-1 is busy");
      expect((await post("hello")).status).toBe(409);

      error = new RunMessageError("not_resumable", "Run run-1 is not resumable");
      expect((await post("hello")).status).toBe(422);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("POST /api/runs/:id/queue-message", () => {
  it("returns 202 and forwards the trimmed message to the engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b24-queue-http-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const calls: Array<{ runId: string; message: string }> = [];
    const http = await startHttpServer({
      engine: {
        queueMessage: async (runId: string, message: string) => {
          calls.push({ runId, message });
          return "queued-id";
        },
      } as unknown as RunEngine,
      chatEngine: {} as unknown as ChatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/run-1/queue-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "  queue later  " }),
      });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ ok: true, queuedMessageId: "queued-id" });
      expect(calls).toEqual([{ runId: "run-1", message: "queue later" }]);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects empty or whitespace messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b24-queue-http-empty-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    const http = await startHttpServer({
      engine: {
        queueMessage: async () => {
          throw new Error("queueMessage should not be called");
        },
      } as unknown as RunEngine,
      chatEngine: {} as unknown as ChatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/run-1/queue-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "message is required" });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
