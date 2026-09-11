import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HALT_DISCOVERY_INPUT_KIND,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  INPUT_ANSWER_MAX_LENGTH,
  answerRunInputSchema,
} from "@lca/shared";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import type { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { isPlanApprovalShaped } from "../packages/daemon/src/input/plan-approval-shape.ts";
import {
  InputStore,
  parseInputMetadataJson,
} from "../packages/daemon/src/input/store.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { freeListenPort } from "./helpers/free-port.ts";

const RESEARCH_REVIEW_META = {
  kind: "research-review",
  choices: [
    { id: "approve", label: "Approve as-is" },
    { id: "comment", label: "Add comments" },
  ],
  recommendedChoiceId: "approve",
  artifacts: [
    {
      label: "research.md",
      path: "docs/roadmap/done/b56-optional-researcher-gatekeeper/research.md",
    },
  ],
} as const;

const RESEARCH_COMMENTS_META = {
  kind: "research-comments",
  artifacts: [
    {
      label: "research.md",
      path: "docs/roadmap/done/b56-optional-researcher-gatekeeper/research.md",
    },
  ],
} as const;

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

function statusOf(
  db: ReturnType<typeof openDatabase>,
  runId: string
): string | undefined {
  const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as
    | { status: string }
    | undefined;
  return row?.status;
}

function pendingStatus(
  db: ReturnType<typeof openDatabase>,
  runId: string
): string | undefined {
  const row = db
    .prepare(
      `SELECT status FROM input_requests WHERE run_id = ? AND status = 'pending'`
    )
    .get(runId) as { status: string } | undefined;
  return row?.status;
}

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
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
  ).run(workspace);
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'Original prompt',
      'config.yaml', 'generated:research'
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
    onNeedsInput: (runId) => {
      if (statusOf(db, runId) === "running") {
        db.prepare("UPDATE runs SET status = 'needs_input' WHERE id = ?").run(
          runId
        );
      }
    },
    onAnswered: (runId) => {
      if (statusOf(db, runId) === "needs_input") {
        db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
      }
    },
  });
}

function idleExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn should not be called");
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

describe("b56.3 shared answer bounds", () => {
  it("exports INPUT_ANSWER_MAX_LENGTH as 8 KiB", () => {
    expect(INPUT_ANSWER_MAX_LENGTH).toBe(8 * 1024);
  });

  it("answerRunInputSchema trims, rejects empty/whitespace, over-cap, and unknown keys", () => {
    expect(answerRunInputSchema.parse({ answer: "  ship it  " })).toEqual({
      answer: "ship it",
    });
    expect(() => answerRunInputSchema.parse({ answer: "" })).toThrow();
    expect(() => answerRunInputSchema.parse({ answer: "   " })).toThrow();
    expect(() =>
      answerRunInputSchema.parse({
        answer: "x".repeat(INPUT_ANSWER_MAX_LENGTH + 1),
      })
    ).toThrow();
    expect(() =>
      answerRunInputSchema.parse({ answer: "ok", extra: true })
    ).toThrow();
  });
});

