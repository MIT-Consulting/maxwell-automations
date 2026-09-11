import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Run } from "@lca/shared";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  diagnoseRun,
  formatPipelineHealthLines,
  summarizePipelineHealth,
} from "../packages/cli/src/doctor.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import type { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import {
  RunEngine,
  RunMessageError,
} from "../packages/daemon/src/runs/engine.ts";
import { freeListenPort } from "./helpers/free-port.ts";

function listRun(
  id: string,
  opts: Partial<Run> & { depth?: number } = {}
): Run {
  const depth = opts.depth ?? 0;
  return {
    id,
    automationId: opts.automationId ?? "ws::generated:implement",
    workspaceId: "ws-1",
    status: opts.status ?? "running",
    triggerKind: "chain",
    prompt: null,
    title: null,
    summary: null,
    agentId: null,
    sdkRunId: null,
    startedAt: "2026-07-10 12:00:00",
    endedAt: null,
    createdAt: "2026-07-10 12:00:00",
    parentRunId: opts.parentRunId ?? null,
    chainRootRunId: opts.chainRootRunId ?? id,
    chainDepth: depth,
    chainMaxDepth: 9,
    chainContextJson: null,
    chainHandledAt: opts.chainHandledAt ?? null,
    chainStopRequestedAt: null,
    chainStopReason: null,
    chainMaxDepthOverride: null,
    pipeline: opts.pipeline ?? {
      pipelineId: "implement-fully",
      featureId: "b50",
      featureSlug: "b50-steer",
    },
    pipelineWave: opts.pipelineWave ?? null,
    pipelineTrack: opts.pipelineTrack ?? null,
    modelSelection: null,
    ...opts,
  };
}

function pausedSnapshot(): RunSnapshot {
  return {
    run: {
      id: "run-paused",
      status: "paused",
      automation_id: "ws::generated:implement",
      workspace_id: "ws-1",
      trigger_kind: "chain",
      agent_id: "agent-1",
      sdk_run_id: "sdk-1",
      prompt: null,
      title: null,
      summary: null,
      started_at: "2026-07-10 12:00:00",
      ended_at: null,
      created_at: "2026-07-10 12:00:00",
      chain_root_run_id: "root-paused",
      chain_depth: 1,
      chain_max_depth: 9,
      chain_context_json: null,
      chain_handled_at: null,
    },
    events: [{ seq: 1, event_type: "run.paused", payload: "{}" }],
  };
}

describe("b50 pause/resume HTTP surfaces", () => {
  it("maps pause/resume REST statuses and error codes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b50-http-pause-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const port = await freeListenPort();
    let error: RunMessageError | undefined;
    const http = await startHttpServer({
      engine: {
        pauseRun: async () => {
          if (error) throw error;
        },
        resumeRun: async () => {
          if (error) throw error;
        },
      } as unknown as RunEngine,
      chatEngine: {} as unknown as ChatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    try {
      const pauseOk = await fetch(`http://127.0.0.1:${port}/api/runs/run-1/pause`, {
        method: "POST",
      });
      expect(pauseOk.status).toBe(200);
      expect(await pauseOk.json()).toEqual({ ok: true });

      const resumeOk = await fetch(`http://127.0.0.1:${port}/api/runs/run-1/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resumeOk.status).toBe(202);
      expect(await resumeOk.json()).toEqual({ ok: true });

      const resumeNote = await fetch(`http://127.0.0.1:${port}/api/runs/run-1/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "  " }),
      });
      expect(resumeNote.status).toBe(202);

      error = new RunMessageError("not_found", "Run not found: run-1");
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/runs/run-1/pause`, { method: "POST" }))
          .status
      ).toBe(404);

      error = new RunMessageError("busy", "Run run-1 cannot be paused from status completed");
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/runs/run-1/pause`, { method: "POST" }))
          .status
      ).toBe(409);
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b50 doctor pause visibility", () => {
  it("counts paused pipelines separately and formats paused health lines", () => {
    const now = Date.parse("2026-07-10T14:00:00Z");
    const runs: Run[] = [
      listRun("root-running", {
        status: "running",
        chainRootRunId: "root-running",
        depth: 1,
      }),
      listRun("root-paused", {
        status: "paused",
        chainRootRunId: "root-paused",
        depth: 2,
      }),
    ];
    const summary = summarizePipelineHealth(runs, now, 30 * 60 * 1000);
    expect(summary.activeCount).toBe(2);
    expect(summary.pausedCount).toBe(1);

    const withPaused = formatPipelineHealthLines(summary);
    expect(withPaused.some((line) => line.includes("paused: 1"))).toBe(true);

    const noPaused = formatPipelineHealthLines({
      ...summary,
      pausedCount: 0,
    });
    expect(noPaused.some((line) => line.startsWith("  paused:"))).toBe(false);
  });

  it("diagnoseRun on paused runs yields parked guidance, not halt copy", () => {
    const parked = diagnoseRun(pausedSnapshot(), []);
    expect(parked).toMatch(/paused by an operator/i);
    expect(parked).toMatch(/steering messages are allowed/i);
    expect(parked).not.toMatch(/halted/i);
    expect(parked).not.toMatch(/stale/i);

    const halted = diagnoseRun(
      {
        run: {
          ...pausedSnapshot().run,
          status: "failed",
          ended_at: "2026-07-10 12:01:00",
        },
        events: [
          {
            seq: 1,
            event_type: "run.error",
            payload: JSON.stringify({ reason: "sdk_error" }),
          },
        ],
      },
      []
    );
    expect(halted).toMatch(/failed|sdk_error/i);
    expect(halted).not.toMatch(/paused by an operator/i);
  });
});
