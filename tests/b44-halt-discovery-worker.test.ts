import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATIONS_IO_TOOL_NAMES,
  parseAutomationsIoToolsAllowlist,
} from "../packages/automations-io/src/server.ts";
import type {
  ActiveRun,
  Executor,
  ResumeParams,
  SpawnParams,
} from "../packages/daemon/src/executor/types.ts";
import {
  automationsIoMcpServers,
  buildRunMcpServers,
} from "../packages/daemon/src/mcp/config.ts";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER,
  HALT_DISCOVERY_WORKER_KEY,
  HALT_DISCOVERY_WORKERS,
} from "../packages/daemon/src/pipelines/halt-discovery.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

type Db = ReturnType<typeof openDatabase>;

function until(
  predicate: () => boolean,
  timeoutMs = 5000
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("until timeout"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function makeActiveRun(agentId: string, sdkRunId: string): ActiveRun {
  return {
    kind: "sdk-local",
    agentId,
    sdkRunId,
    async *stream() {},
    wait: async () => ({ status: "finished", result: "ok" }) as never,
    cancel: async () => undefined,
    dispose: async () => undefined,
  };
}

function seedWorkspace(db: Db, workspacePath: string): string {
  const workspaceId = "ws-halt-discovery";
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Workspace");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, model,
      config_path, config_key, chain_json, model_role
    ) VALUES (?, ?, ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, ?)`
  ).run(
    `${workspaceId}::auto`,
    workspaceId,
    "Test auto",
    JSON.stringify({ type: "manual" }),
    "Prompt for test",
    "manual:test",
    "reviewer"
  );
  return workspaceId;
}

describe("b44 halt-discovery worker contract", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("LCA_AUTOMATIONS_IO_TOOLS allowlist", () => {
    it("treats absent or blank as all current tools", () => {
      expect([...parseAutomationsIoToolsAllowlist(undefined)].sort()).toEqual(
        [...AUTOMATIONS_IO_TOOL_NAMES].sort()
      );
      expect([...parseAutomationsIoToolsAllowlist("")].sort()).toEqual(
        [...AUTOMATIONS_IO_TOOL_NAMES].sort()
      );
      expect([...parseAutomationsIoToolsAllowlist("  ,  ")].sort()).toEqual(
        [...AUTOMATIONS_IO_TOOL_NAMES].sort()
      );
    });

    it("accepts exact subsets and ignores duplicates", () => {
      expect([...parseAutomationsIoToolsAllowlist("ask_user")]).toEqual([
        "ask_user",
      ]);
      expect(
        [...parseAutomationsIoToolsAllowlist("ask_user,chain_control")].sort()
      ).toEqual(["ask_user", "chain_control"]);
      expect(
        [...parseAutomationsIoToolsAllowlist("ask_user,ask_user,pipeline_wave")].sort()
      ).toEqual(["ask_user", "pipeline_wave"]);
    });

    it("rejects unknown names fail-closed", () => {
      expect(() => parseAutomationsIoToolsAllowlist("ask_user,escalate")).toThrow(
        /Unknown automations-io tool/
      );
      expect(() => parseAutomationsIoToolsAllowlist("nope")).toThrow(
        /Unknown automations-io tool/
      );
    });
  });

  describe("MCP env serialization", () => {
    it("omits LCA_AUTOMATIONS_IO_TOOLS by default", () => {
      const servers = automationsIoMcpServers("run-default");
      const env = servers["automations-io"]?.env;
      expect(env?.LCA_RUN_ID).toBe("run-default");
      expect(env).not.toHaveProperty("LCA_AUTOMATIONS_IO_TOOLS");
    });

    it("sets LCA_AUTOMATIONS_IO_TOOLS=ask_user for restricted profile", () => {
      const servers = automationsIoMcpServers("run-restricted", {
        automationsIoTools: ["ask_user"],
      });
      expect(servers["automations-io"]?.env?.LCA_AUTOMATIONS_IO_TOOLS).toBe(
        "ask_user"
      );
    });

    it("threads the allowlist through buildRunMcpServers", () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b44-mcp-"));
      roots.push(root);
      mkdirSync(join(root, ".cursor"), { recursive: true });
      const servers = buildRunMcpServers("run-build", root, {
        automationsIoTools: ["ask_user"],
      });
      expect(servers["automations-io"]?.env?.LCA_AUTOMATIONS_IO_TOOLS).toBe(
        "ask_user"
      );
    });
  });

  describe("generated worker shape", () => {
    it("is manual, enabled, reviewer-role, chainless, and outside implement-fully", () => {
      expect(HALT_DISCOVERY_WORKER.key).toBe(HALT_DISCOVERY_WORKER_KEY);
      expect(HALT_DISCOVERY_WORKER.trigger).toEqual({ type: "manual" });
      expect(HALT_DISCOVERY_WORKER.enabled).toBe(true);
      expect(HALT_DISCOVERY_WORKER.modelRole).toBe("reviewer");
      expect(HALT_DISCOVERY_WORKER.chain).toBeNull();
      expect(HALT_DISCOVERY_TRIGGER_KIND).toBe("halt-discovery");
      expect(HALT_DISCOVERY_WORKERS).toHaveLength(1);
      expect(
        IMPLEMENT_FULLY_WORKERS.some((w) => w.key === HALT_DISCOVERY_WORKER_KEY)
      ).toBe(false);
    });

    it("prompt requires the advisory packet and forbids transition authority", () => {
      const prompt = HALT_DISCOVERY_WORKER.prompt;
      expect(prompt).toContain("lca-halt-discovery");
      expect(prompt).toContain("recommendation: <retry|skip|abort|chat>");
      expect(prompt).toMatch(/Never call or simulate `chain_control`/);
      expect(prompt).toContain("pipeline_wave");
      expect(prompt).toContain("escalation");
      expect(prompt).toContain("daemon restart");
      expect(prompt).toContain("daemon teardown");
      expect(prompt).toContain("lca doctor");
      expect(prompt).toContain("state.sqlite");
    });
  });

  describe("RunEngine spawn/resume restriction", () => {
    it("passes only ask_user for halt-discovery spawn; unrestricted for normal runs", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b44-spawn-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const db = openDatabase(join(root, "state.sqlite"));
      const workspaceId = seedWorkspace(db, workspace);
      const automationId = `${workspaceId}::auto`;

      const spawns: SpawnParams[] = [];
      const executor: Executor = {
        kind: "sdk-local",
        spawn: async (params) => {
          spawns.push(params);
          return makeActiveRun(`agent-${params.runId}`, `sdk-${params.runId}`);
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      };

      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor,
        events: new DaemonEventBus(),
        inputHub: new InputHub(new InputStore(db), {
          onNeedsInput: () => undefined,
          onAnswered: () => undefined,
        }),
        maxConcurrentRuns: 2,
      });

      try {
        const normalId = await engine.triggerRun(automationId, "manual");
        await until(() => spawns.some((s) => s.runId === normalId));
        const normalSpawn = spawns.find((s) => s.runId === normalId);
        expect(normalSpawn?.automationsIoTools).toBeUndefined();

        const discoveryId = await engine.triggerRun(
          automationId,
          HALT_DISCOVERY_TRIGGER_KIND
        );
        await until(() => spawns.some((s) => s.runId === discoveryId));
        const discoverySpawn = spawns.find((s) => s.runId === discoveryId);
        expect(discoverySpawn?.automationsIoTools).toEqual(["ask_user"]);
      } finally {
        await engine.shutdown();
        db.close();
      }
    });

    it("passes only ask_user on needs_input resume for halt-discovery", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b44-resume-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const db = openDatabase(join(root, "state.sqlite"));
      const workspaceId = seedWorkspace(db, workspace);
      const automationId = `${workspaceId}::auto`;
      const runId = "halt-discovery-resume";

      db.prepare(
        `INSERT INTO runs (
          id, automation_id, workspace_id, status, trigger_kind, prompt,
          agent_id, sdk_run_id
        ) VALUES (?, ?, ?, 'needs_input', ?, ?, ?, ?)`
      ).run(
        runId,
        automationId,
        workspaceId,
        HALT_DISCOVERY_TRIGGER_KIND,
        "diagnosis prompt",
        "agent-prior",
        "sdk-prior"
      );

      const resumes: ResumeParams[] = [];
      const executor: Executor = {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async (params) => {
          resumes.push(params);
          return makeActiveRun(params.agentId, params.sdkRunId);
        },
      };

      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor,
        events: new DaemonEventBus(),
        inputHub: new InputHub(new InputStore(db), {
          onNeedsInput: () => undefined,
          onAnswered: () => undefined,
        }),
        maxConcurrentRuns: 2,
      });

      try {
        await engine.resumeInterruptedRuns();
        await until(() => resumes.length >= 1);
        expect(resumes[0]?.automationsIoTools).toEqual(["ask_user"]);
        expect(resumes[0]?.runId).toBe(runId);
      } finally {
        await engine.shutdown();
        db.close();
      }
    });

    it("passes no restriction on needs_input resume for a normal run", async () => {
      const root = mkdtempSync(join(tmpdir(), "lca-b44-resume-normal-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const db = openDatabase(join(root, "state.sqlite"));
      const workspaceId = seedWorkspace(db, workspace);
      const automationId = `${workspaceId}::auto`;
      const runId = "normal-resume";

      db.prepare(
        `INSERT INTO runs (
          id, automation_id, workspace_id, status, trigger_kind, prompt,
          agent_id, sdk_run_id
        ) VALUES (?, ?, ?, 'needs_input', ?, ?, ?, ?)`
      ).run(
        runId,
        automationId,
        workspaceId,
        "manual",
        "normal prompt",
        "agent-prior",
        "sdk-prior"
      );

      const resumes: ResumeParams[] = [];
      const executor: Executor = {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async (params) => {
          resumes.push(params);
          return makeActiveRun(params.agentId, params.sdkRunId);
        },
      };

      const engine = new RunEngine(db, {
        apiKey: "test-key",
        executor,
        events: new DaemonEventBus(),
        inputHub: new InputHub(new InputStore(db), {
          onNeedsInput: () => undefined,
          onAnswered: () => undefined,
        }),
        maxConcurrentRuns: 2,
      });

      try {
        await engine.resumeInterruptedRuns();
        await until(() => resumes.length >= 1);
        expect(resumes[0]?.automationsIoTools).toBeUndefined();
      } finally {
        await engine.shutdown();
        db.close();
      }
    });
  });
});
