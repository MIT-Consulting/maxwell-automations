import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capabilitiesDocumentSchema,
  DEFAULT_ROLE_MODEL_PROFILE_ID,
  FACTORY_VERSION,
  FEATURE_QUEUE_ENTRY_STATES,
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  summarizeFeatureQueueForCapabilities,
  emptyQueueEntryDetail,
  type CapabilitiesDocument,
  type FeatureQueueEntry,
  type PipelineModelRole,
  type ModelSelection,
  type PipelineOutcome,
  type RunStatus,
} from "@lca/shared";
import {
  parseCapabilitiesArgs,
  cmdCapabilities,
  enrichCapabilitiesDocument,
  formatCapabilitiesHuman,
} from "../packages/cli/src/capabilities.ts";
import { DaemonClient, resolveWorkspaceId } from "../packages/cli/src/client.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { automationId } from "../packages/daemon/src/config/parse.ts";
import { buildCapabilitiesDocument } from "../packages/daemon/src/capabilities.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import { freeListenPort } from "./helpers/free-port.ts";

afterEach(() => {
  vi.resetModules();
});

type Db = ReturnType<typeof openDatabase>;

const QUALITY: Partial<Record<PipelineModelRole, ModelSelection>> = {
  planner: { id: "gpt-5.6-sol" },
  implementer: { id: "grok-4.5" },
  reviewer: { id: "claude-opus-5" },
  docs: { id: "composer-2.5" },
};

