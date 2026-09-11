import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChainRunContext } from "@lca/shared";
import { DaemonClient, DaemonError } from "../packages/cli/src/client.ts";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

type Db = ReturnType<typeof openDatabase>;

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b36",
    featureSlug: "b36-escalation",
    featureDir: "docs/roadmap/b36-escalation",
    featureIndex: "docs/roadmap/b36-escalation/00-index.md",
    idea: "escalation coverage",
    planningDepth: "jit",
    approvalPolicy: "none",
    researchApprovalPolicy: "none",
    loopMode: "normal",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
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

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async (params: SpawnParams) => {
      const activeRun: ActiveRun = {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        wait: async () => ({ status: "finished", result: "ok" }) as never,
        cancel: async () => {},
        dispose: async () => {},
      };
      return activeRun;
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function insertAutomation(
  db: Db,
  input: {
    id: string;
    configKey: string;
    name: string;
    prompt?: string;
    chainJson?: string | null;
    modelRole?: string | null;
    enabled?: number;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role
    ) VALUES (?, 'ws', ?, ?, 'enabled', ?, ?, NULL, 'test.yaml', ?, ?, ?)`
  ).run(
    input.id,
    input.name,
    input.enabled ?? 1,
    JSON.stringify({ type: "manual" }),
    input.prompt ?? `Prompt for ${input.name} {{featureId}}`,
    input.configKey,
    input.chainJson ?? null,
    input.modelRole ?? null
  );
}

function seedChainWorkers(db: Db): void {
  insertAutomation(db, {
    id: "ws::a",
    configKey: "a",
    name: "Worker A",
    prompt: "A prompt {{featureId}}",
    chainJson: JSON.stringify({ next: "b", when: "completed" }),
    modelRole: "implementer",
  });
  insertAutomation(db, {
    id: "ws::b",
    configKey: "b",
    name: "Worker B",
    prompt: "B prompt {{featureId}}",
    chainJson: JSON.stringify({ next: "c", when: "completed" }),
    modelRole: "reviewer",
    enabled: 0,
  });
  insertAutomation(db, {
    id: "ws::c",
    configKey: "c",
    name: "Worker C",
    prompt: "C prompt {{featureId}}",
    modelRole: "docs",
    enabled: 0,
  });
}

function seedFailedPipelineRun(
  store: RunStore,
  db: Db,
  opts: {
    id: string;
    automationId?: string;
    depth?: number;
    maxDepth?: number;
    maxDepthOverride?: number | null;
    prompt?: string;
    rootId?: string;
    legacy?: boolean;
    status?: "failed" | "completed" | "cancelled" | "running" | "queued";
  }
): void {
  const id = opts.id;
  const rootId = opts.rootId ?? "root-1";
  const depth = opts.depth ?? 2;
  if (opts.legacy) {
    store.insertRun({
      id,
      automationId: opts.automationId ?? "ws::a",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: opts.prompt ?? "legacy prompt",
      parentRunId: "legacy-parent",
    });
  } else {
    store.insertRun({
      id,
      automationId: opts.automationId ?? "ws::a",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: opts.prompt ?? "A prompt b36 — stored verbatim",
      chainContext: CONTEXT,
      chainRootRunId: rootId,
      chainDepth: depth,
      chainMaxDepth: opts.maxDepth ?? 5,
    });
  }
  if (opts.maxDepthOverride != null) {
    db.prepare(
      `UPDATE runs SET chain_max_depth_override = ? WHERE id = ?`
    ).run(opts.maxDepthOverride, id);
  }
  store.setStatus(id, opts.status ?? "failed");
  if (opts.status === "running" || opts.status === "queued") {
    db.prepare(`UPDATE runs SET ended_at = NULL WHERE id = ?`).run(id);
  }
}

function countRuns(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
}

function listChildRuns(db: Db, parentId: string) {
  return db
    .prepare(
      `SELECT id, automation_id, parent_run_id, trigger_kind, prompt,
              chain_root_run_id, chain_depth, chain_max_depth, status
       FROM runs WHERE parent_run_id = ? ORDER BY created_at ASC, rowid ASC`
    )
    .all(parentId) as Array<{
    id: string;
    automation_id: string;
    parent_run_id: string | null;
    trigger_kind: string | null;
    prompt: string | null;
    chain_root_run_id: string | null;
    chain_depth: number | null;
    chain_max_depth: number | null;
    status: string;
  }>;
}

function escalatedEvents(db: Db, runId: string) {
  return (
    db
      .prepare(
        `SELECT payload FROM run_events
         WHERE run_id = ? AND event_type = 'run.pipeline-escalated'
         ORDER BY seq ASC`
      )
      .all(runId) as Array<{ payload: string }>
  ).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

function readRun(db: Db, id: string) {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | {
        id: string;
        status: string;
        prompt: string | null;
        chain_depth: number | null;
        chain_max_depth: number | null;
        chain_max_depth_override: number | null;
        chain_root_run_id: string | null;
        chain_context_json: string | null;
        chain_handled_at: string | null;
        chain_stop_requested_at: string | null;
        chain_stop_reason: string | null;
        trigger_kind: string | null;
        parent_run_id: string | null;
        automation_id: string;
        model: string | null;
        model_params_json: string | null;
      }
    | undefined;
}

type Harness = {
  db: Db;
  store: RunStore;
  client: DaemonClient;
  port: number;
};

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b36-5-esc-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
  ).run("ws", workspace, "Workspace");
  seedChainWorkers(db);

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    events,
    inputHub,
    maxConcurrentRuns: 4,
  });
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
  });
  chainRunner.start();

  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    events,
  });
  const port = await freeListenPort();
  const triggers = new TriggerManager(db, engine, { port });
  const http = await startHttpServer({
    engine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "test",
    port,
    settings: DEFAULT_SETTINGS,
    triggers,
  });
  const client = new DaemonClient(`http://127.0.0.1:${port}`);

  try {
    await run({ db, store, client, port });
  } finally {
    chainRunner.stop();
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b36-5 escalation", () => {
  it("retry preserves depth, root, context, prompt, and trigger_kind", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, {
        id: "failed-1",
        depth: 2,
        maxDepth: 5,
        prompt: "exact stored prompt {{not-re-rendered}}",
      });
      const beforeContext = readRun(h.db, "failed-1")!.chain_context_json;

      const response = await h.client.escalate("failed-1", {
        action: "retry",
        reason: "try again",
      });
      expect(response.action).toBe("retry");
      expect(response.childRunId).toBeTruthy();
      expect(response.stopReason).toBeNull();
      expect(listChildRuns(h.db, "failed-1").map((r) => r.id)).toContain(
        response.childRunId
      );

      const child = readRun(h.db, response.childRunId!)!;
      expect(child.chain_depth).toBe(2);
      expect(child.chain_root_run_id).toBe("root-1");
      expect(child.chain_context_json).toBe(beforeContext);
      expect(child.prompt).toBe("exact stored prompt {{not-re-rendered}}");
      expect(child.parent_run_id).toBe("failed-1");
      expect(child.trigger_kind).toBe("escalation");
      expect(child.chain_max_depth).toBe(5);
      expect(child.automation_id).toBe("ws::a");

      const events = escalatedEvents(h.db, "failed-1");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "retry",
        actor: "operator",
        reason: "try again",
        childRunId: response.childRunId,
      });
    });
  });

  it("retry carries effective budget from override", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, {
        id: "failed-rebudget",
        depth: 1,
        maxDepth: 3,
        maxDepthOverride: 9,
      });
      const response = await h.client.escalate("failed-rebudget", {
        action: "retry",
      });
      const child = readRun(h.db, response.childRunId!)!;
      expect(child.chain_max_depth).toBe(9);
    });
  });

  it("skip enqueues successor at depth+1 with skip notice and no passResult", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, {
        id: "failed-skip",
        depth: 2,
        maxDepth: 5,
      });
      const response = await h.client.escalate("failed-skip", {
        action: "skip",
        reason: "did it by hand",
      });
      const child = readRun(h.db, response.childRunId!)!;
      expect(child.automation_id).toBe("ws::b");
      expect(child.chain_depth).toBe(3);
      expect(child.trigger_kind).toBe("escalation");
      expect(child.model).toBe("reviewer-model");
      expect(child.prompt).toContain("B prompt b36");
      expect(child.prompt).toContain(
        "--- step skipped by operator: a (run failed-skip) was not completed by an agent ---"
      );
      expect(child.prompt).toContain("did it by hand");
      expect(child.prompt).not.toContain("--- chained from");
    });
  });

  it("skip template failure records the reason without consuming the claim", async () => {
    await withHarness(async (h) => {
      h.db
        .prepare(`UPDATE automations SET prompt = ? WHERE id = ?`)
        .run("B prompt {{missingVariable}}", "ws::b");
      seedFailedPipelineRun(h.store, h.db, {
        id: "failed-template",
        depth: 2,
        maxDepth: 5,
      });
      const before = countRuns(h.db);

      await expect(
        h.client.escalate("failed-template", { action: "skip" })
      ).rejects.toThrow(/template-error/i);

      expect(countRuns(h.db)).toBe(before);
      expect(readRun(h.db, "failed-template")!.chain_handled_at).toBeNull();
      const event = h.db
        .prepare(
          `SELECT payload FROM run_events
           WHERE run_id = ? AND event_type = 'run.chain-skipped'
           ORDER BY seq DESC LIMIT 1`
        )
        .get("failed-template") as { payload: string } | undefined;
      expect(event).toBeTruthy();
      expect(JSON.parse(event!.payload)).toMatchObject({
        reason: "template-error",
      });
    });
  });

  it("abort marks a terminal run; second abort is idempotent", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, { id: "failed-abort", depth: 2 });
      const first = await h.client.escalate("failed-abort", {
        action: "abort",
        reason: "give up",
      });
      expect(first.childRunId).toBeNull();
      expect(first.stopReason).toBe("aborted: give up");
      const afterFirst = readRun(h.db, "failed-abort")!;
      expect(afterFirst.chain_stop_requested_at).toBeTruthy();
      expect(afterFirst.chain_stop_reason).toBe("aborted: give up");
      expect(afterFirst.chain_handled_at).toBeTruthy();
      expect(listChildRuns(h.db, "failed-abort")).toHaveLength(0);

      const second = await h.client.escalate("failed-abort", {
        action: "abort",
        reason: "different reason ignored",
      });
      expect(second.stopReason).toBe("aborted: give up");
      const afterSecond = readRun(h.db, "failed-abort")!;
      expect(afterSecond.chain_stop_requested_at).toBe(
        afterFirst.chain_stop_requested_at
      );
      expect(afterSecond.chain_stop_reason).toBe("aborted: give up");
      expect(escalatedEvents(h.db, "failed-abort").length).toBeGreaterThanOrEqual(
        2
      );
    });
  });

  it("abort on an active run cancels it and sets the marker", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, {
        id: "active-abort",
        depth: 1,
        status: "running",
      });

      const response = await h.client.escalate("active-abort", {
        action: "abort",
        reason: "stop now",
      });
      expect(response.stopReason).toBe("aborted: stop now");
      await until(() => readRun(h.db, "active-abort")!.status === "cancelled");
      const row = readRun(h.db, "active-abort")!;
      expect(row.chain_stop_requested_at).toBeTruthy();
      expect(row.chain_stop_reason).toBe("aborted: stop now");
    });
  });

  it("second retry/skip is refused already-chained", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, { id: "once-retry", depth: 2 });
      await h.client.escalate("once-retry", { action: "retry" });
      const before = countRuns(h.db);
      await expect(
        h.client.escalate("once-retry", { action: "retry" })
      ).rejects.toThrow(/already-chained|409/i);
      expect(countRuns(h.db)).toBe(before);

      seedFailedPipelineRun(h.store, h.db, { id: "once-skip", depth: 2 });
      await h.client.escalate("once-skip", { action: "skip" });
      const beforeSkip = countRuns(h.db);
      await expect(
        h.client.escalate("once-skip", { action: "skip" })
      ).rejects.toThrow(/already-chained|409/i);
      expect(countRuns(h.db)).toBe(beforeSkip);
    });
  });

  it("returns every refusal code without claiming where refused early", async () => {
    await withHarness(async (h) => {
      try {
        await h.client.escalate("missing-run", { action: "retry" });
        expect.fail("expected 404");
      } catch (err) {
        expect((err as DaemonError).message).toMatch(/^404/);
        expect((err as DaemonError).message).toMatch(/not found/i);
      }

      seedFailedPipelineRun(h.store, h.db, {
        id: "legacy-1",
        legacy: true,
        status: "failed",
      });
      await expect(
        h.client.escalate("legacy-1", { action: "retry" })
      ).rejects.toThrow(/409/);
      expect((await rejectMessage(h.client, "legacy-1", "retry"))).toMatch(
        /not-pipeline|not a context-aware/i
      );
      expect(readRun(h.db, "legacy-1")!.chain_handled_at).toBeNull();

      h.store.insertRun({
        id: "corrupt-1",
        automationId: "ws::a",
        workspaceId: "ws",
        triggerKind: "chain",
        prompt: "p",
        chainRootRunId: "root-1",
        chainDepth: 1,
        chainMaxDepth: 5,
        chainContext: CONTEXT,
      });
      h.db
        .prepare(
          `UPDATE runs SET chain_context_json = ?, status = 'failed',
             ended_at = datetime('now') WHERE id = ?`
        )
        .run("{not-json", "corrupt-1");
      await expect(
        h.client.escalate("corrupt-1", { action: "retry" })
      ).rejects.toThrow(/409/);
      expect(readRun(h.db, "corrupt-1")!.chain_handled_at).toBeNull();

      seedFailedPipelineRun(h.store, h.db, {
        id: "running-1",
        depth: 2,
        status: "running",
      });
      await expect(
        h.client.escalate("running-1", { action: "retry" })
      ).rejects.toThrow(/409/);
      expect(await rejectMessage(h.client, "running-1", "skip")).toMatch(
        /not-halted|not halted/i
      );
      expect(readRun(h.db, "running-1")!.chain_handled_at).toBeNull();

      seedFailedPipelineRun(h.store, h.db, {
        id: "root-run",
        depth: 0,
        rootId: "root-run",
      });
      expect(await rejectMessage(h.client, "root-run", "retry")).toMatch(
        /root-run|pipeline root/i
      );
      expect(readRun(h.db, "root-run")!.chain_handled_at).toBeNull();

      insertAutomation(h.db, {
        id: "ws::leaf",
        configKey: "leaf",
        name: "Leaf",
        chainJson: null,
      });
      seedFailedPipelineRun(h.store, h.db, {
        id: "no-next",
        automationId: "ws::leaf",
        depth: 1,
      });
      expect(await rejectMessage(h.client, "no-next", "skip")).toMatch(
        /no-successor|no configured successor/i
      );
      expect(readRun(h.db, "no-next")!.chain_handled_at).toBeNull();

      seedFailedPipelineRun(h.store, h.db, {
        id: "budget-out",
        depth: 5,
        maxDepth: 5,
      });
      expect(await rejectMessage(h.client, "budget-out", "skip")).toMatch(
        /budget-exhausted|budget exhausted/i
      );
      expect(readRun(h.db, "budget-out")!.chain_handled_at).toBeNull();
    });
  });

  it("retry is budget-exempt at depth==budget; successor then hits max-depth", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, {
        id: "at-budget",
        depth: 5,
        maxDepth: 5,
      });
      const response = await h.client.escalate("at-budget", { action: "retry" });
      const child = readRun(h.db, response.childRunId!)!;
      expect(child.chain_depth).toBe(5);
      expect(child.chain_max_depth).toBe(5);

      await until(() => {
        const skipped = h.db
          .prepare(
            `SELECT payload FROM run_events
             WHERE run_id = ? AND event_type = 'run.chain-skipped'`
          )
          .all(response.childRunId!) as Array<{ payload: string }>;
        return skipped.some(
          (e) =>
            (JSON.parse(e.payload) as { reason?: string }).reason === "max-depth"
        );
      });
      expect(listChildRuns(h.db, response.childRunId!)).toHaveLength(0);
    });
  });

  it("succeeds over loopback with no X-LCA-Run-Token", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, { id: "no-token", depth: 2 });
      const res = await fetch(
        `http://127.0.0.1:${h.port}/api/runs/no-token/escalate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "retry" }),
        }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { childRunId: string };
      expect(body.childRunId).toBeTruthy();
    });
  });

  it("after retry completes, ChainRunner chains onward to the successor", async () => {
    await withHarness(async (h) => {
      seedFailedPipelineRun(h.store, h.db, {
        id: "failed-chain-on",
        depth: 2,
      });
      const response = await h.client.escalate("failed-chain-on", {
        action: "retry",
      });
      await until(() => listChildRuns(h.db, response.childRunId!).length === 1);
      const next = listChildRuns(h.db, response.childRunId!)[0]!;
      expect(next.automation_id).toBe("ws::b");
      expect(next.chain_depth).toBe(3);
      expect(next.trigger_kind).toBe("chain");
    });
  });
});

async function rejectMessage(
  client: DaemonClient,
  runId: string,
  action: "retry" | "skip" | "abort"
): Promise<string> {
  try {
    await client.escalate(runId, { action });
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
