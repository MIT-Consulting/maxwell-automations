import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES,
  type InputRequest,
  type ModelSelection,
} from "@lca/shared";
import { DaemonClient } from "../packages/cli/src/client.ts";
import {
  cmdImplementFully,
  parseImplementFullyArgs,
} from "../packages/cli/src/implement-fully.ts";
import { formatInputRequest } from "../packages/cli/src/input-request.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
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
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
});

type Db = ReturnType<typeof openDatabase>;

const DOCUMENTED_FEATURE_ID = "b56";
const DOCUMENTED_SLUG = "b56-optional-researcher-gatekeeper";

const FOUR_ROLE_DEFAULTS: ResolvedSettings["pipelineRoleModels"] = {
  planner: { id: "planner-default" },
  implementer: {
    id: "implementer-default",
    params: [{ id: "fast", value: "true" }],
  },
  reviewer: { id: "reviewer-default" },
  docs: { id: "docs-default" },
};

const RESEARCHER_SELECTION: ModelSelection = {
  id: "fable-research",
  params: [{ id: "thinking", value: "high" }],
};

const SIX_ROLE_DEFAULTS: ResolvedSettings["pipelineRoleModels"] = {
  ...FOUR_ROLE_DEFAULTS,
  researcher: RESEARCHER_SELECTION,
  gatekeeper: { id: "fable-gate" },
};

const featureArgs = ["--feature", DOCUMENTED_FEATURE_ID];

const CLI_INDEX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "cli",
  "src",
  "index.ts"
);

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn should not be called in kickoff tests");
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
      "<!-- next: b99 -->",
      "",
      "## Backlog",
      "",
      `- **${DOCUMENTED_FEATURE_ID}** Optional researcher. — [docs](./${DOCUMENTED_SLUG}/00-index.md)`,
      "",
    ].join("\n"),
    "utf8"
  );
  const featureDir = join(workspacePath, "docs", "roadmap", DOCUMENTED_SLUG);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, "00-index.md"), "# b56\n", "utf8");
  writeFileSync(join(featureDir, "prd.md"), "# prd\n", "utf8");
}

function seedWorkspaceDisk(workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  writeRoadmapIndex(workspacePath);
}

function countAutomations(db: Db): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM automations").get() as { n: number }
  ).n;
}