function stubExecutor(): Executor {
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

function writeReadyRoadmap(workspacePath: string): void {
  mkdirSync(join(workspacePath, "docs", "roadmap"), { recursive: true });
  writeFileSync(
    join(workspacePath, "docs", "roadmap", "00-index.md"),
    `# Roadmap

<!-- next: b99 -->

## Backlog

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
`
  );
}

function chainContextJson(featureId: string): string {
  return JSON.stringify({
    variables: {
      pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
      featureId,
      featureSlug: `${featureId}-slug`,
      featureDir: `docs/roadmap/${featureId}-slug`,
      featureIndex: `docs/roadmap/${featureId}-slug/00-index.md`,
      idea: "idea",
      planningDepth: "full",
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
  });
}

function insertGeneratedEntry(
  db: Db,
  workspaceId: string
): string {
  const entryAutomation = automationId(
    workspaceId,
    `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
  );
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, origin
    ) VALUES (?, ?, 'entry', 1, 'enabled', ?, 'p', NULL, 'gen.yaml', ?, 'generated')`
  ).run(
    entryAutomation,
    workspaceId,
    JSON.stringify({ type: "manual" }),
    `${GENERATED_CONFIG_KEY_PREFIX}${IMPLEMENT_FULLY_ENTRY_WORKER_KEY}`
  );
  return entryAutomation;
}

function insertPipelineRoot(
  db: Db,
  args: {
    id: string;
    automationId: string;
    workspaceId: string;
    featureId: string;
    status: string;
  }
): void {
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status, trigger_kind, prompt,
       chain_root_run_id, chain_depth, chain_max_depth, chain_context_json,
       created_at, updated_at, started_at
     ) VALUES (?, ?, ?, ?, 'manual', 'prompt', ?, 0, 9, ?, datetime('now'), datetime('now'), datetime('now'))`
  ).run(
    args.id,
    args.automationId,
    args.workspaceId,
    args.status,
    args.id,
    chainContextJson(args.featureId)
  );
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const stdout: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origOut;
  }
  return stdout.join("");
}

async function withCapabilitiesServer(
  settings: typeof DEFAULT_SETTINGS,
  run: (args: {
    client: DaemonClient;
    port: number;
    db: Db;
    workspacePath: string;
    workspaceId: string;
  }) => Promise<void>,
  opts?: { seedWorkspace?: boolean }
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "lca-b80-"));
  const db = openDatabase(join(root, "state.sqlite"));
  const workspacePath = join(root, "workspace");
  const workspaceId = "ws-b80";
  if (opts?.seedWorkspace !== false) {
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(join(workspacePath, ".git"), { recursive: true });
    writeReadyRoadmap(workspacePath);
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, workspacePath, "My Workspace");
  }
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
  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  try {
    await run({ client, port, db, workspacePath, workspaceId });
  } finally {
    await http.close();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("b80 buildCapabilitiesDocument", () => {
  it("validates against the shared schema and includes green done signal", () => {
    const doc = buildCapabilitiesDocument({
      daemonVersion: { version: FACTORY_VERSION, channel: "factory" },
      roleModelSettings: {
        pipelineRoleModels: QUALITY,
        pipelineRoleModelProfiles: {
          quality: {
            roleModels: QUALITY,
            description: "High regression risk",
          },
        },
        defaultPipelineRoleModelProfile: null,
      },
    });
    capabilitiesDocumentSchema.parse(doc);
    const backlog = doc.playbooks.find((p) => p.id === "backlog-unattended");
    expect(backlog?.doneSignal).toMatch(/outcome: green/);
    expect(backlog?.doneSignal).toMatch(/complete:/);
    const failed = doc.statuses.find((s) => s.id === "failed" && s.domain === "run");
    expect(failed?.meaning).toMatch(/failed/);
    expect(doc.statuses.some((s) => s.id === "error")).toBe(false);
    expect(doc.antiPatterns.some((a) => a.includes("b66"))).toBe(true);
    expect(doc.antiPatterns.some((a) => a.includes("b74"))).toBe(true);
    expect(doc.surfaces.some((s) => s.id === "watch")).toBe(true);
    const runIds = new Set(
      doc.statuses.filter((s) => s.domain === "run").map((s) => s.id)
    );
    const pipelineIds = new Set(
      doc.statuses.filter((s) => s.domain === "pipeline").map((s) => s.id)
    );
    const queueIds = new Set(
      doc.statuses.filter((s) => s.domain === "queue").map((s) => s.id)
    );
    const runStatuses: RunStatus[] = [
      "queued",
      "running",
      "needs_input",
      "paused",
      "completed",
      "failed",
      "cancelled",
    ];
    const pipelineOutcomes: PipelineOutcome[] = [
      "running",
      "green",
      "blocked",
      "deadlock",
      "aborted",
      "failed",
    ];
    for (const id of runStatuses) {
      expect(runIds.has(id)).toBe(true);
    }
    for (const id of pipelineOutcomes) {
      expect(pipelineIds.has(id)).toBe(true);
    }
    for (const id of FEATURE_QUEUE_ENTRY_STATES) {
      expect(queueIds.has(id)).toBe(true);
    }
    expect(queueIds.has("waiting")).toBe(false);
    expect(JSON.stringify(doc)).not.toContain("controlToken");
    expect(JSON.stringify(doc)).not.toContain("CURSOR_API_KEY");
  });

  it("keeps distinct daemon and CLI identities when they differ", () => {
    const base = buildCapabilitiesDocument({
      daemonVersion: { version: "daemon-fixture-1.0.0", channel: "public" },
      roleModelSettings: {
        pipelineRoleModels: QUALITY,
        pipelineRoleModelProfiles: {},
        defaultPipelineRoleModelProfile: null,
      },
    });
    const enriched = enrichCapabilitiesDocument(base, {
      cli: { version: "cli-fixture-9.9.9", channel: "public" },
      skills: "in-sync",
    });
    capabilitiesDocumentSchema.parse(enriched);
    expect(enriched.version.daemon.version).toBe("daemon-fixture-1.0.0");
    expect(enriched.version.cli?.version).toBe("cli-fixture-9.9.9");
    expect(enriched.version.skills).toBe("in-sync");
    const text = formatCapabilitiesHuman(enriched);
    expect(text).toContain("daemon-fixture-1.0.0");
    expect(text).toContain("cli-fixture-9.9.9");
    expect(text).toMatch(/daemon and CLI builds differ/);
    expect(text).toMatch(/trust daemon surfaces/i);
  });

  it("carries profile description as bestFor without fabricating default description", () => {
    const doc = buildCapabilitiesDocument({
      daemonVersion: { version: "1.0.0", channel: "public" },
      roleModelSettings: {
        pipelineRoleModels: QUALITY,
        pipelineRoleModelProfiles: {
          quality: {
            roleModels: { planner: { id: "grok-4.5" } },
            description: "Operator calibration",
          },
        },
        defaultPipelineRoleModelProfile: null,
      },
    });
    const named = doc.profiles.find((p) => p.id === "quality");
    expect(named?.bestFor).toBe("Operator calibration");
    const defaultProfile = doc.profiles.find(
      (p) => p.id === DEFAULT_ROLE_MODEL_PROFILE_ID
    );
    expect(defaultProfile?.bestFor).toBeUndefined();
  });
});

describe("b80 GET /api/capabilities", () => {
  it("returns schema-valid JSON without workspace and resolves workspaceId", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, port, workspaceId }) => {
      const doc = await client.getCapabilities();
      capabilitiesDocumentSchema.parse(doc);
      expect(doc.version.daemon.version).toBeTruthy();
      expect(doc.version.cli).toBeUndefined();
      expect(doc.workspace).toBeUndefined();

      const friendly = await fetch(
        `http://127.0.0.1:${port}/api/capabilities?workspace=foo`
      );
      expect(friendly.status).toBe(400);

      const missing = await fetch(
        `http://127.0.0.1:${port}/api/capabilities?workspaceId=missing-id`
      );
      expect(missing.status).toBe(404);

      const scoped = await client.getCapabilities(workspaceId);
      capabilitiesDocumentSchema.parse(scoped);
      expect(scoped.workspace?.id).toBe(workspaceId);
      expect(scoped.workspace?.readiness.state).toBe("ready");
      expect(scoped.workspace?.pipeline.active).toBe(false);
      expect(scoped.workspace?.pipeline.rootRunId).toBeNull();
      expect(scoped.workspace?.queue.isEmpty).toBe(true);
      expect(doc.surfaces.every((s) => s.availability === undefined)).toBe(true);
      expect(doc.playbooks.every((p) => p.availability === undefined)).toBe(true);
      const feature = scoped.surfaces.find((s) => s.id === "implement-fully-feature");
      expect(feature?.availability?.status).toBe("available");
      expect(JSON.stringify(scoped)).not.toMatch(/waiting\.question|kickoff_json/);
      expect(JSON.stringify(scoped)).not.toContain('"candidates"');
    });
  });

  it("blocks documented kickoff when the roadmap is not ready", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, workspaceId, workspacePath }) => {
      rmSync(join(workspacePath, "docs"), { recursive: true, force: true });
      const scoped = await client.getCapabilities(workspaceId);
      capabilitiesDocumentSchema.parse(scoped);
      expect(scoped.workspace?.readiness.state).not.toBe("ready");
      expect(scoped.workspace?.pipeline.active).toBe(false);
      const feature = scoped.surfaces.find((s) => s.id === "implement-fully-feature");
      expect(feature?.availability?.status).toBe("blocked");
      expect(feature?.availability?.reason).toMatch(/roadmap/i);
      expect(JSON.stringify(scoped.workspace)).not.toContain('"path"');
      expect(JSON.stringify(scoped.workspace)).not.toContain('"candidates"');
    });
  });

  it("blocks kickoff surfaces when an active pipeline is present", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, db, workspaceId }) => {
      const entryAutomation = insertGeneratedEntry(db, workspaceId);
      insertPipelineRoot(db, {
        id: "active-root",
        automationId: entryAutomation,
        workspaceId,
        featureId: "b80",
        status: "running",
      });

      const scoped = await client.getCapabilities(workspaceId);
      capabilitiesDocumentSchema.parse(scoped);
      expect(scoped.workspace?.pipeline.active).toBe(true);
      expect(scoped.workspace?.pipeline.featureId).toBe("b80");
      const feature = scoped.surfaces.find((s) => s.id === "implement-fully-feature");
      expect(feature?.availability?.status).toBe("blocked");
      expect(feature?.availability?.reason).toMatch(/active pipeline/i);
      const watch = scoped.surfaces.find((s) => s.id === "watch");
      expect(watch?.availability).toBeUndefined();
      const doctor = scoped.surfaces.find((s) => s.id === "doctor");
      expect(doctor?.availability).toBeUndefined();
    });
  });

  it("flags waiting without leaking the input question", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, db, workspaceId }) => {
      const entryAutomation = insertGeneratedEntry(db, workspaceId);
      insertPipelineRoot(db, {
        id: "waiting-root",
        automationId: entryAutomation,
        workspaceId,
        featureId: "b80",
        status: "needs_input",
      });
      db.prepare(
        `INSERT INTO input_requests (id, run_id, question, status)
         VALUES ('in-secret', 'waiting-root', 'SECRET_QUESTION_DO_NOT_LEAK', 'pending')`
      ).run();

      const scoped = await client.getCapabilities(workspaceId);
      capabilitiesDocumentSchema.parse(scoped);
      expect(scoped.workspace?.pipeline.active).toBe(true);
      expect(scoped.workspace?.pipeline.waiting).toBe(true);
      expect(scoped.workspace?.pipeline.halt).toBe(false);
      const serialized = JSON.stringify(scoped);
      expect(serialized).not.toContain("SECRET_QUESTION_DO_NOT_LEAK");
      expect(serialized).not.toContain("waiting.question");
    });
  });

  it("flags a halted pipeline for escalate instead of a second kickoff", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, db, workspaceId }) => {
      const entryAutomation = insertGeneratedEntry(db, workspaceId);
      insertPipelineRoot(db, {
        id: "halt-root",
        automationId: entryAutomation,
        workspaceId,
        featureId: "b80",
        status: "running",
      });
      db.prepare(
        `INSERT INTO runs (
           id, automation_id, workspace_id, status, parent_run_id,
           chain_root_run_id, chain_depth
         ) VALUES ('halt-child', ?, ?, 'failed', 'halt-root', 'halt-root', 1)`
      ).run(entryAutomation, workspaceId);

      const scoped = await client.getCapabilities(workspaceId);
      capabilitiesDocumentSchema.parse(scoped);
      expect(scoped.workspace?.pipeline.active).toBe(true);
      expect(scoped.workspace?.pipeline.halt).toBe(true);
      const feature = scoped.surfaces.find((s) => s.id === "implement-fully-feature");
      expect(feature?.availability?.status).toBe("blocked");
      const escalate = scoped.surfaces.find((s) => s.id === "escalate");
      expect(escalate?.availability).toBeUndefined();
    });
  });

  it("summarizes queued, running, and blocked entries without kickoff JSON", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, db, workspaceId }) => {
      db.prepare(
        `INSERT INTO feature_queue_entries (
           id, workspace_id, feature_id, position, after_json, kickoff_json, state
         ) VALUES
           ('q1', ?, 'b1', 1, '[]', ?, 'queued'),
           ('q2', ?, 'b2', 2, '["b1"]', ?, 'running'),
           ('q3', ?, 'b3', 3, '["b2"]', ?, 'blocked')`
      ).run(
        workspaceId,
        JSON.stringify({ automationId: "secret", prompt: "SECRET_KICKOFF" }),
        workspaceId,
        JSON.stringify({ automationId: "secret", prompt: "SECRET_KICKOFF" }),
        workspaceId,
        JSON.stringify({ automationId: "secret", prompt: "SECRET_KICKOFF" })
      );
      db.prepare(
        `UPDATE feature_queue_entries SET run_id = 'run-b2', detail = 'SECRET_DETAIL' WHERE id = 'q2'`
      ).run();
      db.prepare(
        `UPDATE feature_queue_entries SET detail = 'SECRET_BLOCK' WHERE id = 'q3'`
      ).run();

      const scoped = await client.getCapabilities(workspaceId);
      capabilitiesDocumentSchema.parse(scoped);
      expect(scoped.workspace?.queue.counts.queued).toBe(1);
      expect(scoped.workspace?.queue.counts.running).toBe(1);
      expect(scoped.workspace?.queue.counts.blocked).toBe(1);
      expect(scoped.workspace?.queue.running?.featureId).toBe("b2");
      expect(scoped.workspace?.queue.blockedFeatureIds).toEqual(["b3"]);
      expect(scoped.workspace?.queue.nextEligibleFeatureId).toBe("b1");
      const serialized = JSON.stringify(scoped);
      expect(serialized).not.toContain("SECRET_KICKOFF");
      expect(serialized).not.toContain("SECRET_DETAIL");
      expect(serialized).not.toContain("SECRET_BLOCK");
      expect(serialized).not.toContain("kickoff_json");
    });
  });
});

