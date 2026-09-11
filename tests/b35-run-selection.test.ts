import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOMATION_MODEL,
  modelSelectionKey,
  type ModelSelection,
} from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { resolveModelSelection } from "../packages/daemon/src/models/resolve.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

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

function stubExecutor(): Executor {
  const activeRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-b35",
    sdkRunId: "sdk-b35",
    async *stream() {},
    wait: async () => ({ status: "finished" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return {
    kind: "sdk-local",
    spawn: async (_params: SpawnParams) => activeRun,
    resume: async () => activeRun,
  };
}

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run("ws", workspace);
}

function insertAutomation(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    configKey: string;
    name: string;
    model?: string | null;
    modelParamsJson?: string | null;
    chainJson?: string | null;
    prompt?: string;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      model_params_json, config_path, config_key, chain_json
    ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, ?, ?, 'test.yaml', ?, ?)`
  ).run(
    input.id,
    input.name,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name}`,
    input.model ?? null,
    input.modelParamsJson ?? null,
    input.configKey,
    input.chainJson ?? null
  );
}

function latestEventPayload(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  eventType: string
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND event_type = ?
       ORDER BY seq DESC LIMIT 1`
    )
    .get(runId, eventType) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

describe("resolveModelSelection", () => {
  it("returns the first non-nullish candidate, normalized", () => {
    const first: ModelSelection = {
      id: "  grok-4.5  ",
      params: [
        { id: "z", value: "2" },
        { id: "a", value: "1" },
      ],
    };
    expect(
      resolveModelSelection(first, { id: "other" })
    ).toEqual({
      id: "grok-4.5",
      params: [
        { id: "a", value: "1" },
        { id: "z", value: "2" },
      ],
    });
  });

  it("skips null and undefined candidates", () => {
    expect(
      resolveModelSelection(null, undefined, { id: "fallback-model" })
    ).toEqual({ id: "fallback-model" });
  });

  it("returns the global default when no candidates survive", () => {
    expect(resolveModelSelection()).toEqual({ id: DEFAULT_AUTOMATION_MODEL });
    expect(resolveModelSelection(null, undefined)).toEqual({
      id: DEFAULT_AUTOMATION_MODEL,
    });
  });

  it("skips corrupt candidates instead of throwing", () => {
    expect(
      resolveModelSelection(
        { id: "  " },
        {
          id: "ok",
          params: [
            { id: "dup", value: "1" },
            { id: "dup", value: "2" },
          ],
        },
        { id: "survivor" }
      )
    ).toEqual({ id: "survivor" });
  });
});

describe("b35.4a run selection resolution", () => {
  it("resolves automation params, prefers run override, and falls back with params", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-run-sel-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: stubExecutor(),
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
    });

    try {
      seedWorkspace(db, workspace);
      insertAutomation(db, {
        id: "auto",
        configKey: "auto",
        name: "B35",
        model: "grok-4.5",
        modelParamsJson: JSON.stringify([
          { id: "reasoning_effort", value: "high" },
        ]),
      });

      const runId = await engine.triggerRun("auto");
      await until(() => {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(runId) as { status: string } | undefined;
        return row?.status === "completed";
      });

      const started = latestEventPayload(db, runId, "run.started");
      expect(started?.model).toBe("grok-4.5");
      expect(started?.modelSelection).toEqual({
        id: "grok-4.5",
        params: [{ id: "reasoning_effort", value: "high" }],
      });
      expect(
        modelSelectionKey(started!.modelSelection as ModelSelection)
      ).toBe(
        modelSelectionKey({
          id: "grok-4.5",
          params: [{ id: "reasoning_effort", value: "high" }],
        })
      );

      expect(
        engine.setRunModel(runId, {
          id: "composer-2",
          params: [{ id: "reasoning_effort", value: "low" }],
        })
      ).toBe(true);
      expect(engine.prepareForPromotion(runId).model).toEqual({
        id: "composer-2",
        params: [{ id: "reasoning_effort", value: "low" }],
      });

      expect(engine.setRunModel(runId, null)).toBe(true);
      expect(engine.prepareForPromotion(runId).model).toEqual({
        id: "grok-4.5",
        params: [{ id: "reasoning_effort", value: "high" }],
      });
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("chained child uses target automation selection, not parent params", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-run-chain-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    seedWorkspace(db, workspace);

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: stubExecutor(),
      events,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 4,
    });
    const chainRunner = new ChainRunner({
      store,
      engine,
      events,
      onLog: () => undefined,
    });
    chainRunner.start();

    try {
      insertAutomation(db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        model: "parent-model",
        modelParamsJson: JSON.stringify([
          { id: "reasoning_effort", value: "high" },
        ]),
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        model: "child-model",
        modelParamsJson: JSON.stringify([
          { id: "reasoning_effort", value: "low" },
        ]),
      });

      const runA = await engine.triggerRun("ws::a");
      await until(() => store.getRun(runA)?.status === "completed");
      await until(() => {
        const runs = db
          .prepare("SELECT id FROM runs ORDER BY created_at ASC")
          .all() as Array<{ id: string }>;
        return runs.length >= 2;
      });

      const runs = db
        .prepare("SELECT id, automation_id FROM runs ORDER BY created_at ASC")
        .all() as Array<{ id: string; automation_id: string }>;
      const child = runs.find((r) => r.id !== runA);
      expect(child?.automation_id).toBe("ws::b");

      await until(() => store.getRun(child!.id)?.status === "completed");

      const childStarted = latestEventPayload(db, child!.id, "run.started");
      expect(childStarted?.model).toBe("child-model");
      expect(childStarted?.modelSelection).toEqual({
        id: "child-model",
        params: [{ id: "reasoning_effort", value: "low" }],
      });
      expect(childStarted?.modelSelection).not.toEqual({
        id: "parent-model",
        params: [{ id: "reasoning_effort", value: "high" }],
      });
    } finally {
      chainRunner.stop();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
