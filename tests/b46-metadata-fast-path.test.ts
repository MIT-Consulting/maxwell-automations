import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import { IMPLEMENT_FULLY_PIPELINE_ID } from "@lca/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  buildImplementFullyRunMetadata,
} from "../packages/daemon/src/runs/auto-metadata.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import {
  extractImplementFullyHandoff,
} from "../packages/daemon/src/runs/pipeline-handoff.ts";
import type {
  ActiveRun,
  Executor,
} from "../packages/daemon/src/executor/types.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function validPacket(worker = "implement"): string {
  return [
    "```text",
    "lca-handoff",
    "version: 1",
    `pipeline: ${IMPLEMENT_FULLY_PIPELINE_ID}`,
    `worker: ${worker}`,
    "feature: feat-meta",
    "phase: 02-compact.md",
    "outcome: implemented",
    "summary: Compact handoff metadata path works",
    "artifacts:",
    "- none",
    "decisions:",
    "- none",
    "deviations:",
    "- none",
    "verification:",
    "- npm test => pass",
    "risks:",
    "- none",
    "downstream-effects:",
    "- none",
    "next: review next",
    "```",
  ].join("\n");
}

function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
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

function makeExecutor(outcome: {
  status: "finished" | "error";
  result?: string;
  error?: string;
}): Executor {
  const activeRun: ActiveRun = {
    kind: "sdk-local",
    agentId: "agent-b46",
    sdkRunId: "sdk-b46",
    async *stream() {},
    wait: async () => {
      if (outcome.status === "error") {
        return { status: "error", error: outcome.error ?? "boom" } as never;
      }
      return { status: "finished", result: outcome.result ?? "" } as never;
    },
    cancel: async () => {},
    dispose: async () => {},
  };
  return {
    kind: "sdk-local",
    spawn: async () => activeRun,
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

const CTX = {
  variables: {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "feat-meta",
    featureSlug: "feat-meta",
    featureDir: "docs/roadmap/feat-meta",
    featureIndex: "docs/roadmap/feat-meta/00-index.md",
    idea: "meta",
  },
  roleModels: {},
};

describe("b46 buildImplementFullyRunMetadata", () => {
  it("caps title/summary and prefers handoff summary", () => {
    const extracted = extractImplementFullyHandoff(validPacket());
    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    const meta = buildImplementFullyRunMetadata({
      workerKey: "implement",
      featureId: "feat-meta",
      status: "completed",
      packet: extracted.packet,
    });
    expect(meta.title.length).toBeLessThanOrEqual(56);
    expect(meta.summary.length).toBeLessThanOrEqual(180);
    expect(meta.summary).toBe("Compact handoff metadata path works");
    expect(meta.title).toContain("implement");
    expect(meta.title).toContain("feat-meta");
  });

  it("uses deterministic failure metadata without a packet", () => {
    const meta = buildImplementFullyRunMetadata({
      workerKey: "review",
      featureId: "feat-meta",
      status: "failed",
      packet: null,
      errorHint: "Review Gate red",
    });
    expect(meta.title.startsWith("Failed:")).toBe(true);
    expect(meta.summary).toContain("Review Gate red");
  });
});

describe("b46 metadata fast path via engine", () => {
  async function runCase(outcome: {
    status: "finished" | "error";
    result?: string;
    error?: string;
  }): Promise<{ title: string; summary: string; promptCalls: number }> {
    const promptSpy = vi.spyOn(Agent, "prompt").mockResolvedValue({
      status: "finished",
      result: '{"title":"SHOULD NOT","summary":"appear"}',
    } as never);

    const root = mkdtempSync(join(tmpdir(), "lca-b46-meta-"));
    const ws = join(root, "ws");
    mkdirSync(ws, { recursive: true });
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    db.prepare(
      `INSERT INTO workspaces (id, name, path) VALUES ('ws', 'WS', ?)`
    ).run(ws);
    db.prepare(
      `INSERT INTO automations (
         id, workspace_id, name, enabled, status, trigger_json, prompt, model,
         config_path, config_key, chain_json
       ) VALUES (
         'ws::impl', 'ws', 'Impl', 1, 'enabled', ?, 'do it', null,
         'test.yaml', 'generated:implement', null
       )`
    ).run(JSON.stringify({ type: "manual" }));

    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: makeExecutor(outcome),
      events,
      inputHub,
      maxConcurrentRuns: 4,
    });

    try {
      const runId = await engine.triggerRun("ws::impl", "manual", {
        chainContext: CTX,
        chainMaxDepth: 40,
      });
      await until(() => {
        const row = db
          .prepare("SELECT status, title FROM runs WHERE id = ?")
          .get(runId) as { status: string; title: string | null };
        return (
          (row.status === "completed" || row.status === "failed") &&
          row.title != null
        );
      });
      const final = db
        .prepare("SELECT title, summary FROM runs WHERE id = ?")
        .get(runId) as { title: string; summary: string };
      return {
        title: final.title,
        summary: final.summary,
        promptCalls: promptSpy.mock.calls.length,
      };
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }

  it("never calls Agent.prompt for success, failure, or malformed packet", async () => {
    const ok = await runCase({
      status: "finished",
      result: validPacket(),
    });
    expect(ok.promptCalls).toBe(0);
    expect(ok.summary).toBe("Compact handoff metadata path works");
    expect(ok.title).toContain("implement");

    const bad = await runCase({
      status: "finished",
      result: "no packet here",
    });
    expect(bad.promptCalls).toBe(0);
    expect(bad.summary).toMatch(/without a valid handoff/i);

    const fail = await runCase({
      status: "error",
      error: "Review Gate red",
    });
    expect(fail.promptCalls).toBe(0);
    expect(fail.title.startsWith("Failed:")).toBe(true);
  });
});