describe("b80 parseCapabilitiesArgs", () => {
  it("accepts --json and --workspace with a value", () => {
    expect(parseCapabilitiesArgs(["--json"])).toEqual({ ok: true, json: true });
    expect(parseCapabilitiesArgs([])).toEqual({ ok: true, json: false });
    expect(parseCapabilitiesArgs(["--workspace", "foo"])).toEqual({
      ok: true,
      json: false,
      workspaceQuery: "foo",
    });
    expect(parseCapabilitiesArgs(["-w", "My Workspace"])).toEqual({
      ok: true,
      json: false,
      workspaceQuery: "My Workspace",
    });
    const unknown = parseCapabilitiesArgs(["--verbose"]);
    expect(unknown.ok).toBe(false);
  });
});

describe("b80 CLI capabilities output", () => {
  it("prints exactly one JSON document on stdout in json mode", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client }) => {
      const joined = await captureStdout(() => cmdCapabilities(client, ["--json"]));
      expect(joined.trim().startsWith("{")).toBe(true);
      expect(joined.trim().endsWith("}")).toBe(true);
      const parsed = JSON.parse(joined.trim()) as CapabilitiesDocument;
      capabilitiesDocumentSchema.parse(parsed);
      expect(parsed.version.cli).toBeTruthy();
      expect(parsed.version.skills).toBeTruthy();
      expect(parsed.workspace).toBeUndefined();
    });
  });

  it("resolves a spaced workspace name and says why kickoff is available", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, workspaceId }) => {
      const joined = await captureStdout(() =>
        cmdCapabilities(client, ["--workspace", "My Workspace", "--json"])
      );
      const parsed = JSON.parse(joined.trim()) as CapabilitiesDocument;
      capabilitiesDocumentSchema.parse(parsed);
      expect(parsed.workspace?.id).toBe(workspaceId);
      expect(parsed.workspace?.name).toBe("My Workspace");
      expect(parsed.workspace?.pipeline.active).toBe(false);
      const feature = parsed.surfaces.find((s) => s.id === "implement-fully-feature");
      expect(feature?.availability?.status).toBe("available");
    });
  });

  it("human mode renders version skew when daemon and CLI identities differ", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client }) => {
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        await cmdCapabilities(client, []);
      } finally {
        console.log = origLog;
      }
      const text = lines.join("\n");
      expect(text).toContain("Surfaces");
      expect(text).toContain("Best for:");
      expect(text).toContain("Not for:");
      expect(text).toContain("Profiles (role-model recipes)");
      expect(text).toContain("Planning profiles");
      expect(text).toContain("Statuses");
      expect(text).toContain("Playbooks");
      expect(text).toContain("Anti-patterns");
      expect(text).toContain("Pointers");
      expect(text).toMatch(/outcome: green/);
      expect(text).not.toContain("Availability:");
      if (text.includes("daemon and CLI builds differ")) {
        expect(text).toMatch(/trust daemon surfaces/i);
      }
    });
  });

  it("puts availability next to kickoff surfaces when a workspace is selected", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, db, workspaceId }) => {
      const entryAutomation = insertGeneratedEntry(db, workspaceId);
      insertPipelineRoot(db, {
        id: "human-root",
        automationId: entryAutomation,
        workspaceId,
        featureId: "b80",
        status: "running",
      });
      const lines: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        await cmdCapabilities(client, ["-w", "My Workspace"]);
      } finally {
        console.log = origLog;
      }
      const text = lines.join("\n");
      expect(text).toContain("Workspace");
      expect(text).toContain("Pipeline: active b80");
      expect(text).toMatch(/implement-fully-feature[\s\S]*Availability: blocked/m);
      expect(text).toMatch(/backlog-unattended[\s\S]*Availability: blocked/m);
    });
  });
});

