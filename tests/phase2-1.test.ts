import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
});

describe("run state transitions", () => {
  it("allows only valid state-machine transitions", async () => {
    const { assertTransition, canTransition } = await import(
      "../packages/daemon/src/runs/state-machine.ts"
    );

    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("queued", "completed")).toBe(false);
    expect(() => assertTransition("completed", "needs_input")).toThrow(
      "Invalid run transition"
    );
  });
});

describe("automation config validation", () => {
  it("validates entries and skips invalid automation fixtures", async () => {
    const { validateAutomationEntries } = await import(
      "../packages/daemon/src/config/parse.ts"
    );
    const warnings: string[] = [];

    const valid = validateAutomationEntries(
      "automations.yaml",
      [
        {
          name: "Manual",
          trigger: { type: "manual" },
          prompt: "Say hello",
        },
        {
          trigger: { type: "manual" },
          prompt: "Missing a name",
        },
      ],
      { onWarning: (message) => warnings.push(message) }
    );

    expect(valid).toHaveLength(1);
    expect(valid[0].name).toBe("Manual");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("name");
  });

  it("falls back to a name-derived config key when no id is present", async () => {
    const { configKeyForEntry } = await import(
      "../packages/daemon/src/config/parse.ts"
    );

    expect(
      configKeyForEntry("C:/repo/.cursor/automations/sample.yaml", {
        name: "Nightly Review!",
        trigger: { type: "manual" },
        prompt: "Review",
      }, 0)
    ).toBe("sample:nightly-review");
  });

  it("tolerates unknown top-level config keys instead of rejecting the file", async () => {
    const {
      globalConfigYamlSchema,
      workspaceAutomationsYamlSchema,
    } = await import("../packages/shared/src/schemas/config.ts");

    const global = globalConfigYamlSchema.safeParse({
      workspaces: ["/repo"],
      automations: [],
      version: 2,
    });
    const workspace = workspaceAutomationsYamlSchema.safeParse({
      automations: [],
      notes: "ignore me",
    });

    expect(global.success).toBe(true);
    expect(workspace.success).toBe(true);
  });
});

