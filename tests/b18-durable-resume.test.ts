import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";

function seedRun(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  input: {
    runId: string;
    status: string;
    agentId?: string | null;
    sdkRunId?: string | null;
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
}

function inputHubFor(db: ReturnType<typeof openDatabase>): InputHub {
  return new InputHub(new InputStore(db), {
    onNeedsInput: () => undefined,
    onAnswered: () => undefined,
  });
}

describe("b18 durable resume", () => {
  it("keeps terminal runs resumable after reopening the store (simulated restart)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b18-resume-"));
    const dbPath = join(root, "state.sqlite");
    const db = openDatabase(dbPath);
    let resumeCalled = false;

    const nextRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-next",
      sdkRunId: "sdk-next",
      async *stream() {
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "reply" }] },
        } as never;
      },
      wait: async () => ({ status: "finished", result: "reply" }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async () => {
        throw new Error("second follow-up should not be called");
      },
    };
    const resumedRun: ActiveRun = {
      kind: "sdk-local",
      agentId: "agent-resumed",
      sdkRunId: "sdk-resumed",
      async *stream() {},
      wait: async () => ({ status: "finished", result: null }) as never,
      cancel: async () => undefined,
      dispose: async () => undefined,
      sendFollowUp: async () => nextRun,
    };
    const executor: Executor = {
      kind: "sdk-local",
      spawn: async () => {
        throw new Error("spawn should not be called");
      },
      resume: async (_params: ResumeParams) => {
        resumeCalled = true;
        return resumedRun;
      },
    };

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "completed",
        agentId: "agent-original",
        sdkRunId: "sdk-original",
      });

      const storeBefore = new RunStore(db);
      expect(storeBefore.getRun("run")).toMatchObject({
        agent_id: "agent-original",
        sdk_run_id: "sdk-original",
        status: "completed",
      });

      const storeAfterRestart = new RunStore(db);
      const row = storeAfterRestart.getRun("run");
      expect(row).toMatchObject({
        agent_id: "agent-original",
        sdk_run_id: "sdk-original",
        status: "completed",
      });

      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor,
        inputHub: inputHubFor(db),
      });

      await expect(engine.sendMessage("run", "follow up after restart")).resolves.toBeUndefined();
      expect(resumeCalled).toBe(true);

      await engine.shutdown();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
