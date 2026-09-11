import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeNotifyEventPrefs, type ChainRunContext } from "@lca/shared";
import type {
  ActiveRun,
  Executor,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  buildRunDeepLink,
  Notifier,
} from "../packages/daemon/src/notify/notifier.ts";
import { ChainRunner } from "../packages/daemon/src/runs/chain-runner.ts";
import type { HaltRecoveryResult } from "../packages/daemon/src/runs/halt-recovery-runtime.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

/** Toast content asserts for halt events that default quiet under b51 prefs. */
const haltToastPrefs = mergeNotifyEventPrefs({
  pipeline_halt_recovered: { toast: true, ntfy: false },
});

type Db = ReturnType<typeof openDatabase>;
type NotifyCall = {
  title?: string;
  message?: string;
  open?: string;
};

const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));

vi.mock("node-notifier", () => ({
  default: {
    notify: (
      opts: NotifyCall,
      cb?: (err: Error | null, response: string) => void
    ) => {
      notifyMock(opts, cb);
    },
  },
}));

const CONTEXT: ChainRunContext = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b43",
    featureSlug: "b43-unattended-halt-recovery",
    featureDir: "docs/roadmap/b43-unattended-halt-recovery",
    featureIndex: "docs/roadmap/b43-unattended-halt-recovery/00-index.md",
    idea: "operator visibility",
    planningDepth: "jit",
    approvalPolicy: "none",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

afterEach(() => {
  notifyMock.mockReset();
});

/** Narrow dispatch seam matching index.ts / tryRecoverPipelineHalt. */
function dispatchHaltRecoveryDecision(
  runId: string,
  result: HaltRecoveryResult,
  sink: (runId: string, result: HaltRecoveryResult) => void,
  onSinkError?: (message: string) => void
): void {
  if (result.kind !== "acted" && result.kind !== "declined") return;
  try {
    sink(runId, result);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    onSinkError?.(
      `Pipeline halt recovery notify failed for run ${runId}: ${text}`
    );
  }
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

function seedWorkers(db: Db): void {
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role
    ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, ?, ?)`
  ).run(
    "ws::review",
    "Review",
    JSON.stringify({ type: "manual" }),
    "Review {{featureId}}",
    "generated:review",
    JSON.stringify({ next: "generated:docs-commit", when: "completed" }),
    "reviewer"
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role
    ) VALUES (?, 'ws', ?, 0, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, ?)`
  ).run(
    "ws::docs",
    "Docs",
    JSON.stringify({ type: "manual" }),
    "Docs {{featureId}}",
    "generated:docs-commit",
    "docs"
  );
}

function seedFailedHalt(store: RunStore, id: string): void {
  store.insertRun({
    id,
    automationId: "ws::review",
    workspaceId: "ws",
    triggerKind: "chain",
    prompt: "Review prompt stored",
    chainContext: CONTEXT,
    chainRootRunId: "root-vis-1",
    chainDepth: 2,
    chainMaxDepth: 9,
  });
  store.setStatus(id, "failed");
  store.appendEvent(id, "assistant", {
    message: { content: [{ type: "text", text: "working" }] },
  });
  store.appendEvent(id, "tool_call", { name: "Shell" });
  store.appendEvent(id, "run.error", {
    reason: "sdk_error",
    sdkStatus: "error",
  });
}