describe("automation archival", () => {
  it("archives renamed automation rows without deleting run history", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-phase-2-1-"));
    const workspace = join(testHome, "workspace");

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
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

    const automationFile = join(workspaceAutomationsDir(workspace), "jobs.yaml");
    writeFileSync(
      automationFile,
      `automations:\n  - name: Original Name\n    enabled: true\n    trigger:\n      type: manual\n    prompt: Run it\n`,
      "utf8"
    );

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      reconcileConfig(db);
      const first = db
        .prepare("SELECT id FROM automations WHERE archived_at IS NULL")
        .get() as { id: string };
      const runId = "run-history-survives";
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind)
         SELECT ?, id, workspace_id, 'completed', 'manual' FROM automations WHERE id = ?`
      ).run(runId, first.id);
      db.prepare(
        `INSERT INTO run_events (run_id, seq, event_type, payload)
         VALUES (?, 1, 'assistant', '{}')`
      ).run(runId);

      writeFileSync(
        automationFile,
        `automations:\n  - name: Renamed Automation\n    enabled: true\n    trigger:\n      type: manual\n    prompt: Run it\n`,
        "utf8"
      );
      reconcileConfig(db);

      const oldAutomation = db
        .prepare("SELECT archived_at, enabled FROM automations WHERE id = ?")
        .get(first.id) as { archived_at: string | null; enabled: number };
      const runCount = db
        .prepare("SELECT COUNT(*) AS n FROM runs WHERE id = ?")
        .get(runId) as { n: number };
      const eventCount = db
        .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?")
        .get(runId) as { n: number };
      const activeCount = db
        .prepare("SELECT COUNT(*) AS n FROM automations WHERE archived_at IS NULL")
        .get() as { n: number };

      expect(oldAutomation.archived_at).toBeTruthy();
      expect(oldAutomation.enabled).toBe(0);
      expect(runCount.n).toBe(1);
      expect(eventCount.n).toBe(1);
      expect(activeCount.n).toBe(1);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("resolves archived automations by id for the resume path", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-resume-archived-"));

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { RunStore } = await import("../packages/daemon/src/runs/store.ts");

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
      ).run(testHome);
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt,
          config_path, config_key, archived_at
        ) VALUES (
          'auto', 'ws', 'Archived', 0, 'backlog', '{"type":"manual"}', 'Run',
          'config.yaml', 'auto', datetime('now')
        )`
      ).run();

      const store = new RunStore(db);

      expect(store.getAutomation("auto")).toBeUndefined();
      const resumable = store.getAutomationByIdIncludingArchived("auto");
      expect(resumable?.name).toBe("Archived");
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("operator answer follow-up streaming", () => {
  it("streams follow-up events and drives the run terminal", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-follow-up-"));

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { RunEngine } = await import(
      "../packages/daemon/src/runs/engine.ts"
    );

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
      ).run(testHome);
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
        ) VALUES (
          'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Run', 'config.yaml', 'auto'
        )`
      ).run();
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind)
         VALUES ('run', 'auto', 'ws', 'running', 'manual')`
      ).run();

      const nextRun = {
        kind: "sdk-local",
        agentId: "agent-2",
        sdkRunId: "sdk-2",
        async *stream() {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "done" }] },
          };
        },
        wait: async () => ({ status: "finished", result: "done" }),
        cancel: async () => undefined,
        dispose: async () => undefined,
      };
      const initialRun = {
        kind: "sdk-local",
        agentId: "agent-1",
        sdkRunId: "sdk-1",
        async *stream() {
          return;
        },
        wait: async () => ({ status: "finished", result: null }),
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => nextRun,
      };

      const engine = new RunEngine(db, {
        apiKey: "test",
        executor: {} as never,
        inputHub: {} as never,
      });
      const internals = engine as unknown as {
        activeRuns: Map<string, unknown>;
        inFlight: Map<string, AbortController>;
        deliverAnswerFollowUp(runId: string, answer: string): Promise<void>;
      };
      internals.activeRuns.set("run", initialRun);
      internals.inFlight.set("run", new AbortController());

      await internals.deliverAnswerFollowUp("run", "yes");

      const row = db
        .prepare("SELECT status, agent_id, sdk_run_id FROM runs WHERE id = 'run'")
        .get() as { status: string; agent_id: string; sdk_run_id: string };
      const events = db
        .prepare("SELECT event_type FROM run_events ORDER BY seq")
        .all() as Array<{ event_type: string }>;

      expect(row.status).toBe("completed");
      expect(row.agent_id).toBe("agent-2");
      expect(row.sdk_run_id).toBe("sdk-2");
      expect(events.map((event) => event.event_type)).toEqual([
        "input.delivered",
        "assistant",
        "run.finished",
      ]);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("shutdown drain", () => {
  it("awaits in-flight run tasks and disposes handles before resolving", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-shutdown-"));

    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));

    const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
    const { RunEngine } = await import("../packages/daemon/src/runs/engine.ts");

    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
      ).run(testHome);
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
        ) VALUES (
          'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Run', 'config.yaml', 'auto'
        )`
      ).run();
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind)
         VALUES ('run', 'auto', 'ws', 'running', 'manual')`
      ).run();

      const engine = new RunEngine(db, {
        apiKey: "test",
        executor: {} as never,
        inputHub: {} as never,
      });
      const internals = engine as unknown as {
        activeRuns: Map<string, unknown>;
        inFlight: Map<string, AbortController>;
        runTasks: Set<Promise<void>>;
        store: { appendEvent(runId: string, type: string, payload: unknown): number };
      };

      let disposed = false;
      internals.inFlight.set("run", new AbortController());
      internals.activeRuns.set("run", {
        kind: "sdk-local",
        agentId: "a",
        sdkRunId: "s",
        async *stream() {},
        wait: async () => ({ status: "cancelled", result: null }),
        cancel: async () => undefined,
        dispose: async () => {
          disposed = true;
        },
      });

      let lateWriteDone = false;
      const task = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        internals.store.appendEvent("run", "run.drained", {});
        lateWriteDone = true;
      })();
      internals.runTasks.add(task);
      void task.finally(() => internals.runTasks.delete(task));

      await engine.shutdown();

      const drained = db
        .prepare(
          "SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'run' AND event_type = 'run.drained'"
        )
        .get() as { n: number };

      expect(lateWriteDone).toBe(true);
      expect(disposed).toBe(true);
      expect(internals.activeRuns.size).toBe(0);
      expect(internals.inFlight.size).toBe(0);
      expect(drained.n).toBe(1);
    } finally {
      db.close();
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
