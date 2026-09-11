import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActiveRun, Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

function seedRun(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  input: {
    runId: string;
    status: string;
    agentId?: string | null;
    sdkRunId?: string | null;
    withChildren?: boolean;
  }
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    workspace
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Original prompt',
      'config.yaml', 'auto'
    )`
  ).run();
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, agent_id, sdk_run_id
    ) VALUES (
      @runId, 'auto', 'ws', @status, 'manual', 'Stored prompt', @agentId, @sdkRunId
    )`
  ).run({
    runId: input.runId,
    status: input.status,
    agentId: input.agentId ?? null,
    sdkRunId: input.sdkRunId ?? null,
  });
  if (input.withChildren) {
    db.prepare(
      `INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, 1, 'run.finished', '{}')`
    ).run(input.runId);
    db.prepare(
      `INSERT INTO input_requests (id, run_id, question, status) VALUES (?, ?, 'test?', 'answered')`
    ).run(randomUUID(), input.runId);
  }
}

function inputHubFor(db: ReturnType<typeof openDatabase>): InputHub {
  return new InputHub(new InputStore(db), {});
}

describe("RunEngine purgeRuns", () => {
  it("deletes a completed run, cascades children, and emits runs_deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b6-purge-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const deletedEvents: string[][] = [];
    events.subscribe((msg) => {
      if (msg.type === "runs_deleted") deletedEvents.push(msg.runIds);
    });
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: { kind: "sdk-local", spawn: async () => { throw new Error("no spawn"); } },
      inputHub: inputHubFor(db),
      events,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "done-run",
        status: "completed",
        withChildren: true,
      });

      const deleted = await engine.purgeRuns(["done-run"]);

      expect(deleted).toEqual(["done-run"]);
      expect(
        db.prepare("SELECT id FROM runs WHERE id = 'done-run'").get()
      ).toBeUndefined();
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'done-run'").get() as {
          n: number;
        }
      ).toMatchObject({ n: 0 });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM input_requests WHERE run_id = 'done-run'").get() as {
          n: number;
        }
      ).toMatchObject({ n: 0 });
      expect(deletedEvents).toEqual([["done-run"]]);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips non-terminal runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b6-guard-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: { kind: "sdk-local", spawn: async () => { throw new Error("no spawn"); } },
      inputHub: inputHubFor(db),
    });

    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
        workspace
      );
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
        ) VALUES (
          'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Original prompt',
          'config.yaml', 'auto'
        )`
      ).run();
      for (const [runId, status] of [
        ["running-run", "running"],
        ["queued-run", "queued"],
        ["done-run", "completed"],
      ] as const) {
        db.prepare(
          `INSERT INTO runs (
            id, automation_id, workspace_id, status, trigger_kind, prompt
          ) VALUES (?, 'auto', 'ws', ?, 'manual', 'Stored prompt')`
        ).run(runId, status);
      }

      const deleted = await engine.purgeRuns(["running-run", "queued-run", "done-run"]);

      expect(deleted).toEqual(["done-run"]);
      expect(
        (db.prepare("SELECT status FROM runs WHERE id = 'running-run'").get() as { status: string })
          .status
      ).toBe("running");
      expect(
        (db.prepare("SELECT status FROM runs WHERE id = 'queued-run'").get() as { status: string })
          .status
      ).toBe("queued");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("disposes retained local SDK handles before deleting", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b6-retained-"));
    const db = openDatabase(join(root, "state.sqlite"));
    let disposed = false;
    const retainedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-retained",
      sdkRunId: "sdk-retained",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => {
        disposed = true;
      },
      sendFollowUp: async () => {
        throw new Error("unexpected follow-up");
      },
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
    };
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor,
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "retained-run",
        status: "completed",
        agentId: "agent-retained",
        sdkRunId: "sdk-retained",
      });

      const internals = engine as unknown as {
        retainedRuns: Map<string, { activeRun: ActiveRun; runToken: string; retainedAt: number }>;
        runTokens: Map<string, string>;
      };
      internals.retainedRuns.set("retained-run", {
        activeRun: retainedRun,
        runToken: "token-retained",
        retainedAt: Date.now(),
      });
      internals.runTokens.set("retained-run", "token-retained");

      const deleted = await engine.purgeRuns(["retained-run"]);

      expect(deleted).toEqual(["retained-run"]);
      expect(disposed).toBe(true);
      expect(internals.retainedRuns.size).toBe(0);
      expect(internals.runTokens.has("retained-run")).toBe(false);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes attachment rows and owner directory for a terminal run", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b6-purge-att-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { RunEngine: Engine } = await import(
      "../packages/daemon/src/runs/engine.ts"
    );
    const { DaemonEventBus: EventBus } = await import(
      "../packages/daemon/src/events.ts"
    );
    const { InputHub: Hub } = await import(
      "../packages/daemon/src/input/hub.ts"
    );
    const { InputStore: InStore } = await import(
      "../packages/daemon/src/input/store.ts"
    );
    const { AttachmentStore: AttStore } = await import(
      "../packages/daemon/src/attachments/store.ts"
    );
    const { writeAttachmentBlob: writeBlob, buildAttachmentOwnerDir: ownerDir } =
      await import("../packages/daemon/src/attachments/storage.ts");
    const { DEFAULT_SETTINGS: settings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    const db = openDb(join(testHome, "state.sqlite"));
    const events = new EventBus();
    const deletedEvents: string[][] = [];
    events.subscribe((msg) => {
      if (msg.type === "runs_deleted") deletedEvents.push(msg.runIds);
    });
    const engine = new Engine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("no spawn");
        },
      },
      inputHub: new Hub(new InStore(db), {}),
      events,
    });

    try {
      seedRun(db, join(testHome, "workspace"), {
        runId: "done-run",
        status: "completed",
      });
      const written = writeBlob({
        ownerKind: "run",
        ownerId: "done-run",
        filename: "note.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("hello"),
        settings,
      });
      new AttStore(db).insertUploaded({
        id: written.id,
        ownerKind: "run",
        ownerId: "done-run",
        filename: written.filename,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
        kind: written.kind,
        storagePath: written.storagePath,
      });

      const dir = ownerDir("run", "done-run");
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(written.storagePath)).toBe(true);

      const deleted = await engine.purgeRuns(["done-run"]);

      expect(deleted).toEqual(["done-run"]);
      expect(
        db.prepare("SELECT id FROM runs WHERE id = 'done-run'").get()
      ).toBeUndefined();
      expect(new AttStore(db).listForOwner("run", "done-run")).toEqual([]);
      expect(existsSync(dir)).toBe(false);
      expect(deletedEvents).toEqual([["done-run"]]);
    } finally {
      await engine.shutdown();
      db.close();
      vi.doUnmock("node:os");
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("leaves attachment state intact when skipping a non-terminal run", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b6-purge-skip-att-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { RunEngine: Engine } = await import(
      "../packages/daemon/src/runs/engine.ts"
    );
    const { InputHub: Hub } = await import(
      "../packages/daemon/src/input/hub.ts"
    );
    const { InputStore: InStore } = await import(
      "../packages/daemon/src/input/store.ts"
    );
    const { AttachmentStore: AttStore } = await import(
      "../packages/daemon/src/attachments/store.ts"
    );
    const { writeAttachmentBlob: writeBlob, buildAttachmentOwnerDir: ownerDir } =
      await import("../packages/daemon/src/attachments/storage.ts");
    const { DEFAULT_SETTINGS: settings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    const db = openDb(join(testHome, "state.sqlite"));
    const engine = new Engine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("no spawn");
        },
      },
      inputHub: new Hub(new InStore(db), {}),
    });

    try {
      seedRun(db, join(testHome, "workspace"), {
        runId: "running-run",
        status: "running",
      });
      const written = writeBlob({
        ownerKind: "run",
        ownerId: "running-run",
        filename: "note.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("keep-me"),
        settings,
      });
      new AttStore(db).insertUploaded({
        id: written.id,
        ownerKind: "run",
        ownerId: "running-run",
        filename: written.filename,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
        kind: written.kind,
        storagePath: written.storagePath,
      });

      const dir = ownerDir("run", "running-run");
      const deleted = await engine.purgeRuns(["running-run"]);

      expect(deleted).toEqual([]);
      expect(
        (db.prepare("SELECT status FROM runs WHERE id = 'running-run'").get() as {
          status: string;
        }).status
      ).toBe("running");
      expect(new AttStore(db).listForOwner("run", "running-run")).toHaveLength(1);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(written.storagePath)).toBe(true);
    } finally {
      await engine.shutdown();
      db.close();
      vi.doUnmock("node:os");
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("detaches promoted chat origin_run_id without deleting the chat", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b6-purge-promote-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("no spawn");
        },
      },
      inputHub: inputHubFor(db),
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "promoted-run",
        status: "completed",
      });
      db.prepare(
        `INSERT INTO chat_sessions (
          id, workspace_id, title, title_source, status, model, system_prompt,
          agent_id, sdk_run_id, origin_run_id
        ) VALUES (
          'chat-1', 'ws', 'Promoted', 'user', 'idle', NULL, NULL,
          NULL, NULL, 'promoted-run'
        )`
      ).run();

      const deleted = await engine.purgeRuns(["promoted-run"]);

      expect(deleted).toEqual(["promoted-run"]);
      expect(
        db.prepare("SELECT id FROM runs WHERE id = 'promoted-run'").get()
      ).toBeUndefined();
      const chat = db
        .prepare("SELECT id, origin_run_id FROM chat_sessions WHERE id = 'chat-1'")
        .get() as { id: string; origin_run_id: string | null };
      expect(chat.id).toBe("chat-1");
      expect(chat.origin_run_id).toBeNull();
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
