import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import type { ChatSession } from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import type { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import type { ChatSessionRow } from "../packages/daemon/src/chats/store.ts";
import {
  RunEngine,
  RunMessageError,
  type RunPromotionSource,
} from "../packages/daemon/src/runs/engine.ts";


describe("b28.4 promote-to-chat HTTP", () => {
  it("POST /api/runs/:id/promote-to-chat returns 201 and calls releaseRetainedRun", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-http-happy-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();

    let released = false;
    const source: RunPromotionSource = {
      run: {
        id: "run-1",
        automation_id: "auto",
        workspace_id: "ws",
        status: "completed",
        agent_id: "agent-1",
        sdk_run_id: "sdk-1",
        trigger_kind: "manual",
        prompt: "prompt",
        parent_run_id: null,
        started_at: null,
        ended_at: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
      model: "composer-2.5",
      events: [{ seq: 1, event_type: "assistant", payload: "{}", created_at: "2026-01-01T00:00:00Z" }],
    };
    const chatRow: ChatSessionRow = {
      id: "chat-1",
      workspace_id: "ws",
      title: null,
      title_source: null,
      status: "idle",
      agent_id: "agent-1",
      sdk_run_id: "sdk-1",
      model: "composer-2.5",
      system_prompt: null,
      origin_run_id: "run-1",
      archived_at: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      last_message_at: null,
    };

    const engine = {
      prepareForPromotion: (_runId: string) => source,
      releaseRetainedRun: async () => {
        released = true;
      },
    } as unknown as RunEngine;
    const chatEngine = {
      promoteFromRun: () => chatRow,
    } as unknown as ChatEngine;

    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/runs/run-1/promote-to-chat`,
        { method: "POST" }
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { chat: ChatSession };
      expect(body.chat.id).toBe("chat-1");
      expect(body.chat.originRunId).toBe("run-1");
      expect(body.chat.agentId).toBe("agent-1");
      expect(released).toBe(true);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps RunMessageError codes to HTTP statuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b28-4-http-errors-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    let error: RunMessageError | undefined;

    const engine = {
      prepareForPromotion: () => {
        if (error) throw error;
        throw new Error("unexpected");
      },
      releaseRetainedRun: async () => undefined,
    } as unknown as RunEngine;
    const chatEngine = {
      promoteFromRun: () => {
        throw new Error("promoteFromRun should not be called");
      },
    } as unknown as ChatEngine;

    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    async function post() {
      return fetch(`http://127.0.0.1:${port}/api/runs/run-1/promote-to-chat`, {
        method: "POST",
      });
    }

    try {
      error = new RunMessageError("not_found", "Run not found: run-1");
      expect((await post()).status).toBe(404);

      error = new RunMessageError("not_resumable", "Run run-1 is not resumable");
      expect((await post()).status).toBe(422);

      error = new RunMessageError("busy", "Run run-1 cannot be promoted while running");
      expect((await post()).status).toBe(409);

      error = new RunMessageError("context_missing", "Run run-1: workspace unavailable");
      expect((await post()).status).toBe(400);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
