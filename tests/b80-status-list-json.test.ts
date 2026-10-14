import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Automation, DaemonStatus, Run, RunStatus } from "@lca/shared";
import {
  buildListJsonDocument,
  LIST_RUN_DISPLAY_CAP,
  LIST_RUN_FETCH_LIMIT,
  parseListArgs,
  selectListEntries,
} from "../packages/cli/src/list.ts";
import {
  buildStatusJsonDocument,
  collectStatusSnapshot,
  parseStatusArgs,
  STATUS_RUN_FETCH_LIMIT,
} from "../packages/cli/src/status.ts";
import { DaemonClient } from "../packages/cli/src/client.ts";

const ALL_RUN_STATUSES: RunStatus[] = [
  "queued",
  "running",
  "needs_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

function daemonStatus(): DaemonStatus {
  return {
    ok: true,
    version: "1.0.0",
    pid: 1,
    port: 3747,
    host: "127.0.0.1",
    bindAddresses: ["127.0.0.1:3747"],
    allowedIps: [],
    remoteAuth: false,
    mode: "dev",
    startedAt: "2026-01-01T00:00:00.000Z",
    uptimeMs: 1000,
  };
}

describe("b80 status --json", () => {
  it("parses only --json and rejects unknown options", () => {
    expect(parseStatusArgs(["--json"])).toEqual({ ok: true, json: true });
    expect(parseStatusArgs([])).toEqual({ ok: true, json: false });
    expect(parseStatusArgs(["--verbose"]).ok).toBe(false);
    expect(parseStatusArgs(["foo"]).ok).toBe(false);
  });

  it("emits one document with every run status and the fetch limit", () => {
    const runs: Run[] = [
      {
        id: "r1",
        automationId: "a1",
        workspaceId: "w1",
        status: "running",
        agentId: null,
        sdkRunId: null,
        triggerKind: "manual",
        parentRunId: null,
        title: null,
        summary: null,
        model: null,
        modelSelection: null,
        startedAt: "2026-01-01 00:00:00",
        endedAt: null,
        createdAt: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
      },
    ];
    const automations: Automation[] = [
      {
        id: "a1",
        workspaceId: "w1",
        name: "alpha",
        enabled: true,
        status: "enabled",
        origin: "config",
        trigger: { type: "manual" },
        prompt: "p",
        model: null,
        modelSelection: null,
        chain: null,
        configPath: "a.yaml",
        configKey: "a",
        archivedAt: null,
        createdAt: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
      },
    ];
    const doc = buildStatusJsonDocument(daemonStatus(), {
      automations,
      workspaces: [
        {
          id: "w1",
          path: "/tmp/w1",
          name: "w1",
          createdAt: "2026-01-01 00:00:00",
          updatedAt: "2026-01-01 00:00:00",
        },
      ],
      runs,
    });
    expect(doc.limits.runFetchLimit).toBe(STATUS_RUN_FETCH_LIMIT);
    for (const status of ALL_RUN_STATUSES) {
      expect(doc.counts.runsByStatus[status]).toBe(status === "running" ? 1 : 0);
    }
    expect(doc.counts.automations).toEqual({ total: 1, enabled: 1 });
    expect(JSON.parse(JSON.stringify(doc)).daemon.ok).toBe(true);
  });

  it("collectStatusSnapshot uses the same 500-run window as status", async () => {
    const client = {
      listAutomations: async () => [],
      listRuns: async (limit: number) => {
        expect(limit).toBe(STATUS_RUN_FETCH_LIMIT);
        return [];
      },
      listWorkspaces: async () => [],
    } as unknown as DaemonClient;
    await collectStatusSnapshot(client);
  });
});

describe("b80 list --json", () => {
  it("parses --json alongside workspace flags", () => {
    expect(parseListArgs(["--json", "-w", "ws-a"])).toEqual({
      workspaceQuery: "ws-a",
      json: true,
    });
    expect(() => parseListArgs(["--format", "json"])).toThrow(
      "Unknown list option: --format"
    );
  });

  it("returns bounded entries with explicit limits", () => {
    const doc = buildListJsonDocument([], [], undefined);
    expect(doc.limits).toEqual({
      runFetchLimit: LIST_RUN_FETCH_LIMIT,
      runDisplayCap: LIST_RUN_DISPLAY_CAP,
    });
    expect(doc.workspace).toBeNull();
  });

  it("scopes JSON to the resolved workspace and the display cap", () => {
    const automations: Automation[] = [
      {
        id: "a1",
        workspaceId: "w1",
        name: "alpha",
        enabled: true,
        status: "enabled",
        origin: "config",
        trigger: { type: "manual" },
        prompt: "p",
        model: null,
        modelSelection: null,
        chain: null,
        configPath: "a.yaml",
        configKey: "a",
        archivedAt: null,
        createdAt: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
      },
      {
        id: "a2",
        workspaceId: "w2",
        name: "beta",
        enabled: true,
        status: "enabled",
        origin: "config",
        trigger: { type: "manual" },
        prompt: "p",
        model: null,
        modelSelection: null,
        chain: null,
        configPath: "b.yaml",
        configKey: "b",
        archivedAt: null,
        createdAt: "2026-01-01 00:00:00",
        updatedAt: "2026-01-01 00:00:00",
      },
    ];
    const runs: Run[] = Array.from({ length: 20 }, (_, i) => ({
      id: `r${i}`,
      automationId: "a1",
      workspaceId: i < 18 ? "w1" : "w2",
      status: "completed",
      agentId: null,
      sdkRunId: null,
      triggerKind: "manual",
      parentRunId: null,
      title: null,
      summary: null,
      model: null,
      modelSelection: null,
      startedAt: "2026-01-01 00:00:00",
      endedAt: "2026-01-01 00:00:00",
      createdAt: `2026-01-01 00:${String(i).padStart(2, "0")}:00`,
      updatedAt: "2026-01-01 00:00:00",
    }));
    const selected = selectListEntries(automations, runs, "w1");
    const doc = buildListJsonDocument(selected.automations, selected.runs, {
      id: "w1",
      path: "/tmp/w1",
      name: "Alpha",
      createdAt: "2026-01-01 00:00:00",
      updatedAt: "2026-01-01 00:00:00",
    });
    expect(doc.workspace).toEqual({ id: "w1", name: "Alpha" });
    expect(doc.automations.map((a) => a.id)).toEqual(["a1"]);
    expect(doc.runs).toHaveLength(LIST_RUN_DISPLAY_CAP);
    expect(doc.runs.every((run) => run.workspaceId === "w1")).toBe(true);
    expect(JSON.parse(JSON.stringify(doc)).limits.runFetchLimit).toBe(
      LIST_RUN_FETCH_LIMIT
    );
  });
});

describe("b80 status/list human key lines", () => {
  it("keeps text status and list headings in cli.ts", () => {
    const cliSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "src", "cli.ts"),
      "utf8"
    );
    expect(cliSrc).toContain("Daemon: running (${live.mode.toUpperCase()} mode)");
    expect(cliSrc).toContain("Automations: ${snapshot.automations.length}");
    expect(cliSrc).toContain('console.log("Automations");');
    expect(cliSrc).toContain('console.log("\\nRecent runs");');
    expect(cliSrc).toContain("status --json requires a live daemon");
    expect(cliSrc).toContain("max status [--json]");
    expect(cliSrc.match(/max status \[--json\]/g)?.length).toBe(1);
  });
});
