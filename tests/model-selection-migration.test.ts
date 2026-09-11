import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  SCHEMA_VERSION,
} from "../packages/daemon/src/db/schema.ts";
import {
  selectionFromStored,
  splitSelectionForDb,
} from "../packages/daemon/src/models/selection-persist.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { ChatStore } from "../packages/daemon/src/chats/store.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

function schemaVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

/** Build a realistic pre-v13 (v12) database without opening via openDatabase. */
function openV12Database(dbPath: string): Database.Database {
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

  expect(schemaVersion(db)).toBe(12);
  return db;
}

describe("model selection persistence helpers", () => {
  it("splits id-only selections to NULL params json", () => {
    expect(splitSelectionForDb({ id: "grok-4.5" })).toEqual({
      model: "grok-4.5",
      modelParamsJson: null,
    });
    expect(splitSelectionForDb(null)).toEqual({
      model: null,
      modelParamsJson: null,
    });
  });

  it("serializes and reconstructs parameterized selections", () => {
    const stored = splitSelectionForDb({
      id: "grok-4.5",
      params: [
        { id: "fast", value: "true" },
        { id: "reasoning_effort", value: "high" },
      ],
    });
    expect(stored.model).toBe("grok-4.5");
    expect(JSON.parse(stored.modelParamsJson!)).toEqual([
      { id: "fast", value: "true" },
      { id: "reasoning_effort", value: "high" },
    ]);
    expect(selectionFromStored(stored.model, stored.modelParamsJson)).toEqual({
      id: "grok-4.5",
      params: [
        { id: "fast", value: "true" },
        { id: "reasoning_effort", value: "high" },
      ],
    });
  });

  it("degrades corrupt params json to id-only without throwing", () => {
    const warnings: string[] = [];
    expect(
      selectionFromStored("custom-model", "{not-json", (d) => warnings.push(d))
    ).toEqual({ id: "custom-model" });
    expect(warnings.length).toBeGreaterThan(0);

    expect(
      selectionFromStored("custom-model", JSON.stringify({ id: "x" }))
    ).toEqual({ id: "custom-model" });

    expect(
      selectionFromStored(
        "custom-model",
        JSON.stringify([{ id: "a", value: "1" }, { id: "a", value: "2" }])
      )
    ).toEqual({ id: "custom-model" });
  });
});

