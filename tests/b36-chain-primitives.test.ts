import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import {
  CHAIN_CONTEXT_MAX_BYTES,
  CHAIN_KEY_MAX_LENGTH,
  CHAIN_RENDERED_PROMPT_MAX_BYTES,
  CHAIN_VALUE_MAX_LENGTH,
  CHAIN_VAR_MAX_NESTED,
  CHAIN_VAR_MAX_TOP_LEVEL,
  triggerRunSchema,
} from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
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
  SCHEMA_VERSION,
} from "../packages/daemon/src/db/schema.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import {
  ChainRunner,
} from "../packages/daemon/src/runs/chain-runner.ts";
import { renderChainTemplate } from "../packages/daemon/src/runs/chain-template.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { selectionFromStored } from "../packages/daemon/src/models/selection-persist.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
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

function stubExecutor(
  result = "parent output",
  spawns?: Array<{ model: SpawnParams["model"] }>
): Executor {
  const activeRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-b36",
    sdkRunId: "sdk-b36",
    async *stream() {},
    wait: async () => ({ status: "finished", result }) as never,
    cancel: async () => {},
    dispose: async () => {},
  };
  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      spawns?.push({ model: params.model });
      return activeRun;
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    "ws",
    workspace,
    "Workspace"
  );
}

function insertAutomation(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    configKey: string;
    name: string;
    enabled?: number;
    chainJson?: string | null;
    prompt?: string;
    model?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json
    ) VALUES (?, 'ws', ?, ?, 'enabled', ?, ?, ?, 'test.yaml', ?, ?)`
  ).run(
    input.id,
    input.name,
    input.enabled ?? 1,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name}`,
    input.model ?? null,
    input.configKey,
    input.chainJson ?? null
  );
}

type Env = {
  root: string;
  db: ReturnType<typeof openDatabase>;
  events: DaemonEventBus;
  store: RunStore;
  engine: RunEngine;
  chainRunner: ChainRunner;
  spawns: Array<{ model: SpawnParams["model"] }>;
};

async function createEnv(options?: {
  maxDepth?: number;
  result?: string;
}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-"));
  const workspace = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  seedWorkspace(db, workspace);

  const spawns: Array<{ model: SpawnParams["model"] }> = [];
  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: stubExecutor(options?.result, spawns),
    events,
    inputHub,
    maxConcurrentRuns: 4,
  });
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    maxDepth: options?.maxDepth,
  });
  chainRunner.start();
  return { root, db, events, store, engine, chainRunner, spawns };
}

async function destroyEnv(env: Env): Promise<void> {
  env.chainRunner.stop();
  await env.engine.shutdown();
  env.db.close();
  rmSync(env.root, { recursive: true, force: true });
}

function listRuns(db: ReturnType<typeof openDatabase>) {
  return db
    .prepare(
      `SELECT id, automation_id, parent_run_id, prompt, chain_root_run_id,
              chain_depth, chain_max_depth, chain_context_json, model, model_params_json
       FROM runs ORDER BY created_at ASC, rowid ASC`
    )
    .all() as Array<{
    id: string;
    automation_id: string;
    parent_run_id: string | null;
    prompt: string | null;
    chain_root_run_id: string | null;
    chain_depth: number | null;
    chain_max_depth: number | null;
    chain_context_json: string | null;
    model: string | null;
    model_params_json: string | null;
  }>;
}

