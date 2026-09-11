import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  automationYamlEntrySchema,
  chainControlSchema,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import {
  MIGRATION_V1_SQL,
  MIGRATION_V2_SQL,
  MIGRATION_V3_SQL,
  MIGRATION_V4_SQL,
  MIGRATION_V5_SQL,
  MIGRATION_V6_AUTOMATIONS_SQL,
  MIGRATION_V6_RUNS_SQL,
  MIGRATION_V7_SQL,
  MIGRATION_V8_SQL,
  MIGRATION_V9_SQL,
  MIGRATION_V10_SQL,
  MIGRATION_V10_RUN_QUEUE_SQL,
  MIGRATION_V10_CHAT_QUEUE_SQL,
  MIGRATION_V11_SQL,
  MIGRATION_V12_SQL,
  MIGRATION_V13_AUTOMATIONS_SQL,
  MIGRATION_V13_RUNS_SQL,
  MIGRATION_V13_CHAT_SESSIONS_SQL,
  MIGRATION_V13_WORKSPACE_CHAT_DEFAULTS_SQL,
  MIGRATION_V14_CHAIN_ROOT_RUN_ID_SQL,
  MIGRATION_V14_CHAIN_DEPTH_SQL,
  MIGRATION_V14_CHAIN_MAX_DEPTH_SQL,
  MIGRATION_V14_CHAIN_CONTEXT_JSON_SQL,
  SCHEMA_VERSION,
} from "../packages/daemon/src/db/schema.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

function hasColumn(
  db: { prepare: (sql: string) => { all: () => unknown[] } },
  table: string,
  name: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === name);
}

function schemaVersion(db: {
  prepare: (sql: string) => { get: () => unknown };
}): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

/** Realistic pre-v15 (v14) database without opening via openDatabase. */
function openV14Database(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const apply = (version: number, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
      version
    );
  };

  apply(1, MIGRATION_V1_SQL);
  if (!hasColumn(db, "runs", "sdk_run_id")) apply(2, MIGRATION_V2_SQL);
  else db.prepare("INSERT INTO schema_migrations (version) VALUES (2)").run();
  if (!hasColumn(db, "automations", "archived_at")) apply(3, MIGRATION_V3_SQL);
  else db.prepare("INSERT INTO schema_migrations (version) VALUES (3)").run();
  if (!hasColumn(db, "runs", "prompt")) apply(4, MIGRATION_V4_SQL);
  else db.prepare("INSERT INTO schema_migrations (version) VALUES (4)").run();
  if (!hasColumn(db, "automations", "origin")) apply(5, MIGRATION_V5_SQL);
  else db.prepare("INSERT INTO schema_migrations (version) VALUES (5)").run();
  if (!hasColumn(db, "automations", "chain_json")) {
    db.exec(MIGRATION_V6_AUTOMATIONS_SQL);
  }
  if (!hasColumn(db, "runs", "parent_run_id")) {
    db.exec(MIGRATION_V6_RUNS_SQL);
  }
  db.prepare("INSERT INTO schema_migrations (version) VALUES (6)").run();
  apply(7, MIGRATION_V7_SQL);
  apply(8, MIGRATION_V8_SQL);
  apply(9, MIGRATION_V9_SQL);
  apply(10, MIGRATION_V10_SQL);
  if (!hasColumn(db, "run_queued_messages", "attachments_json")) {
    db.exec(MIGRATION_V10_RUN_QUEUE_SQL);
  }
  if (!hasColumn(db, "chat_queued_messages", "attachments_json")) {
    db.exec(MIGRATION_V10_CHAT_QUEUE_SQL);
  }
  if (!hasColumn(db, "chat_sessions", "title_source")) apply(11, MIGRATION_V11_SQL);
  else db.prepare("INSERT INTO schema_migrations (version) VALUES (11)").run();
  if (!hasColumn(db, "runs", "model")) apply(12, MIGRATION_V12_SQL);
  else db.prepare("INSERT INTO schema_migrations (version) VALUES (12)").run();
  if (!hasColumn(db, "automations", "model_params_json")) {
    db.exec(MIGRATION_V13_AUTOMATIONS_SQL);
  }
  if (!hasColumn(db, "runs", "model_params_json")) {
    db.exec(MIGRATION_V13_RUNS_SQL);
  }
  if (!hasColumn(db, "chat_sessions", "model_params_json")) {
    db.exec(MIGRATION_V13_CHAT_SESSIONS_SQL);
  }
  if (!hasColumn(db, "workspace_chat_defaults", "model_params_json")) {
    db.exec(MIGRATION_V13_WORKSPACE_CHAT_DEFAULTS_SQL);
  }
  db.prepare("INSERT INTO schema_migrations (version) VALUES (13)").run();

  if (!hasColumn(db, "runs", "chain_root_run_id")) {
    db.exec(MIGRATION_V14_CHAIN_ROOT_RUN_ID_SQL);
  }
  if (!hasColumn(db, "runs", "chain_depth")) {
    db.exec(MIGRATION_V14_CHAIN_DEPTH_SQL);
  }
  if (!hasColumn(db, "runs", "chain_max_depth")) {
    db.exec(MIGRATION_V14_CHAIN_MAX_DEPTH_SQL);
  }
  if (!hasColumn(db, "runs", "chain_context_json")) {
    db.exec(MIGRATION_V14_CHAIN_CONTEXT_JSON_SQL);
  }
  db.prepare("INSERT INTO schema_migrations (version) VALUES (14)").run();
  expect(schemaVersion(db)).toBe(14);
  return db;
}

