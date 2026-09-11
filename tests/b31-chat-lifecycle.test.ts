import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveHeuristicTitle,
  shouldRefineWithLlm,
} from "../packages/daemon/src/chats/auto-title.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { ChatStore } from "../packages/daemon/src/chats/store.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import type { DaemonEventSink } from "../packages/daemon/src/events.ts";
import type {
  ActiveRun,
  Executor,
} from "../packages/daemon/src/executor/types.ts";

function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
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

function seedWorkspace(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  workspaceId = "ws"
): void {
  mkdirSync(workspace, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run(workspaceId, workspace);
}

function makeSimpleExecutor(): Executor {
  const makeRun = (agentId: string, sdkRunId: string): ActiveRun => ({
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result: "done" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
    sendFollowUp: async () => makeRun(agentId, `${sdkRunId}-follow`),
  });
  return {
    kind: "sdk-local",
    spawn: async () => makeRun("agent-1", "sdk-1"),
    resume: async () => makeRun("agent-1", "sdk-2"),
  };
}

function silentSink(): DaemonEventSink {
  return {
    emitRunEvent: () => undefined,
    emitRunStatus: () => undefined,
    emitChatEvent: () => undefined,
    emitChatStatus: () => undefined,
    emitChatInputRequest: () => undefined,
  };
}

describe("b31 auto-title heuristic", () => {
  it("returns null for empty input", () => {
    expect(deriveHeuristicTitle({})).toBeNull();
    expect(deriveHeuristicTitle({ text: "   " })).toBeNull();
  });

  it("collapses whitespace and truncates long text", () => {
    const long =
      "Fix the authentication bug in the login flow when users have expired tokens and need to refresh";
    const title = deriveHeuristicTitle({ text: long });
    expect(title).toBeTruthy();
    expect(title!.length).toBeLessThanOrEqual(56);
    expect(title).not.toMatch(/\s{2,}/);
  });

  it("falls back to attachment names", () => {
    expect(
      deriveHeuristicTitle({ text: "", attachmentNames: ["diagram.png"] })
    ).toBe("diagram.png");
    expect(
      deriveHeuristicTitle({
        text: null,
        attachmentNames: ["a.png", "b.pdf"],
      })
    ).toBe("Attachments: a.png, b.pdf");
  });

  it("shouldRefineWithLlm flags short and generic titles", () => {
    expect(shouldRefineWithLlm(null)).toBe(true);
    expect(shouldRefineWithLlm("hi")).toBe(true);
    expect(shouldRefineWithLlm("hello!")).toBe(true);
    expect(shouldRefineWithLlm("Fix login token refresh")).toBe(false);
  });
});

describe("b31 title_source and purge", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("migrates to current schema with title_source column", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b31-schema-"));
    roots.push(root);
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      const version = (
        db
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get() as { version: number }
      ).version;
      expect(version).toBe(SCHEMA_VERSION);
      const cols = db
        .prepare("PRAGMA table_info(chat_sessions)")
        .all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "title_source")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("auto-titles first message and user rename blocks later auto", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b31-autotitle-"));
    roots.push(root);
    const workspace = join(root, "ws");
    const db = openDatabase(join(root, "state.sqlite"));
    seedWorkspace(db, workspace);

    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: makeSimpleExecutor(),
      events: silentSink(),
    });

    try {
      const session = engine.createChat({ workspaceId: "ws" });
      expect(session.title).toBeNull();
      expect(session.title_source).toBeNull();

      await engine.sendMessage(
        session.id,
        "Investigate flaky CI on Windows runners"
      );
      await until(() => {
        const row = db
          .prepare("SELECT status, title, title_source FROM chat_sessions WHERE id = ?")
          .get(session.id) as {
          status: string;
          title: string | null;
          title_source: string | null;
        };
        return row.status === "idle" && !!row.title;
      });

      const afterAuto = db
        .prepare("SELECT title, title_source FROM chat_sessions WHERE id = ?")
        .get(session.id) as { title: string; title_source: string };
      expect(afterAuto.title_source).toBe("auto");
      expect(afterAuto.title.toLowerCase()).toContain("investigate");

      await engine.patchChat(session.id, { title: "My custom name" });
      const store = new ChatStore(db);
      expect(store.setAutoTitleIfEligible(session.id, "Should not win")).toBe(
        false
      );
      const locked = store.getChatSession(session.id)!;
      expect(locked.title).toBe("My custom name");
      expect(locked.title_source).toBe("user");
    } finally {
      await engine.shutdown();
      db.close();
    }
  });

  it("does not rewrite auto title on later turns", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b31-autotitle-stable-"));
    roots.push(root);
    const workspace = join(root, "ws");
    const db = openDatabase(join(root, "state.sqlite"));
    seedWorkspace(db, workspace);

    const engine = new ChatEngine(db, {
      apiKey: "test-key",
      executor: makeSimpleExecutor(),
      events: silentSink(),
    });

    try {
      const session = engine.createChat({ workspaceId: "ws" });
      await engine.sendMessage(
        session.id,
        "Investigate flaky CI on Windows runners"
      );
      await until(() => {
        const row = db
          .prepare("SELECT status, title FROM chat_sessions WHERE id = ?")
          .get(session.id) as { status: string; title: string | null };
        return row.status === "idle" && !!row.title;
      });

      const firstTitle = (
        db
          .prepare("SELECT title FROM chat_sessions WHERE id = ?")
          .get(session.id) as { title: string }
      ).title;

      await engine.sendMessage(session.id, "Also check the flaky unit tests");
      await until(() => {
        const row = db
          .prepare("SELECT status FROM chat_sessions WHERE id = ?")
          .get(session.id) as { status: string };
        return row.status === "idle";
      });
      // Allow deferred maybeAutoTitle to run (or no-op) before asserting.
      await new Promise((r) => setTimeout(r, 50));

      const secondTitle = (
        db
          .prepare("SELECT title, title_source FROM chat_sessions WHERE id = ?")
          .get(session.id) as { title: string; title_source: string }
      );
      expect(secondTitle.title_source).toBe("auto");
      expect(secondTitle.title).toBe(firstTitle);
    } finally {
      await engine.shutdown();
      db.close();
    }
  });

  it("purgeChat removes session, attachment rows, and blob directory", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b31-purge-"));
    roots.push(testHome);
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { ChatEngine: Engine } = await import(
      "../packages/daemon/src/chats/engine.ts"
    );
    const { AttachmentStore: AttStore } = await import(
      "../packages/daemon/src/attachments/store.ts"
    );
    const { writeAttachmentBlob: writeBlob, buildAttachmentOwnerDir: ownerDir } =
      await import("../packages/daemon/src/attachments/storage.ts");
    const { DEFAULT_SETTINGS: settings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    const workspace = join(testHome, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDb(join(testHome, "state.sqlite"));
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
    ).run(workspace);

    const makeRun = (): ActiveRun => ({
      kind: "sdk-local",
      agentId: "a",
      sdkRunId: "s",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
        } as never;
      },
      wait: async () => ({ status: "finished", result: "done" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
    });
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => makeRun(),
      resume: async () => makeRun(),
    };

    const engine = new Engine(db, {
      apiKey: "test-key",
      executor,
      events: silentSink(),
    });

    try {
      const session = engine.createChat({ workspaceId: "ws" });
      const written = writeBlob({
        ownerKind: "chat",
        ownerId: session.id,
        filename: "note.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("hello"),
        settings,
      });
      new AttStore(db).insertUploaded({
        id: written.id,
        ownerKind: "chat",
        ownerId: session.id,
        filename: written.filename,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
        kind: written.kind,
        storagePath: written.storagePath,
      });

      const dir = ownerDir("chat", session.id);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(written.storagePath)).toBe(true);

      const deleted = await engine.purgeChat(session.id);
      expect(deleted).toBe(true);
      expect(engine.getChat(session.id)).toBeUndefined();
      expect(new AttStore(db).listForOwner("chat", session.id)).toEqual([]);
      expect(existsSync(dir)).toBe(false);

      expect(await engine.purgeChat(session.id)).toBe(false);
    } finally {
      await engine.shutdown();
      db.close();
      vi.doUnmock("node:os");
    }
  });
});

