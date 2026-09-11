import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatStatus } from "@lca/shared";
import { ChatStore } from "../packages/daemon/src/chats/store.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { migrate } from "../packages/daemon/src/db/migrate.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import type { DaemonEventSink } from "../packages/daemon/src/events.ts";

function tableExists(
  db: ReturnType<typeof openDatabase>,
  name: string
): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function schemaVersion(db: ReturnType<typeof openDatabase>): number {
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function seedWorkspace(db: ReturnType<typeof openDatabase>): void {
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    "/tmp/workspace"
  );
}

describe("b28.1 chat schema and store", () => {
  it("migrates to current schema idempotently with chat tables present", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-1-migrate-"));
    const dbPath = join(root, "state.sqlite");
    const db = openDatabase(dbPath);

    try {
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
      expect(tableExists(db, "chat_sessions")).toBe(true);
      expect(tableExists(db, "chat_events")).toBe(true);
      expect(tableExists(db, "chat_queued_messages")).toBe(true);
      expect(tableExists(db, "workspace_chat_defaults")).toBe(true);
      expect(tableExists(db, "attachments")).toBe(true);

      migrate(db);
      expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips chat sessions, events, status, and queued messages", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-1-store-"));
    const dbPath = join(root, "state.sqlite");
    const db = openDatabase(dbPath);

    const emittedEvents: ChatEvent[] = [];
    const emittedStatuses: Array<{ chatId: string; status: ChatStatus }> = [];
    const sink: DaemonEventSink = {
      emitRunEvent: () => undefined,
      emitRunStatus: () => undefined,
      emitChatEvent: (_chatId, event) => {
        emittedEvents.push(event);
      },
      emitChatStatus: (chatId, status) => {
        emittedStatuses.push({ chatId, status });
      },
      emitChatInputRequest: () => undefined,
    };

    try {
      seedWorkspace(db);
      const store = new ChatStore(db, sink);

      const session = store.createChatSession({ workspaceId: "ws" });
      expect(session.status).toBe("idle");
      expect(session.workspace_id).toBe("ws");

      const seq1 = store.appendEvent(session.id, "user.message", { text: "hello" });
      const seq2 = store.appendEvent(session.id, "assistant.message", { text: "hi" });
      expect(seq1).toBe(1);
      expect(seq2).toBe(2);

      const events = store.listChatEvents(session.id);
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
      expect(emittedEvents).toHaveLength(2);

      store.setStatus(session.id, "running");
      expect(store.getChatSession(session.id)?.status).toBe("running");
      expect(emittedStatuses).toEqual([{ chatId: session.id, status: "running" }]);

      const queuedId = store.enqueueQueuedMessage(session.id, "follow up");
      const pending = store.getOldestPendingQueuedMessage(session.id);
      expect(pending?.id).toBe(queuedId);

      store.markQueuedMessageDelivered(queuedId);
      expect(store.getOldestPendingQueuedMessage(session.id)).toBeUndefined();
      expect(store.cancelAllPendingQueuedMessages(session.id)).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips workspace chat defaults and clears them", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-6a-defaults-"));
    const dbPath = join(root, "state.sqlite");
    const db = openDatabase(dbPath);

    try {
      seedWorkspace(db);
      const store = new ChatStore(db);

      expect(store.getWorkspaceChatDefaults("ws")).toBeUndefined();

      store.upsertWorkspaceChatDefaults("ws", {
        model: "composer-2.5",
        systemPrompt: "Be concise.",
        mcpOverlayJson: JSON.stringify({ extra: { foo: { type: "stdio" } } }),
      });

      const row = store.getWorkspaceChatDefaults("ws");
      expect(row?.model).toBe("composer-2.5");
      expect(row?.system_prompt).toBe("Be concise.");
      expect(JSON.parse(row!.mcp_overlay_json)).toEqual({
        extra: { foo: { type: "stdio" } },
      });

      store.upsertWorkspaceChatDefaults("ws", { model: null });
      const partial = store.getWorkspaceChatDefaults("ws");
      expect(partial?.model).toBeNull();
      expect(partial?.system_prompt).toBe("Be concise.");

      store.clearWorkspaceChatDefaults("ws");
      expect(store.getWorkspaceChatDefaults("ws")).toBeUndefined();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
