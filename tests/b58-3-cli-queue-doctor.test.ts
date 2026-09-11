import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FeatureQueueEntry } from "@lca/shared";
import { DaemonClient, DaemonError } from "../packages/cli/src/client.ts";
import {
  buildImplementFullyKickoff,
  buildKickoffVariables,
  cmdImplementFully,
  parseImplementFullyArgs,
} from "../packages/cli/src/implement-fully.ts";
import {
  formatFeatureQueueLines,
  summarizeFeatureQueue,
} from "../packages/cli/src/doctor.ts";
import { cmdQueue } from "../packages/cli/src/queue.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import {
  DEFAULT_SETTINGS,
  type ResolvedSettings,
} from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { IMPLEMENT_FULLY_ENTRY_WORKER_KEY } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { FeatureQueueStore } from "../packages/daemon/src/runs/feature-queue-store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:os");
});

type Db = ReturnType<typeof openDatabase>;

const ROLE_DEFAULTS: ResolvedSettings["pipelineRoleModels"] = {
  planner: { id: "planner-default" },
  implementer: {
    id: "implementer-default",
    params: [{ id: "fast", value: "true" }],
  },
  reviewer: { id: "reviewer-default" },
  docs: { id: "docs-default" },
};

const DOCUMENTED_FEATURE_ID = "b42";
const DOCUMENTED_SLUG = "b42-my-feature";
const DOCUMENTED_IDEA =
  "Ship the kickoff verb. Prior art: docs/roadmap/b42-my-feature/prd.md.";
const FEATURE_ARGS = ["--feature", DOCUMENTED_FEATURE_ID];

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn should not be called in queue CLI tests");
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

function writeRoadmapIndex(workspacePath: string): void {
  const index = join(workspacePath, "docs", "roadmap", "00-index.md");
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(
    index,
    [
      "# Roadmap",
      "",
      "## Backlog",
      "",
      `- **${DOCUMENTED_FEATURE_ID}** Ship the kickoff verb. — [docs](./${DOCUMENTED_SLUG}/00-index.md)`,
      "",
    ].join("\n"),
    "utf8"
  );
  const featureDir = join(workspacePath, "docs", "roadmap", DOCUMENTED_SLUG);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, "00-index.md"), "# b42\n", "utf8");
  writeFileSync(join(featureDir, "prd.md"), "# prd\n", "utf8");
}

function seedWorkspaceDisk(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  writeRoadmapIndex(workspacePath);
}

