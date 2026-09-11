import type Database from "better-sqlite3";
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
  MIGRATION_V15_CHAIN_STOP_REQUESTED_AT_SQL,
  MIGRATION_V15_CHAIN_STOP_REASON_SQL,
  MIGRATION_V15_CHAIN_MAX_DEPTH_OVERRIDE_SQL,
  MIGRATION_V15_CHAIN_HANDLED_AT_SQL,
  MIGRATION_V15_AUTOMATIONS_MODEL_ROLE_SQL,
  MIGRATION_V16_RUNS_TITLE_SQL,
  MIGRATION_V16_RUNS_SUMMARY_SQL,
  MIGRATION_V17_PIPELINE_WAVE_ID_SQL,
  MIGRATION_V17_PIPELINE_TRACK_ID_SQL,
  MIGRATION_V17_EXECUTION_CWD_SQL,
  MIGRATION_V17_PIPELINE_WAVES_SQL,
  MIGRATION_V17_PIPELINE_TRACKS_SQL,
  MIGRATION_V18_INPUT_METADATA_SQL,
  MIGRATION_V19_FEATURE_QUEUE_SQL,
  MIGRATION_V20_FEATURE_QUEUE_DIGEST_SQL,
  MIGRATION_V21_CHAT_ATTACHED_RUN_SQL,
  SCHEMA_VERSION,
} from "./schema.js";

