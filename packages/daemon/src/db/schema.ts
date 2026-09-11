export const SCHEMA_VERSION = 21;

export const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'backlog',
  trigger_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  config_path TEXT NOT NULL,
  config_key TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(workspace_id, config_key)
);

CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_automations_enabled ON automations(enabled);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  agent_id TEXT,
  trigger_kind TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runs_automation ON runs(automation_id);
CREATE INDEX IF NOT EXISTS idx_runs_workspace_status ON runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS input_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_input_requests_run ON input_requests(run_id);
CREATE INDEX IF NOT EXISTS idx_input_requests_status ON input_requests(status);
`;

export const MIGRATION_V2_SQL = `
ALTER TABLE runs ADD COLUMN sdk_run_id TEXT;
`;

export const MIGRATION_V3_SQL = `
ALTER TABLE automations ADD COLUMN archived_at TEXT;
`;

// Persist the resolved prompt (automation prompt or trigger-injected override)
// on the run row so queued runs survive a restart and history/export is
// self-contained without re-reading config.
export const MIGRATION_V4_SQL = `
ALTER TABLE runs ADD COLUMN prompt TEXT;
`;

export const MIGRATION_V5_SQL = `
ALTER TABLE automations ADD COLUMN origin TEXT NOT NULL DEFAULT 'config';
`;

export const MIGRATION_V6_AUTOMATIONS_SQL = `
ALTER TABLE automations ADD COLUMN chain_json TEXT;
`;

export const MIGRATION_V6_RUNS_SQL = `
ALTER TABLE runs ADD COLUMN parent_run_id TEXT;
`;

export const MIGRATION_V7_SQL = `
CREATE TABLE IF NOT EXISTS run_queued_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_queued_messages_run_status_created
  ON run_queued_messages(run_id, status, created_at);
`;

export const MIGRATION_V8_SQL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  agent_id TEXT,
  sdk_run_id TEXT,
  model TEXT,
  system_prompt TEXT,
  origin_run_id TEXT REFERENCES runs(id),
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_message_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_updated
  ON chat_sessions(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_chat_events_chat_seq ON chat_events(chat_id, seq);

CREATE TABLE IF NOT EXISTS chat_queued_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_queued_messages_chat_status_created
  ON chat_queued_messages(chat_id, status, created_at);
`;

