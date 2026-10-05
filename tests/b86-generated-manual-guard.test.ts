import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENERATED_CONFIG_KEY_PREFIX } from "@lca/shared";
import type { ActiveRun, Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  RunEngine,
  TriggerRunValidationError,
} from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

const GENERATED_CONFIG_KEY = `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`;
const GENERATED_ID = `ws::${GENERATED_CONFIG_KEY}`;
const PLAIN_ID = "ws::plain-auto";

function executorReturning(): Executor {
  const active: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-b86",
    sdkRunId: "sdk-b86",
    async *stream() {},
    wait: async () => ({ id: "r", status: "finished", result: "done" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return { kind: "sdk-local", spawn: async () => active, resume: async () => active };
}

function insertAutomation(
  db: ReturnType<typeof openDatabase>,
  input: { id: string; configKey: string; origin?: string | null }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt,
      config_path, config_key, origin
    ) VALUES (?, 'ws', ?, 1, 'enabled', '{"type":"manual"}', 'Go', 'test.yaml', ?, ?)`
  ).run(
    input.id,
    input.configKey,
    input.configKey,
    input.origin ?? null
  );
}

function createEnv() {
  const root = mkdtempSync(join(tmpdir(), "lca-b86-guard-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    workspace
  );
  insertAutomation(db, {
    id: PLAIN_ID,
    configKey: "plain-auto",
    origin: "config",
  });
  insertAutomation(db, {
    id: GENERATED_ID,
    configKey: GENERATED_CONFIG_KEY,
    origin: "generated",
  });

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: executorReturning(),
    events,
    inputHub: new InputHub(new InputStore(db), {
      onNeedsInput: () => undefined,
      onAnswered: () => undefined,
    }),
    maxConcurrentRuns: 2,
  });
  const runCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  const destroy = async () => {
    await engine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { engine, runCount, destroy };
}

describe("RunEngine generated manual guard", () => {
  it("refuses manual context-less generated triggers and inserts no run", async () => {
    const env = createEnv();
    try {
      const attempt = env.engine.triggerRun(GENERATED_ID, "manual");
      await expect(attempt).rejects.toBeInstanceOf(TriggerRunValidationError);
      await expect(attempt).rejects.toThrow(/implement-fully/i);
      expect(env.runCount()).toBe(0);
    } finally {
      await env.destroy();
    }
  });

  it("allows manual generated triggers with chain context", async () => {
    const env = createEnv();
    try {
      const runId = await env.engine.triggerRun(GENERATED_ID, "manual", {
        chainContext: { variables: {}, roleModels: {} },
        chainMaxDepth: 3,
      });
      expect(runId).toBeTruthy();
      expect(env.runCount()).toBe(1);
    } finally {
      await env.destroy();
    }
  });

  it("allows manual context-less triggers for ordinary automations", async () => {
    const env = createEnv();
    try {
      const runId = await env.engine.triggerRun(PLAIN_ID, "manual");
      expect(runId).toBeTruthy();
      expect(env.runCount()).toBe(1);
    } finally {
      await env.destroy();
    }
  });

  it("does not block chain triggers of generated workers without this guard", async () => {
    const env = createEnv();
    try {
      const rootId = await env.engine.triggerRun(GENERATED_ID, "manual", {
        chainContext: { variables: {}, roleModels: {} },
        chainMaxDepth: 3,
      });
      const childId = await env.engine.triggerRun(GENERATED_ID, "chain", {
        parentRunId: rootId,
        chainRootRunId: rootId,
        chainDepth: 1,
        chainContext: { variables: {}, roleModels: {} },
        chainMaxDepth: 3,
      });
      expect(childId).toBeTruthy();
      expect(env.runCount()).toBe(2);
    } finally {
      await env.destroy();
    }
  });
});