function currentVersion(db: Database.Database): number {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get() as { name: string } | undefined;
  if (!table) {
    return 0;
  }
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function applyVersion(db: Database.Database, version: number): void {
  db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
}

export function migrate(db: Database.Database): void {
  let version = currentVersion(db);

  if (version < 1) {
    db.exec(MIGRATION_V1_SQL);
    applyVersion(db, 1);
    version = 1;
  }

  if (version < 2) {
    const columns = db
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "sdk_run_id")) {
      db.exec(MIGRATION_V2_SQL);
    }
    applyVersion(db, 2);
    version = 2;
  }

  if (version < 3) {
    const columns = db
      .prepare("PRAGMA table_info(automations)")
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "archived_at")) {
      db.exec(MIGRATION_V3_SQL);
    }
    applyVersion(db, 3);
    version = 3;
  }

  if (version < 4) {
    const columns = db
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "prompt")) {
      db.exec(MIGRATION_V4_SQL);
    }
    applyVersion(db, 4);
    version = 4;
  }

  if (version < 5) {
    const columns = db
      .prepare("PRAGMA table_info(automations)")
      .all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "origin")) {
      db.exec(MIGRATION_V5_SQL);
    }
    applyVersion(db, 5);
    version = 5;
  }

  if (version < 6) {
    const automationColumns = db
      .prepare("PRAGMA table_info(automations)")
      .all() as Array<{ name: string }>;
    if (!automationColumns.some((c) => c.name === "chain_json")) {
      db.exec(MIGRATION_V6_AUTOMATIONS_SQL);
    }
    const runColumns = db
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    if (!runColumns.some((c) => c.name === "parent_run_id")) {
      db.exec(MIGRATION_V6_RUNS_SQL);
    }
    applyVersion(db, 6);
    version = 6;
  }

  if (version < 7) {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_queued_messages'"
      )
      .get() as { name: string } | undefined;
    if (!table) {
      db.exec(MIGRATION_V7_SQL);
    }
    applyVersion(db, 7);
    version = 7;
  }

  if (version < 8) {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_sessions'"
      )
      .get() as { name: string } | undefined;
    if (!table) {
      db.exec(MIGRATION_V8_SQL);
    }
    applyVersion(db, 8);
    version = 8;
  }

  if (version < 9) {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_chat_defaults'"
      )
      .get() as { name: string } | undefined;
    if (!table) {
      db.exec(MIGRATION_V9_SQL);
    }
    applyVersion(db, 9);
    version = 9;
  }

  if (version < 10) {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'"
      )
      .get() as { name: string } | undefined;
    if (!table) {
      db.exec(MIGRATION_V10_SQL);
    }
    const runQueueColumns = db
      .prepare("PRAGMA table_info(run_queued_messages)")
      .all() as Array<{ name: string }>;
    if (!runQueueColumns.some((c) => c.name === "attachments_json")) {
      db.exec(MIGRATION_V10_RUN_QUEUE_SQL);
    }
    const chatQueueColumns = db
      .prepare("PRAGMA table_info(chat_queued_messages)")
      .all() as Array<{ name: string }>;
    if (!chatQueueColumns.some((c) => c.name === "attachments_json")) {
      db.exec(MIGRATION_V10_CHAT_QUEUE_SQL);
    }
    applyVersion(db, 10);
    version = 10;
  }

  if (version < 11) {
    const chatColumns = db
      .prepare("PRAGMA table_info(chat_sessions)")
      .all() as Array<{ name: string }>;
    if (!chatColumns.some((c) => c.name === "title_source")) {
      db.exec(MIGRATION_V11_SQL);
    }
    applyVersion(db, 11);
    version = 11;
  }

  if (version < 12) {
    const runColumns = db
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    if (!runColumns.some((c) => c.name === "model")) {
      db.exec(MIGRATION_V12_SQL);
    }
    applyVersion(db, 12);
    version = 12;
  }

  if (version < 13) {
    const automationColumns = db
      .prepare("PRAGMA table_info(automations)")
      .all() as Array<{ name: string }>;
    if (!automationColumns.some((c) => c.name === "model_params_json")) {
      db.exec(MIGRATION_V13_AUTOMATIONS_SQL);
    }
    const runColumns = db
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    if (!runColumns.some((c) => c.name === "model_params_json")) {
      db.exec(MIGRATION_V13_RUNS_SQL);
    }
    const chatColumns = db
      .prepare("PRAGMA table_info(chat_sessions)")
      .all() as Array<{ name: string }>;
    if (!chatColumns.some((c) => c.name === "model_params_json")) {
      db.exec(MIGRATION_V13_CHAT_SESSIONS_SQL);
    }
    const defaultsColumns = db
      .prepare("PRAGMA table_info(workspace_chat_defaults)")
      .all() as Array<{ name: string }>;
    if (!defaultsColumns.some((c) => c.name === "model_params_json")) {
      db.exec(MIGRATION_V13_WORKSPACE_CHAT_DEFAULTS_SQL);
    }
    applyVersion(db, 13);
    version = 13;
  }

  if (version < 14) {
    const hasRunColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(runs)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    if (!hasRunColumn("chain_root_run_id")) {
      db.exec(MIGRATION_V14_CHAIN_ROOT_RUN_ID_SQL);
    }
    if (!hasRunColumn("chain_depth")) {
      db.exec(MIGRATION_V14_CHAIN_DEPTH_SQL);
    }
    if (!hasRunColumn("chain_max_depth")) {
      db.exec(MIGRATION_V14_CHAIN_MAX_DEPTH_SQL);
    }
    if (!hasRunColumn("chain_context_json")) {
      db.exec(MIGRATION_V14_CHAIN_CONTEXT_JSON_SQL);
    }
    applyVersion(db, 14);
    version = 14;
  }

  if (version < 15) {
    const hasRunColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(runs)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    const hasAutomationColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(automations)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    if (!hasRunColumn("chain_stop_requested_at")) {
      db.exec(MIGRATION_V15_CHAIN_STOP_REQUESTED_AT_SQL);
    }
    if (!hasRunColumn("chain_stop_reason")) {
      db.exec(MIGRATION_V15_CHAIN_STOP_REASON_SQL);
    }
    if (!hasRunColumn("chain_max_depth_override")) {
      db.exec(MIGRATION_V15_CHAIN_MAX_DEPTH_OVERRIDE_SQL);
    }
    if (!hasRunColumn("chain_handled_at")) {
      db.exec(MIGRATION_V15_CHAIN_HANDLED_AT_SQL);
    }
    if (!hasAutomationColumn("model_role")) {
      db.exec(MIGRATION_V15_AUTOMATIONS_MODEL_ROLE_SQL);
    }
    applyVersion(db, 15);
    version = 15;
  }

  if (version < 16) {
    const hasRunColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(runs)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    if (!hasRunColumn("title")) {
      db.exec(MIGRATION_V16_RUNS_TITLE_SQL);
    }
    if (!hasRunColumn("summary")) {
      db.exec(MIGRATION_V16_RUNS_SUMMARY_SQL);
    }
    applyVersion(db, 16);
    version = 16;
  }

  if (version < 17) {
    const hasRunColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(runs)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    if (!hasRunColumn("pipeline_wave_id")) {
      db.exec(MIGRATION_V17_PIPELINE_WAVE_ID_SQL);
    }
    if (!hasRunColumn("pipeline_track_id")) {
      db.exec(MIGRATION_V17_PIPELINE_TRACK_ID_SQL);
    }
    if (!hasRunColumn("execution_cwd")) {
      db.exec(MIGRATION_V17_EXECUTION_CWD_SQL);
    }
    db.exec(MIGRATION_V17_PIPELINE_WAVES_SQL);
    db.exec(MIGRATION_V17_PIPELINE_TRACKS_SQL);
    applyVersion(db, 17);
    version = 17;
  }

  if (version < 18) {
    const hasInputColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(input_requests)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    if (!hasInputColumn("metadata_json")) {
      db.exec(MIGRATION_V18_INPUT_METADATA_SQL);
    }
    applyVersion(db, 18);
    version = 18;
  }

  if (version < 19) {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feature_queue_entries'"
      )
      .get() as { name: string } | undefined;
    if (!table) {
      db.exec(MIGRATION_V19_FEATURE_QUEUE_SQL);
    }
    applyVersion(db, 19);
    version = 19;
  }

  if (version < 20) {
    const hasFeatureQueueColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(feature_queue_entries)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    if (!hasFeatureQueueColumn("batch_digest_at")) {
      db.exec(MIGRATION_V20_FEATURE_QUEUE_DIGEST_SQL);
    }
    applyVersion(db, 20);
    version = 20;
  }

  if (version < 21) {
    const hasChatSessionColumn = (name: string): boolean => {
      const cols = db
        .prepare("PRAGMA table_info(chat_sessions)")
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === name);
    };
    if (!hasChatSessionColumn("attached_run_id")) {
      db.exec(MIGRATION_V21_CHAT_ATTACHED_RUN_SQL);
    }
    applyVersion(db, 21);
  }

  if (currentVersion(db) < SCHEMA_VERSION) {
    throw new Error(
      `Schema migration incomplete (at v${currentVersion(db)}, want v${SCHEMA_VERSION})`
    );
  }
}