function chainSkipped(
  db: ReturnType<typeof openDatabase>,
  runId: string
): Record<string, unknown> | undefined {
  const row = db
    .prepare(
      `SELECT payload FROM run_events
       WHERE run_id = ? AND event_type = 'run.chain-skipped'
       ORDER BY seq DESC LIMIT 1`
    )
    .get(runId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : undefined;
}

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

/** Realistic pre-v14 (v13) database without opening via openDatabase. */
function openV13Database(dbPath: string) {
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
  expect(schemaVersion(db)).toBe(13);
  return db;
}

describe("b36 chain template renderer", () => {
  it("renders simple, repeated, dotted, and multiple placeholders", () => {
    const result = renderChainTemplate(
      "Feature {{featureId}} phase {{phase.ref}} again {{featureId}}",
      {
        featureId: "b36",
        phase: { ref: "01" },
      }
    );
    expect(result).toEqual({
      ok: true,
      text: "Feature b36 phase 01 again b36",
    });
  });

  it("preserves dollars, braces, backslashes, Windows paths, Unicode, multiline", () => {
    const result = renderChainTemplate("path={{p}} $ {{brace}} {{u}}\n{{m}}", {
      p: "C:\\Code\\repo",
      brace: "{not-a-placeholder}",
      u: "café — 日本語",
      m: "line1\nline2",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(
        "path=C:\\Code\\repo $ {not-a-placeholder} café — 日本語\nline1\nline2"
      );
    }
  });

  it("does not recurse into replacement values", () => {
    const result = renderChainTemplate("{{a}}", {
      a: "{{b}}",
      b: "secret",
    });
    expect(result).toEqual({ ok: true, text: "{{b}}" });
  });

  it("leaves prompts without placeholders unchanged", () => {
    expect(renderChainTemplate("plain prompt", {})).toEqual({
      ok: true,
      text: "plain prompt",
    });
  });

  it("errors on missing, malformed, and dangerous keys", () => {
    expect(renderChainTemplate("{{missing}}", {}).ok).toBe(false);
    expect(renderChainTemplate("{{}}", { a: "x" }).ok).toBe(false);
    expect(renderChainTemplate("{{missing", {}).ok).toBe(false);
    expect(renderChainTemplate("literal object close }}", {}).ok).toBe(true);
    expect(renderChainTemplate("{{a{{b}}", { b: "x" }).ok).toBe(false);
    expect(
      renderChainTemplate("{{a.b.c}}", { a: { b: "x" } }).ok
    ).toBe(false);
    expect(
      renderChainTemplate("{{__proto__}}", { __proto__: "x" } as never).ok
    ).toBe(false);
    expect(
      renderChainTemplate(`{{${"k".repeat(CHAIN_KEY_MAX_LENGTH + 1)}}}`, {}).ok
    ).toBe(false);
    expect(renderChainTemplate("{{toString}}", {}).ok).toBe(false);
  });

  it("errors when string/map placeholder shape mismatches", () => {
    expect(
      renderChainTemplate("{{map}}", { map: { k: "v" } }).ok
    ).toBe(false);
    expect(
      renderChainTemplate("{{s.k}}", { s: "string" }).ok
    ).toBe(false);
  });

  it("rejects rendered prompts over the byte limit", () => {
    const result = renderChainTemplate(
      "x".repeat(CHAIN_RENDERED_PROMPT_MAX_BYTES + 1),
      {}
    );
    expect(result).toMatchObject({ ok: false, code: "oversized" });
  });
});

describe("b36 triggerRunSchema", () => {
  it("accepts legacy automationId-only and rejects context without maxDepth", () => {
    expect(triggerRunSchema.safeParse({ automationId: "a" }).success).toBe(
      true
    );
    expect(
      triggerRunSchema.safeParse({
        automationId: "a",
        variables: { featureId: "b36" },
      }).success
    ).toBe(false);
    expect(
      triggerRunSchema.safeParse({
        automationId: "a",
        variables: { featureId: "b36" },
        maxDepth: 5,
      }).success
    ).toBe(true);
  });

  it("rejects dangerous keys and oversized variable counts", () => {
    expect(
      triggerRunSchema.safeParse({
        automationId: "a",
        maxDepth: 1,
        variables: { constructor: "x" },
      }).success
    ).toBe(false);
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < CHAIN_VAR_MAX_TOP_LEVEL + 1; i++) {
      tooMany[`k${i}`] = "v";
    }
    expect(
      triggerRunSchema.safeParse({
        automationId: "a",
        maxDepth: 1,
        variables: tooMany,
      }).success
    ).toBe(false);
  });

  it("enforces key, value, nested-map, context-byte, role, and depth bounds", () => {
    const base = { automationId: "a", maxDepth: 1 };
    expect(
      triggerRunSchema.safeParse({
        ...base,
        variables: { ["k".repeat(CHAIN_KEY_MAX_LENGTH + 1)]: "v" },
      }).success
    ).toBe(false);
    expect(
      triggerRunSchema.safeParse({
        ...base,
        variables: { k: "v".repeat(CHAIN_VALUE_MAX_LENGTH + 1) },
      }).success
    ).toBe(false);

    const nested = Object.fromEntries(
      Array.from({ length: CHAIN_VAR_MAX_NESTED + 1 }, (_, i) => [
        `k${i}`,
        "v",
      ])
    );
    expect(
      triggerRunSchema.safeParse({
        ...base,
        variables: { nested },
      }).success
    ).toBe(false);
    expect(
      triggerRunSchema.safeParse({
        ...base,
        variables: { emptyMap: {} },
      }).success
    ).toBe(false);
    expect(
      triggerRunSchema.safeParse({
        ...base,
        variables: { "   ": "v" },
      }).success
    ).toBe(false);

    const largeContext = Object.fromEntries(
      Array.from({ length: CHAIN_VAR_MAX_TOP_LEVEL }, (_, i) => [
        `map${i}`,
        Object.fromEntries(
          Array.from({ length: CHAIN_VAR_MAX_NESTED }, (__, j) => [
            `k${j}`,
            "x".repeat(
              Math.ceil(
                CHAIN_CONTEXT_MAX_BYTES /
                  CHAIN_VAR_MAX_TOP_LEVEL /
                  CHAIN_VAR_MAX_NESTED
              )
            ),
          ])
        ),
      ])
    );
    expect(
      triggerRunSchema.safeParse({
        ...base,
        variables: largeContext,
      }).success
    ).toBe(false);
    expect(
      triggerRunSchema.safeParse({
        ...base,
        roleModels: { constructor: { id: "model" } },
      }).success
    ).toBe(false);
    expect(
      triggerRunSchema.safeParse({ automationId: "a", maxDepth: 0 }).success
    ).toBe(false);
    expect(
      triggerRunSchema.safeParse({ automationId: "a", maxDepth: 501 }).success
    ).toBe(false);
  });
});

describe("b36 schema v14 migration", () => {
  it("opens fresh databases at SCHEMA_VERSION with chain columns", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-fresh-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      for (const col of [
        "chain_root_run_id",
        "chain_depth",
        "chain_max_depth",
        "chain_context_json",
      ]) {
        expect(hasColumn(db, "runs", col)).toBe(true);
      }
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades v13 to v14 without altering existing rows", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-v13-"));
    const dbPath = join(root, "state.sqlite");
    const db = openV13Database(dbPath);
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
      `INSERT INTO runs (id, automation_id, workspace_id, status, model)
       VALUES ('run1', 'auto', 'ws', 'completed', 'kept-model')`
    ).run();

    try {
      expect(hasColumn(db, "runs", "chain_context_json")).toBe(false);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "runs", "chain_context_json")).toBe(true);
      const row = db
        .prepare(
          `SELECT model, chain_root_run_id, chain_depth, chain_max_depth, chain_context_json
           FROM runs WHERE id = 'run1'`
        )
        .get() as {
        model: string;
        chain_root_run_id: string | null;
        chain_depth: number | null;
        chain_max_depth: number | null;
        chain_context_json: string | null;
      };
      expect(row.model).toBe("kept-model");
      expect(row.chain_root_run_id).toBeNull();
      expect(row.chain_depth).toBeNull();
      expect(row.chain_max_depth).toBeNull();
      expect(row.chain_context_json).toBeNull();
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("partial-column rerun is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-partial-"));
    const dbPath = join(root, "state.sqlite");
    const db = openV13Database(dbPath);
    try {
      db.exec(`ALTER TABLE runs ADD COLUMN chain_root_run_id TEXT`);
      expect(hasColumn(db, "runs", "chain_root_run_id")).toBe(true);
      expect(hasColumn(db, "runs", "chain_depth")).toBe(false);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "runs", "chain_depth")).toBe(true);
      expect(hasColumn(db, "runs", "chain_max_depth")).toBe(true);
      expect(hasColumn(db, "runs", "chain_context_json")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b36 atomic root kickoff", () => {
  it("stores context, root id, depth 0, max depth, rendered prompt, and model before spawn", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::root",
        configKey: "root",
        name: "Root",
        prompt: "Work on {{featureId}}",
      });

      const runId = await env.engine.triggerRun("ws::root", "manual", {
        chainContext: {
          variables: { featureId: "b36" },
          roleModels: {
            implementer: {
              id: "composer-2",
              params: [{ id: "fast", value: "true" }],
            },
          },
        },
        chainMaxDepth: 3,
        modelSelectionOverride: {
          id: "composer-2",
          params: [{ id: "fast", value: "true" }],
        },
      });

      const row = env.store.getRun(runId)!;
      expect(row.prompt).toBe("Work on b36");
      expect(row.chain_root_run_id).toBe(runId);
      expect(row.chain_depth).toBe(0);
      expect(row.chain_max_depth).toBe(3);
      expect(JSON.parse(row.chain_context_json!)).toEqual({
        variables: { featureId: "b36" },
        roleModels: {
          implementer: {
            id: "composer-2",
            params: [{ id: "fast", value: "true" }],
          },
        },
      });
      expect(selectionFromStored(row.model, row.model_params_json)).toEqual({
        id: "composer-2",
        params: [{ id: "fast", value: "true" }],
      });

      await until(() => env.spawns.length >= 1);
      expect(env.spawns[0]!.model).toEqual({
        id: "composer-2",
        params: [{ id: "fast", value: "true" }],
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("failed template resolution inserts no run", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::root",
        configKey: "root",
        name: "Root",
        prompt: "Missing {{featureId}}",
      });
      await expect(
        env.engine.triggerRun("ws::root", "manual", {
          chainContext: { variables: {}, roleModels: {} },
          chainMaxDepth: 2,
        })
      ).rejects.toThrow(/template-error/);
      expect(listRuns(env.db)).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("rejects invalid internal context metadata before inserting", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::root",
        configKey: "root",
        name: "Root",
        prompt: "plain",
      });
      await expect(
        env.engine.triggerRun("ws::root", "manual", {
          chainContext: { variables: {}, roleModels: {} },
          chainMaxDepth: 0,
        })
      ).rejects.toThrow(/chainMaxDepth/);
      await expect(
        env.engine.triggerRun("ws::root", "chain", {
          parentRunId: "parent",
          chainContext: { variables: {}, roleModels: {} },
          chainMaxDepth: 2,
        })
      ).rejects.toThrow(/root id and transition depth/);
      expect(listRuns(env.db)).toHaveLength(0);
    } finally {
      await destroyEnv(env);
    }
  });

  it("legacy automationId-only leaves context null", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::root",
        configKey: "root",
        name: "Root",
        prompt: "plain {{not-templated}}",
      });
      const runId = await env.engine.triggerRun("ws::root");
      const row = env.store.getRun(runId)!;
      expect(row.prompt).toBe("plain {{not-templated}}");
      expect(row.chain_root_run_id).toBeNull();
      expect(row.chain_context_json).toBeNull();
    } finally {
      await destroyEnv(env);
    }
  });
});

