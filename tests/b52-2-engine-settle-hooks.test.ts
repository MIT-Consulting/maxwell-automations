import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
} from "@lca/shared";
import type { ParsedChainContext } from "../packages/daemon/src/runs/store.ts";
import type { ActiveRun, Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { notifyOnRunCompleted } from "../packages/daemon/src/notify/run-completed.ts";
import type {
  AutomationRow,
  RunRow,
} from "../packages/daemon/src/runs/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

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

function inputHubFor(db: ReturnType<typeof openDatabase>): InputHub {
  return new InputHub(new InputStore(db), {
    onNeedsInput: () => undefined,
    onAnswered: () => undefined,
  });
}

function seedRun(
  db: ReturnType<typeof openDatabase>,
  workspace: string,
  input: {
    runId: string;
    status: string;
    automationId?: string;
    configKey?: string;
    automationName?: string;
    agentId?: string | null;
    sdkRunId?: string | null;
  }
): void {
  const automationId = input.automationId ?? "auto";
  const configKey = input.configKey ?? "auto";
  const automationName = input.automationName ?? "Automation";
  mkdirSync(workspace, { recursive: true });
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    workspace
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      ?, 'ws', ?, 1, 'enabled', '{"type":"manual"}', 'Prompt',
      'config.yaml', ?
    )`
  ).run(automationId, automationName, configKey);
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, agent_id, sdk_run_id
    ) VALUES (
      @runId, @automationId, 'ws', @status, 'manual', 'Stored prompt', @agentId, @sdkRunId
    )`
  ).run({
    runId: input.runId,
    automationId,
    status: input.status,
    agentId: input.agentId ?? null,
    sdkRunId: input.sdkRunId ?? null,
  });
}

function statusOf(db: ReturnType<typeof openDatabase>, runId: string): string | undefined {
  const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function makeQuickExecutor(result = "done"): Executor {
  const active: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-quick",
    sdkRunId: "sdk-quick",
    async *stream() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "working" }] },
      } as never;
    },
    wait: async () => ({ status: "finished", result }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return {
    kind: "sdk-local",
    spawn: async () => active,
    resume: async () => active,
  };
}

