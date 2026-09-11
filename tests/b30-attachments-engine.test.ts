import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("b30 attachment storage + SDK conversion", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unmock("node:os");
  });

  it("writes blobs outside SQLite and converts images for agent.send", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b30-engine-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    try {
      const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
      const { ATTACHMENTS_DIR } = await import("../packages/daemon/src/paths.ts");
      const { AttachmentStore } = await import(
        "../packages/daemon/src/attachments/store.ts"
      );
      const { decodeBase64Content, writeAttachmentBlob } = await import(
        "../packages/daemon/src/attachments/storage.ts"
      );
      const { toSdkSendInput } = await import(
        "../packages/daemon/src/executor/operator-message.ts"
      );

      const db = openDatabase(join(testHome, "state.sqlite"));
      try {
        db.prepare(
          "INSERT INTO workspaces (id, path, name) VALUES ('ws', '/repo', 'Repo')"
        ).run();
        db.prepare(
          `INSERT INTO automations (
            id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
          ) VALUES ('auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'Run', 'c.yaml', 'auto')`
        ).run();
        db.prepare(
          `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
           VALUES ('run', 'auto', 'ws', 'completed', 'manual', 'Run')`
        ).run();

        const bytes = decodeBase64Content(
          PNG_1X1,
          DEFAULT_SETTINGS.maxAttachmentBytes
        );
        const written = writeAttachmentBlob({
          ownerKind: "run",
          ownerId: "run",
          filename: "pixel.png",
          mimeType: "image/png",
          bytes,
          settings: DEFAULT_SETTINGS,
        });
        expect(written.storagePath.startsWith(ATTACHMENTS_DIR)).toBe(true);

        const store = new AttachmentStore(db);
        store.insertUploaded({
          id: written.id,
          ownerKind: "run",
          ownerId: "run",
          filename: written.filename,
          mimeType: written.mimeType,
          sizeBytes: written.sizeBytes,
          sha256: written.sha256,
          kind: written.kind,
          storagePath: written.storagePath,
        });

        const sdkInput = toSdkSendInput({
          text: "what is this?",
          attachments: [
            {
              id: written.id,
              name: written.filename,
              mimeType: written.mimeType,
              sizeBytes: written.sizeBytes,
              kind: "image",
              storagePath: written.storagePath,
            },
          ],
        });
        expect(typeof sdkInput).toBe("object");
        if (typeof sdkInput !== "string") {
          expect(sdkInput.text).toBe("what is this?");
          expect(sdkInput.images?.[0]?.mimeType).toBe("image/png");
          expect(sdkInput.images?.[0]?.data?.length).toBeGreaterThan(10);
        }

        const meta = db
          .prepare(
            "SELECT storage_path, size_bytes FROM attachments WHERE id = ?"
          )
          .get(written.id) as { storage_path: string; size_bytes: number };
        expect(meta.size_bytes).toBe(bytes.length);
        expect(meta.storage_path).toBe(written.storagePath);

        // Follow-up path converts images for agent.send.
        const followUpInput = toSdkSendInput({
          text: "system\n\nhere is an image",
          attachments: [
            {
              id: written.id,
              name: written.filename,
              mimeType: written.mimeType,
              sizeBytes: written.sizeBytes,
              kind: "image",
              storagePath: written.storagePath,
            },
          ],
        });
        expect(typeof followUpInput).toBe("object");
        if (typeof followUpInput !== "string") {
          expect(followUpInput.images?.length).toBe(1);
        }
      } finally {
        db.close();
      }
    } finally {
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {
        /* Windows may briefly lock WAL files */
      }
    }
  });

  it("ChatEngine spawn delivers images via immediate sendFollowUp", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b30-spawn-images-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    vi.doMock("@cursor/sdk", () => ({
      Agent: {
        prompt: async () => ({ status: "finished", result: null }),
      },
      CursorAgentError: class CursorAgentError extends Error {},
    }));

    try {
      const { mkdirSync } = await import("node:fs");
      const { openDatabase } = await import("../packages/daemon/src/db/index.ts");
      const { ChatEngine } = await import("../packages/daemon/src/chats/engine.ts");
      const { AttachmentStore } = await import(
        "../packages/daemon/src/attachments/store.ts"
      );
      const { writeAttachmentBlob, decodeBase64Content } = await import(
        "../packages/daemon/src/attachments/storage.ts"
      );
      const types = await import("../packages/daemon/src/executor/types.ts");
      const { normalizeOperatorMessage } = types;
      type ActiveRun = import("../packages/daemon/src/executor/types.ts").ActiveRun;
      type Executor = import("../packages/daemon/src/executor/types.ts").Executor;
      type OperatorMessage =
        import("../packages/daemon/src/executor/types.ts").OperatorMessage;
      type SpawnParams =
        import("../packages/daemon/src/executor/types.ts").SpawnParams;

      const workspace = join(testHome, "workspace");
      mkdirSync(workspace, { recursive: true });
      const db = openDatabase(join(testHome, "state.sqlite"));

      const spawnPrompts: Array<string | OperatorMessage> = [];
      const followUps: OperatorMessage[] = [];

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
        sendFollowUp: async (message) => {
          followUps.push(normalizeOperatorMessage(message));
          return makeRun("agent-follow", "sdk-follow");
        },
      });

      const executor: Executor = {
        kind: "sdk-local",
        spawn: async (params: SpawnParams) => {
          spawnPrompts.push(params.prompt);
          return makeRun("agent-spawn", "sdk-spawn");
        },
        resume: async () => makeRun("agent-resume", "sdk-resume"),
      };

      const engine = new ChatEngine(db, {
        apiKey: "test-key",
        executor,
        events: {
          emitRunEvent: () => undefined,
          emitRunStatus: () => undefined,
          emitChatEvent: () => undefined,
          emitChatStatus: () => undefined,
          emitChatInputRequest: () => undefined,
        },
      });

      try {
        db.prepare(
          "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
        ).run(workspace);

        const session = engine.createChat({ workspaceId: "ws" });
        const bytes = decodeBase64Content(
          PNG_1X1,
          DEFAULT_SETTINGS.maxAttachmentBytes
        );
        const written = writeAttachmentBlob({
          ownerKind: "chat",
          ownerId: session.id,
          filename: "shot.png",
          mimeType: "image/png",
          bytes,
          settings: DEFAULT_SETTINGS,
        });
        new AttachmentStore(db).insertUploaded({
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

        await engine.sendMessage(session.id, "here is an image", [
          {
            id: written.id,
            name: written.filename,
            mimeType: written.mimeType,
            sizeBytes: written.sizeBytes,
            kind: "image",
          },
        ]);

        await new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const tick = () => {
            const status = (
              db
                .prepare("SELECT status FROM chat_sessions WHERE id = ?")
                .get(session.id) as { status: string } | undefined
            )?.status;
            if (status === "idle") {
              resolve();
              return;
            }
            if (Date.now() - start > 8000) {
              reject(new Error("chat did not reach idle"));
              return;
            }
            setTimeout(tick, 10);
          };
          tick();
        });

        expect(spawnPrompts).toHaveLength(1);
        const spawnMsg = normalizeOperatorMessage(spawnPrompts[0]!);
        expect(spawnMsg.attachments?.some((a) => a.kind === "image")).toBeFalsy();
        expect(followUps).toHaveLength(1);
        expect(followUps[0]!.attachments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: written.id,
              kind: "image",
              mimeType: "image/png",
            }),
          ])
        );
      } finally {
        await engine.shutdown();
        db.close();
      }
    } finally {
      vi.doUnmock("@cursor/sdk");
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {
        /* Windows may briefly lock WAL files */
      }
    }
  }, 15000);
});