describe("b33 archived chat data path", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("archive/unarchive round-trip preserves events and attachments", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b33-archive-"));
    roots.push(testHome);
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { openDatabase: openDb } = await import(
      "../packages/daemon/src/db/index.ts"
    );
    const { ChatEngine: Engine } = await import(
      "../packages/daemon/src/chats/engine.ts"
    );
    const { ChatStore: Store } = await import(
      "../packages/daemon/src/chats/store.ts"
    );
    const { AttachmentStore: AttStore } = await import(
      "../packages/daemon/src/attachments/store.ts"
    );
    const { writeAttachmentBlob: writeBlob } = await import(
      "../packages/daemon/src/attachments/storage.ts"
    );
    const { DEFAULT_SETTINGS: settings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    const workspace = join(testHome, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDb(join(testHome, "state.sqlite"));
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
    ).run(workspace);

    const spawn = vi.fn(async () => {
      throw new Error("SDK spawn must not run for archived chats");
    });
    const executor: Executor = {
      kind: "sdk-local",
      spawn,
      resume: async () => {
        throw new Error("SDK resume must not run for archived chats");
      },
    };

    const sessionFrames: Array<{ chatId: string; archivedAt: string | null }> =
      [];
    const engine = new Engine(db, {
      apiKey: "test-key",
      executor,
      events: {
        ...silentSink(),
        emitChatSession: (chatId, session) => {
          sessionFrames.push({ chatId, archivedAt: session.archivedAt });
        },
      },
    });
    const store = new Store(db);

    try {
      const session = engine.createChat({
        workspaceId: "ws",
        title: "Keep transcript",
      });
      store.appendEvent(session.id, "chat.message", {
        role: "user",
        text: "hello before archive",
      });
      const written = writeBlob({
        ownerKind: "chat",
        ownerId: session.id,
        filename: "note.txt",
        mimeType: "text/plain",
        bytes: Buffer.from("hello"),
        settings,
      });
      new AttStore(db).insertUploaded({
        id: written.id,
        ownerKind: "chat",
        ownerId: session.id,
        filename: written.filename,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
        kind: written.kind,
        storagePath: written.storagePath,
      });

      const archived = await engine.patchChat(session.id, { archived: true });
      expect(archived?.archivedAt).toBeTruthy();
      expect(
        engine.listWorkspaceChats("ws").some((c) => c.id === session.id)
      ).toBe(false);
      expect(
        engine.listArchivedWorkspaceChats("ws").some((c) => c.id === session.id)
      ).toBe(true);

      await expect(engine.sendMessage(session.id, "nope")).rejects.toMatchObject({
        name: "ChatMessageError",
        code: "archived",
      });
      await expect(
        engine.queueMessage(session.id, "nope")
      ).rejects.toMatchObject({ name: "ChatMessageError", code: "archived" });
      await expect(
        engine.interruptChat(session.id, "nope")
      ).rejects.toMatchObject({ name: "ChatMessageError", code: "archived" });
      expect(spawn).not.toHaveBeenCalled();
      expect(
        store.listChatEvents(session.id).filter((e) => e.event_type === "chat.message")
      ).toHaveLength(1);

      const restored = await engine.patchChat(session.id, { archived: false });
      expect(restored?.archivedAt).toBeNull();
      expect(
        sessionFrames.some(
          (f) => f.chatId === session.id && f.archivedAt === null
        )
      ).toBe(true);
      expect(
        engine.listWorkspaceChats("ws").some((c) => c.id === session.id)
      ).toBe(true);
      expect(
        engine.listArchivedWorkspaceChats("ws").some((c) => c.id === session.id)
      ).toBe(false);

      const snap = engine.getChatSnapshot(session.id)!;
      expect(snap.events.some((e) => e.eventType === "chat.message")).toBe(true);
      expect(new AttStore(db).listForOwner("chat", session.id)).toHaveLength(1);

      // Re-archive then hard-delete from archived state.
      await engine.patchChat(session.id, { archived: true });
      expect(await engine.purgeChat(session.id)).toBe(true);
      expect(engine.getChat(session.id)).toBeUndefined();
    } finally {
      await engine.shutdown();
      db.close();
      vi.doUnmock("node:os");
    }
  });

  it("archive and unarchive are idempotent at the store", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b33-store-"));
    roots.push(root);
    const workspace = join(root, "ws");
    const db = openDatabase(join(root, "state.sqlite"));
    seedWorkspace(db, workspace);
    const store = new ChatStore(db);
    try {
      const row = store.createChatSession({ workspaceId: "ws", title: "t" });
      store.archiveChatSession(row.id);
      store.archiveChatSession(row.id);
      const archived = store.getChatSession(row.id)!;
      expect(archived.archived_at).toBeTruthy();
      expect(archived.title).toBe("t");

      store.unarchiveChatSession(row.id);
      store.unarchiveChatSession(row.id);
      const active = store.getChatSession(row.id)!;
      expect(active.archived_at).toBeNull();
      expect(active.title).toBe("t");
    } finally {
      db.close();
    }
  });
});