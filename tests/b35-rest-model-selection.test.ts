import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freeListenPort } from "./helpers/free-port.ts";
import {
  MODEL_PARAMS_MAX_COUNT,
  modelSelectionKey,
  type Automation,
  type ChatSession,
  type Run,
} from "@lca/shared";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { workspaceChatConfigPath } from "../packages/daemon/src/paths.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";


function noopExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn not expected in REST model tests");
    },
    resume: async () => {
      throw new Error("resume not expected in REST model tests");
    },
  };
}

const selection = {
  id: "grok-4.5",
  params: [{ id: "reasoning", value: "high" }],
};

async function withServer(
  fn: (ctx: {
    port: number;
    base: string;
    db: ReturnType<typeof openDatabase>;
    workspace: string;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b35-rest-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'Workspace')"
  ).run("ws", workspace);

  const port = await freeListenPort();
  const events = new DaemonEventBus();
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => undefined,
    onAnswered: () => undefined,
  });
  const executor = noopExecutor();
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor,
    inputHub,
    maxConcurrentRuns: 1,
    events,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor,
    events,
  });
  const http = await startHttpServer({
    engine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "test",
    port,
  });

  try {
    await fn({ port, base: `http://127.0.0.1:${port}`, db, workspace });
  } finally {
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b35 REST modelSelection round-trips", () => {
  it("creates and clears automation modelSelection; rejects conflicts", async () => {
    await withServer(async ({ base }) => {
      const createRes = await fetch(`${base}/api/automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws",
          name: "B35 Auto",
          trigger: { type: "manual" },
          prompt: "do the thing",
          modelSelection: selection,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { automation: Automation };
      expect(created.automation.model).toBe("grok-4.5");
      expect(
        modelSelectionKey(created.automation.modelSelection!)
      ).toBe(modelSelectionKey(selection));

      const clearRes = await fetch(
        `${base}/api/automations/${encodeURIComponent(created.automation.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelSelection: null }),
        }
      );
      expect(clearRes.status).toBe(200);
      const cleared = (await clearRes.json()) as { automation: Automation };
      expect(cleared.automation.model).toBeNull();
      expect(cleared.automation.modelSelection).toBeNull();

      const conflictRes = await fetch(
        `${base}/api/automations/${encodeURIComponent(created.automation.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "a",
            modelSelection: { id: "b" },
          }),
        }
      );
      expect(conflictRes.status).toBe(400);
      const conflictBody = (await conflictRes.json()) as { error: string };
      expect(conflictBody.error.length).toBeGreaterThan(0);

      const dualRes = await fetch(
        `${base}/api/automations/${encodeURIComponent(created.automation.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "grok-4.5",
            modelSelection: selection,
          }),
        }
      );
      expect(dualRes.status).toBe(200);
      const dual = (await dualRes.json()) as { automation: Automation };
      expect(modelSelectionKey(dual.automation.modelSelection!)).toBe(
        modelSelectionKey(selection)
      );
    });
  });

  it("round-trips run and chat selections, including clear and legacy-only", async () => {
    await withServer(async ({ base, db, workspace }) => {
      db.prepare(
        `INSERT INTO automations (
          id, workspace_id, name, enabled, status, trigger_json, prompt, model,
          config_path, config_key
        ) VALUES (?, ?, ?, 1, 'enabled', ?, ?, ?, ?, ?)`
      ).run(
        "auto",
        "ws",
        "B35",
        JSON.stringify({ type: "manual" }),
        "do the thing",
        "auto-model",
        "test.yaml",
        "auto"
      );
      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
         VALUES ('run-1', 'auto', 'ws', 'completed', 'manual', 'do the thing')`
      ).run();

      const setRun = await fetch(`${base}/api/runs/run-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelSelection: selection }),
      });
      expect(setRun.status).toBe(200);
      const runBody = (await setRun.json()) as { run: Run };
      expect(runBody.run.model).toBe("grok-4.5");
      expect(modelSelectionKey(runBody.run.modelSelection!)).toBe(
        modelSelectionKey(selection)
      );

      const clearRun = await fetch(`${base}/api/runs/run-1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelSelection: null }),
      });
      expect(clearRun.status).toBe(200);
      const clearedRun = (await clearRun.json()) as { run: Run };
      expect(clearedRun.run.model).toBeNull();
      expect(clearedRun.run.modelSelection).toBeNull();

      const createChat = await fetch(`${base}/api/workspaces/ws/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelSelection: selection }),
      });
      expect(createChat.status).toBe(201);
      const chatCreated = (await createChat.json()) as { chat: ChatSession };
      expect(modelSelectionKey(chatCreated.chat.modelSelection!)).toBe(
        modelSelectionKey(selection)
      );

      const patchChat = await fetch(
        `${base}/api/chats/${encodeURIComponent(chatCreated.chat.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelSelection: null }),
        }
      );
      expect(patchChat.status).toBe(200);
      const chatCleared = (await patchChat.json()) as { chat: ChatSession };
      expect(chatCleared.chat.model).toBeNull();
      expect(chatCleared.chat.modelSelection).toBeNull();

      // Chat-defaults persist via YAML + reconcile. Temp DB workspaces are not
      // listed in the real global config, so assert the YAML write instead of
      // the SQLite projection (structured YAML round-trip is covered in b28-6b).
      const defaultsRes = await fetch(
        `${base}/api/workspaces/ws/chat-defaults`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelSelection: selection }),
        }
      );
      expect(defaultsRes.status).toBe(200);
      const chatYaml = readFileSync(workspaceChatConfigPath(workspace), "utf8");
      expect(chatYaml).toContain("grok-4.5");
      expect(chatYaml).toContain("reasoning");
      expect(chatYaml).toContain("high");

      const clearDefaults = await fetch(
        `${base}/api/workspaces/ws/chat-defaults`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelSelection: null }),
        }
      );
      expect(clearDefaults.status).toBe(200);
      const clearedYaml = readFileSync(
        workspaceChatConfigPath(workspace),
        "utf8"
      );
      expect(clearedYaml).not.toMatch(/^\s*model:/m);

      const legacyRes = await fetch(`${base}/api/automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws",
          name: "Legacy Auto",
          trigger: { type: "manual" },
          prompt: "legacy",
          model: "grok-4.5",
        }),
      });
      expect(legacyRes.status).toBe(201);
      const legacy = (await legacyRes.json()) as { automation: Automation };
      expect(legacy.automation.model).toBe("grok-4.5");
      expect(legacy.automation.modelSelection).toEqual({ id: "grok-4.5" });
    });
  });

  it("rejects malformed selections with 400", async () => {
    await withServer(async ({ base }) => {
      const duplicate = await fetch(`${base}/api/automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws",
          name: "Bad Dup",
          trigger: { type: "manual" },
          prompt: "x",
          modelSelection: {
            id: "grok-4.5",
            params: [
              { id: "web", value: "true" },
              { id: "web", value: "false" },
            ],
          },
        }),
      });
      expect(duplicate.status).toBe(400);
      const dupBody = (await duplicate.json()) as { error: string };
      expect(dupBody.error.length).toBeGreaterThan(0);

      const oversizedParams = Array.from(
        { length: MODEL_PARAMS_MAX_COUNT + 1 },
        (_, i) => ({ id: `p${i}`, value: "v" })
      );
      const oversized = await fetch(`${base}/api/automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws",
          name: "Bad Size",
          trigger: { type: "manual" },
          prompt: "x",
          modelSelection: { id: "grok-4.5", params: oversizedParams },
        }),
      });
      expect(oversized.status).toBe(400);
      const overBody = (await oversized.json()) as { error: string };
      expect(overBody.error.length).toBeGreaterThan(0);
    });
  });
});
