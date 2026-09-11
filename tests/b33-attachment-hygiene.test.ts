import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function loadWithTempHome(prefix: string) {
  const testHome = mkdtempSync(join(tmpdir(), prefix));
  vi.resetModules();
  vi.doMock("node:os", () => ({ homedir: () => testHome }));

  const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
  const { ATTACHMENTS_DIR } = await import("../packages/daemon/src/paths.ts");
  const { AttachmentStore } = await import(
    "../packages/daemon/src/attachments/store.ts"
  );
  const {
    buildAttachmentOwnerDir,
    removeAttachmentOwnerDir,
    writeAttachmentBlob,
  } = await import("../packages/daemon/src/attachments/storage.ts");
  const {
    sweepOrphanAttachments,
    startAttachmentSweepScheduler,
    ATTACHMENT_SWEEP_INTERVAL_MS,
  } = await import("../packages/daemon/src/attachments/sweep.ts");
  const { DEFAULT_SETTINGS } = await import(
    "../packages/daemon/src/config/settings.ts"
  );

  return {
    testHome,
    openDatabase,
    ATTACHMENTS_DIR,
    AttachmentStore,
    buildAttachmentOwnerDir,
    removeAttachmentOwnerDir,
    writeAttachmentBlob,
    sweepOrphanAttachments,
    startAttachmentSweepScheduler,
    ATTACHMENT_SWEEP_INTERVAL_MS,
    DEFAULT_SETTINGS,
  };
}

function seedWorkspace(
  db: import("better-sqlite3").Database,
  workspacePath: string
): void {
  mkdirSync(workspacePath, { recursive: true });
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
  ).run(workspacePath);
}

function seedAutomation(db: import("better-sqlite3").Database): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES ('auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'Run', 'c.yaml', 'auto')`
  ).run();
}