const V15_RUN_COLUMNS = [
  "chain_stop_requested_at",
  "chain_stop_reason",
  "chain_max_depth_override",
  "chain_handled_at",
] as const;

describe("b36.02a schema v15 migration", () => {
  it("opens fresh databases at SCHEMA_VERSION with all five new columns", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2a-fresh-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      for (const col of V15_RUN_COLUMNS) {
        expect(hasColumn(db, "runs", col)).toBe(true);
      }
      expect(hasColumn(db, "automations", "model_role")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades v14 to v15 without altering existing rows", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2a-v14-"));
    const dbPath = join(root, "state.sqlite");
    const db = openV14Database(dbPath);
    const contextJson = JSON.stringify({
      variables: { featureId: "b36" },
      roleModels: { implementer: { id: "fast" } },
    });
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
    ).run(join(root, "workspace"));
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt,
        config_path, config_key
      ) VALUES ('auto', 'ws', 'A', 1, 'enabled', ?, 'p', 'c.yaml', 'a')`
    ).run(JSON.stringify({ type: "manual" }));
    db.prepare(
      `INSERT INTO runs (
        id, automation_id, workspace_id, status, model,
        chain_root_run_id, chain_depth, chain_max_depth, chain_context_json
      ) VALUES (
        'run1', 'auto', 'ws', 'completed', 'kept-model',
        'run1', 0, 10, ?
      )`
    ).run(contextJson);

    try {
      expect(hasColumn(db, "runs", "chain_handled_at")).toBe(false);
      expect(hasColumn(db, "automations", "model_role")).toBe(false);
      const before = db
        .prepare(
          `SELECT model, chain_root_run_id, chain_depth, chain_max_depth,
                  chain_context_json FROM runs WHERE id = 'run1'`
        )
        .get() as Record<string, unknown>;

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      for (const col of V15_RUN_COLUMNS) {
        expect(hasColumn(db, "runs", col)).toBe(true);
      }
      expect(hasColumn(db, "automations", "model_role")).toBe(true);

      const after = db
        .prepare(
          `SELECT model, chain_root_run_id, chain_depth, chain_max_depth,
                  chain_context_json, chain_stop_requested_at, chain_stop_reason,
                  chain_max_depth_override, chain_handled_at
           FROM runs WHERE id = 'run1'`
        )
        .get() as Record<string, unknown>;
      expect(after.model).toBe(before.model);
      expect(after.chain_root_run_id).toBe(before.chain_root_run_id);
      expect(after.chain_depth).toBe(before.chain_depth);
      expect(after.chain_max_depth).toBe(before.chain_max_depth);
      expect(after.chain_context_json).toBe(before.chain_context_json);
      expect(after.chain_stop_requested_at).toBeNull();
      expect(after.chain_stop_reason).toBeNull();
      expect(after.chain_max_depth_override).toBeNull();
      expect(after.chain_handled_at).toBeNull();

      const auto = db
        .prepare(`SELECT model_role FROM automations WHERE id = 'auto'`)
        .get() as { model_role: string | null };
      expect(auto.model_role).toBeNull();

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("partial-column rerun is idempotent and still lands on SCHEMA_VERSION", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2a-partial-"));
    const dbPath = join(root, "state.sqlite");
    const db = openV14Database(dbPath);
    try {
      db.exec(`ALTER TABLE runs ADD COLUMN chain_stop_requested_at TEXT`);
      expect(hasColumn(db, "runs", "chain_stop_requested_at")).toBe(true);
      expect(hasColumn(db, "runs", "chain_handled_at")).toBe(false);
      expect(hasColumn(db, "automations", "model_role")).toBe(false);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      for (const col of V15_RUN_COLUMNS) {
        expect(hasColumn(db, "runs", col)).toBe(true);
      }
      expect(hasColumn(db, "automations", "model_role")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b36.02a chainControlSchema", () => {
  it("rejects empty, unknown keys, blank/overlong reason, and out-of-range depth", () => {
    expect(chainControlSchema.safeParse({}).success).toBe(false);
    expect(
      chainControlSchema.safeParse({ stop: { reason: "x" }, extra: 1 }).success
    ).toBe(false);
    expect(
      chainControlSchema.safeParse({ stop: { reason: "   " } }).success
    ).toBe(false);
    expect(
      chainControlSchema.safeParse({
        stop: { reason: "r".repeat(257) },
      }).success
    ).toBe(false);
    expect(
      chainControlSchema.safeParse({ rebudget: { maxDepth: 0 } }).success
    ).toBe(false);
    expect(
      chainControlSchema.safeParse({ rebudget: { maxDepth: 501 } }).success
    ).toBe(false);
    expect(
      chainControlSchema.safeParse({ extendBudget: { transitions: 0 } }).success
    ).toBe(false);
    expect(
      chainControlSchema.safeParse({ extendBudget: { transitions: 501 } })
        .success
    ).toBe(false);
    expect(
      chainControlSchema.safeParse({
        rebudget: { maxDepth: 12 },
        extendBudget: { transitions: 6 },
      }).success
    ).toBe(false);
  });

  it("accepts stop-only, rebudget-only, extend-only, and stop with either budget op", () => {
    expect(
      chainControlSchema.safeParse({ stop: { reason: "done" } }).success
    ).toBe(true);
    expect(
      chainControlSchema.safeParse({ rebudget: { maxDepth: 12 } }).success
    ).toBe(true);
    expect(
      chainControlSchema.safeParse({
        stop: { reason: "done" },
        rebudget: { maxDepth: 3 },
      }).success
    ).toBe(true);
    expect(
      chainControlSchema.safeParse({ extendBudget: { transitions: 6 } }).success
    ).toBe(true);
    expect(
      chainControlSchema.safeParse({
        stop: { reason: "blocked: x" },
        extendBudget: { transitions: 12 },
      }).success
    ).toBe(true);
  });
});

describe("b36.02a RunStore chain control and claim", () => {
  function withStore(
    fn: (store: RunStore, db: ReturnType<typeof openDatabase>) => void
  ): void {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2a-store-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const store = new RunStore(db);
    try {
      mkdirSync(join(root, "workspace"), { recursive: true });
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
      ).run(join(root, "workspace"));
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt,
          config_path, config_key
        ) VALUES ('auto', 'ws', 'A', 1, 'enabled', ?, 'p', 'c.yaml', 'a')`
      ).run(JSON.stringify({ type: "manual" }));
      fn(store, db);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  function seedRun(
    store: RunStore,
    id: string,
    opts?: {
      status?: "queued" | "running" | "completed" | "failed" | "cancelled";
      chainMaxDepth?: number;
      chainContext?: { variables: Record<string, string>; roleModels: Record<string, { id: string }> };
    }
  ): void {
    store.insertRun({
      id,
      automationId: "auto",
      workspaceId: "ws",
      triggerKind: "manual",
      prompt: "hello",
      chainRootRunId: id,
      chainDepth: 0,
      chainMaxDepth: opts?.chainMaxDepth ?? 10,
      chainContext: opts?.chainContext ?? {
        variables: { featureId: "b36" },
        roleModels: {},
      },
    });
    if (opts?.status && opts.status !== "queued") {
      store.setStatus(id, opts.status);
    }
  }

  it("fails with not-found when the run does not exist", () => {
    withStore((store) => {
      const result = store.applyChainControl("missing", {
        stop: { reason: "x" },
      });
      expect(result).toEqual({ ok: false, reason: "not-found" });
    });
  });

  it("fails with terminal when the run is completed/failed/cancelled", () => {
    withStore((store) => {
      for (const status of ["completed", "failed", "cancelled"] as const) {
        const id = `run-${status}`;
        seedRun(store, id, { status });
        expect(
          store.applyChainControl(id, { stop: { reason: "late" } })
        ).toEqual({ ok: false, reason: "terminal" });
      }
    });
  });

  it("accepts stop and keeps the first reason on repeat", () => {
    withStore((store) => {
      seedRun(store, "run-stop");
      const first = store.applyChainControl("run-stop", {
        stop: { reason: "first-reason" },
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.response.stopRequested).toBe(true);
      expect(first.response.stopReason).toBe("first-reason");
      const stamped = store.getRun("run-stop")!.chain_stop_requested_at;
      expect(stamped).toBeTruthy();

      const second = store.applyChainControl("run-stop", {
        stop: { reason: "second-reason" },
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.response.stopReason).toBe("first-reason");
      expect(store.getRun("run-stop")!.chain_stop_requested_at).toBe(stamped);
    });
  });

  it("accepts rebudget, leaves original budget/context intact, reports effectiveMaxDepth", () => {
    withStore((store) => {
      const context = {
        variables: { featureId: "b36" },
        roleModels: { implementer: { id: "fast" } },
      };
      seedRun(store, "run-budget", {
        chainMaxDepth: 8,
        chainContext: context,
      });
      const before = store.getRun("run-budget")!;
      const result = store.applyChainControl("run-budget", {
        rebudget: { maxDepth: 20 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.response.maxDepth).toBe(8);
      expect(result.response.maxDepthOverride).toBe(20);
      expect(result.response.effectiveMaxDepth).toBe(20);

      const after = store.getRun("run-budget")!;
      expect(after.chain_max_depth).toBe(8);
      expect(after.chain_context_json).toBe(before.chain_context_json);
      expect(JSON.parse(after.chain_context_json!)).toEqual(context);
    });
  });

  it("identical rebudget is success with no write; conflicting rebudget fails and writes nothing", () => {
    withStore((store) => {
      seedRun(store, "run-budget-idem", { chainMaxDepth: 5 });
      const first = store.applyChainControl("run-budget-idem", {
        rebudget: { maxDepth: 12 },
      });
      expect(first.ok).toBe(true);
      const stamped = store.getRun("run-budget-idem")!.updated_at;

      const same = store.applyChainControl("run-budget-idem", {
        rebudget: { maxDepth: 12 },
      });
      expect(same.ok).toBe(true);
      if (!same.ok) return;
      expect(same.response.maxDepthOverride).toBe(12);
      expect(store.getRun("run-budget-idem")!.updated_at).toBe(stamped);

      const conflict = store.applyChainControl("run-budget-idem", {
        rebudget: { maxDepth: 99 },
      });
      expect(conflict).toEqual({ ok: false, reason: "rebudget-conflict" });
      expect(store.getRun("run-budget-idem")!.chain_max_depth_override).toBe(12);
      expect(store.getRun("run-budget-idem")!.updated_at).toBe(stamped);
    });
  });

  it("extendBudget grows from the effective ceiling, clamps at 500, and is write-once", () => {
    withStore((store) => {
      seedRun(store, "run-extend", { chainMaxDepth: 10 });
      const first = store.applyChainControl("run-extend", {
        extendBudget: { transitions: 6 },
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.response.maxDepth).toBe(10);
      expect(first.response.maxDepthOverride).toBe(16);
      expect(first.response.effectiveMaxDepth).toBe(16);
      expect(first.response.budgetExtension).toEqual({
        previousEffectiveMaxDepth: 10,
        requestedTransitions: 6,
        appliedTransitions: 6,
        clamped: false,
      });
      const stamped = store.getRun("run-extend")!.updated_at;

      const same = store.applyChainControl("run-extend", {
        extendBudget: { transitions: 6 },
      });
      expect(same.ok).toBe(true);
      if (!same.ok) return;
      expect(same.response.budgetExtension?.appliedTransitions).toBe(0);
      expect(store.getRun("run-extend")!.updated_at).toBe(stamped);

      const conflict = store.applyChainControl("run-extend", {
        extendBudget: { transitions: 12 },
      });
      expect(conflict).toEqual({ ok: false, reason: "extend-conflict" });
      expect(store.getRun("run-extend")!.chain_max_depth_override).toBe(16);

      seedRun(store, "run-clamp", { chainMaxDepth: 498 });
      const clamped = store.applyChainControl("run-clamp", {
        extendBudget: { transitions: 12 },
      });
      expect(clamped.ok).toBe(true);
      if (!clamped.ok) return;
      expect(clamped.response.effectiveMaxDepth).toBe(500);
      expect(clamped.response.budgetExtension).toEqual({
        previousEffectiveMaxDepth: 498,
        requestedTransitions: 12,
        appliedTransitions: 2,
        clamped: true,
      });
    });
  });

  it("extendBudget refuses runs without context-aware budget metadata", () => {
    withStore((store, db) => {
      store.insertRun({
        id: "run-legacy",
        automationId: "auto",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "hello",
      });
      const result = store.applyChainControl("run-legacy", {
        extendBudget: { transitions: 6 },
      });
      expect(result).toEqual({ ok: false, reason: "no-budget-context" });
      expect(store.getRun("run-legacy")!.chain_max_depth_override).toBeNull();
      // stop still works without context
      expect(
        store.applyChainControl("run-legacy", { stop: { reason: "done" } }).ok
      ).toBe(true);
    });
  });

  it("claims a transition exactly once per run, and independently across runs", () => {
    withStore((store) => {
      seedRun(store, "run-a");
      seedRun(store, "run-b");
      expect(store.claimChainHandled("run-a")).toBe(true);
      expect(store.claimChainHandled("run-a")).toBe(false);
      expect(store.claimChainHandled("run-b")).toBe(true);
      expect(store.getRun("run-a")!.chain_handled_at).toBeTruthy();
      expect(store.getRun("run-b")!.chain_handled_at).toBeTruthy();
    });
  });
});

describe("b36.02a model_role persistence", () => {
  it("reconciles modelRole from YAML and clears it when removed", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b36-2a-reconcile-"));
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

    const automationFile = join(
      workspaceAutomationsDir(workspace),
      "jobs.yaml"
    );
    writeFileSync(
      automationFile,
      `automations:\n  - name: Role Worker\n    enabled: true\n    trigger:\n      type: manual\n    prompt: Do work\n    modelRole: implementer\n`,
      "utf8"
    );

    const db = openDb(join(testHome, "state.sqlite"));
    try {
      reconcileConfig(db);
      const withRole = db
        .prepare(
          `SELECT model_role FROM automations WHERE name = 'Role Worker' AND archived_at IS NULL`
        )
        .get() as { model_role: string | null };
      expect(withRole.model_role).toBe("implementer");

      writeFileSync(
        automationFile,
        `automations:\n  - name: Role Worker\n    enabled: true\n    trigger:\n      type: manual\n    prompt: Do work\n`,
        "utf8"
      );
      reconcileConfig(db);
      const cleared = db
        .prepare(
          `SELECT model_role FROM automations WHERE name = 'Role Worker' AND archived_at IS NULL`
        )
        .get() as { model_role: string | null };
      expect(cleared.model_role).toBeNull();
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("round-trips modelRole through dashboard create and clear-on-update", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-2a-dash-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      mkdirSync(join(root, "workspace"), { recursive: true });
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
      ).run(join(root, "workspace"));

      const store = new DashboardStore(db);
      const created = store.createAutomation({
        workspaceId: "ws",
        name: "Dash Role",
        trigger: { type: "manual" },
        prompt: "prompt",
        modelRole: "reviewer",
        enabled: true,
      });
      expect(created.modelRole).toBe("reviewer");
      expect(created.origin).toBe("dashboard");

      const cleared = store.updateAutomation(created.id, { modelRole: null });
      expect(cleared).not.toBe("not_found");
      expect(cleared).not.toBe("forbidden");
      if (typeof cleared === "object") {
        expect(cleared.modelRole).toBeUndefined();
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects dangerous modelRole keys at the schema boundary", () => {
    expect(
      automationYamlEntrySchema.safeParse({
        name: "x",
        trigger: { type: "manual" },
        prompt: "p",
        modelRole: "constructor",
      }).success
    ).toBe(false);
    expect(
      automationYamlEntrySchema.safeParse({
        name: "x",
        trigger: { type: "manual" },
        prompt: "p",
        modelRole: "implementer",
      }).success
    ).toBe(true);
  });
});
