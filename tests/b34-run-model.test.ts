import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import type { Run } from "@lca/shared";
import { updateRunSchema } from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

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
  workspace: string,
  automationModel: string | null = "auto-model"
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run("ws", workspace);
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key
    ) VALUES (?, ?, ?, 1, 'enabled', ?, ?, ?, ?, ?)`
  ).run(
    "auto",
    "ws",
    "B34",
    JSON.stringify({ type: "manual" }),
    "do the thing",
    automationModel,
    "test.yaml",
    "auto"
  );
}

describe("b34.3 run model schema", () => {
  it("accepts model string or null; rejects missing model", () => {
    expect(updateRunSchema.safeParse({ model: "gpt-5" }).success).toBe(true);
    expect(updateRunSchema.safeParse({ model: null }).success).toBe(true);
    expect(updateRunSchema.safeParse({}).success).toBe(false);
    expect(updateRunSchema.safeParse({ model: "" }).success).toBe(false);
  });

  it("migrates to current schema with runs.model and model_params_json columns", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b34-run-migrate-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const version = (
        db
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get() as { version: number }
      ).version;
      expect(version).toBe(SCHEMA_VERSION);
      const cols = db.prepare("PRAGMA table_info(runs)").all() as Array<{
        name: string;
      }>;
      expect(cols.some((c) => c.name === "model")).toBe(true);
      expect(cols.some((c) => c.name === "model_params_json")).toBe(true);
      migrate(db);
      expect(
        (
          db
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get() as { version: number }
        ).version
      ).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b34.3 run model engine precedence", () => {
  it("prepareForPromotion resolves run override over automation model", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b34-run-engine-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const activeRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-b34",
      sdkRunId: "sdk-b34",
      async *stream() {},
      wait: async () => ({ status: "finished" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async (_params: SpawnParams) => activeRun,
      resume: async () => activeRun,
    };
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => undefined,
      onAnswered: () => undefined,
    });
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub,
      maxConcurrentRuns: 1,
    });

    try {
      seedWorkspaceAndAutomation(db, workspace, "auto-model");
      const runId = await engine.triggerRun("auto");
      await until(() => {
        const row = db
          .prepare("SELECT status FROM runs WHERE id = ?")
          .get(runId) as { status: string } | undefined;
        return row?.status === "completed";
      });

      expect(engine.setRunModel(runId, "run-override")).toBe(true);
      expect(engine.prepareForPromotion(runId).model).toEqual({
        id: "run-override",
      });

      expect(engine.setRunModel(runId, null)).toBe(true);
      expect(engine.prepareForPromotion(runId).model).toEqual({
        id: "auto-model",
      });

      const dash = new DashboardStore(db).getRun(runId);
      expect(dash?.model).toBeNull();
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b34.3 run model HTTP", () => {
  it("PATCH set/clear persists and returns run.model", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b34-run-http-"));
    const workspace = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    seedWorkspaceAndAutomation(db, workspace);
    const port = await freeListenPort();
    const events = new DaemonEventBus();
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => undefined,
      onAnswered: () => undefined,
    });
    const noopExecutor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn not expected");
      },
      resume: async () => {
        throw new Error("resume not expected");
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: noopExecutor,
      inputHub,
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: noopExecutor,
      events,
    });
    const store = new DashboardStore(db);
    db.prepare(
      `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
       VALUES ('run-1', 'auto', 'ws', 'completed', 'manual', 'do the thing')`
    ).run();

    const http = await startHttpServer({
      engine,
      chatEngine,
      store,
      db,
      events,
      apiKey: "test",
      port,
    });

    try {
      const setRes = await fetch(`http://127.0.0.1:${port}/api/runs/run-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "composer-2.5" }),
      });
      expect(setRes.status).toBe(200);
      const setBody = (await setRes.json()) as { run: Run };
      expect(setBody.run.model).toBe("composer-2.5");
      expect(store.getRun("run-1")?.model).toBe("composer-2.5");

      const clearRes = await fetch(`http://127.0.0.1:${port}/api/runs/run-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: null }),
      });
      expect(clearRes.status).toBe(200);
      const clearBody = (await clearRes.json()) as { run: Run };
      expect(clearBody.run.model).toBeNull();
    } finally {
      await http.close();
      await engine.shutdown();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
