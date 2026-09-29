import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  modelSelectionKey,
  parseModelSelectionKey,
  type ModelSelection,
} from "@lca/shared";
import type { ActiveRun, Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  ModelPreflight,
  formatModelPreflightFailures,
  type ModelProbe,
} from "../packages/daemon/src/models/preflight.ts";
import {
  RunEngine,
  TriggerRunValidationError,
} from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";

const REJECTED = 'AI Model Not Found Invalid parameters for registry model: "grok-4.7"';

const GOOD: ModelSelection = { id: "composer-2.5", params: [{ id: "fast", value: "true" }] };
const BAD: ModelSelection = {
  id: "grok-4.7",
  params: [
    { id: "context", value: "500k" },
    { id: "reasoning_effort", value: "xhigh" },
  ],
};

function probeRejecting(bad: ModelSelection["id"]): ModelProbe & { calls: ModelSelection[] } {
  const calls: ModelSelection[] = [];
  const probe = (async (selection: ModelSelection) => {
    calls.push(selection);
    return selection.id === bad ? { ok: false, message: REJECTED } : { ok: true };
  }) as ModelProbe & { calls: ModelSelection[] };
  probe.calls = calls;
  return probe;
}

function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("until() timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function executorReturning(result: Awaited<ReturnType<ActiveRun["wait"]>>): Executor {
  const active: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-preflight",
    sdkRunId: "sdk-preflight",
    async *stream() {},
    wait: async () => result,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
  return { kind: "sdk-local", spawn: async () => active, resume: async () => active };
}