function seedRun(db: import("better-sqlite3").Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
     VALUES (?, 'auto', 'ws', 'completed', 'manual', 'Run')`
  ).run(runId);
}

function seedChat(db: import("better-sqlite3").Database, chatId: string): void {
  db.prepare(
    `INSERT INTO chat_sessions (
      id, workspace_id, title, title_source, status, model, system_prompt,
      agent_id, sdk_run_id, origin_run_id
    ) VALUES (?, 'ws', 'Chat', 'user', 'idle', NULL, NULL, NULL, NULL, NULL)`
  ).run(chatId);
}

function insertAttachmentMeta(
  store: InstanceType<
    typeof import("../packages/daemon/src/attachments/store.ts").AttachmentStore
  >,
  input: {
    id: string;
    ownerKind: "run" | "chat";
    ownerId: string;
    storagePath: string;
  }
): void {
  store.insertUploaded({
    id: input.id,
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    filename: "pixel.png",
    mimeType: "image/png",
    sizeBytes: PNG_1X1.length,
    sha256: "abc",
    kind: "image",
    storagePath: input.storagePath,
  });
}

describe("b33 orphan attachment sweep", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    vi.unmock("node:os");
    for (const root of roots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows may briefly lock WAL files */
      }
    }
  });

  it("removes ownerless run metadata and directory", async () => {
    const ctx = await loadWithTempHome("lca-b33-run-orphan-");
    roots.push(ctx.testHome);
    const db = ctx.openDatabase(join(ctx.testHome, "state.sqlite"));
    try {
      seedWorkspace(db, join(ctx.testHome, "ws"));
      seedAutomation(db);

      const written = ctx.writeAttachmentBlob({
        ownerKind: "run",
        ownerId: "missing-run",
        filename: "pixel.png",
        mimeType: "image/png",
        bytes: PNG_1X1,
        settings: ctx.DEFAULT_SETTINGS,
      });
      const store = new ctx.AttachmentStore(db);
      insertAttachmentMeta(store, {
        id: written.id,
        ownerKind: "run",
        ownerId: "missing-run",
        storagePath: written.storagePath,
      });

      const ownerDir = ctx.buildAttachmentOwnerDir("run", "missing-run");
      expect(existsSync(ownerDir)).toBe(true);

      const summary = ctx.sweepOrphanAttachments({ store });
      expect(summary.metadataRowsRemoved).toBe(1);
      expect(summary.ownerDirsRemoved).toBeGreaterThanOrEqual(1);
      expect(summary.failures).toBe(0);
      expect(store.listForOwner("run", "missing-run")).toEqual([]);
      expect(existsSync(ownerDir)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("removes ownerless chat metadata and directory", async () => {
    const ctx = await loadWithTempHome("lca-b33-chat-orphan-");
    roots.push(ctx.testHome);
    const db = ctx.openDatabase(join(ctx.testHome, "state.sqlite"));
    try {
      seedWorkspace(db, join(ctx.testHome, "ws"));

      const written = ctx.writeAttachmentBlob({
        ownerKind: "chat",
        ownerId: "missing-chat",
        filename: "pixel.png",
        mimeType: "image/png",
        bytes: PNG_1X1,
        settings: ctx.DEFAULT_SETTINGS,
      });
      const store = new ctx.AttachmentStore(db);
      insertAttachmentMeta(store, {
        id: written.id,
        ownerKind: "chat",
        ownerId: "missing-chat",
        storagePath: written.storagePath,
      });

      const ownerDir = ctx.buildAttachmentOwnerDir("chat", "missing-chat");
      expect(existsSync(ownerDir)).toBe(true);

      const summary = ctx.sweepOrphanAttachments({ store });
      expect(summary.metadataRowsRemoved).toBe(1);
      expect(summary.ownerDirsRemoved).toBeGreaterThanOrEqual(1);
      expect(summary.failures).toBe(0);
      expect(store.listForOwner("chat", "missing-chat")).toEqual([]);
      expect(existsSync(ownerDir)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("removes disk-only directory for a missing owner", async () => {
    const ctx = await loadWithTempHome("lca-b33-disk-only-");
    roots.push(ctx.testHome);
    const db = ctx.openDatabase(join(ctx.testHome, "state.sqlite"));
    try {
      seedWorkspace(db, join(ctx.testHome, "ws"));
      const store = new ctx.AttachmentStore(db);

      const ownerDir = ctx.buildAttachmentOwnerDir("run", "ghost-run");
      mkdirSync(ownerDir, { recursive: true });
      writeFileSync(join(ownerDir, "blob"), "x");
      expect(existsSync(ownerDir)).toBe(true);
      expect(store.listOrphanedOwners()).toEqual([]);

      const summary = ctx.sweepOrphanAttachments({ store });
      expect(summary.metadataRowsRemoved).toBe(0);
      expect(summary.ownerDirsRemoved).toBe(1);
      expect(summary.failures).toBe(0);
      expect(existsSync(ownerDir)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("preserves staged upload for an existing owner", async () => {
    const ctx = await loadWithTempHome("lca-b33-staged-");
    roots.push(ctx.testHome);
    const db = ctx.openDatabase(join(ctx.testHome, "state.sqlite"));
    try {
      seedWorkspace(db, join(ctx.testHome, "ws"));
      seedAutomation(db);
      seedRun(db, "live-run");

      const written = ctx.writeAttachmentBlob({
        ownerKind: "run",
        ownerId: "live-run",
        filename: "pixel.png",
        mimeType: "image/png",
        bytes: PNG_1X1,
        settings: ctx.DEFAULT_SETTINGS,
      });
      const store = new ctx.AttachmentStore(db);
      insertAttachmentMeta(store, {
        id: written.id,
        ownerKind: "run",
        ownerId: "live-run",
        storagePath: written.storagePath,
      });

      const row = store.getById("run", "live-run", written.id)!;
      expect(row.message_seq).toBeNull();

      const summary = ctx.sweepOrphanAttachments({ store });
      expect(summary.metadataRowsRemoved).toBe(0);
      expect(summary.ownerDirsRemoved).toBe(0);
      expect(store.getById("run", "live-run", written.id)).toBeTruthy();
      expect(existsSync(ctx.buildAttachmentOwnerDir("run", "live-run"))).toBe(
        true
      );
    } finally {
      db.close();
    }
  });

  it("preserves existing owner directory without metadata", async () => {
    const ctx = await loadWithTempHome("lca-b33-dir-keep-");
    roots.push(ctx.testHome);
    const db = ctx.openDatabase(join(ctx.testHome, "state.sqlite"));
    try {
      seedWorkspace(db, join(ctx.testHome, "ws"));
      seedChat(db, "live-chat");
      const store = new ctx.AttachmentStore(db);

      const ownerDir = ctx.buildAttachmentOwnerDir("chat", "live-chat");
      mkdirSync(ownerDir, { recursive: true });
      writeFileSync(join(ownerDir, "staged"), "pending");

      const summary = ctx.sweepOrphanAttachments({ store });
      expect(summary.metadataRowsRemoved).toBe(0);
      expect(summary.ownerDirsRemoved).toBe(0);
      expect(existsSync(ownerDir)).toBe(true);
      expect(existsSync(join(ownerDir, "staged"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("isolates one removal failure and continues other owners", async () => {
    const ctx = await loadWithTempHome("lca-b33-fail-iso-");
    roots.push(ctx.testHome);
    const db = ctx.openDatabase(join(ctx.testHome, "state.sqlite"));
    try {
      seedWorkspace(db, join(ctx.testHome, "ws"));
      const store = new ctx.AttachmentStore(db);

      const boomDir = ctx.buildAttachmentOwnerDir("run", "boom");
      const okDir = ctx.buildAttachmentOwnerDir("run", "ok");
      mkdirSync(boomDir, { recursive: true });
      mkdirSync(okDir, { recursive: true });
      writeFileSync(join(boomDir, "a"), "1");
      writeFileSync(join(okDir, "b"), "2");

      const logs: string[] = [];
      const summary = ctx.sweepOrphanAttachments({
        store,
        removeOwnerDir: (kind, id) => {
          if (id === "boom") {
            throw new Error("simulated remove failure");
          }
          ctx.removeAttachmentOwnerDir(kind, id);
        },
        log: (m) => logs.push(m),
      });

      expect(summary.failures).toBe(1);
      expect(summary.ownerDirsRemoved).toBe(1);
      expect(existsSync(boomDir)).toBe(true);
      expect(existsSync(okDir)).toBe(false);
      expect(logs.some((l) => l.includes("boom"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("scheduler: startup pass, 6h cadence, overlap guard, and stop", async () => {
    vi.useFakeTimers();
    const ctx = await loadWithTempHome("lca-b33-sched-");
    roots.push(ctx.testHome);
    const db = ctx.openDatabase(join(ctx.testHome, "state.sqlite"));
    let handle: { stop: () => void } | undefined;
    try {
      const store = new ctx.AttachmentStore(db);
      const calls: number[] = [];
      let releaseFirst: (() => void) | undefined;
      let pass = 0;

      handle = ctx.startAttachmentSweepScheduler({
        store,
        intervalMs: ctx.ATTACHMENT_SWEEP_INTERVAL_MS,
        sweep: () => {
          pass += 1;
          const n = pass;
          calls.push(n);
          if (n === 1) {
            return new Promise((resolve) => {
              releaseFirst = () =>
                resolve({
                  metadataRowsRemoved: 0,
                  ownerDirsRemoved: 0,
                  failures: 0,
                });
            });
          }
          return {
            metadataRowsRemoved: 0,
            ownerDirsRemoved: 0,
            failures: 0,
          };
        },
      });

      // Flush the startup microtask; first pass stays in flight until released.
      await Promise.resolve();
      expect(calls).toEqual([1]);

      // Cadence tick while first pass in flight → overlap skipped.
      await vi.advanceTimersByTimeAsync(ctx.ATTACHMENT_SWEEP_INTERVAL_MS);
      expect(calls).toEqual([1]);

      releaseFirst!();
      await Promise.resolve();
      await Promise.resolve();

      // Next cadence runs a new pass.
      await vi.advanceTimersByTimeAsync(ctx.ATTACHMENT_SWEEP_INTERVAL_MS);
      await Promise.resolve();
      expect(calls).toEqual([1, 2]);

      handle.stop();
      handle = undefined;
      await vi.advanceTimersByTimeAsync(ctx.ATTACHMENT_SWEEP_INTERVAL_MS * 2);
      expect(calls).toEqual([1, 2]);
    } finally {
      handle?.stop();
      db.close();
    }
  });
});