describe("b36 context-aware chaining", () => {
  it("propagates context/root/maxDepth and increments child depth", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "Root {{featureId}}",
        chainJson: JSON.stringify({ next: "b", passResult: true }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "Child for {{featureId}}",
        enabled: 0,
      });

      const rootId = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: { featureId: "pipe-1" },
          roleModels: {},
        },
        chainMaxDepth: 5,
      });
      await until(() => listRuns(env.db).length >= 2);

      const runs = listRuns(env.db);
      const child = runs.find((r) => r.parent_run_id === rootId)!;
      expect(child.chain_root_run_id).toBe(rootId);
      expect(child.chain_depth).toBe(1);
      expect(child.chain_max_depth).toBe(5);
      expect(child.prompt).toContain("Child for pipe-1");
      expect(child.prompt).toContain("parent output");
      expect(JSON.parse(child.chain_context_json!).variables.featureId).toBe(
        "pipe-1"
      );
    } finally {
      await destroyEnv(env);
    }
  });

  it("isolates concurrent pipelines sharing workers", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "Root {{featureId}}",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "Worker {{featureId}}",
        enabled: 0,
      });

      const root1 = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: { featureId: "alpha" },
          roleModels: {},
        },
        chainMaxDepth: 5,
      });
      const root2 = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: {
          variables: { featureId: "beta" },
          roleModels: {},
        },
        chainMaxDepth: 5,
      });
      await until(() => listRuns(env.db).length >= 4);

      const runs = listRuns(env.db);
      const child1 = runs.find((r) => r.parent_run_id === root1)!;
      const child2 = runs.find((r) => r.parent_run_id === root2)!;
      expect(child1.prompt).toBe("Worker alpha");
      expect(child2.prompt).toBe("Worker beta");
      expect(child1.chain_root_run_id).toBe(root1);
      expect(child2.chain_root_run_id).toBe(root2);
    } finally {
      await destroyEnv(env);
    }
  });

  it("keeps braces in parent result literal and survives store recreate", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "Root {{featureId}}",
        chainJson: JSON.stringify({ next: "b", passResult: true }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "Child {{featureId}}",
      });

      env.chainRunner.stop();
      await env.engine.shutdown();

      const rootId = "root-after-restart";
      env.store.insertRun({
        id: rootId,
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "Root keep",
        chainContext: {
          variables: { featureId: "keep" },
          roleModels: {},
        },
        chainRootRunId: rootId,
        chainDepth: 0,
        chainMaxDepth: 4,
      });
      env.store.appendEvent(rootId, "run.finished", {
        sdkStatus: "finished",
        result: "see {{featureId}} in output",
      });

      // Recreate store/engine/runner from the same DB before terminal handling.
      const store2 = new RunStore(env.db, env.events);
      const engine2 = new RunEngine(env.db, {
        apiKey: "test-key",
        executor: stubExecutor("second"),
        events: env.events,
        inputHub: new InputHub(new InputStore(env.db), {
          onNeedsInput: () => {},
          onAnswered: () => {},
        }),
        maxConcurrentRuns: 4,
      });
      const runner2 = new ChainRunner({
        store: store2,
        engine: engine2,
        events: env.events,
        onLog: () => {},
      });
      runner2.start();
      store2.setStatus(rootId, "completed");
      await until(() => listRuns(env.db).length >= 2);

      const child = listRuns(env.db).find((r) => r.parent_run_id === rootId)!;
      expect(child.prompt).toContain("Child keep");
      expect(child.prompt).toContain("see {{featureId}} in output");
      const parsed = store2.parseChainContext(store2.getRun(child.id)!)!;
      expect(parsed.ok).toBe(true);

      runner2.stop();
      await engine2.shutdown();
    } finally {
      env.db.close();
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("stops at per-pipeline depth budget independently", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::loop",
        configKey: "loop",
        name: "Loop",
        prompt: "n={{n}}",
        chainJson: JSON.stringify({ next: "loop" }),
      });

      const tight = await env.engine.triggerRun("ws::loop", "manual", {
        chainContext: { variables: { n: "tight" }, roleModels: {} },
        chainMaxDepth: 1,
      });
      const loose = await env.engine.triggerRun("ws::loop", "manual", {
        chainContext: { variables: { n: "loose" }, roleModels: {} },
        chainMaxDepth: 2,
      });

      await until(() => {
        const runs = listRuns(env.db);
        const tightLeaf = runs
          .filter((r) => r.chain_root_run_id === tight)
          .at(-1);
        const looseLeaf = runs
          .filter((r) => r.chain_root_run_id === loose)
          .at(-1);
        return (
          tightLeaf != null &&
          looseLeaf != null &&
          chainSkipped(env.db, tightLeaf.id)?.reason === "max-depth" &&
          chainSkipped(env.db, looseLeaf.id)?.reason === "max-depth"
        );
      }, 10000);

      const tightRuns = listRuns(env.db).filter(
        (r) => r.chain_root_run_id === tight
      );
      const looseRuns = listRuns(env.db).filter(
        (r) => r.chain_root_run_id === loose
      );
      // maxDepth 1 → root(0) + child(1) then skip = 2 runs
      expect(tightRuns).toHaveLength(2);
      // maxDepth 2 → root + 2 children = 3 runs
      expect(looseRuns).toHaveLength(3);
      const tightSkip = chainSkipped(env.db, tightRuns.at(-1)!.id)!;
      expect(tightSkip.depth).toBe(1);
      expect(tightSkip.maxDepth).toBe(1);
    } finally {
      await destroyEnv(env);
    }
  });

  it("emits template-error skip without enqueueing on missing child vars", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "ok",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "needs {{missing}}",
      });

      const rootId = await env.engine.triggerRun("ws::a", "manual", {
        chainContext: { variables: { other: "x" }, roleModels: {} },
        chainMaxDepth: 3,
      });
      await until(
        () => chainSkipped(env.db, rootId)?.reason === "template-error"
      );
      expect(listRuns(env.db)).toHaveLength(1);
      expect(chainSkipped(env.db, rootId)).toMatchObject({
        reason: "template-error",
        depth: 0,
        maxDepth: 3,
      });
    } finally {
      await destroyEnv(env);
    }
  });

  it("does not inherit parent model on child; no override uses automation model", async () => {
    const env = await createEnv();
    try {
      insertAutomation(env.db, {
        id: "ws::a",
        configKey: "a",
        name: "A",
        prompt: "root",
        model: "parent-model",
        chainJson: JSON.stringify({ next: "b" }),
      });
      insertAutomation(env.db, {
        id: "ws::b",
        configKey: "b",
        name: "B",
        prompt: "child",
        model: "child-model",
      });

      await env.engine.triggerRun("ws::a", "manual", {
        chainContext: { variables: {}, roleModels: {} },
        chainMaxDepth: 3,
        modelSelectionOverride: { id: "root-override" },
      });
      await until(() => env.spawns.length >= 2);

      expect(env.spawns[0]!.model).toEqual({ id: "root-override" });
      expect(env.spawns[1]!.model).toEqual({ id: "child-model" });
    } finally {
      await destroyEnv(env);
    }
  });
});

describe("b36 REST kickoff", () => {
  it("accepts strict context kickoff and rejects invalid variables", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b36-http-"));
    const workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
    ).run("ws", workspace);
    insertAutomation(db, {
      id: "ws::root",
      configKey: "root",
      name: "Root",
      prompt: "Hello {{featureId}}",
    });

    const events = new DaemonEventBus();
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
    });

    try {
      const bad = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId: "ws::root",
          variables: { featureId: "x" },
        }),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          automationId: "ws::root",
          variables: { featureId: "b36" },
          maxDepth: 4,
          modelSelection: { id: "composer-2" },
        }),
      });
      expect(ok.status).toBe(201);
      const { runId } = (await ok.json()) as { runId: string };
      const row = new RunStore(db).getRun(runId)!;
      expect(row.prompt).toBe("Hello b36");
      expect(row.chain_depth).toBe(0);
      expect(row.chain_max_depth).toBe(4);
      expect(row.model).toBe("composer-2");
    } finally {
      await http.close();
      await engine.shutdown();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