function makeFailingExecutor(message: string): Executor {
  const active: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-fail",
    sdkRunId: "sdk-fail",
    async *stream() {},
    wait: async () => ({ status: "error", result: message }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return {
    kind: "sdk-local",
    spawn: async () => active,
    resume: async () => active,
  };
}

function stubRun(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1234567890abcdef",
    automation_id: "auto",
    workspace_id: "ws",
    status: "completed",
    trigger_kind: "manual",
    prompt: "p",
    agent_id: null,
    sdk_run_id: null,
    parent_run_id: null,
    chain_depth: null,
    chain_context_json: null,
    title: null,
    summary: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

function stubAutomation(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: "auto",
    workspace_id: "ws",
    name: "My Automation",
    config_key: "manual.yaml",
    prompt: "p",
    model: null,
    model_params_json: null,
    model_role: null,
    trigger_json: "{}",
    chain_json: null,
    ...overrides,
  };
}

describe("b52 phase 2 — engine settle hooks", () => {
  describe("RunEngine.onRunCompleted", () => {
    it("fires exactly once when a run transitions to completed", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b52-engine-complete-"));
      const db = openDatabase(join(root, "state.sqlite"));
      const onRunCompleted = vi.fn();
      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor: makeQuickExecutor(),
        inputHub: inputHubFor(db),
        onRunCompleted,
      });

      try {
        seedRun(db, join(root, "workspace"), {
          runId: "placeholder",
          status: "completed",
        });
        db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

        const runId = await engine.triggerRun("auto");
        await until(() => statusOf(db, runId) === "completed");

        expect(onRunCompleted).toHaveBeenCalledTimes(1);
        expect(onRunCompleted).toHaveBeenCalledWith(runId);
      } finally {
        await engine.shutdown();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("does not fire when a run settles to failed", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b52-engine-failed-"));
      const db = openDatabase(join(root, "state.sqlite"));
      const onRunCompleted = vi.fn();
      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor: makeFailingExecutor("boom"),
        inputHub: inputHubFor(db),
        onRunCompleted,
      });

      try {
        seedRun(db, join(root, "workspace"), {
          runId: "placeholder",
          status: "completed",
        });
        db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

        const runId = await engine.triggerRun("auto");
        await until(() => statusOf(db, runId) === "failed");

        expect(onRunCompleted).not.toHaveBeenCalled();
      } finally {
        await engine.shutdown();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("does not fire again without a new transition into completed", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b52-engine-no-retx-"));
      const db = openDatabase(join(root, "state.sqlite"));
      const onRunCompleted = vi.fn();
      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor: makeQuickExecutor(),
        inputHub: inputHubFor(db),
        onRunCompleted,
      });

      try {
        seedRun(db, join(root, "workspace"), {
          runId: "placeholder",
          status: "completed",
        });
        db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

        const runId = await engine.triggerRun("auto");
        await until(() => statusOf(db, runId) === "completed");
        expect(onRunCompleted).toHaveBeenCalledTimes(1);

        onRunCompleted.mockClear();
        engine.runStallSweep();
        expect(onRunCompleted).not.toHaveBeenCalled();
      } finally {
        await engine.shutdown();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fires again after interactive reopen completes", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b52-engine-reopen-"));
      const workspace = join(root, "workspace");
      const db = openDatabase(join(root, "state.sqlite"));
      const onRunCompleted = vi.fn();
      const nextRun: ActiveRun = {
        kind: "sdk-local",
        agentId: "agent-next",
        sdkRunId: "sdk-next",
        async *stream() {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "done" }] },
          } as never;
        },
        wait: async () => ({ status: "finished", result: "done" }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
      };
      const initialRun: ActiveRun = {
        kind: "sdk-local",
        agentId: "agent-initial",
        sdkRunId: "sdk-initial",
        async *stream() {
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "first" }] },
          } as never;
        },
        wait: async () => ({ status: "finished", result: "first" }) as never,
        cancel: async () => undefined,
        dispose: async () => undefined,
        sendFollowUp: async () => nextRun,
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
      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor: {
          kind: "sdk-local",
          spawn: async () => initialRun,
          resume: async () => resumedRun,
        },
        inputHub: inputHubFor(db),
        onRunCompleted,
      });

      try {
        seedRun(db, workspace, {
          runId: "placeholder",
          status: "completed",
        });
        db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

        const runId = await engine.triggerRun("auto");
        await until(() => statusOf(db, runId) === "completed");
        expect(onRunCompleted).toHaveBeenCalledTimes(1);

        await engine.sendMessage(runId, "follow up");
        await until(() => statusOf(db, runId) === "completed");

        expect(onRunCompleted).toHaveBeenCalledTimes(2);
        expect(onRunCompleted.mock.calls.every(([id]) => id === runId)).toBe(true);
      } finally {
        await engine.shutdown();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("swallows sink throws so settle is not broken", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b52-engine-sink-throw-"));
      const db = openDatabase(join(root, "state.sqlite"));
      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor: makeQuickExecutor(),
        inputHub: inputHubFor(db),
        onRunCompleted: () => {
          throw new Error("sink exploded");
        },
      });

      try {
        seedRun(db, join(root, "workspace"), {
          runId: "placeholder",
          status: "completed",
        });
        db.prepare("DELETE FROM runs WHERE id = 'placeholder'").run();

        const runId = await engine.triggerRun("auto");
        await until(() => statusOf(db, runId) === "completed");
        expect(statusOf(db, runId)).toBe("completed");
      } finally {
        await engine.shutdown();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("notifyOnRunCompleted", () => {
    function makeDeps(input: {
      run?: RunRow;
      automation?: AutomationRow;
      parseChainContext?: (row: RunRow) => ParsedChainContext | null;
      notifier?: {
        runCompleted: ReturnType<typeof vi.fn>;
        pipelineComplete: ReturnType<typeof vi.fn>;
      };
    }) {
      const runCompleted = input.notifier?.runCompleted ?? vi.fn();
      const pipelineComplete = input.notifier?.pipelineComplete ?? vi.fn();
      return {
        runCompleted,
        pipelineComplete,
        deps: {
          getRun: (id: string) =>
            input.run && input.run.id === id ? input.run : undefined,
          getAutomation: (id: string) =>
            input.automation && input.automation.id === id
              ? input.automation
              : undefined,
          parseChainContext: input.parseChainContext,
          notifier: { runCompleted, pipelineComplete },
        },
      };
    }

    it("calls runCompleted once for an ordinary automation", () => {
      const run = stubRun();
      const automation = stubAutomation({ name: "Daily lint" });
      const { deps, runCompleted, pipelineComplete } = makeDeps({ run, automation });

      notifyOnRunCompleted(run.id, deps);

      expect(runCompleted).toHaveBeenCalledTimes(1);
      expect(runCompleted).toHaveBeenCalledWith(run.id, "Daily lint");
      expect(pipelineComplete).not.toHaveBeenCalled();
    });

    it("calls both methods for implement-fully final-gate worker", () => {
      const run = stubRun({ automation_id: "fg" });
      const automation = stubAutomation({
        id: "fg",
        name: "Final gate",
        config_key: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY}`,
      });
      const { deps, runCompleted, pipelineComplete } = makeDeps({ run, automation });

      notifyOnRunCompleted(run.id, deps);

      expect(runCompleted).toHaveBeenCalledTimes(1);
      expect(runCompleted).toHaveBeenCalledWith(run.id, "Final gate");
      expect(pipelineComplete).toHaveBeenCalledTimes(1);
      expect(pipelineComplete).toHaveBeenCalledWith(run.id, "Final gate");
    });

    it("defers to the richer phase-completed toast for implement-fully context-aware workers", () => {
      const run = stubRun({
        automation_id: "worker",
        chain_depth: 2,
        chain_max_depth: 10,
        chain_root_run_id: "root-run",
        chain_context_json: JSON.stringify({
          variables: { pipelineId: IMPLEMENT_FULLY_PIPELINE_ID, featureId: "b60" },
          roleModels: {},
        }),
      });
      const automation = stubAutomation({
        id: "worker",
        name: "",
        config_key: `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`,
      });
      const parseChainContext = (row: RunRow): ParsedChainContext =>
        ({
          ok: true,
          context: JSON.parse(row.chain_context_json!),
        }) as ParsedChainContext;
      const { deps, runCompleted, pipelineComplete } = makeDeps({
        run,
        automation,
        parseChainContext,
      });

      notifyOnRunCompleted(run.id, deps);

      expect(runCompleted).not.toHaveBeenCalled();
      expect(pipelineComplete).not.toHaveBeenCalled();
    });

    it("does not defer when parseChainContext is unavailable, even for a context-aware run", () => {
      const run = stubRun({
        automation_id: "worker",
        chain_depth: 2,
        chain_max_depth: 10,
        chain_root_run_id: "root-run",
        chain_context_json: JSON.stringify({
          variables: { pipelineId: IMPLEMENT_FULLY_PIPELINE_ID, featureId: "b60" },
          roleModels: {},
        }),
      });
      const automation = stubAutomation({
        id: "worker",
        name: "",
        config_key: `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`,
      });
      const { deps, runCompleted } = makeDeps({ run, automation });

      notifyOnRunCompleted(run.id, deps);

      expect(runCompleted).toHaveBeenCalledTimes(1);
      expect(runCompleted).toHaveBeenCalledWith(run.id, "plan-phase");
    });

    it.each([
      ["integrate-wave", `${GENERATED_CONFIG_KEY_PREFIX}integrate-wave`],
      ["plan-phase", `${GENERATED_CONFIG_KEY_PREFIX}plan-phase`],
    ] as const)("calls runCompleted only for generated:%s worker", (_label, configKey) => {
      const run = stubRun({ automation_id: "worker" });
      const automation = stubAutomation({
        id: "worker",
        name: "",
        config_key: configKey,
      });
      const { deps, runCompleted, pipelineComplete } = makeDeps({ run, automation });

      notifyOnRunCompleted(run.id, deps);

      expect(runCompleted).toHaveBeenCalledTimes(1);
      expect(runCompleted).toHaveBeenCalledWith(run.id, _label);
      expect(pipelineComplete).not.toHaveBeenCalled();
    });

    it("no-ops when the run is missing", () => {
      const { deps, runCompleted, pipelineComplete } = makeDeps({});
      notifyOnRunCompleted("missing-run", deps);
      expect(runCompleted).not.toHaveBeenCalled();
      expect(pipelineComplete).not.toHaveBeenCalled();
    });

    it("calls unlabeled runCompleted when automation is missing", () => {
      const run = stubRun();
      const { deps, runCompleted, pipelineComplete } = makeDeps({ run });

      notifyOnRunCompleted(run.id, deps);

      expect(runCompleted).toHaveBeenCalledTimes(1);
      expect(runCompleted).toHaveBeenCalledWith(run.id, undefined);
      expect(pipelineComplete).not.toHaveBeenCalled();
    });

    it("does not throw when notifier methods throw", () => {
      const run = stubRun();
      const automation = stubAutomation({
        config_key: `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY}`,
      });
      const runCompleted = vi.fn(() => {
        throw new Error("runCompleted failed");
      });
      const pipelineComplete = vi.fn(() => {
        throw new Error("pipelineComplete failed");
      });
      const deps = {
        getRun: () => run,
        getAutomation: () => automation,
        notifier: { runCompleted, pipelineComplete },
      };

      expect(() => notifyOnRunCompleted(run.id, deps)).not.toThrow();
      expect(runCompleted).toHaveBeenCalledTimes(1);
      expect(pipelineComplete).toHaveBeenCalledTimes(1);
    });
  });
});