function countRuns(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

function countProvisionCalls(client: DaemonClient): {
  dry: number;
  apply: number;
  triggers: number;
} {
  const c = client as DaemonClient & {
    _provisionCalls?: { dry: number; apply: number; triggers: number };
  };
  return c._provisionCalls ?? { dry: 0, apply: 0, triggers: 0 };
}

function wrapClient(client: DaemonClient): DaemonClient {
  const tallies = { dry: 0, apply: 0, triggers: 0 };
  const origProvision = client.provisionPipelineWorkers.bind(client);
  const origTrigger = client.triggerRunWithContext.bind(client);
  client.provisionPipelineWorkers = async (pipelineId, body) => {
    if (body.dryRun) tallies.dry += 1;
    else tallies.apply += 1;
    return origProvision(pipelineId, body);
  };
  client.triggerRunWithContext = async (req) => {
    tallies.triggers += 1;
    return origTrigger(req);
  };
  (client as DaemonClient & { _provisionCalls: typeof tallies })._provisionCalls =
    tallies;
  return client;
}

async function withServer(
  settings: ResolvedSettings,
  run: (args: {
    db: Db;
    workspacePath: string;
    client: DaemonClient;
  }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b56-8-"));
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
  });
  const client = wrapClient(new DaemonClient(`http://127.0.0.1:${port}`));
  try {
    await run({ db, workspacePath, client });
  } finally {
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function baseRequest(
  overrides: Partial<InputRequest> = {}
): InputRequest {
  return {
    id: "req-1",
    runId: "run-1",
    question: "Approve research findings?",
    answer: null,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    answeredAt: null,
    ...overrides,
  };
}

describe("b56.08 parseImplementFullyArgs --research-approval", () => {
  it("accepts none and before-planning", () => {
    expect(
      parseImplementFullyArgs([
        ...featureArgs,
        "--research-approval",
        "none",
      ]).researchApprovalPolicy
    ).toBe("none");
    expect(
      parseImplementFullyArgs([
        ...featureArgs,
        "--research-approval",
        "before-planning",
      ]).researchApprovalPolicy
    ).toBe("before-planning");
  });

  it("rejects missing and unknown values listing both valid policies", () => {
    expect(() =>
      parseImplementFullyArgs([...featureArgs, "--research-approval"])
    ).toThrow(
      new RegExp(
        IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES.map((p) =>
          p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        ).join(".*")
      )
    );
    const err = (() => {
      try {
        parseImplementFullyArgs([
          ...featureArgs,
          "--research-approval",
          "always",
        ]);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(err).toMatch(/Unknown --research-approval "always"/);
    for (const policy of IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES) {
      expect(err).toContain(policy);
    }
  });

  it("applies last-wins on repetition", () => {
    const parsed = parseImplementFullyArgs([
      ...featureArgs,
      "--research-approval",
      "before-planning",
      "--research-approval",
      "none",
    ]);
    expect(parsed.researchApprovalPolicy).toBe("none");
  });

  it("still rejects unknown flags and lists --research-approval among valid flags", () => {
    expect(() =>
      parseImplementFullyArgs([...featureArgs, "--research-approva"])
    ).toThrow(/Unknown flag "--research-approva"/);
    expect(() =>
      parseImplementFullyArgs([...featureArgs, "--research-approva"])
    ).toThrow(/--research-approval/);
  });
});

describe("b56.08 researchApprovalPolicy precedence", () => {
  it("flag beats options bag; bag applies when flag absent; neither yields none", async () => {
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels: SIX_ROLE_DEFAULTS },
      async ({ db, workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...a) => {
          lines.push(a.map(String).join(" "));
        });
        try {
          // Flag beats bag.
          await cmdImplementFully(
            client,
            [
              ...featureArgs,
              "--research-approval",
              "before-planning",
              "--dry-run",
            ],
            { researchApprovalPolicy: "none" }
          );
          const joinedFlag = lines.join("\n");
          expect(joinedFlag).toMatch(
            /Research:\s+fable-research \(approval=before-planning\)/
          );
          expect(joinedFlag).toMatch(
            /"researchApprovalPolicy": "before-planning"/
          );

          lines.length = 0;
          // Bag when flag absent.
          await cmdImplementFully(client, [...featureArgs, "--dry-run"], {
            researchApprovalPolicy: "before-planning",
          });
          const joinedBag = lines.join("\n");
          expect(joinedBag).toMatch(
            /Research:\s+fable-research \(approval=before-planning\)/
          );

          lines.length = 0;
          // Neither → none.
          await cmdImplementFully(client, [...featureArgs, "--dry-run"]);
          const joinedNeither = lines.join("\n");
          expect(joinedNeither).toMatch(
            /Research:\s+fable-research \(approval=none\)/
          );
          expect(joinedNeither).toMatch(/"researchApprovalPolicy": "none"/);
        } finally {
          log.mockRestore();
          process.chdir(prev);
        }
        expect(countAutomations(db)).toBe(0);
        expect(countRuns(db)).toBe(0);
      }
    );
  });
});

describe("b56.08 cmdImplementFully --research-approval", () => {
  it("arms before-planning on trigger variables and dry-run Research row", async () => {
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels: SIX_ROLE_DEFAULTS },
      async ({ db, workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        const lines: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...a) => {
          lines.push(a.map(String).join(" "));
        });
        try {
          await cmdImplementFully(client, [
            ...featureArgs,
            "--research-approval",
            "before-planning",
            "--dry-run",
          ]);
        } finally {
          log.mockRestore();
          process.chdir(prev);
        }
        const joined = lines.join("\n");
        expect(joined).toMatch(/Dry run — nothing written/);
        expect(joined).toMatch(
          /Research:\s+fable-research \(approval=before-planning\)/
        );
        expect(joined).toMatch(
          /"researchApprovalPolicy": "before-planning"/
        );
        expect(countAutomations(db)).toBe(0);
        expect(countRuns(db)).toBe(0);
        const calls = countProvisionCalls(client);
        expect(calls.apply).toBe(0);
        expect(calls.triggers).toBe(0);
      }
    );
  });

  it("before-planning without researcher fails with --role researcher= hint and zero writes", async () => {
    await withServer(
      { ...DEFAULT_SETTINGS, pipelineRoleModels: FOUR_ROLE_DEFAULTS },
      async ({ db, workspacePath, client }) => {
        const prev = process.cwd();
        process.chdir(workspacePath);
        try {
          await expect(
            cmdImplementFully(client, [
              ...featureArgs,
              "--research-approval",
              "before-planning",
            ])
          ).rejects.toThrow(/--role researcher=/);
          await expect(
            cmdImplementFully(client, [
              ...featureArgs,
              "--research-approval",
              "before-planning",
            ])
          ).rejects.toThrow(
            /researchApprovalPolicy "before-planning" requires a resolved "researcher" role/
          );
        } finally {
          process.chdir(prev);
        }
        expect(countAutomations(db)).toBe(0);
        expect(countRuns(db)).toBe(0);
        const calls = countProvisionCalls(client);
        expect(calls.dry).toBe(0);
        expect(calls.apply).toBe(0);
        expect(calls.triggers).toBe(0);
      }
    );
  });
});

