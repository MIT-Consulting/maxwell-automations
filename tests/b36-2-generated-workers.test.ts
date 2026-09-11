import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import {
  type WsServerMessage,
  type GeneratedWorkerPlan,
  type GeneratedWorkerSpec,
} from "@lca/shared";
import { provisionGeneratedWorkersSchema } from "../packages/shared/src/schemas/config.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  GENERATED_CONFIG_PATH,
  provisionGeneratedWorkers,
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
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("../packages/daemon/src/config/generated-workers.ts");
});

const FOUR_WORKERS: GeneratedWorkerSpec[] = [
  {
    key: "plan-phase",
    name: "Plan Phase",
    prompt: "Plan the phase",
    trigger: { type: "manual" },
    modelRole: "planner",
  },
  {
    key: "implement",
    name: "Implement",
    prompt: "Implement the phase",
    trigger: { type: "manual" },
    modelRole: "implementer",
  },
  {
    key: "review",
    name: "Review",
    prompt: "Review the work",
    trigger: { type: "manual" },
    modelRole: "reviewer",
  },
  {
    key: "docs-commit",
    name: "Docs Commit",
    prompt: "Document and commit",
    trigger: { type: "manual" },
    modelRole: "docs",
  },
];

type Db = ReturnType<typeof openDatabase>;
type AutomationEvent = Extract<
  WsServerMessage,
  { type: "automation_event" }
>;

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

