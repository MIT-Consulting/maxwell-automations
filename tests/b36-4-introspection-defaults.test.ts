import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import {
  IMPLEMENT_FULLY_BUDGET_FORMULA,
  IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_VARIABLES,
  PIPELINE_MODEL_ROLES,
  PIPELINE_REQUIRED_MODEL_ROLES,
  type ModelSelection,
  type PipelineIntrospectionResponse,
  type PipelineModelRole,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { GENERATED_CONFIG_KEY_PREFIX } from "../packages/daemon/src/config/generated-workers.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import type { ResolvedSettings } from "../packages/daemon/src/config/settings.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import {
  checkControlToken,
  startHttpServer,
} from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_WORKERS,
  implementFullyRequiredSkills,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";

type Db = ReturnType<typeof openDatabase>;

function seedWorkspace(db: Db, workspacePath: string): string {
  mkdirSync(workspacePath, { recursive: true });
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");
  return workspaceId;
}

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

function introspectUrl(port: number, pipelineId = IMPLEMENT_FULLY_PIPELINE_ID): string {
  return `http://127.0.0.1:${port}/api/pipelines/${encodeURIComponent(pipelineId)}`;
}

async function withServer(
  settings: ResolvedSettings,
  run: (args: { port: number }) => Promise<void>,
  opts?: { controlToken?: string }
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-4b-http-"));
  const workspacePath = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  seedWorkspace(db, workspacePath);
  const events = new DaemonEventBus();
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
  const http = await startHttpServer({
    engine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "test",
    port,
    settings,
    triggers,
    controlToken: opts?.controlToken,
  });
  try {
    await run({ port });
  } finally {
    await http.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function assertUnchangedSurface(body: PipelineIntrospectionResponse): void {
  expect(body.pipelineId).toBe(IMPLEMENT_FULLY_PIPELINE_ID);
  expect(body.entryWorkerKey).toBe(IMPLEMENT_FULLY_ENTRY_WORKER_KEY);
  expect(body.entryWorkerConfigKey).toBe(
    `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
  );
  expect(body.requiredVariables).toEqual([...IMPLEMENT_FULLY_VARIABLES]);
  expect(body.requiredVariables).toHaveLength(10);
  expect(body.requiredSkills).toEqual(implementFullyRequiredSkills());
  expect(body.budgetFormula).toBe(IMPLEMENT_FULLY_BUDGET_FORMULA);
  expect(body.executeBudgetFormula).toBe(IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA);
  expect(body.workers).toHaveLength(8);
  expect(body.workers.map((w) => w.key)).toEqual(
    IMPLEMENT_FULLY_WORKERS.map((w) => w.key)
  );
  expect(new Set(body.workers.map((w) => w.modelRole))).toEqual(
    new Set([...PIPELINE_MODEL_ROLES])
  );

  const raw = JSON.stringify(body);
  for (const worker of IMPLEMENT_FULLY_WORKERS) {
    expect(raw).not.toContain(worker.prompt.slice(0, 80));
  }
  expect(raw).not.toContain("## Handoff");
  expect(raw).not.toContain("/implement-phase");
}

describe("b36.04b role defaults on pipeline introspection", () => {
  it("reports roleDefaults as {} when nothing is configured", async () => {
    await withServer(DEFAULT_SETTINGS, async ({ port }) => {
      const res = await fetch(introspectUrl(port));
      expect(res.status).toBe(200);
      const body = (await res.json()) as PipelineIntrospectionResponse;
      expect(body.roleDefaults).toEqual({});
      expect("roleDefaults" in body).toBe(true);
      assertUnchangedSurface(body);
    });
  });

  it("reports only the configured roles for a partial map", async () => {
    const pipelineRoleModels: Partial<
      Record<PipelineModelRole, ModelSelection>
    > = {
      planner: { id: "grok-4.5" },
      reviewer: { id: "claude-4.6-sonnet-medium-thinking" },
    };
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels },
      async ({ port }) => {
        const res = await fetch(introspectUrl(port));
        expect(res.status).toBe(200);
        const body = (await res.json()) as PipelineIntrospectionResponse;
        expect(body.roleDefaults).toEqual({
          planner: { id: "grok-4.5" },
          reviewer: { id: "claude-4.6-sonnet-medium-thinking" },
        });
        expect(body.roleDefaults.implementer).toBeUndefined();
        expect(body.roleDefaults.docs).toBeUndefined();
        expect("implementer" in body.roleDefaults).toBe(false);
        expect("docs" in body.roleDefaults).toBe(false);
        expect(Object.keys(body.roleDefaults).sort()).toEqual([
          "planner",
          "reviewer",
        ]);
        assertUnchangedSurface(body);
      }
    );
  });

  it("reports all four roles with normalized selections including params", async () => {
    const pipelineRoleModels: Partial<
      Record<PipelineModelRole, ModelSelection>
    > = {
      planner: { id: "grok-4.5" },
      implementer: {
        id: "composer-2.5",
        params: [
          { id: "a", value: "1" },
          { id: "z", value: "2" },
        ],
      },
      reviewer: {
        id: "claude-4.6-sonnet-medium-thinking",
        params: [{ id: "thinking", value: "medium" }],
      },
      docs: { id: "composer-2.5" },
    };
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels },
      async ({ port }) => {
        const res = await fetch(introspectUrl(port));
        expect(res.status).toBe(200);
        const body = (await res.json()) as PipelineIntrospectionResponse;
        expect(body.roleDefaults).toEqual({
          planner: { id: "grok-4.5" },
          implementer: {
            id: "composer-2.5",
            params: [
              { id: "a", value: "1" },
              { id: "z", value: "2" },
            ],
          },
          reviewer: {
            id: "claude-4.6-sonnet-medium-thinking",
            params: [{ id: "thinking", value: "medium" }],
          },
          docs: { id: "composer-2.5" },
        });
        expect(Object.keys(body.roleDefaults).sort()).toEqual([
          ...PIPELINE_REQUIRED_MODEL_ROLES,
        ].sort());
        assertUnchangedSurface(body);
      }
    );
  });

  it("keeps 404 for unknown pipeline and control-token gate for remote", async () => {
    const controlToken = "b36-4b-control-token";
    await withServer(
      DEFAULT_SETTINGS,
      async ({ port }) => {
        const unknown = await fetch(introspectUrl(port, "missing"));
        expect(unknown.status).toBe(404);

        // Loopback cannot present as non-loopback over a real socket; assert the
        // same gate the daemon applies (matching b13 / b28 suites).
        expect(
          checkControlToken({ isLoopbackSource: false, controlToken })
        ).toBe("missing");
        expect(
          checkControlToken({
            isLoopbackSource: false,
            controlToken,
            presented: "wrong",
          })
        ).toBe("mismatch");
        expect(
          checkControlToken({
            isLoopbackSource: false,
            controlToken,
            presented: controlToken,
          })
        ).toBe("ok");

        const ok = await fetch(introspectUrl(port));
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as PipelineIntrospectionResponse;
        expect(body.roleDefaults).toEqual({});
      },
      { controlToken }
    );
  });
});
