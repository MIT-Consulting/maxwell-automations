import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import { DEFAULT_AUTOMATION_MODEL } from "@lca/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
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
  MIGRATION_V15_CHAIN_STOP_REQUESTED_AT_SQL,
  MIGRATION_V15_CHAIN_STOP_REASON_SQL,
  MIGRATION_V15_CHAIN_MAX_DEPTH_OVERRIDE_SQL,
  MIGRATION_V15_CHAIN_HANDLED_AT_SQL,
  MIGRATION_V15_AUTOMATIONS_MODEL_ROLE_SQL,
  MIGRATION_V16_RUNS_TITLE_SQL,
  SCHEMA_VERSION,
} from "../packages/daemon/src/db/schema.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { generateRunMetadata } from "../packages/daemon/src/runs/auto-metadata.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import type {
  ActiveRun,
  Executor,
} from "../packages/daemon/src/executor/types.ts";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

afterEach(() => {
  vi.restoreAllMocks();
});

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

function until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
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

/** Realistic pre-v16 (v15) database without opening via openDatabase. */
function openV15Database(dbPath: string) {
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

  if (!hasColumn(db, "runs", "chain_stop_requested_at")) {
    db.exec(MIGRATION_V15_CHAIN_STOP_REQUESTED_AT_SQL);
  }
  if (!hasColumn(db, "runs", "chain_stop_reason")) {
    db.exec(MIGRATION_V15_CHAIN_STOP_REASON_SQL);
  }
  if (!hasColumn(db, "runs", "chain_max_depth_override")) {
    db.exec(MIGRATION_V15_CHAIN_MAX_DEPTH_OVERRIDE_SQL);
  }
  if (!hasColumn(db, "runs", "chain_handled_at")) {
    db.exec(MIGRATION_V15_CHAIN_HANDLED_AT_SQL);
  }
  if (!hasColumn(db, "automations", "model_role")) {
    db.exec(MIGRATION_V15_AUTOMATIONS_MODEL_ROLE_SQL);
  }
  db.prepare("INSERT INTO schema_migrations (version) VALUES (15)").run();
  expect(schemaVersion(db)).toBe(15);
  return db;
}

function seedWorkspaceAndAuto(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  autoName = "Automation"
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
  ).run(workspace);
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt,
      config_path, config_key
    ) VALUES (
      'auto', 'ws', ?, 1, 'enabled', '{"type":"manual"}', 'Automation prompt',
      'config.yaml', 'auto'
    )`
  ).run(autoName);
}

function insertRun(
  db: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    status: string;
    prompt?: string | null;
    title?: string | null;
    summary?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, title, summary
    ) VALUES (
      @runId, 'auto', 'ws', @status, 'manual', @prompt, @title, @summary
    )`
  ).run({
    runId: input.runId,
    status: input.status,
    prompt: input.prompt ?? "Stored prompt",
    title: input.title ?? null,
    summary: input.summary ?? null,
  });
}

function inputHubFor(db: ReturnType<typeof openDatabase>): InputHub {
  return new InputHub(new InputStore(db), {
    onNeedsInput: () => undefined,
    onAnswered: () => undefined,
  });
}

function makeQuickExecutor(result = "done"): Executor {
  const active: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-meta",
    sdkRunId: "sdk-meta",
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "working" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return {
    kind: "sdk-local",
    spawn: async () => active,
    resume: async () => active,
  };
}