describe("b43 notifier pipeline decisions", () => {
  it("emits distinct acted and declined toasts with source deep links", () => {
    const dashboardUrl = "http://127.0.0.1:3747";
    const notifier = new Notifier({
      dashboardUrl,
      eventPrefs: haltToastPrefs,
    });
    const sourceId = "source-run-aaaaaaaa";
    const childId = "child-run-bbbbbbbb";

    notifier.pipelineHaltRecovered(sourceId, "retry", childId);
    notifier.pipelineHaltUnrecovered(
      sourceId,
      "lineage-budget-exhausted",
      "daemon escalations already at cap"
    );

    expect(notifyMock).toHaveBeenCalledTimes(2);
    const acted = notifyMock.mock.calls[0]![0] as NotifyCall;
    const declined = notifyMock.mock.calls[1]![0] as NotifyCall;

    expect(acted.title).toMatch(/automatically recovered/i);
    expect(acted.message).toMatch(/retry/i);
    expect(acted.message).toMatch(/child-ru/i);
    expect(acted.message).toMatch(/no operator action/i);
    expect(acted.open).toBe(buildRunDeepLink(dashboardUrl, sourceId));

    expect(declined.title).toMatch(/remains halted/i);
    expect(declined.message).toMatch(/lineage-budget-exhausted/);
    expect(declined.message).toMatch(/operator escalation remains available/i);
    expect(declined.open).toBe(buildRunDeepLink(dashboardUrl, sourceId));
  });

  it("honors disabled and isolates notify sink errors", () => {
    const disabled = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      disabled: true,
      eventPrefs: haltToastPrefs,
    });
    disabled.pipelineHaltRecovered("run-1", "skip", "child-1");
    disabled.pipelineHaltUnrecovered("run-1", "not-safe-class", "spawn_error");
    expect(notifyMock).not.toHaveBeenCalled();

    notifyMock.mockImplementation(() => {
      throw new Error("toast boom");
    });
    const logs: string[] = [];
    const live = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      onLog: (m) => logs.push(m),
      eventPrefs: haltToastPrefs,
    });
    expect(() =>
      live.pipelineHaltRecovered("run-2", "retry", null)
    ).not.toThrow();
    expect(logs.some((l) => /Notifier error/i.test(l))).toBe(true);
  });
});

describe("b43 halt-recovery notification dispatch", () => {
  it("dispatches acted/declined only; already-resolved is silent", () => {
    const sink = vi.fn();
    const errors: string[] = [];

    dispatchHaltRecoveryDecision(
      "run-a",
      { kind: "acted", action: "retry", childRunId: "child-1" },
      sink
    );
    dispatchHaltRecoveryDecision(
      "run-b",
      { kind: "declined", code: "not-safe-class", detail: "spawn_error" },
      sink
    );
    dispatchHaltRecoveryDecision(
      "run-c",
      { kind: "already-resolved", detail: "prior decision" },
      sink
    );
    dispatchHaltRecoveryDecision(
      "run-d",
      { kind: "already-resolved", detail: "in-flight" },
      sink
    );

    expect(sink).toHaveBeenCalledTimes(2);

    const throwing = vi.fn(() => {
      throw new Error("toast failed");
    });
    expect(() =>
      dispatchHaltRecoveryDecision(
        "run-e",
        { kind: "acted", action: "skip", childRunId: null },
        throwing,
        (m) => errors.push(m)
      )
    ).not.toThrow();
    expect(errors[0]).toMatch(/notify failed for run run-e/i);
  });

  it("ChainRunner guarded path notifies acted recovery and isolates sink errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b43-vis-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    db.prepare(
      `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
    ).run("ws", workspace, "Workspace");
    seedWorkers(db);

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      }),
      maxConcurrentRuns: 4,
    });

    const callback = vi.fn(() => {
      throw new Error("toast sink exploded");
    });
    const logs: string[] = [];
    const chainRunner = new ChainRunner({
      store,
      engine,
      events,
      onLog: (m) => logs.push(m),
      onHaltRecoveryDecision: callback,
    });

    try {
      seedFailedHalt(store, "halt-vis-1");
      await chainRunner.handleTerminal("halt-vis-1", "failed");

      expect(callback).toHaveBeenCalledTimes(1);
      const [runId, result] = callback.mock.calls[0]! as [
        string,
        HaltRecoveryResult,
      ];
      expect(runId).toBe("halt-vis-1");
      expect(result.kind).toBe("acted");
      if (result.kind === "acted") {
        expect(result.action).toBe("retry");
        expect(result.childRunId).toBeTruthy();
      }
      expect(
        logs.some((l) => /notify failed for run halt-vis-1/i.test(l))
      ).toBe(true);

      // Replay / already-resolved must not toast again.
      callback.mockClear();
      await chainRunner.handleTerminal("halt-vis-1", "failed");
      expect(callback).not.toHaveBeenCalled();
    } finally {
      chainRunner.stop();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