describe("b36.02d provisioner", () => {
  it("is idempotent: create then unchanged with identical updated_at", () => {
    const parsedDefaults = provisionGeneratedWorkersSchema.parse({
      workspaceId: "ws",
      workers: FOUR_WORKERS,
    });
    expect(parsedDefaults.dryRun).toBe(false);
    expect(parsedDefaults.prune).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "lca-b36-2d-idem-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const wsId = seedWorkspace(db, join(root, "workspace"));
      const first = provisionGeneratedWorkers(db, wsId, FOUR_WORKERS);
      expect(first.applied).toBe(true);
      expect(first.items.map((i) => i.action)).toEqual([
        "create",
        "create",
        "create",
        "create",
      ]);
      for (const item of first.items) {
        const row = readAutomation(db, item.automationId)!;
        expect(row.origin).toBe("generated");
        expect(row.config_path).toBe(GENERATED_CONFIG_PATH);
        expect(row.config_key).toBe(
          `${GENERATED_CONFIG_KEY_PREFIX}${item.key}`
        );
      }

      const stamps = first.items.map(
        (_, index) => `2000-01-01 00:00:0${index}`
      );
      for (let i = 0; i < first.items.length; i++) {
        db.prepare("UPDATE automations SET updated_at = ? WHERE id = ?").run(
          stamps[i],
          first.items[i]!.automationId
        );
      }

      const second = provisionGeneratedWorkers(db, wsId, FOUR_WORKERS);
      expect(second.applied).toBe(true);
      expect(second.items.every((i) => i.action === "unchanged")).toBe(true);
      for (let i = 0; i < first.items.length; i++) {
        expect(readAutomation(db, first.items[i]!.automationId)!.updated_at).toBe(
          stamps[i]
        );
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dry-run matches apply and writes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2d-dry-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const wsId = seedWorkspace(db, join(root, "workspace"));
      // Seed one generated worker so the plan is mixed create/unchanged.
      provisionGeneratedWorkers(db, wsId, [FOUR_WORKERS[0]!]);
      const existingId = automationId(wsId, "generated:plan-phase");
      const beforeDryRun = readAutomation(db, existingId);

      const dry = provisionGeneratedWorkers(db, wsId, FOUR_WORKERS, {
        dryRun: true,
      });
      expect(dry.dryRun).toBe(true);
      expect(dry.applied).toBe(false);
      expect(dry.items.map((i) => i.action)).toEqual([
        "unchanged",
        "create",
        "create",
        "create",
      ]);
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM automations")
            .get() as { n: number }
        ).n
      ).toBe(1);
      expect(readAutomation(db, existingId)).toEqual(beforeDryRun);

      const applied = provisionGeneratedWorkers(db, wsId, FOUR_WORKERS);
      expect(applied.dryRun).toBe(false);
      expect(applied.applied).toBe(true);
      expect(applied.items).toEqual(dry.items);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates fields, preserves disabled, and revives archived workers", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2d-refresh-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const wsId = seedWorkspace(db, join(root, "workspace"));
      provisionGeneratedWorkers(db, wsId, [
        {
          key: "implement",
          name: "Implement",
          prompt: "old prompt",
          trigger: { type: "manual" },
          modelRole: "old-role",
          enabled: true,
        },
      ]);
      const id = automationId(wsId, "generated:implement");
      db.prepare(
        `UPDATE automations SET enabled = 0, status = 'backlog' WHERE id = ?`
      ).run(id);

      const updated = provisionGeneratedWorkers(db, wsId, [
        {
          key: "implement",
          name: "Implement",
          prompt: "new prompt",
          trigger: { type: "manual" },
          modelRole: "implementer",
          enabled: true,
        },
      ]);
      expect(updated.items[0]!.action).toBe("update");
      expect(updated.items[0]!.detail).toEqual(
        expect.arrayContaining(["prompt", "model_role"])
      );
      const afterUpdate = readAutomation(db, id)!;
      expect(afterUpdate.prompt).toBe("new prompt");
      expect(afterUpdate.model_role).toBe("implementer");
      expect(afterUpdate.enabled).toBe(0);
      expect(afterUpdate.status).toBe("backlog");

      db.prepare(
        `UPDATE automations SET
          enabled = 0, status = 'backlog',
          archived_at = datetime('now')
         WHERE id = ?`
      ).run(id);

      const revived = provisionGeneratedWorkers(db, wsId, [
        {
          key: "implement",
          name: "Implement",
          prompt: "new prompt",
          trigger: { type: "manual" },
          modelRole: "implementer",
          enabled: true,
        },
      ]);
      expect(revived.items[0]!.action).toBe("revive");
      const afterRevive = readAutomation(db, id)!;
      expect(afterRevive.archived_at).toBeNull();
      expect(afterRevive.enabled).toBe(1);
      expect(afterRevive.status).toBe("enabled");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats conflicts as fatal and writes nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2d-conflict-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const wsId = seedWorkspace(db, join(root, "workspace"));
      const conflictId = automationId(wsId, "generated:plan-phase");
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, origin
        ) VALUES (?, ?, 'Dashboard Claim', 1, 'enabled', ?, 'dash', NULL,
          '__dashboard__', 'generated:plan-phase', 'dashboard')`
      ).run(conflictId, wsId, JSON.stringify({ type: "manual" }));

      const plan = provisionGeneratedWorkers(db, wsId, FOUR_WORKERS);
      expect(plan.applied).toBe(false);
      const conflict = plan.items.find((i) => i.key === "plan-phase")!;
      expect(conflict.action).toBe("conflict");
      expect(conflict.detail).toEqual(["origin=dashboard"]);
      expect(plan.items.filter((i) => i.action === "create")).toHaveLength(3);

      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM automations")
            .get() as { n: number }
        ).n
      ).toBe(1);
      expect(readAutomation(db, conflictId)!.name).toBe("Dashboard Claim");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prunes only removed generated workers in the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2d-prune-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const wsId = seedWorkspace(db, join(root, "workspace"), "ws-a");
      const otherWs = seedWorkspace(db, join(root, "other"), "ws-b");
      provisionGeneratedWorkers(db, wsId, FOUR_WORKERS);
      provisionGeneratedWorkers(db, otherWs, [FOUR_WORKERS[0]!]);

      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, origin
        ) VALUES ('ws-a::config-job', 'ws-a', 'Config Job', 1, 'enabled', ?,
          'cfg', NULL, 'jobs.yaml', 'jobs:config-job', 'config')`
      ).run(JSON.stringify({ type: "manual" }));
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, origin
        ) VALUES ('ws-a::dashboard:x', 'ws-a', 'Dash', 1, 'enabled', ?,
          'd', NULL, '__dashboard__', 'dashboard:x', 'dashboard')`
      ).run(JSON.stringify({ type: "manual" }));

      const kept = FOUR_WORKERS.slice(0, 3);
      const removedId = automationId(wsId, "generated:docs-commit");
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status)
         VALUES ('historical-run', ?, ?, 'completed')`
      ).run(removedId, wsId);
      db.prepare(
        `INSERT INTO run_events (run_id, seq, event_type, payload)
         VALUES ('historical-run', 1, 'result', '{}')`
      ).run();
      const noPrune = provisionGeneratedWorkers(db, wsId, kept);
      expect(noPrune.items.every((i) => i.action !== "archive")).toBe(true);
      expect(
        readAutomation(db, automationId(wsId, "generated:docs-commit"))!
          .archived_at
      ).toBeNull();

      const pruned = provisionGeneratedWorkers(db, wsId, kept, { prune: true });
      expect(
        pruned.items.find((i) => i.key === "docs-commit")?.action
      ).toBe("archive");
      const archived = readAutomation(
        db,
        automationId(wsId, "generated:docs-commit")
      )!;
      expect(archived.archived_at).toBeTruthy();
      expect(archived.enabled).toBe(0);
      expect(archived.status).toBe("backlog");

      expect(readAutomation(db, "ws-a::config-job")!.archived_at).toBeNull();
      expect(readAutomation(db, "ws-a::dashboard:x")!.archived_at).toBeNull();
      expect(
        readAutomation(db, automationId(otherWs, "generated:plan-phase"))!
          .archived_at
      ).toBeNull();
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS n FROM runs WHERE id = 'historical-run'")
            .get() as { n: number }
        ).n
      ).toBe(1);
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'historical-run'"
            )
            .get() as { n: number }
        ).n
      ).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b36.02d ownership guards", () => {
  it("skips YAML generated: keys and leaves generated rows untouched by reconcile", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-2d-ns-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { reconcileConfig } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { workspaceIdFromPath: wsIdFromPath } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { provisionGeneratedWorkers: provision } = await import(
      "../packages/daemon/src/config/generated-workers.ts"
    );
    const { GLOBAL_CONFIG_PATH, workspaceAutomationsDir } = await import(
      "../packages/daemon/src/paths.ts"
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
  - id: generated:plan-phase
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
    const warnings: string[] = [];
    try {
      const wsId = wsIdFromPath(workspace);
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
      ).run(wsId, workspace, "Workspace");
      provision(db, wsId, [
        {
          key: "plan-phase",
          name: "Real Plan",
          prompt: "real prompt",
          trigger: { type: "manual" },
          enabled: false,
        },
      ]);
      const before = readAutomation(
        db,
        automationId(wsId, "generated:plan-phase")
      )!;

      reconcileConfig(db, { onLog: (m) => warnings.push(m) });

      expect(
        warnings.some((w) => w.includes("generated:plan-phase"))
      ).toBe(true);
      const after = readAutomation(
        db,
        automationId(wsId, "generated:plan-phase")
      )!;
      expect(after.name).toBe("Real Plan");
      expect(after.prompt).toBe("real prompt");
      expect(after.enabled).toBe(0);
      expect(after.archived_at).toBeNull();
      expect(after.updated_at).toBe(before.updated_at);

      const yamlClaim = db
        .prepare(
          `SELECT COUNT(*) AS n FROM automations
           WHERE name = 'YAML Claim'`
        )
        .get() as { n: number };
      expect(yamlClaim.n).toBe(0);

      const normal = db
        .prepare(
          `SELECT COUNT(*) AS n FROM automations
           WHERE name = 'Normal Job' AND archived_at IS NULL`
        )
        .get() as { n: number };
      expect(normal.n).toBe(1);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("config-origin upsert does not overwrite a generated row", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-2d-upsert-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));
    vi.doMock(
      "../packages/daemon/src/config/generated-workers.ts",
      async (importOriginal) => {
        const actual = await importOriginal<
          typeof import("../packages/daemon/src/config/generated-workers.ts")
        >();
        return {
          ...actual,
          // Exercise the production upsert guard by bypassing only the earlier
          // reserved-namespace guard.
          isGeneratedConfigKey: () => false,
        };
      }
    );

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { reconcileConfig, workspaceIdFromPath: wsIdFromPath } = await import(
      "../packages/daemon/src/config/reconcile.ts"
    );
    const { provisionGeneratedWorkers: provision } = await import(
      "../packages/daemon/src/config/generated-workers.ts"
    );
    const { GLOBAL_CONFIG_PATH, workspaceAutomationsDir } = await import(
      "../packages/daemon/src/paths.ts"
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
  - id: generated:plan-phase
    name: Clobber Attempt
    enabled: true
    trigger:
      type: manual
    prompt: should not land
`,
      "utf8"
    );

    const db = openDb(join(testHome, "state.sqlite"));
    try {
      const wsId = wsIdFromPath(workspace);
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
      ).run(wsId, workspace, "Workspace");
      const id = automationId(wsId, "generated:plan-phase");
      provision(db, wsId, [FOUR_WORKERS[0]!]);
      db.prepare("UPDATE automations SET updated_at = ? WHERE id = ?").run(
        "2000-01-01 00:00:00",
        id
      );
      const before = readAutomation(db, id)!;

      reconcileConfig(db);

      const after = readAutomation(db, id)!;
      expect(after.name).toBe(before.name);
      expect(after.prompt).toBe(before.prompt);
      expect(after.origin).toBe("generated");
      expect(after.config_path).toBe(GENERATED_CONFIG_PATH);
      expect(after.updated_at).toBe(before.updated_at);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("b36.02d HTTP endpoint", () => {
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
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2d-http-"));
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

  it("resolves workspacePath, rejects global/unknown/dup/invalid key, and forbids dashboard edits", async () => {
    await withServer(async ({
      port,
      db,
      workspacePath,
      workspaceId,
      getRefreshCount,
      automationEvents,
    }) => {
      const byPath = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspacePath,
            workers: FOUR_WORKERS,
          }),
        }
      );
      expect(byPath.status).toBe(200);
      const pathPlan = (await byPath.json()) as GeneratedWorkerPlan;
      expect(pathPlan.workspaceId).toBe(workspaceId);
      expect(pathPlan.applied).toBe(true);
      expect(getRefreshCount()).toBe(1);
      expect(automationEvents).toHaveLength(4);
      expect(automationEvents.every((event) => event.action === "created")).toBe(
        true
      );
      expect(
        automationEvents.every((event) => event.automation !== undefined)
      ).toBe(true);

      const byId = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            workers: FOUR_WORKERS,
            dryRun: true,
          }),
        }
      );
      expect(byId.status).toBe(200);
      const idPlan = (await byId.json()) as GeneratedWorkerPlan;
      expect(idPlan.items.map((i) => i.action)).toEqual(
        pathPlan.items.map(() => "unchanged")
      );
      expect(getRefreshCount()).toBe(1);
      expect(automationEvents).toHaveLength(4);

      const unchangedApply = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            workers: FOUR_WORKERS,
          }),
        }
      );
      expect(unchangedApply.status).toBe(200);
      expect(getRefreshCount()).toBe(1);
      expect(automationEvents).toHaveLength(4);

      const pruned = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            workers: FOUR_WORKERS.slice(0, 3),
            prune: true,
          }),
        }
      );
      expect(pruned.status).toBe(200);
      const prunedPlan = (await pruned.json()) as GeneratedWorkerPlan;
      const archivedId = automationId(workspaceId, "generated:docs-commit");
      expect(
        prunedPlan.items.find((item) => item.automationId === archivedId)?.action
      ).toBe("archive");
      expect(getRefreshCount()).toBe(2);
      expect(automationEvents.at(-1)).toMatchObject({
        action: "deleted",
        id: archivedId,
      });

      const globalRes = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "__global__",
            workers: [FOUR_WORKERS[0]],
          }),
        }
      );
      expect(globalRes.status).toBe(400);

      const unknown = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId: "does-not-exist",
            workers: [FOUR_WORKERS[0]],
          }),
        }
      );
      expect(unknown.status).toBe(404);

      const dup = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            workers: [FOUR_WORKERS[0], FOUR_WORKERS[0]],
          }),
        }
      );
      expect(dup.status).toBe(400);

      const badKey = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            workers: [
              {
                key: "generated:plan-phase",
                name: "Bad",
                prompt: "x",
                trigger: { type: "manual" },
              },
            ],
          }),
        }
      );
      expect(badKey.status).toBe(400);

      const conflictId = automationId(workspaceId, "generated:extra");
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key, origin
        ) VALUES (?, ?, 'Dash', 1, 'enabled', ?, 'd', NULL,
          '__dashboard__', 'generated:extra', 'dashboard')`
      ).run(conflictId, workspaceId, JSON.stringify({ type: "manual" }));

      const conflictRes = await fetch(
        `http://127.0.0.1:${port}/api/generated-workers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspaceId,
            workers: [
              ...FOUR_WORKERS,
              {
                key: "extra",
                name: "Extra",
                prompt: "x",
                trigger: { type: "manual" },
              },
            ],
          }),
        }
      );
      expect(conflictRes.status).toBe(409);
      const conflictPlan = (await conflictRes.json()) as GeneratedWorkerPlan;
      expect(conflictPlan.applied).toBe(false);
      expect(getRefreshCount()).toBe(2);
      expect(automationEvents).toHaveLength(5);
      expect(readAutomation(db, archivedId)!.archived_at).not.toBeNull();

      const generatedId = automationId(workspaceId, "generated:plan-phase");
      const patch = await fetch(
        `http://127.0.0.1:${port}/api/automations/${encodeURIComponent(generatedId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Nope" }),
        }
      );
      expect(patch.status).toBe(403);
      const patchBody = (await patch.json()) as { error: string };
      expect(patchBody.error).not.toContain("config-origin");

      const del = await fetch(
        `http://127.0.0.1:${port}/api/automations/${encodeURIComponent(generatedId)}`,
        { method: "DELETE" }
      );
      expect(del.status).toBe(403);
    });
  });
});