describe("b80 CLI help contract", () => {
  it("advertises max capabilities [--json] in printHelp source", () => {
    const cliSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "cli.ts"),
      "utf8"
    );
    const helpBlock = cliSrc.slice(
      cliSrc.indexOf("function printHelp"),
      cliSrc.indexOf("export async function main")
    );
    expect(helpBlock).toContain("max capabilities [--json] [--workspace, -w <id|name|path>]");
  });
});

describe("b80 resolveWorkspaceId for capabilities", () => {
  it("resolves workspace names requiring encoding at the CLI boundary", async () => {
    await withCapabilitiesServer(DEFAULT_SETTINGS, async ({ client, workspaceId }) => {
      const resolved = await resolveWorkspaceId(client, "My Workspace");
      expect(resolved).toBe(workspaceId);
    });
  });
});

describe("b80 capability queue projection", () => {
  it("drops detail blobs from FeatureQueueSummary", () => {
    const entries: FeatureQueueEntry[] = [
      {
        id: "e1",
        workspaceId: "ws",
        featureId: "b1",
        position: 1,
        after: [],
        origin: "queue",
        state: "queued",
        runId: null,
        detail: "SECRET_DETAIL",
        entryDetail: emptyQueueEntryDetail(),
        createdAt: "2026-01-01 00:00:00",
        startedAt: null,
        settledAt: null,
        updatedAt: "2026-01-01 00:00:00",
      },
      {
        id: "e2",
        workspaceId: "ws",
        featureId: "b2",
        position: 2,
        after: ["b1"],
        origin: "direct",
        state: "blocked",
        runId: null,
        detail: "SECRET_BLOCK",
        entryDetail: emptyQueueEntryDetail(),
        createdAt: "2026-01-01 00:00:00",
        startedAt: null,
        settledAt: null,
        updatedAt: "2026-01-01 00:00:00",
      },
    ];
    const summary = summarizeFeatureQueueForCapabilities(entries);
    expect(summary.counts.queued).toBe(1);
    expect(summary.counts.blocked).toBe(1);
    expect(summary.blockedFeatureIds).toEqual(["b2"]);
    expect(summary.nextEligibleFeatureId).toBe("b1");
    expect(JSON.stringify(summary)).not.toContain("SECRET_DETAIL");
    expect(JSON.stringify(summary)).not.toContain("SECRET_BLOCK");
    expect(summary).not.toHaveProperty("failed");
    expect(summary).not.toHaveProperty("blocked");
  });
});

describe("b80 kickoff recipe unchanged", () => {
  it("role-only profiles still resolve concrete kickoff roleModels", async () => {
    const { resolveRoleModelProfileDefaults } = await import("@lca/shared");
    const { toPipelineIntrospection, IMPLEMENT_FULLY_DEFINITION } =
      await import("../packages/daemon/src/pipelines/implement-fully.ts");
    const introspection = toPipelineIntrospection(IMPLEMENT_FULLY_DEFINITION, {
      pipelineRoleModels: QUALITY,
      pipelineRoleModelProfiles: {
        cheap: { roleModels: { planner: { id: "grok-4.5" } } },
      },
      defaultPipelineRoleModelProfile: null,
    });
    const recipe = resolveRoleModelProfileDefaults("cheap", introspection);
    expect(recipe).toEqual({ planner: { id: "grok-4.5" } });
    expect(Object.keys(recipe)).not.toContain("description");
  });
});