describe("schema v13 model_params_json migration", () => {
  it("opens fresh databases at SCHEMA_VERSION with nullable columns", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-fresh-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      for (const table of [
        "automations",
        "runs",
        "chat_sessions",
        "workspace_chat_defaults",
      ]) {
        expect(hasColumn(db, table, "model_params_json")).toBe(true);
      }
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades a v12 database without rewriting legacy model ids", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-v12-upgrade-"));
    const dbPath = join(root, "state.sqlite");
    const db = openV12Database(dbPath);

    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
    ).run(join(root, "workspace"));
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        config_path, config_key
      ) VALUES ('auto', 'ws', 'A', 1, 'enabled', ?, 'p', 'legacy-auto', 'c.yaml', 'a')`
    ).run(JSON.stringify({ type: "manual" }));
    db.prepare(
      `INSERT INTO runs (id, automation_id, workspace_id, status, model)
       VALUES ('run1', 'auto', 'ws', 'completed', 'legacy-run')`
    ).run();
    db.prepare(
      `INSERT INTO chat_sessions (id, workspace_id, status, model)
       VALUES ('chat1', 'ws', 'idle', 'legacy-chat')`
    ).run();
    db.prepare(
      `INSERT INTO workspace_chat_defaults (workspace_id, model, mcp_overlay_json)
       VALUES ('ws', 'legacy-default', '{}')`
    ).run();

    try {
      expect(hasColumn(db, "automations", "model_params_json")).toBe(false);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "automations", "model_params_json")).toBe(true);

      const auto = db
        .prepare(
          `SELECT model, model_params_json FROM automations WHERE id = 'auto'`
        )
        .get() as { model: string; model_params_json: string | null };
      expect(auto.model).toBe("legacy-auto");
      expect(auto.model_params_json).toBeNull();

      const run = db
        .prepare(`SELECT model, model_params_json FROM runs WHERE id = 'run1'`)
        .get() as { model: string; model_params_json: string | null };
      expect(run.model).toBe("legacy-run");
      expect(run.model_params_json).toBeNull();

      const chat = db
        .prepare(
          `SELECT model, model_params_json FROM chat_sessions WHERE id = 'chat1'`
        )
        .get() as { model: string; model_params_json: string | null };
      expect(chat.model).toBe("legacy-chat");
      expect(chat.model_params_json).toBeNull();

      const defaults = db
        .prepare(
          `SELECT model, model_params_json FROM workspace_chat_defaults WHERE workspace_id = 'ws'`
        )
        .get() as { model: string; model_params_json: string | null };
      expect(defaults.model).toBe("legacy-default");
      expect(defaults.model_params_json).toBeNull();

      // arbitrary custom id still readable as id-only selection
      expect(selectionFromStored(auto.model, auto.model_params_json)).toEqual({
        id: "legacy-auto",
      });

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("dashboard/run/chat stores write and clear model + params atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b35-store-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
      ).run(join(root, "workspace"));

      const dash = new DashboardStore(db);
      const created = dash.createAutomation({
        workspaceId: "ws",
        name: "Param Auto",
        trigger: { type: "manual" },
        prompt: "go",
        modelSelection: {
          id: "grok-4.5",
          params: [{ id: "reasoning_effort", value: "high" }],
        },
      });
      expect(created.model).toBe("grok-4.5");
      expect(created.modelSelection).toEqual({
        id: "grok-4.5",
        params: [{ id: "reasoning_effort", value: "high" }],
      });

      const cleared = dash.updateAutomation(created.id, { model: null });
      expect(cleared).not.toBe("not_found");
      expect(cleared).not.toBe("forbidden");
      if (typeof cleared === "object") {
        expect(cleared.model).toBeNull();
        expect(cleared.modelSelection).toBeNull();
      }

      const runs = new RunStore(db);
      runs.insertRun({
        id: "r1",
        automationId: created.id,
        workspaceId: "ws",
        triggerKind: "manual",
        prompt: "go",
      });
      runs.setRunModel("r1", {
        id: "composer-2",
        params: [{ id: "fast", value: "true" }],
      });
      const runRow = runs.getRun("r1")!;
      expect(runRow.model).toBe("composer-2");
      expect(JSON.parse(runRow.model_params_json!)).toEqual([
        { id: "fast", value: "true" },
      ]);
      runs.setRunModel("r1", null);
      expect(runs.getRun("r1")!.model).toBeNull();
      expect(runs.getRun("r1")!.model_params_json).toBeNull();

      const chats = new ChatStore(db);
      const chat = chats.createChatSession({
        workspaceId: "ws",
        model: {
          id: "gpt-5",
          params: [{ id: "effort", value: "low" }],
        },
      });
      expect(selectionFromStored(chat.model, chat.model_params_json)).toEqual({
        id: "gpt-5",
        params: [{ id: "effort", value: "low" }],
      });
      chats.setChatSessionModel(chat.id, null);
      const clearedChat = chats.getChatSession(chat.id)!;
      expect(clearedChat.model).toBeNull();
      expect(clearedChat.model_params_json).toBeNull();

      chats.upsertWorkspaceChatDefaults("ws", {
        model: {
          id: "claude-4",
          params: [{ id: "thinking", value: "on" }],
        },
      });
      const defaults = chats.getWorkspaceChatDefaults("ws")!;
      expect(defaults.model).toBe("claude-4");
      expect(JSON.parse(defaults.model_params_json!)).toEqual([
        { id: "thinking", value: "on" },
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