export const MIGRATION_V9_SQL = `
CREATE TABLE IF NOT EXISTS workspace_chat_defaults (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  model TEXT,
  system_prompt TEXT,
  mcp_overlay_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export const MIGRATION_V10_SQL = `
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  message_seq INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner
  ON attachments(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_attachments_owner_message_seq
  ON attachments(owner_kind, owner_id, message_seq);
`;

export const MIGRATION_V10_RUN_QUEUE_SQL = `
ALTER TABLE run_queued_messages ADD COLUMN attachments_json TEXT;
`;

export const MIGRATION_V10_CHAT_QUEUE_SQL = `
ALTER TABLE chat_queued_messages ADD COLUMN attachments_json TEXT;
`;

export const MIGRATION_V11_SQL = `
ALTER TABLE chat_sessions ADD COLUMN title_source TEXT;
`;

/** Nullable per-run model override; null = use automation model. */
export const MIGRATION_V12_SQL = `
ALTER TABLE runs ADD COLUMN model TEXT;
`;

/**
 * Canonical model parameter JSON beside existing model ID columns.
 * Empty/id-only selections store NULL; no backfill of existing rows.
 */
export const MIGRATION_V13_AUTOMATIONS_SQL = `
ALTER TABLE automations ADD COLUMN model_params_json TEXT;
`;

export const MIGRATION_V13_RUNS_SQL = `
ALTER TABLE runs ADD COLUMN model_params_json TEXT;
`;

export const MIGRATION_V13_CHAT_SESSIONS_SQL = `
ALTER TABLE chat_sessions ADD COLUMN model_params_json TEXT;
`;

export const MIGRATION_V13_WORKSPACE_CHAT_DEFAULTS_SQL = `
ALTER TABLE workspace_chat_defaults ADD COLUMN model_params_json TEXT;
`;

/**
 * Durable pipeline identity + immutable chain context (b36).
 * Nullable; no backfill. No FK on chain_root_run_id.
 */
export const MIGRATION_V14_CHAIN_ROOT_RUN_ID_SQL = `
ALTER TABLE runs ADD COLUMN chain_root_run_id TEXT;
`;

export const MIGRATION_V14_CHAIN_DEPTH_SQL = `
ALTER TABLE runs ADD COLUMN chain_depth INTEGER;
`;

export const MIGRATION_V14_CHAIN_MAX_DEPTH_SQL = `
ALTER TABLE runs ADD COLUMN chain_max_depth INTEGER;
`;

export const MIGRATION_V14_CHAIN_CONTEXT_JSON_SQL = `
ALTER TABLE runs ADD COLUMN chain_context_json TEXT;
`;

/**
 * Run-scoped chain control + transition claim, and automation model role (b36.02a).
 * Nullable; no backfill. Origin stays app-enforced.
 */
export const MIGRATION_V15_CHAIN_STOP_REQUESTED_AT_SQL = `
ALTER TABLE runs ADD COLUMN chain_stop_requested_at TEXT;
`;

export const MIGRATION_V15_CHAIN_STOP_REASON_SQL = `
ALTER TABLE runs ADD COLUMN chain_stop_reason TEXT;
`;

export const MIGRATION_V15_CHAIN_MAX_DEPTH_OVERRIDE_SQL = `
ALTER TABLE runs ADD COLUMN chain_max_depth_override INTEGER;
`;

export const MIGRATION_V15_CHAIN_HANDLED_AT_SQL = `
ALTER TABLE runs ADD COLUMN chain_handled_at TEXT;
`;

export const MIGRATION_V15_AUTOMATIONS_MODEL_ROLE_SQL = `
ALTER TABLE automations ADD COLUMN model_role TEXT;
`;

/**
 * Agent-generated run identity + outcome summary (b40.02).
 * Nullable; no backfill. Written once after terminal settlement.
 */
export const MIGRATION_V16_RUNS_TITLE_SQL = `
ALTER TABLE runs ADD COLUMN title TEXT;
`;

export const MIGRATION_V16_RUNS_SUMMARY_SQL = `
ALTER TABLE runs ADD COLUMN summary TEXT;
`;

/**
 * Parallel-wave identity on runs + durable wave/track tables (b36.06).
 * Nullable run columns; no backfill.
 */
export const MIGRATION_V17_PIPELINE_WAVE_ID_SQL = `
ALTER TABLE runs ADD COLUMN pipeline_wave_id TEXT;
`;

export const MIGRATION_V17_PIPELINE_TRACK_ID_SQL = `
ALTER TABLE runs ADD COLUMN pipeline_track_id TEXT;
`;

export const MIGRATION_V17_EXECUTION_CWD_SQL = `
ALTER TABLE runs ADD COLUMN execution_cwd TEXT;
`;

export const MIGRATION_V17_PIPELINE_WAVES_SQL = `
CREATE TABLE IF NOT EXISTS pipeline_waves (
  id TEXT PRIMARY KEY,
  root_run_id TEXT NOT NULL,
  coordinator_run_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  integration_run_id TEXT,
  join_claimed_at TEXT,
  finalized_at TEXT,
  blocked_code TEXT,
  blocked_detail TEXT,
  cleanup_state TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(root_run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_waves_root_status
  ON pipeline_waves(root_run_id, status);
CREATE INDEX IF NOT EXISTS idx_pipeline_waves_status
  ON pipeline_waves(status);
`;

export const MIGRATION_V17_PIPELINE_TRACKS_SQL = `
CREATE TABLE IF NOT EXISTS pipeline_tracks (
  id TEXT PRIMARY KEY,
  wave_id TEXT NOT NULL REFERENCES pipeline_waves(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  phase_ref TEXT NOT NULL,
  phase_file TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL,
  planner_run_id TEXT,
  terminal_run_id TEXT,
  head_commit TEXT,
  blocked_detail TEXT,
  integrated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(wave_id, phase_ref),
  UNIQUE(wave_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_tracks_wave_status
  ON pipeline_tracks(wave_id, status);
`;

/**
 * Optional structured metadata on input requests (b45.04).
 * Nullable; no backfill of historical rows.
 */
export const MIGRATION_V18_INPUT_METADATA_SQL = `
ALTER TABLE input_requests ADD COLUMN metadata_json TEXT;
`;

export const MIGRATION_V19_FEATURE_QUEUE_SQL = `
CREATE TABLE IF NOT EXISTS feature_queue_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feature_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  after_json TEXT NOT NULL DEFAULT '[]',
  kickoff_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  run_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  settled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feature_queue_workspace_state
  ON feature_queue_entries(workspace_id, state);
`;

export const MIGRATION_V20_FEATURE_QUEUE_DIGEST_SQL = `
ALTER TABLE feature_queue_entries ADD COLUMN batch_digest_at TEXT;
`;

export const MIGRATION_V21_CHAT_ATTACHED_RUN_SQL = `
ALTER TABLE chat_sessions ADD COLUMN attached_run_id TEXT REFERENCES runs(id);
`;