function makeFailingExecutor(message: string): Executor {
  const active: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-fail",
    sdkRunId: "sdk-fail",
    async *stream() {},
    wait: async () => ({ status: "error", result: message }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return {
    kind: "sdk-local",
    spawn: async () => active,
    resume: async () => active,
  };
}

describe("b40 schema v16 migration", () => {
  it("opens fresh databases at SCHEMA_VERSION with nullable title/summary", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b40-fresh-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "runs", "title")).toBe(true);
      expect(hasColumn(db, "runs", "summary")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("upgrades v15 to v16 without altering an existing run", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b40-v15-"));
    const dbPath = join(root, "state.sqlite");
    const db = openV15Database(dbPath);
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
        id, automation_id, workspace_id, status, prompt
      ) VALUES ('run1', 'auto', 'ws', 'completed', 'kept prompt')`
    ).run();

    try {
      expect(hasColumn(db, "runs", "title")).toBe(false);
      expect(hasColumn(db, "runs", "summary")).toBe(false);
      const before = db
        .prepare(`SELECT status, prompt FROM runs WHERE id = 'run1'`)
        .get() as { status: string; prompt: string };

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "runs", "title")).toBe(true);
      expect(hasColumn(db, "runs", "summary")).toBe(true);

      const after = db
        .prepare(
          `SELECT status, prompt, title, summary FROM runs WHERE id = 'run1'`
        )
        .get() as {
        status: string;
        prompt: string;
        title: string | null;
        summary: string | null;
      };
      expect(after.status).toBe(before.status);
      expect(after.prompt).toBe(before.prompt);
      expect(after.title).toBeNull();
      expect(after.summary).toBeNull();

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles a partially present title column and remains idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b40-partial-"));
    const dbPath = join(root, "state.sqlite");
    const db = openV15Database(dbPath);
    try {
      db.exec(MIGRATION_V16_RUNS_TITLE_SQL);
      expect(hasColumn(db, "runs", "title")).toBe(true);
      expect(hasColumn(db, "runs", "summary")).toBe(false);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(hasColumn(db, "runs", "title")).toBe(true);
      expect(hasColumn(db, "runs", "summary")).toBe(true);
      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b40 generateRunMetadata", () => {
  it("returns normalized title/summary from a finished JSON result", async () => {
    const promptSpy = vi.spyOn(Agent, "prompt").mockResolvedValue({
      status: "finished",
      result: '  {"title": "  Fixed flaky auth  ", "summary": "  Retry loop closed.  "}  ',
    } as never);

    const root = mkdtempSync(join(tmpdir(), "lca-b40-gen-"));
    try {
      const meta = await generateRunMetadata({
        apiKey: "test-key",
        cwd: root,
        automationName: "Auth Fixer",
        status: "completed",
        prompt: "Fix the flaky auth test",
        outcomeEvidence: "All green",
      });
      expect(meta).toEqual({
        title: "Fixed flaky auth",
        summary: "Retry loop closed.",
      });
      expect(promptSpy).toHaveBeenCalledOnce();
      const [promptText, opts] = promptSpy.mock.calls[0]!;
      expect(opts).toMatchObject({
        apiKey: "test-key",
        model: { id: DEFAULT_AUTOMATION_MODEL },
        local: { cwd: root, settingSources: ["all"] },
      });
      expect(String(promptText)).toMatch(/READ-ONLY/i);
      expect(String(promptText)).toMatch(/JSON object/i);
      expect(String(promptText)).toContain("Fix the flaky auth test");
      expect(String(promptText)).toContain("All green");
      expect(String(promptText)).toMatch(/successful outcome/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts fenced JSON, enforces length caps, and bounds evidence", async () => {
    const longTitle = "word ".repeat(40).trim();
    const longSummary = "detail ".repeat(80).trim();
    const huge = "x".repeat(5000);
    vi.spyOn(Agent, "prompt").mockImplementation(async (prompt) => {
      expect(String(prompt)).toContain("truncated");
      expect(String(prompt)).not.toContain(huge);
      return {
        status: "finished",
        result: `\`\`\`json\n{"title":${JSON.stringify(longTitle)},"summary":${JSON.stringify(longSummary)}}\n\`\`\``,
      } as never;
    });

    const root = mkdtempSync(join(tmpdir(), "lca-b40-fence-"));
    try {
      const meta = await generateRunMetadata({
        apiKey: "k",
        cwd: root,
        automationName: "A",
        status: "failed",
        prompt: huge,
        outcomeEvidence: huge,
      });
      expect(meta).not.toBeNull();
      expect(meta!.title.length).toBeLessThanOrEqual(56);
      expect(meta!.summary.length).toBeLessThanOrEqual(180);
      expect(meta!.title).not.toContain("\n");
      expect(meta!.summary).not.toContain("\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null for thrown, non-finished, malformed, blank, and partial results", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b40-null-"));
    const cases: Array<() => void> = [
      () =>
        vi.spyOn(Agent, "prompt").mockRejectedValue(new Error("sdk down")),
      () =>
        vi.spyOn(Agent, "prompt").mockResolvedValue({
          status: "error",
          result: '{"title":"T","summary":"S"}',
        } as never),
      () =>
        vi.spyOn(Agent, "prompt").mockResolvedValue({
          status: "finished",
          result: "not-json",
        } as never),
      () =>
        vi.spyOn(Agent, "prompt").mockResolvedValue({
          status: "finished",
          result: '{"title":"","summary":"S"}',
        } as never),
      () =>
        vi.spyOn(Agent, "prompt").mockResolvedValue({
          status: "finished",
          result: '{"title":"T only"}',
        } as never),
      () =>
        vi.spyOn(Agent, "prompt").mockResolvedValue({
          status: "finished",
          result: 42,
        } as never),
    ];

    try {
      for (const setup of cases) {
        vi.restoreAllMocks();
        setup();
        const meta = await generateRunMetadata({
          apiKey: "k",
          cwd: root,
          automationName: "A",
          status: "completed",
          prompt: "p",
          outcomeEvidence: "o",
        });
        expect(meta).toBeNull();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b40 setRunMetadataIfEligible", () => {
  it("writes atomically for completed/failed and rejects ineligible/overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b40-store-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const store = new RunStore(db);
    try {
      seedWorkspaceAndAuto(db, join(root, "workspace"));
      insertRun(db, { runId: "c", status: "completed" });
      insertRun(db, { runId: "f", status: "failed" });
      insertRun(db, { runId: "r", status: "running" });
      insertRun(db, { runId: "x", status: "cancelled" });

      expect(
        store.setRunMetadataIfEligible("c", {
          title: " Completed title ",
          summary: " Completed summary ",
        })
      ).toBe(true);
      expect(
        store.setRunMetadataIfEligible("f", {
          title: "Failed title",
          summary: "Failed summary",
        })
      ).toBe(true);
      expect(
        store.setRunMetadataIfEligible("r", {
          title: "Nope",
          summary: "Nope",
        })
      ).toBe(false);
      expect(
        store.setRunMetadataIfEligible("x", {
          title: "Nope",
          summary: "Nope",
        })
      ).toBe(false);
      expect(
        store.setRunMetadataIfEligible("c", {
          title: "Overwrite",
          summary: "Overwrite",
        })
      ).toBe(false);
      expect(store.setRunMetadataIfEligible("c", { title: "  ", summary: "S" })).toBe(
        false
      );

      const completed = store.getRun("c")!;
      expect(completed.title).toBe("Completed title");
      expect(completed.summary).toBe("Completed summary");
      const running = store.getRun("r")!;
      expect(running.title).toBeNull();
      expect(running.summary).toBeNull();
      expect(store.listRunEvents("c")).toHaveLength(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b40 engine metadata lifecycle", () => {
  it("settles completed runs before deferred metadata persists + emits once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const promptSpy = vi.spyOn(Agent, "prompt").mockImplementation(async () => {
      await gate;
      return {
        status: "finished",
        result: '{"title":"Named Complete","summary":"All assertions passed."}',
      } as never;
    });

    const root = mkdtempSync(join(tmpdir(), "lca-b40-eng-ok-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const engine = new RunEngine(db, {
      apiKey: "eng-key",
      executor: makeQuickExecutor("finished result text"),
      inputHub: inputHubFor(db),
      events,
    });

    try {
      seedWorkspaceAndAuto(db, join(root, "workspace"), "CI Auto");
      // seed placeholder deleted after insert pattern from b4
      insertRun(db, { runId: "placeholder", status: "completed" });
      db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

      const runId = await engine.triggerRun("auto");
      await until(
        () =>
          (db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
            | { status: string }
            | undefined)?.status === "completed"
      );

      const mid = db
        .prepare("SELECT title, summary, status FROM runs WHERE id = ?")
        .get(runId) as {
        title: string | null;
        summary: string | null;
        status: string;
      };
      expect(mid.status).toBe("completed");
      expect(mid.title).toBeNull();
      expect(mid.summary).toBeNull();
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND event_type = 'run.finished'"
            )
            .get(runId) as { n: number }
        ).n
      ).toBe(1);

      release();
      await until(() => {
        const row = db
          .prepare("SELECT title FROM runs WHERE id = ?")
          .get(runId) as { title: string | null };
        return row.title === "Named Complete";
      });

      const final = db
        .prepare("SELECT title, summary, status FROM runs WHERE id = ?")
        .get(runId) as {
        title: string;
        summary: string;
        status: string;
      };
      expect(final.status).toBe("completed");
      expect(final.summary).toBe("All assertions passed.");
      const metaEvents = db
        .prepare(
          "SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'run.metadata'"
        )
        .all(runId) as Array<{ payload: string }>;
      expect(metaEvents).toHaveLength(1);
      expect(JSON.parse(metaEvents[0]!.payload)).toEqual({
        title: "Named Complete",
        summary: "All assertions passed.",
      });
      expect(promptSpy).toHaveBeenCalled();
      const promptArg = String(promptSpy.mock.calls[0]![0]);
      expect(promptArg).toContain("finished result text");
    } finally {
      release();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("names failed runs from run.error evidence and skips cancelled", async () => {
    const promptSpy = vi.spyOn(Agent, "prompt").mockResolvedValue({
      status: "finished",
      result: '{"title":"Spawn blew up","summary":"Missing credentials."}',
    } as never);

    const root = mkdtempSync(join(tmpdir(), "lca-b40-eng-fail-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const failEngine = new RunEngine(db, {
      apiKey: "eng-key",
      executor: makeFailingExecutor("Missing credentials."),
      inputHub: inputHubFor(db),
      events,
    });

    try {
      seedWorkspaceAndAuto(db, join(root, "workspace"));
      insertRun(db, { runId: "placeholder", status: "completed" });
      db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

      const failedId = await failEngine.triggerRun("auto");
      await until(() => {
        const row = db
          .prepare("SELECT title, status FROM runs WHERE id = ?")
          .get(failedId) as { title: string | null; status: string };
        return row.status === "failed" && row.title === "Spawn blew up";
      });
      expect(promptSpy.mock.calls.some((c) => String(c[0]).includes("Missing credentials"))).toBe(
        true
      );
      const failedMetaEvents = db
        .prepare(
          "SELECT payload FROM run_events WHERE run_id = ? AND event_type = 'run.metadata'"
        )
        .all(failedId) as Array<{ payload: string }>;
      expect(failedMetaEvents).toHaveLength(1);
      expect(JSON.parse(failedMetaEvents[0]!.payload)).toEqual({
        title: "Spawn blew up",
        summary: "Missing credentials.",
      });
      expect(
        (
          db
            .prepare("SELECT summary FROM runs WHERE id = ?")
            .get(failedId) as { summary: string | null }
        ).summary
      ).toBe("Missing credentials.");

      const cancelId = cryptoRandom();
      db.prepare(
        `INSERT INTO runs (
          id, automation_id, workspace_id, status, trigger_kind, prompt
        ) VALUES (?, 'auto', 'ws', 'queued', 'manual', 'cancel me')`
      ).run(cancelId);
      const callsBeforeCancel = promptSpy.mock.calls.length;
      await failEngine.cancelRun(cancelId);
      await new Promise((r) => setTimeout(r, 80));
      expect(promptSpy.mock.calls.length).toBe(callsBeforeCancel);
      const cancelled = db
        .prepare("SELECT status, title, summary FROM runs WHERE id = ?")
        .get(cancelId) as {
        status: string;
        title: string | null;
        summary: string | null;
      };
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.title).toBeNull();
      expect(cancelled.summary).toBeNull();
    } finally {
      await failEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generator failure leaves settlement intact; concurrent entry does not duplicate", async () => {
    const promptSpy = vi
      .spyOn(Agent, "prompt")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({
        status: "finished",
        result: '{"title":"Once","summary":"Only once."}',
      } as never);

    const root = mkdtempSync(join(tmpdir(), "lca-b40-eng-dup-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const engine = new RunEngine(db, {
      apiKey: "eng-key",
      executor: makeQuickExecutor("ok"),
      inputHub: inputHubFor(db),
      events,
    });

    try {
      seedWorkspaceAndAuto(db, join(root, "workspace"));
      insertRun(db, { runId: "placeholder", status: "completed" });
      db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

      const failGenId = await engine.triggerRun("auto");
      await until(
        () =>
          (db.prepare("SELECT status FROM runs WHERE id = ?").get(failGenId) as
            | { status: string }
            | undefined)?.status === "completed"
      );
      await until(() => promptSpy.mock.calls.length >= 1);
      await new Promise((r) => setTimeout(r, 50));
      const failedGen = db
        .prepare("SELECT status, title, summary FROM runs WHERE id = ?")
        .get(failGenId) as {
        status: string;
        title: string | null;
        summary: string | null;
      };
      expect(failedGen.status).toBe("completed");
      expect(failedGen.title).toBeNull();
      expect(failedGen.summary).toBeNull();
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND event_type = 'run.metadata'"
            )
            .get(failGenId) as { n: number }
        ).n
      ).toBe(0);

      const okId = await engine.triggerRun("auto");
      await until(() => {
        const row = db
          .prepare("SELECT title FROM runs WHERE id = ?")
          .get(okId) as { title: string | null };
        return row.title === "Once";
      });
      // Force another deferred schedule by flipping null via SQL and re-entering
      // is not allowed to overwrite; call setRunMetadataIfEligible again.
      const store = new RunStore(db, events);
      expect(
        store.setRunMetadataIfEligible(okId, {
          title: "Twice",
          summary: "No overwrite",
        })
      ).toBe(false);
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND event_type = 'run.metadata'"
            )
            .get(okId) as { n: number }
        ).n
      ).toBe(1);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b40 REST metadata surface", () => {
  it("exposes null then persisted title/summary on list and detail", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b40-rest-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const dash = new DashboardStore(db);
    const engine = new RunEngine(db, {
      apiKey: "k",
      executor: makeQuickExecutor(),
      inputHub: inputHubFor(db),
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "k",
      executor: makeQuickExecutor(),
      events,
    });
    const port = await freeListenPort();
    const server = await startHttpServer({
      engine,
      chatEngine,
      store: dash,
      db,
      events,
      apiKey: "k",
      port,
      settings: DEFAULT_SETTINGS,
      listModels: async () => [],
    });

    try {
      seedWorkspaceAndAuto(db, join(root, "workspace"));
      insertRun(db, { runId: "run-rest", status: "completed" });

      const listBefore = await fetch(`http://127.0.0.1:${port}/api/runs`).then(
        (r) => r.json()
      );
      const listed = (listBefore as { runs: Array<Record<string, unknown>> }).runs.find(
        (r) => r.id === "run-rest"
      );
      expect(listed?.title).toBeNull();
      expect(listed?.summary).toBeNull();

      const detailBefore = await fetch(
        `http://127.0.0.1:${port}/api/runs/run-rest`
      ).then((r) => r.json());
      expect((detailBefore as { run: Record<string, unknown> }).run.title).toBeNull();

      expect(
        store.setRunMetadataIfEligible("run-rest", {
          title: "REST Title",
          summary: "REST Summary",
        })
      ).toBe(true);

      const mapped = dash.getRun("run-rest");
      expect(mapped?.title).toBe("REST Title");
      expect(mapped?.summary).toBe("REST Summary");
      expect(dash.listRuns().find((r) => r.id === "run-rest")?.summary).toBe(
        "REST Summary"
      );

      const listAfter = await fetch(`http://127.0.0.1:${port}/api/runs`).then(
        (r) => r.json()
      );
      const listedAfter = (
        listAfter as { runs: Array<Record<string, unknown>> }
      ).runs.find((r) => r.id === "run-rest");
      expect(listedAfter?.title).toBe("REST Title");
      expect(listedAfter?.summary).toBe("REST Summary");

      const detailAfter = await fetch(
        `http://127.0.0.1:${port}/api/runs/run-rest`
      ).then((r) => r.json());
      expect((detailAfter as { run: Record<string, unknown> }).run.title).toBe(
        "REST Title"
      );
      expect((detailAfter as { run: Record<string, unknown> }).run.summary).toBe(
        "REST Summary"
      );
    } finally {
      await server.close();
      await engine.shutdown();
      await chatEngine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function cryptoRandom(): string {
  return `run-${Math.random().toString(16).slice(2)}`;
}