function createEnv(options: {
  executor?: Executor;
  modelPreflight?: ModelPreflight;
}) {
  const root = mkdtempSync(join(tmpdir(), "lca-preflight-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')").run(
    workspace
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES ('ws::root', 'ws', 'Root', 1, 'enabled', '{"type":"manual"}', 'Go', 'test.yaml', 'root')`
  ).run();
  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor:
      options.executor ??
      executorReturning({ id: "r", status: "finished", result: "done" } as never),
    events,
    inputHub: new InputHub(new InputStore(db), {
      onNeedsInput: () => undefined,
      onAnswered: () => undefined,
    }),
    maxConcurrentRuns: 2,
    ...(options.modelPreflight ? { modelPreflight: options.modelPreflight } : {}),
  });
  const runCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  const destroy = async () => {
    await engine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { db, store, engine, runCount, destroy };
}

describe("parseModelSelectionKey", () => {
  it("round-trips modelSelectionKey and normalizes param order", () => {
    const parsed = parseModelSelectionKey("grok-4.7?reasoning_effort=xhigh&context=256k");
    expect(parsed).toEqual({
      id: "grok-4.7",
      params: [
        { id: "context", value: "256k" },
        { id: "reasoning_effort", value: "xhigh" },
      ],
    });
    expect(parseModelSelectionKey(modelSelectionKey(parsed))).toEqual(parsed);
    expect(parseModelSelectionKey("composer-2.5")).toEqual({ id: "composer-2.5" });
  });

  it("rejects malformed specs", () => {
    expect(() => parseModelSelectionKey("grok-4.7?")).toThrow(/empty parameter list/);
    expect(() => parseModelSelectionKey("grok-4.7?context")).toThrow(/key=value/);
    expect(() => parseModelSelectionKey("?context=256k")).toThrow(/non-empty/);
    expect(() => parseModelSelectionKey("m?a=1&a=2")).toThrow(/duplicate/);
  });
});

describe("ModelPreflight.check", () => {
  it("probes each distinct selection once and names every role that uses a rejected one", async () => {
    const probe = probeRejecting("grok-4.7");
    const preflight = new ModelPreflight({ probe });
    const failures = await preflight.check({
      planner: GOOD,
      implementer: GOOD,
      reviewer: BAD,
      gatekeeper: BAD,
    });
    expect(probe.calls).toHaveLength(2);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.roles).toEqual(["reviewer", "gatekeeper"]);
    expect(failures[0]!.message).toBe(REJECTED);
    expect(formatModelPreflightFailures(failures)).toContain(
      "reviewer/gatekeeper → grok-4.7 (context=500k, reasoning_effort=xhigh)"
    );
  });

  it("caches passes within the TTL but always re-probes failures", async () => {
    let now = 0;
    const probe = probeRejecting("grok-4.7");
    const preflight = new ModelPreflight({ probe, successTtlMs: 1000, now: () => now });

    await preflight.check({ planner: GOOD, reviewer: BAD });
    await preflight.check({ planner: GOOD, reviewer: BAD });
    expect(probe.calls.map((s) => s.id)).toEqual(["composer-2.5", "grok-4.7", "grok-4.7"]);

    now = 2000;
    await preflight.check({ planner: GOOD });
    expect(probe.calls.filter((s) => s.id === "composer-2.5")).toHaveLength(2);
  });

  it("treats a thrown probe as a failure and an inconclusive probe as a pass-through", async () => {
    const onLog = vi.fn();
    const preflight = new ModelPreflight({
      onLog,
      probe: async (selection) => {
        if (selection.id === "composer-2.5") throw new Error("startup failed: boom");
        return { ok: "inconclusive", message: "no result within 60000ms" };
      },
    });
    const failures = await preflight.check({ implementer: GOOD, reviewer: BAD });
    expect(failures.map((f) => f.message)).toEqual(["startup failed: boom"]);
    expect(onLog).toHaveBeenCalledWith(expect.stringMatching(/inconclusive.*allowing kickoff/));
  });
});

describe("RunEngine kickoff preflight", () => {
  it("refuses a context root whose role model is rejected and inserts no run", async () => {
    const probe = probeRejecting("grok-4.7");
    const env = createEnv({ modelPreflight: new ModelPreflight({ probe }) });
    try {
      const attempt = env.engine.triggerRun("ws::root", "manual", {
        chainContext: { variables: {}, roleModels: { implementer: GOOD, reviewer: BAD } },
        chainMaxDepth: 3,
      });
      await expect(attempt).rejects.toBeInstanceOf(TriggerRunValidationError);
      await expect(attempt).rejects.toThrow(/model preflight failed.*reviewer.*registry model/);
      expect(env.runCount()).toBe(0);
    } finally {
      await env.destroy();
    }
  });

  it("creates the root when every role model passes and skips probing child transitions", async () => {
    const probe = probeRejecting("grok-4.7");
    const env = createEnv({ modelPreflight: new ModelPreflight({ probe }) });
    try {
      const rootId = await env.engine.triggerRun("ws::root", "manual", {
        chainContext: { variables: {}, roleModels: { implementer: GOOD } },
        chainMaxDepth: 3,
      });
      expect(env.store.getRun(rootId)?.chain_depth).toBe(0);

      await env.engine.triggerRun("ws::root", "chain", {
        parentRunId: rootId,
        chainRootRunId: rootId,
        chainDepth: 1,
        chainContext: { variables: {}, roleModels: { reviewer: BAD } },
        chainMaxDepth: 3,
      });
      expect(probe.calls.map((s) => s.id)).toEqual(["composer-2.5"]);
      expect(env.runCount()).toBe(2);
    } finally {
      await env.destroy();
    }
  });
});

describe("RunEngine sdk_error detail", () => {
  it("records RunResult.error.message on the run.error event", async () => {
    const env = createEnv({
      executor: executorReturning({
        id: "r",
        status: "error",
        error: { message: REJECTED, code: "model_not_found" },
      } as never),
    });
    try {
      const runId = await env.engine.triggerRun("ws::root");
      await until(() => env.store.getRun(runId)?.status === "failed");
      await until(() =>
        env.store.listRunEvents(runId).some((e) => e.event_type === "run.error")
      );
      const errorEvent = env.store
        .listRunEvents(runId)
        .find((e) => e.event_type === "run.error")!;
      expect(JSON.parse(errorEvent.payload)).toMatchObject({
        reason: "sdk_error",
        message: REJECTED,
        sdkErrorCode: "model_not_found",
      });
    } finally {
      await env.destroy();
    }
  });
});