async function withServer(
  run: (args: {
    port: number;
    db: Db;
    workspacePath: string;
    workspaceId: string;
    client: DaemonClient;
    queueStore: FeatureQueueStore;
  }) => Promise<void>,
  opts?: { settings?: ResolvedSettings }
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b58-3-"));
  const workspacePath = join(root, "workspace");
  const db = openDatabase(join(root, "state.sqlite"));
  seedWorkspaceDisk(workspacePath);
  const workspaceId = workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");

  const events = new DaemonEventBus();
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => {},
    onAnswered: () => {},
  });
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    inputHub,
    maxConcurrentRuns: 1,
    events,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    events,
  });
  const port = await freeListenPort();
  const triggers = new TriggerManager(db, engine, { port });
  const settings = opts?.settings ?? {
    ...DEFAULT_SETTINGS,
    pipelineRoleModels: ROLE_DEFAULTS,
  };
  const queueStore = new FeatureQueueStore(db);
  const http = await startHttpServer({
    engine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "test",
    port,
    settings,
    triggers,
    featureQueue: queueStore,
  });
  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  try {
    await run({ port, db, workspacePath, workspaceId, client, queueStore });
  } finally {
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function entry(
  overrides: Partial<FeatureQueueEntry> & Pick<FeatureQueueEntry, "id">
): FeatureQueueEntry {
  return {
    workspaceId: "ws-1",
    featureId: "b1",
    position: 1,
    after: [],
    state: "queued",
    runId: null,
    detail: null,
    createdAt: "2026-07-10 12:00:00",
    startedAt: null,
    settledAt: null,
    updatedAt: "2026-07-10 12:00:00",
    ...overrides,
  };
}

describe("b58.3 buildImplementFullyKickoff extraction", () => {
  it("matches cmdImplementFully kickoff payload and skips guard/trigger", async () => {
    await withServer(async ({ workspacePath, client }) => {
      const parsed = parseImplementFullyArgs(FEATURE_ARGS);
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const listRuns = vi.spyOn(client, "listRuns");
        const trigger = vi.spyOn(client, "triggerRunWithContext");

        const built = await buildImplementFullyKickoff(client, parsed);
        expect(listRuns).not.toHaveBeenCalled();
        expect(trigger).not.toHaveBeenCalled();

        const logCalls: unknown[][] = [];
        vi.spyOn(console, "log").mockImplementation((...args) => {
          logCalls.push(args);
        });
        await cmdImplementFully(client, [...FEATURE_ARGS, "--dry-run"]);

        const jsonLine = logCalls
          .map((call) => call[0])
          .find(
            (line): line is string =>
              typeof line === "string" && line.trimStart().startsWith("{")
          );
        expect(jsonLine).toBeDefined();
        const dryKickoff = JSON.parse(jsonLine!) as typeof built.kickoff;
        expect(built.kickoff).toEqual(dryKickoff);
        expect(built.kickoff.maxDepth).toBe(1);
        expect(built.kickoff.automationId).toBe(
          automationId(
            (await client.listWorkspaces()).find((w) => w.path === workspacePath)!
              .id,
            `generated:${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
          )
        );
        expect(built.kickoff.variables).toEqual(
          buildKickoffVariables(
            DOCUMENTED_FEATURE_ID,
            DOCUMENTED_SLUG,
            DOCUMENTED_IDEA
          )
        );
      } finally {
        process.chdir(prev);
      }
    });
  });
});

describe("b58.3 cmdQueue", () => {
  it("add enqueues after real provision", async () => {
    await withServer(async ({ workspacePath, workspaceId, client, queueStore, db }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdQueue(client, ["add", ...FEATURE_ARGS]);
        log.mockRestore();
      } finally {
        process.chdir(prev);
      }

      const rows = queueStore.listEntries(workspaceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.feature_id).toBe(DOCUMENTED_FEATURE_ID);
      expect(rows[0]!.state).toBe("queued");
      const autoCount = (
        db.prepare("SELECT COUNT(*) AS n FROM automations").get() as { n: number }
      ).n;
      expect(autoCount).toBeGreaterThan(0);
    });
  });

  it("surfaces daemon 400 for unknown dependency", async () => {
    await withServer(async ({ workspacePath, client }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        await expect(
          cmdQueue(client, [
            "add",
            ...FEATURE_ARGS,
            "--after",
            "b99",
          ])
        ).rejects.toThrow(/unknown dependency/i);
      } finally {
        process.chdir(prev);
      }
    });
  });

  it("surfaces 409 duplicate feature as DaemonError", async () => {
    await withServer(async ({ workspacePath, client }) => {
      const prev = process.cwd();
      process.chdir(workspacePath);
      try {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await cmdQueue(client, ["add", ...FEATURE_ARGS]);
        await expect(
          cmdQueue(client, ["add", ...FEATURE_ARGS])
        ).rejects.toThrow(DaemonError);
        log.mockRestore();
      } finally {
        process.chdir(prev);
      }
    });
  });

  it("list renders mixed states with dependencies and short run id", async () => {
    const entries: FeatureQueueEntry[] = [
      entry({
        id: "entry-queued",
        featureId: "b10",
        state: "queued",
        after: ["b9"],
      }),
      entry({
        id: "entry-blocked",
        featureId: "b11",
        state: "blocked",
        detail: "blocked by failed feature b9",
      }),
      entry({
        id: "entry-running",
        featureId: "b9",
        state: "running",
        runId: "run-abcdef12",
      }),
    ];

    class StubClient extends DaemonClient {
      override async listFeatureQueue(): Promise<FeatureQueueEntry[]> {
        return entries;
      }
    }
    const client = new StubClient("http://127.0.0.1:1");
    const logCalls: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logCalls.push(args);
    });
    await cmdQueue(client, ["list"]);
    const output = logCalls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/queued\s+b10/);
    expect(output).toMatch(/b9/);
    expect(output).toMatch(/blocked\s+b11/);
    expect(output).toMatch(/run-abcd/);
    expect(output).toMatch(/blocked by failed feature b9/);
  });

  it("rm resolves unique prefix and rejects ambiguous prefix", async () => {
    const entries: FeatureQueueEntry[] = [
      entry({ id: "aaaa1111-1111", featureId: "b1", state: "queued" }),
      entry({ id: "aaaa2222-2222", featureId: "b2", state: "queued" }),
    ];
    let cancelled: string | undefined;

    class StubClient extends DaemonClient {
      override async listFeatureQueue(): Promise<FeatureQueueEntry[]> {
        return entries;
      }
      override async cancelFeatureQueueEntry(
        id: string
      ): Promise<FeatureQueueEntry> {
        cancelled = id;
        return entries.find((e) => e.id === id)!;
      }
    }
    const client = new StubClient("http://127.0.0.1:1");

    await expect(cmdQueue(client, ["rm", "aaaa"])).rejects.toThrow(/Ambiguous/);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await cmdQueue(client, ["rm", "aaaa1111"]);
    log.mockRestore();
    expect(cancelled).toBe("aaaa1111-1111");
  });

  it("clear cancels queued and blocked only", async () => {
    const entries: FeatureQueueEntry[] = [
      entry({ id: "q1", featureId: "b1", state: "queued" }),
      entry({ id: "b1-blocked", featureId: "b2", state: "blocked" }),
      entry({
        id: "r1",
        featureId: "b3",
        state: "running",
        runId: "run-running",
      }),
      entry({ id: "d1", featureId: "b4", state: "done" }),
      entry({ id: "f1", featureId: "b5", state: "failed" }),
    ];
    const cancelled: string[] = [];

    class StubClient extends DaemonClient {
      override async listFeatureQueue(): Promise<FeatureQueueEntry[]> {
        return entries;
      }
      override async cancelFeatureQueueEntry(
        id: string
      ): Promise<FeatureQueueEntry> {
        cancelled.push(id);
        return entries.find((e) => e.id === id)!;
      }
    }
    const client = new StubClient("http://127.0.0.1:1");
    const logCalls: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logCalls.push(args);
    });
    await cmdQueue(client, ["clear"]);
    expect(cancelled.sort()).toEqual(["b1-blocked", "q1"]);
    expect(logCalls.map((c) => c.join(" ")).join("\n")).toMatch(
      /Cancelled 2 waiting entries/
    );
  });
});

describe("b58.3 doctor feature queue formatters", () => {
  it("empty queue is one line", () => {
    const lines = formatFeatureQueueLines(summarizeFeatureQueue([]));
    expect(lines).toEqual(["  (no queued features)"]);
  });

  it("running-with-waiting shows counts, running, and next eligible", () => {
    const entries: FeatureQueueEntry[] = [
      entry({
        id: "e1",
        featureId: "b1",
        state: "done",
        position: 1,
      }),
      entry({
        id: "e2",
        featureId: "b2",
        state: "running",
        runId: "run-12345678",
        position: 2,
      }),
      entry({
        id: "e3",
        featureId: "b3",
        state: "queued",
        after: ["b1"],
        position: 3,
      }),
    ];
    const summary = summarizeFeatureQueue(entries);
    expect(summary.running).toEqual({
      featureId: "b2",
      runId: "run-12345678",
    });
    expect(summary.nextEligibleFeatureId).toBe("b3");
    const lines = formatFeatureQueueLines(summary);
    expect(lines.some((l) => l.includes("running: b2"))).toBe(true);
    expect(lines.some((l) => l.includes("next: b3"))).toBe(true);
  });

  it("failed and blocked entries include detail", () => {
    const entries: FeatureQueueEntry[] = [
      entry({
        id: "e1",
        featureId: "b1",
        state: "failed",
        detail: "terminal worker failed",
      }),
      entry({
        id: "e2",
        featureId: "b2",
        state: "blocked",
        detail: "blocked by failed feature b1",
      }),
    ];
    const lines = formatFeatureQueueLines(summarizeFeatureQueue(entries));
    expect(lines.some((l) => l.includes("failed: b1 — terminal worker failed"))).toBe(
      true
    );
    expect(
      lines.some((l) => l.includes("blocked: b2 — blocked by failed feature b1"))
    ).toBe(true);
  });
});
