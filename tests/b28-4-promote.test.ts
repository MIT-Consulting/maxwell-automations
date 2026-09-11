import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import {
  ChatEngine,
} from "../packages/daemon/src/chats/engine.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  RunEngine,
  RunMessageError,
} from "../packages/daemon/src/runs/engine.ts";

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

function seedRunEvents(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  events: Array<{ event_type: string; payload: string; seq: number }>
): void {
  for (const ev of events) {
    db.prepare(
      `INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, ?, ?, ?)`
    ).run(runId, ev.seq, ev.event_type, ev.payload);
  }
}

function chatEventTypes(db: ReturnType<typeof openDatabase>, chatId: string): string[] {
  return (
    db
      .prepare("SELECT event_type FROM chat_events WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function chatStatus(db: ReturnType<typeof openDatabase>, chatId: string): string | undefined {
  const row = db.prepare("SELECT status FROM chat_sessions WHERE id = ?").get(chatId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function inputHubFor(db: ReturnType<typeof openDatabase>): InputHub {
  return new InputHub(new InputStore(db));
}

function makeSimpleSpawnExecutor(): {
  executor: Executor;
  spawnCalls: () => number;
  resumeCalls: () => number;
} {
  let spawns = 0;
  let resumes = 0;

  const makeRun = (agentId: string, sdkRunId: string): ActiveRun => ({
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello from agent" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "done" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  });

  return {
    executor: {
      kind: "sdk-local",
      spawn: async (_params: SpawnParams) => {
        spawns += 1;
        return makeRun("agent-spawn", "sdk-spawn");
      },
      resume: async (_params: ResumeParams) => {
        resumes += 1;
        const shell = makeRun("agent-resume", "sdk-resume");
        return {
          ...shell,
          async *stream() {},
          sendFollowUp: async (message: string) => {
            const followUp = makeRun("agent-follow-up", "sdk-follow-up");
            return {
              ...followUp,
              async *stream() {
                yield {
                  type: "assistant",
                  message: { content: [{ type: "text", text: `follow-up: ${message}` }] },
                } as never;
              },
            };
          },
        };
      },
    },
    spawnCalls: () => spawns,
    resumeCalls: () => resumes,
  };
}

type RunEngineInternals = {
  retainedRuns: Map<string, { activeRun: ActiveRun; runToken: string }>;
};

function runEngineInternals(engine: RunEngine): RunEngineInternals {
  return engine as unknown as RunEngineInternals;
}

describe("b28.4 run → chat promotion", () => {
  it("promotes a resumable terminal run with copied transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-promote-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
      inputHub: inputHubFor(db),
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
    });

    try {
      seedRun(db, workspace, {
        runId: "run-1",
        status: "completed",
        agentId: "agent-local",
        sdkRunId: "sdk-local",
      });
      seedRunEvents(db, "run-1", [
        { seq: 1, event_type: "run.started", payload: '{"model":"composer-2.5"}' },
        { seq: 2, event_type: "assistant", payload: '{"text":"prior work"}' },
      ]);

      const source = runEngine.prepareForPromotion("run-1");
      expect(source.run.agent_id).toBe("agent-local");
      expect(source.run.sdk_run_id).toBe("sdk-local");
      expect(source.model).toBeTruthy();
      expect(source.events).toHaveLength(2);

      const chat = chatEngine.promoteFromRun({
        runId: "run-1",
        workspaceId: source.run.workspace_id,
        agentId: source.run.agent_id,
        sdkRunId: source.run.sdk_run_id,
        model: source.model,
        events: source.events,
      });

      const row = db
        .prepare(
          "SELECT agent_id, sdk_run_id, origin_run_id, status FROM chat_sessions WHERE id = ?"
        )
        .get(chat.id) as {
        agent_id: string;
        sdk_run_id: string;
        origin_run_id: string;
        status: string;
      };
      expect(row.agent_id).toBe("agent-local");
      expect(row.sdk_run_id).toBe("sdk-local");
      expect(row.origin_run_id).toBe("run-1");
      expect(row.status).toBe("idle");
      expect(chatEventTypes(db, chat.id)).toEqual([
        "chat.promoted_from_run",
        "run.started",
        "assistant",
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("first message after promote resumes, not spawns", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-resume-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const { executor, spawnCalls, resumeCalls } = makeSimpleSpawnExecutor();
    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor,
      inputHub: inputHubFor(db),
    });
    const chatEngine = new ChatEngine(db, { apiKey: "test", executor });

    try {
      seedRun(db, workspace, {
        runId: "run-1",
        status: "completed",
        agentId: "agent-local",
        sdkRunId: "sdk-local",
      });

      const source = runEngine.prepareForPromotion("run-1");
      const chat = chatEngine.promoteFromRun({
        runId: "run-1",
        workspaceId: source.run.workspace_id,
        agentId: source.run.agent_id,
        sdkRunId: source.run.sdk_run_id,
        model: source.model,
        events: source.events,
      });

      await chatEngine.sendMessage(chat.id, "hi");
      await until(() => chatStatus(db, chat.id) === "idle");

      expect(resumeCalls()).toBe(1);
      expect(spawnCalls()).toBe(0);
    } finally {
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects cloud (bc-) runs as not_resumable", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-cloud-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "run-cloud",
        status: "completed",
        agentId: "bc-cloud-agent",
        sdkRunId: "sdk-cloud",
      });

      expect(() => runEngine.prepareForPromotion("run-cloud")).toThrow(RunMessageError);
      try {
        runEngine.prepareForPromotion("run-cloud");
      } catch (err) {
        expect(err).toBeInstanceOf(RunMessageError);
        expect((err as RunMessageError).code).toBe("not_resumable");
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-terminal runs as busy", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-busy-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, workspace, {
        runId: "run-running",
        status: "running",
        agentId: "agent-local",
        sdkRunId: "sdk-local",
      });

      try {
        runEngine.prepareForPromotion("run-running");
        expect.fail("expected busy");
      } catch (err) {
        expect(err).toBeInstanceOf(RunMessageError);
        expect((err as RunMessageError).code).toBe("busy");
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing runs as not_found", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-missing-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
      inputHub: inputHubFor(db),
    });

    try {
      try {
        runEngine.prepareForPromotion("missing-run");
        expect.fail("expected not_found");
      } catch (err) {
        expect(err).toBeInstanceOf(RunMessageError);
        expect((err as RunMessageError).code).toBe("not_found");
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releaseRetainedRun disposes retained session and never throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-release-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
      inputHub: inputHubFor(db),
    });

    let disposed = false;
    const activeRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-retained",
      sdkRunId: "sdk-retained",
      async *stream() {},
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => {
        disposed = true;
      },
    };

    try {
      runEngineInternals(runEngine).retainedRuns.set("run-retained", {
        activeRun,
        runToken: "token-1",
      });

      await expect(runEngine.releaseRetainedRun("run-retained")).resolves.toBeUndefined();
      expect(disposed).toBe(true);
      expect(runEngineInternals(runEngine).retainedRuns.has("run-retained")).toBe(false);

      await expect(runEngine.releaseRetainedRun("no-such-run")).resolves.toBeUndefined();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("integrated promote disposes the run's live retained session", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-integrated-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspace = join(root, "workspace");
    const runEngine = new RunEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
      inputHub: inputHubFor(db),
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: makeSimpleSpawnExecutor().executor,
    });

    let disposed = false;
    const retained: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-local",
      sdkRunId: "sdk-local",
      async *stream() {},
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => {
        disposed = true;
      },
    };

    try {
      seedRun(db, workspace, {
        runId: "run-1",
        status: "completed",
        agentId: "agent-local",
        sdkRunId: "sdk-local",
      });
      seedRunEvents(db, "run-1", [
        { seq: 1, event_type: "run.started", payload: '{"model":"composer-2.5"}' },
      ]);
      runEngineInternals(runEngine).retainedRuns.set("run-1", {
        activeRun: retained,
        runToken: "token-1",
      });

      // The integrated invariant: prepare → promote → release disposes the
      // origin run's live session so run and chat never own the agent at once.
      const source = runEngine.prepareForPromotion("run-1");
      const chat = chatEngine.promoteFromRun({
        runId: "run-1",
        workspaceId: source.run.workspace_id,
        agentId: source.run.agent_id,
        sdkRunId: source.run.sdk_run_id,
        model: source.model,
        events: source.events,
      });
      await expect(runEngine.releaseRetainedRun("run-1")).resolves.toBeUndefined();

      expect(disposed).toBe(true);
      expect(runEngineInternals(runEngine).retainedRuns.has("run-1")).toBe(false);

      const row = db
        .prepare(
          "SELECT agent_id, sdk_run_id, origin_run_id FROM chat_sessions WHERE id = ?"
        )
        .get(chat.id) as {
        agent_id: string;
        sdk_run_id: string;
        origin_run_id: string;
      };
      expect(row.agent_id).toBe("agent-local");
      expect(row.sdk_run_id).toBe("sdk-local");
      expect(row.origin_run_id).toBe("run-1");
    } finally {
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
