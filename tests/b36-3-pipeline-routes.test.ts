import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import {
  IMPLEMENT_FULLY_BUDGET_FORMULA,
  IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_VARIABLES,
  PIPELINE_MODEL_ROLES,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
  type WsServerMessage,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  GENERATED_CONFIG_PATH,
} from "../packages/daemon/src/config/generated-workers.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_WORKERS,
  implementFullyRequiredSkills,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
});

type Db = ReturnType<typeof openDatabase>;
type AutomationEvent = Extract<
  WsServerMessage,
  { type: "automation_event" }
>;

const EXPECTED_ROLES: Record<string, string> = {
  "plan-skeleton": "architect",
  "plan-phase": "planner",
  implement: "implementer",
  review: "reviewer",
  "docs-commit": "docs",
  "integrate-wave": "reviewer",
  "final-gate": "gatekeeper",
  research: "researcher",
};

function seedWorkspace(db: Db, workspacePath: string, id?: string): string {
  mkdirSync(workspacePath, { recursive: true });
  const workspaceId = id ?? workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");
  return workspaceId;
}

function readAutomation(db: Db, id: string) {
  return db
    .prepare(
      `SELECT id, origin, name, prompt, trigger_json, chain_json, model,
              model_params_json, model_role, enabled, status, config_key,
              config_path, archived_at, updated_at
       FROM automations WHERE id = ?`
    )
    .get(id) as
    | {
        id: string;
        origin: string;
        name: string;
        prompt: string;
        trigger_json: string;
        chain_json: string | null;
        model: string | null;
        model_params_json: string | null;
        model_role: string | null;
        enabled: number;
        status: string;
        config_key: string;
        config_path: string;
        archived_at: string | null;
        updated_at: string;
      }
    | undefined;
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

function writeSkill(workspace: string, name: string): void {
  const path = join(workspace, ".cursor", "skills", name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    ["---", `name: ${name}`, `description: ${name}`, "---", `# ${name}`].join(
      "\n"
    ),
    "utf8"
  );
}

describe("b36.03c pipeline routes", () => {
  async function withServer(
    run: (args: {
      port: number;
      db: Db;
      workspacePath: string;
      workspaceId: string;
      getRefreshCount: () => number;
      automationEvents: AutomationEvent[];
    }) => Promise<void>
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-3c-http-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
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
    const refresh = vi.spyOn(triggers, "refresh").mockImplementation(() => {});
    const automationEvents: AutomationEvent[] = [];
    const unsubscribe = events.subscribe((message) => {
      if (message.type === "automation_event") {
        automationEvents.push(message);
      }
    });
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
    });
    try {
      await run({
        port,
        db,
        workspacePath,
        workspaceId,
        getRefreshCount: () => refresh.mock.calls.length,
        automationEvents,
      });
    } finally {
      unsubscribe();
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  function provisionUrl(port: number, pipelineId = IMPLEMENT_FULLY_PIPELINE_ID): string {
    return `http://127.0.0.1:${port}/api/pipelines/${encodeURIComponent(pipelineId)}/workers`;
  }

  function introspectUrl(port: number, pipelineId = IMPLEMENT_FULLY_PIPELINE_ID): string {
    return `http://127.0.0.1:${port}/api/pipelines/${encodeURIComponent(pipelineId)}`;
  }

  it("provisions seven workers idempotently with expected origin, keys, and roles", async () => {
    await withServer(async ({
      port,
      db,
      workspaceId,
      getRefreshCount,
      automationEvents,
    }) => {
      const first = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as ProvisionPipelineWorkersResponse;
      expect(firstBody.pipelineId).toBe(IMPLEMENT_FULLY_PIPELINE_ID);
      expect(firstBody.plan.applied).toBe(true);
      expect(firstBody.plan.items).toHaveLength(8);
      expect(firstBody.plan.items.map((i) => i.action)).toEqual([
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
      ]);
      expect(getRefreshCount()).toBe(1);
      expect(automationEvents).toHaveLength(8);
      expect(automationEvents.every((event) => event.action === "created")).toBe(
        true
      );

      for (const item of firstBody.plan.items) {
        const row = readAutomation(db, item.automationId)!;
        expect(row.origin).toBe("generated");
        expect(row.config_path).toBe(GENERATED_CONFIG_PATH);
        expect(row.config_key).toBe(`${GENERATED_CONFIG_KEY_PREFIX}${item.key}`);
        expect(row.model_role).toBe(EXPECTED_ROLES[item.key]);
      }

      const stamps = firstBody.plan.items.map(
        (_, index) => `2000-01-01 00:00:0${index}`
      );
      for (let i = 0; i < firstBody.plan.items.length; i++) {
        db.prepare("UPDATE automations SET updated_at = ? WHERE id = ?").run(
          stamps[i],
          firstBody.plan.items[i]!.automationId
        );
      }

      const second = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as ProvisionPipelineWorkersResponse;
      expect(secondBody.plan.applied).toBe(true);
      expect(secondBody.plan.items.every((i) => i.action === "unchanged")).toBe(
        true
      );
      expect(getRefreshCount()).toBe(1);
      expect(automationEvents).toHaveLength(8);
      for (let i = 0; i < firstBody.plan.items.length; i++) {
        expect(
          readAutomation(db, firstBody.plan.items[i]!.automationId)!.updated_at
        ).toBe(stamps[i]);
      }
    });
  });

  it("resolves every chain.next from the entry worker across the sequential cycle", async () => {
    await withServer(async ({ port, db, workspaceId }) => {
      const res = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(res.status).toBe(200);

      const runStore = new RunStore(db, new DaemonEventBus());
      const byKey = new Map(
        IMPLEMENT_FULLY_WORKERS.map((worker) => [
          worker.key,
          {
            id: automationId(workspaceId, `${GENERATED_CONFIG_KEY_PREFIX}${worker.key}`),
            next: worker.chain?.next ?? null,
          },
        ])
      );

      for (const worker of IMPLEMENT_FULLY_WORKERS) {
        if (worker.chain == null) {
          expect(worker.key).toBe("final-gate");
          continue;
        }
        const target = runStore.resolveChainTarget(workspaceId, worker.chain.next);
        expect(target).not.toBeNull();
        const expectedKey = worker.chain.next.slice(GENERATED_CONFIG_KEY_PREFIX.length);
        expect(target).toBe(byKey.get(expectedKey)!.id);
      }

      const seen = new Set<string>();
      let currentKey: string | undefined = IMPLEMENT_FULLY_ENTRY_WORKER_KEY;
      while (currentKey && !seen.has(currentKey)) {
        seen.add(currentKey);
        const nextRef = byKey.get(currentKey)!.next;
        if (nextRef == null) break;
        const nextId = runStore.resolveChainTarget(workspaceId, nextRef);
        expect(nextId).not.toBeNull();
        currentKey = [...byKey.entries()].find(([, v]) => v.id === nextId)?.[0];
      }
      expect(seen.size).toBe(4);
      expect([...seen].sort()).toEqual(
        [
          "plan-skeleton",
          "plan-phase",
          "implement",
          "review",
        ].sort()
      );
      expect(byKey.has("integrate-wave")).toBe(true);
      expect(byKey.get("integrate-wave")!.next).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`
      );
      expect(byKey.has("final-gate")).toBe(true);
      expect(byKey.get("final-gate")!.next).toBeNull();
    });
  });

  it("dry-run matches apply and writes nothing", async () => {
    await withServer(async ({
      port,
      db,
      workspaceId,
      getRefreshCount,
      automationEvents,
    }) => {
      const dry = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, dryRun: true }),
      });
      expect(dry.status).toBe(200);
      const dryBody = (await dry.json()) as ProvisionPipelineWorkersResponse;
      expect(dryBody.plan.dryRun).toBe(true);
      expect(dryBody.plan.applied).toBe(false);
      expect(dryBody.plan.items.map((i) => i.action)).toEqual([
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
        "create",
      ]);
      expect(getRefreshCount()).toBe(0);
      expect(automationEvents).toHaveLength(0);
      const count = db
        .prepare(
          `SELECT COUNT(*) AS n FROM automations WHERE workspace_id = ?`
        )
        .get(workspaceId) as { n: number };
      expect(count.n).toBe(0);

      const apply = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(apply.status).toBe(200);
      const applyBody = (await apply.json()) as ProvisionPipelineWorkersResponse;
      expect(applyBody.plan.items.map((i) => i.action)).toEqual(
        dryBody.plan.items.map((i) => i.action)
      );
      expect(applyBody.plan.items.map((i) => i.key)).toEqual(
        dryBody.plan.items.map((i) => i.key)
      );
      expect(getRefreshCount()).toBe(1);
      expect(automationEvents).toHaveLength(8);
    });
  });

  it("reports missing skills as advisory and drops present project skills", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-3c-skills-home-"));
    const root = mkdtempSync(join(tmpdir(), "lca-b36-3c-skills-ws-"));
    const workspacePath = join(root, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
      tmpdir: () => tmpdir(),
    }));

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { workspaceIdFromPath: wsIdFromPath } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { DEFAULT_SETTINGS: settings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    const { DaemonEventBus: Bus } = await import(
      "../packages/daemon/src/events.ts"
    );
    const { DashboardStore: DashStore } = await import(
      "../packages/daemon/src/http/dashboard-store.ts"
    );
    const { startHttpServer: startServer } = await import(
      "../packages/daemon/src/http/server.ts"
    );
    const { ChatEngine: Chats } = await import(
      "../packages/daemon/src/chats/engine.ts"
    );
    const { InputHub: Hub } = await import(
      "../packages/daemon/src/input/hub.ts"
    );
    const { InputStore: InStore } = await import(
      "../packages/daemon/src/input/store.ts"
    );
    const { RunEngine: Engine } = await import(
      "../packages/daemon/src/runs/engine.ts"
    );
    const { TriggerManager: Triggers } = await import(
      "../packages/daemon/src/triggers/manager.ts"
    );
    const { implementFullyRequiredSkills: requiredSkills } = await import(
      "../packages/daemon/src/pipelines/implement-fully.ts"
    );

    mkdirSync(workspacePath, { recursive: true });
    const db = openDb(join(root, "state.sqlite"));
    const workspaceId = wsIdFromPath(workspacePath);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, workspacePath, "Workspace");

    const events = new Bus();
    const inputHub = new Hub(new InStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new Engine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub,
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new Chats(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const triggers = new Triggers(db, engine, { port });
    const http = await startServer({
      engine,
      chatEngine,
      store: new DashStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings,
      triggers,
    });

    try {
      const empty = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(empty.status).toBe(200);
      const emptyBody = (await empty.json()) as ProvisionPipelineWorkersResponse;
      expect(emptyBody.missingSkills).toEqual(requiredSkills());
      expect(emptyBody.plan.applied).toBe(true);

      writeSkill(workspacePath, "implement-phase");

      const partial = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(partial.status).toBe(200);
      const partialBody =
        (await partial.json()) as ProvisionPipelineWorkersResponse;
      expect(partialBody.missingSkills).not.toContain("implement-phase");
      expect(partialBody.missingSkills).toEqual(
        requiredSkills().filter((s) => s !== "implement-phase")
      );
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("conflicts block the whole request with 409 and no writes", async () => {
    await withServer(async ({
      port,
      db,
      workspaceId,
      getRefreshCount,
      automationEvents,
    }) => {
      const conflictKey = "plan-phase";
      const conflictId = automationId(
        workspaceId,
        `${GENERATED_CONFIG_KEY_PREFIX}${conflictKey}`
      );
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, origin
        ) VALUES (?, ?, 'Dash', 1, 'enabled', ?, 'd', NULL,
          '__dashboard__', ?, 'dashboard')`
      ).run(
        conflictId,
        workspaceId,
        JSON.stringify({ type: "manual" }),
        `${GENERATED_CONFIG_KEY_PREFIX}${conflictKey}`
      );

      const res = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ProvisionPipelineWorkersResponse;
      expect(body.plan.applied).toBe(false);
      expect(
        body.plan.items.some((item) => item.action === "conflict")
      ).toBe(true);
      expect(getRefreshCount()).toBe(0);
      expect(automationEvents).toHaveLength(0);

      const generated = db
        .prepare(
          `SELECT COUNT(*) AS n FROM automations
           WHERE workspace_id = ? AND origin = 'generated'`
        )
        .get(workspaceId) as { n: number };
      expect(generated.n).toBe(0);
      expect(readAutomation(db, conflictId)!.origin).toBe("dashboard");
    });
  });

  it("maps status codes for unknown pipeline/workspace, global, and bad bodies", async () => {
    await withServer(async ({ port, workspaceId, workspacePath }) => {
      const unknownPipeline = await fetch(provisionUrl(port, "no-such-pipeline"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(unknownPipeline.status).toBe(404);

      const unknownWs = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "does-not-exist" }),
      });
      expect(unknownWs.status).toBe(404);

      const globalRes = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "__global__" }),
      });
      expect(globalRes.status).toBe(400);

      const withWorkers = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          workers: IMPLEMENT_FULLY_WORKERS,
        }),
      });
      expect(withWorkers.status).toBe(400);

      const both = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, workspacePath }),
      });
      expect(both.status).toBe(400);

      const neither = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(neither.status).toBe(400);

      const byPath = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspacePath }),
      });
      expect(byPath.status).toBe(200);
    });
  });

  it("introspects the pipeline without prompt text", async () => {
    await withServer(async ({ port }) => {
      const res = await fetch(introspectUrl(port));
      expect(res.status).toBe(200);
      const body = (await res.json()) as PipelineIntrospectionResponse;
      expect(body.pipelineId).toBe(IMPLEMENT_FULLY_PIPELINE_ID);
      expect(body.entryWorkerKey).toBe(IMPLEMENT_FULLY_ENTRY_WORKER_KEY);
      expect(body.entryWorkerConfigKey).toBe(
        `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
      );
      expect(body.requiredVariables).toEqual([...IMPLEMENT_FULLY_VARIABLES]);
      expect(body.requiredVariables).toHaveLength(10);
      expect(body.requiredSkills).toEqual(implementFullyRequiredSkills());
      expect(body.budgetFormula).toBe(IMPLEMENT_FULLY_BUDGET_FORMULA);
      expect(body.executeBudgetFormula).toBe(
        IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA
      );
      expect(body.workers).toHaveLength(8);
      expect(body.workers.map((w) => w.key)).toEqual(
        IMPLEMENT_FULLY_WORKERS.map((w) => w.key)
      );
      expect(new Set(body.workers.map((w) => w.modelRole))).toEqual(
        new Set([...PIPELINE_MODEL_ROLES])
      );
      expect(body.roleDefaults).toEqual({});
      for (const worker of body.workers) {
        if (worker.key === "final-gate") {
          expect(worker.chain).toBeNull();
          continue;
        }
        expect(worker.chain).not.toBeNull();
        expect(worker.chain!.next.startsWith(GENERATED_CONFIG_KEY_PREFIX)).toBe(
          true
        );
      }

      const raw = JSON.stringify(body);
      for (const worker of IMPLEMENT_FULLY_WORKERS) {
        expect(raw).not.toContain(worker.prompt.slice(0, 80));
      }
      expect(raw).not.toContain("## Handoff");
      expect(raw).not.toContain("/implement-phase");

      const unknown = await fetch(introspectUrl(port, "missing"));
      expect(unknown.status).toBe(404);
    });
  });

  it("keeps ownership guards: reconcile leaves rows; PATCH/DELETE return 403", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-3c-own-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
      tmpdir: () => tmpdir(),
    }));

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { reconcileConfig, workspaceIdFromPath: wsIdFromPath } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { GLOBAL_CONFIG_PATH, workspaceAutomationsDir } = await import(
      "../packages/daemon/src/paths.ts"
    );
    const { DEFAULT_SETTINGS: settings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    const { DaemonEventBus: Bus } = await import(
      "../packages/daemon/src/events.ts"
    );
    const { DashboardStore: DashStore } = await import(
      "../packages/daemon/src/http/dashboard-store.ts"
    );
    const { startHttpServer: startServer } = await import(
      "../packages/daemon/src/http/server.ts"
    );
    const { ChatEngine: Chats } = await import(
      "../packages/daemon/src/chats/engine.ts"
    );
    const { InputHub: Hub } = await import(
      "../packages/daemon/src/input/hub.ts"
    );
    const { InputStore: InStore } = await import(
      "../packages/daemon/src/input/store.ts"
    );
    const { RunEngine: Engine } = await import(
      "../packages/daemon/src/runs/engine.ts"
    );
    const { TriggerManager: Triggers } = await import(
      "../packages/daemon/src/triggers/manager.ts"
    );

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    mkdirSync(workspaceAutomationsDir(workspace), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      `workspaces:\n  - ${workspace.replace(/\\/g, "/")}\n`,
      "utf8"
    );
    writeFileSync(
      join(workspaceAutomationsDir(workspace), "jobs.yaml"),
      `automations:
  - id: generated:plan-skeleton
    name: YAML Claim
    enabled: true
    trigger:
      type: manual
    prompt: Should be skipped
  - name: Normal Job
    enabled: true
    trigger:
      type: manual
    prompt: Keep me
`,
      "utf8"
    );

    const db = openDb(join(testHome, "state.sqlite"));
    const workspaceId = wsIdFromPath(workspace);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, workspace, "Workspace");

    const events = new Bus();
    const inputHub = new Hub(new InStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new Engine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub,
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new Chats(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const triggers = new Triggers(db, engine, { port });
    const http = await startServer({
      engine,
      chatEngine,
      store: new DashStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings,
      triggers,
    });

    try {
      const provision = await fetch(provisionUrl(port), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      expect(provision.status).toBe(200);

      const stamps = IMPLEMENT_FULLY_WORKERS.map(
        (_, index) => `2000-01-01 00:00:0${index}`
      );
      for (let i = 0; i < IMPLEMENT_FULLY_WORKERS.length; i++) {
        const id = automationId(
          workspaceId,
          `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_WORKERS[i]!.key}`
        );
        db.prepare("UPDATE automations SET updated_at = ? WHERE id = ?").run(
          stamps[i],
          id
        );
      }

      reconcileConfig(db);

      for (let i = 0; i < IMPLEMENT_FULLY_WORKERS.length; i++) {
        const id = automationId(
          workspaceId,
          `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_WORKERS[i]!.key}`
        );
        const row = readAutomation(db, id)!;
        expect(row.origin).toBe("generated");
        expect(row.updated_at).toBe(stamps[i]);
      }

      const generatedId = automationId(
        workspaceId,
        `${GENERATED_CONFIG_KEY_PREFIX}plan-skeleton`
      );
      const patch = await fetch(
        `http://127.0.0.1:${port}/api/automations/${encodeURIComponent(generatedId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Nope" }),
        }
      );
      expect(patch.status).toBe(403);

      const del = await fetch(
        `http://127.0.0.1:${port}/api/automations/${encodeURIComponent(generatedId)}`,
        { method: "DELETE" }
      );
      expect(del.status).toBe(403);
    } finally {
      await http.close();
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