describe("b56.3 HTTP answer boundary", () => {
  it("rejects over-cap answers with 400 and leaves the request pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-http-cap-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const hub = inputHubFor(db);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: idleExecutor(),
      inputHub: hub,
    });
    const port = await freeListenPort();
    const http = await startHttpServer({
      engine,
      chatEngine: {} as unknown as ChatEngine,
      store: new DashboardStore(db),
      db,
      events: new DaemonEventBus(),
      apiKey: "test",
      port,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "needs_input",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      hub.presentWithoutWait("run", "Review research?", RESEARCH_REVIEW_META);
      expect(pendingStatus(db, "run")).toBe("pending");

      const over = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent("run")}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            answer: "x".repeat(INPUT_ANSWER_MAX_LENGTH + 1),
          }),
        }
      );
      expect(over.status).toBe(400);
      expect(pendingStatus(db, "run")).toBe("pending");
      expect(statusOf(db, "run")).toBe("needs_input");

      const ok = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent("run")}/answer`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: "approve" }),
        }
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      expect(pendingStatus(db, "run")).toBeUndefined();
    } finally {
      await http.close();
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b56.3 Input Hub research-review / research-comments", () => {
  it("accepts only approve/comment ids; free text and unknown ids stay pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-review-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
      });
      const hub = inputHubFor(db);
      expect(isPlanApprovalShaped(RESEARCH_REVIEW_META)).toBe(false);

      const p = hub.ask("run", "Review research?", RESEARCH_REVIEW_META);
      expect(() => hub.submitAnswer("run", "looks good")).toThrow(
        /declared choice ids/
      );
      expect(() => hub.submitAnswer("run", "Approve as-is")).toThrow(
        /declared choice ids/
      );
      expect(() => hub.submitAnswer("run", "revise")).toThrow(
        /declared choice ids/
      );
      expect(pendingStatus(db, "run")).toBe("pending");

      hub.submitAnswer("run", "approve");
      await expect(p).resolves.toBe("approve");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts comment id then free-form research-comments text within the cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-comments-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
      });
      const hub = inputHubFor(db);

      const step1 = hub.ask("run", "Review research?", RESEARCH_REVIEW_META);
      hub.submitAnswer("run", "comment");
      await expect(step1).resolves.toBe("comment");

      const verbatim = "  Keep the Sol path; drop the Luna detour.  ";
      const step2 = hub.ask("run", "Comments?", RESEARCH_COMMENTS_META);
      expect(() =>
        hub.submitAnswer("run", "x".repeat(INPUT_ANSWER_MAX_LENGTH + 1))
      ).toThrow(/8192|maximum length/i);
      expect(pendingStatus(db, "run")).toBe("pending");

      hub.submitAnswer("run", verbatim);
      await expect(step2).resolves.toBe(verbatim);

      const answered = db
        .prepare(
          `SELECT answer, metadata_json FROM input_requests
           WHERE run_id = 'run' AND status = 'answered'
             AND metadata_json LIKE '%research-comments%'`
        )
        .get() as { answer: string; metadata_json: string };
      expect(answered.answer).toBe(verbatim);
      expect(parseInputMetadataJson(answered.metadata_json)?.kind).toBe(
        "research-comments"
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b56.3 engine round trip, stall, restart, cancel", () => {
  it("askAndWait flips needs_input and resolves for both research steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-engine-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const hub = inputHubFor(db);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: idleExecutor(),
      inputHub: hub,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
        agentId: "agent",
        sdkRunId: "sdk",
      });

      const review = engine.askAndWait(
        "run",
        "Review research?",
        undefined,
        RESEARCH_REVIEW_META
      );
      await until(() => statusOf(db, "run") === "needs_input");
      await engine.submitAnswer("run", "comment");
      await expect(review).resolves.toBe("comment");
      expect(statusOf(db, "run")).toBe("running");

      const comments = engine.askAndWait(
        "run",
        "Add comments",
        undefined,
        RESEARCH_COMMENTS_META
      );
      await until(() => statusOf(db, "run") === "needs_input");
      await engine.submitAnswer("run", "prefer Sol");
      await expect(comments).resolves.toBe("prefer Sol");
      expect(statusOf(db, "run")).toBe("running");
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("needs_input research runs are not stall candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-stall-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const hub = inputHubFor(db);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: idleExecutor(),
      events,
      inputHub: hub,
      runStallTimeoutMs: 1000,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "needs_input",
        agentId: "agent",
        sdkRunId: "sdk",
      });
      hub.presentWithoutWait("run", "Review research?", RESEARCH_REVIEW_META);
      db.prepare(
        `UPDATE runs SET updated_at = datetime('now','-3600 seconds') WHERE id = ?`
      ).run("run");

      expect(store.listStallCandidates().map((r) => r.id)).not.toContain("run");
      engine.runStallSweep();
      expect(statusOf(db, "run")).toBe("needs_input");
      expect(pendingStatus(db, "run")).toBe("pending");
    } finally {
      void engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("needs_input research runs remain resumable with metadata intact", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-resume-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    const hub = inputHubFor(db);

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "needs_input",
        agentId: "agent-research",
        sdkRunId: "sdk-research",
      });
      hub.presentWithoutWait("run", "Review research?", RESEARCH_REVIEW_META);

      const resumable = store.listResumableRuns().map((r) => r.id);
      expect(resumable).toContain("run");

      const pending = hub.getPendingQuestion("run");
      expect(pending?.status).toBe("pending");
      expect(parseInputMetadataJson(pending!.metadata_json)).toMatchObject({
        kind: "research-review",
        recommendedChoiceId: "approve",
        choices: [
          { id: "approve", label: "Approve as-is" },
          { id: "comment", label: "Add comments" },
        ],
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cancelRun cancels pending research request and produces no chain successor", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-cancel-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const hub = inputHubFor(db);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: idleExecutor(),
      inputHub: hub,
    });

    try {
      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
        agentId: "agent",
        sdkRunId: "sdk",
      });

      const waiter = engine.askAndWait(
        "run",
        "Review research?",
        undefined,
        RESEARCH_REVIEW_META
      );
      await until(() => statusOf(db, "run") === "needs_input");

      await engine.cancelRun("run");
      await expect(waiter).rejects.toThrow(/cancelled/i);
      expect(statusOf(db, "run")).toBe("cancelled");

      const req = db
        .prepare(
          `SELECT status FROM input_requests WHERE run_id = 'run' ORDER BY created_at DESC LIMIT 1`
        )
        .get() as { status: string };
      expect(req.status).toBe("cancelled");

      const successors = db
        .prepare(
          `SELECT id FROM runs WHERE parent_run_id = 'run' OR id LIKE '%plan-skeleton%'`
        )
        .all() as Array<{ id: string }>;
      expect(successors).toHaveLength(0);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("research kinds are not halt-discovery and answering does not escalate", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b56-3-no-esc-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const hub = inputHubFor(db);
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: idleExecutor(),
      inputHub: hub,
    });

    try {
      expect(RESEARCH_REVIEW_META.kind).not.toBe(HALT_DISCOVERY_INPUT_KIND);
      expect(RESEARCH_COMMENTS_META.kind).not.toBe(HALT_DISCOVERY_INPUT_KIND);
      expect(isPlanApprovalShaped(RESEARCH_REVIEW_META)).toBe(false);

      seedRun(db, join(root, "workspace"), {
        runId: "run",
        status: "running",
        agentId: "agent",
        sdkRunId: "sdk",
      });

      const p = engine.askAndWait(
        "run",
        "Review research?",
        undefined,
        RESEARCH_REVIEW_META
      );
      await until(() => statusOf(db, "run") === "needs_input");
      await engine.submitAnswer("run", "approve");
      await expect(p).resolves.toBe("approve");

      const haltEvents = (
        db
          .prepare(
            `SELECT event_type FROM run_events WHERE run_id = 'run' AND event_type LIKE '%halt%'`
          )
          .all() as Array<{ event_type: string }>
      ).map((e) => e.event_type);
      expect(haltEvents).toHaveLength(0);
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b56.3 prompt contract", () => {
  it("research prompt owns the before-planning checkpoint and Operator Review", () => {
    const research = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === IMPLEMENT_FULLY_RESEARCH_WORKER_KEY
    )!;
    const prompt = research.prompt;
    expect(prompt).toContain("{{researchApprovalPolicy}}");
    expect(prompt).toContain("before-planning");
    expect(prompt).toContain("research-review");
    expect(prompt).toContain("research-comments");
    expect(prompt).toContain("approve");
    expect(prompt).toContain("comment");
    expect(prompt).toContain("Approve as-is");
    expect(prompt).toContain("Add comments");
    expect(prompt).toContain("## Operator Review");
    expect(prompt).toContain("{{featureDir}}/research.md");
    expect(prompt).not.toMatch(/not honored yet/);
    expect(prompt).not.toMatch(/Reserve the section name/);
  });

  it("plan-skeleton reads Operator Review as authoritative", () => {
    const skeleton = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === IMPLEMENT_FULLY_ENTRY_WORKER_KEY
    )!;
    expect(skeleton.prompt).toContain("## Operator Review");
    expect(skeleton.prompt).toMatch(/authoritative/i);
  });
});