describe("b56.08 formatInputRequest", () => {
  it("renders structured choices, recommendation, and artifact path", () => {
    const out = formatInputRequest(
      baseRequest({
        metadata: {
          kind: "research-review",
          choices: [
            {
              id: "approve",
              label: "Approve as-is",
              description: "Proceed with findings",
            },
            { id: "comment", label: "Comment" },
          ],
          recommendedChoiceId: "approve",
          artifacts: [
            {
              label: "Research findings",
              path: "docs/roadmap/done/b56-optional-researcher-gatekeeper/research.md",
            },
          ],
        },
      })
    );
    expect(out).toContain("Approve research findings?");
    expect(out).toContain("approve");
    expect(out).toContain("comment");
    expect(out).toContain("(recommended)");
    expect(out).toContain(
      "docs/roadmap/done/b56-optional-researcher-gatekeeper/research.md"
    );
    expect(out).toMatch(/Answer with one of:.*approve.*comment/);
  });

  it("returns question alone for free-form and tolerates partial metadata", () => {
    expect(formatInputRequest(baseRequest({ metadata: null }))).toBe(
      "Approve research findings?"
    );
    expect(formatInputRequest(baseRequest({ metadata: undefined }))).toBe(
      "Approve research findings?"
    );
    expect(
      formatInputRequest(
        baseRequest({
          metadata: { kind: "research-comments", choices: [] },
        })
      )
    ).toBe("Approve research findings?");
    expect(() =>
      formatInputRequest(
        baseRequest({
          metadata: { kind: "research-review" },
        })
      )
    ).not.toThrow();
  });
});

describe("b56.08 followRun answer retryability (source contract)", () => {
  it("adds request id to answered only after client.answer succeeds", () => {
    const src = readFileSync(CLI_INDEX_PATH, "utf8");
    const followStart = src.indexOf("async function followRun(");
    expect(followStart).toBeGreaterThan(-1);
    const nextFn = src.indexOf("\nasync function ", followStart + 1);
    const followBlock = src.slice(
      followStart,
      nextFn === -1 ? undefined : nextFn
    );

    // Must not mark handled before submitting.
    expect(followBlock).not.toMatch(
      /answered\.add\(msg\.request\.id\);\s*void promptAnswer/
    );
    expect(followBlock).not.toMatch(
      /answered\.add\(msg\.request\.id\);\s*\n\s*void promptAnswer/
    );

    const answerIdx = followBlock.indexOf("await client.answer(");
    const addIdx = followBlock.indexOf("answered.add(request.id)");
    expect(answerIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(answerIdx);

    // Failed submissions still surface the existing error line.
    expect(followBlock).toContain("Failed to send answer:");
  });
});

describe("b56.08 help text", () => {
  it("documents --research-approval and both valid values", () => {
    const src = readFileSync(CLI_INDEX_PATH, "utf8");
    expect(src).toContain("--research-approval");
    expect(src).toContain("none|before-planning");
    for (const policy of IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES) {
      expect(src).toContain(policy);
    }
  });
});
