import { describe, expect, it, vi } from "vitest";
import type { Automation, Run, Workspace } from "@lca/shared";
import {
  DaemonClient,
  DaemonError,
  resolveWorkspaceId,
} from "../packages/cli/src/client.ts";
import { parseListArgs, selectListEntries } from "../packages/cli/src/list.ts";

const WS_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const AUTO_A = "auto-a";
const AUTO_B = "auto-b";

function workspace(
  id: string,
  path: string,
  name: string | null = null
): Workspace {
  return {
    id,
    path,
    name,
    createdAt: "2026-01-01 00:00:00",
    updatedAt: "2026-01-01 00:00:00",
  };
}

function automation(
  id: string,
  workspaceId: string,
  configKey: string
): Automation {
  return {
    id,
    workspaceId,
    name: configKey,
    enabled: true,
    status: "enabled",
    origin: "config",
    trigger: { type: "manual" },
    prompt: "test",
    model: null,
    modelSelection: null,
    chain: null,
    configPath: `${configKey}.yaml`,
    configKey,
    archivedAt: null,
    createdAt: "2026-01-01 00:00:00",
    updatedAt: "2026-01-01 00:00:00",
  };
}

function run(
  id: string,
  workspaceId: string,
  automationId: string,
  createdAt: string
): Run {
  return {
    id,
    automationId,
    workspaceId,
    status: "completed",
    agentId: null,
    sdkRunId: null,
    triggerKind: "manual",
    parentRunId: null,
    title: null,
    summary: null,
    model: null,
    modelSelection: null,
    startedAt: createdAt,
    endedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("parseListArgs", () => {
  it("accepts --workspace with a value", () => {
    expect(parseListArgs(["--workspace", "my-workspace"])).toEqual({
      workspaceQuery: "my-workspace",
    });
  });

  it("accepts -w with a value", () => {
    expect(parseListArgs(["-w", WS_A])).toEqual({
      workspaceQuery: WS_A,
    });
  });

  it("returns undefined when no workspace flag is present", () => {
    expect(parseListArgs([])).toEqual({ workspaceQuery: undefined });
  });

  it("throws when --workspace is missing a value", () => {
    expect(() => parseListArgs(["--workspace"])).toThrow(DaemonError);
    expect(() => parseListArgs(["--workspace"])).toThrow(
      "--workspace requires an id|name"
    );
  });

  it("throws when -w is missing a value", () => {
    expect(() => parseListArgs(["-w"])).toThrow(DaemonError);
    expect(() => parseListArgs(["-w"])).toThrow(
      "--workspace requires an id|name"
    );
  });

  it("throws on unknown options", () => {
    expect(() => parseListArgs(["--format", "json"])).toThrow(DaemonError);
    expect(() => parseListArgs(["--format", "json"])).toThrow(
      "Unknown list option: --format"
    );
  });
});

describe("selectListEntries", () => {
  const automations = [
    automation(AUTO_A, WS_A, "alpha"),
    automation(AUTO_B, WS_B, "beta"),
  ];

  it("returns all automations and the first 15 runs when unfiltered", () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      run(`run-${i}`, WS_A, AUTO_A, `2026-01-01 00:${String(i).padStart(2, "0")}:00`)
    );

    const result = selectListEntries(automations, runs);

    expect(result.automations).toEqual(automations);
    expect(result.runs).toHaveLength(15);
    expect(result.runs.map((r) => r.id)).toEqual(
      runs.slice(0, 15).map((r) => r.id)
    );
    expect(automations).toHaveLength(2);
    expect(runs).toHaveLength(20);
  });

  it("filters automations and runs by workspaceId independently", () => {
    const runs = [
      run("run-wrong-ws", WS_B, AUTO_A, "2026-01-01 00:00:00"),
      run("run-right-ws", WS_A, AUTO_B, "2026-01-01 00:01:00"),
    ];

    const result = selectListEntries(automations, runs, WS_A);

    expect(result.automations.map((a) => a.id)).toEqual([AUTO_A]);
    expect(result.runs.map((r) => r.id)).toEqual(["run-right-ws"]);
  });

  it("applies the 15-run cap after workspace filtering", () => {
    const foreignRuns = Array.from({ length: 20 }, (_, i) =>
      run(`foreign-${i}`, WS_B, AUTO_B, `2026-01-01 00:${String(i).padStart(2, "0")}:00`)
    );
    const matchingRuns = Array.from({ length: 20 }, (_, i) =>
      run(`match-${i}`, WS_A, AUTO_A, `2026-01-02 00:${String(i).padStart(2, "0")}:00`)
    );
    const runs = [...foreignRuns, ...matchingRuns];

    const result = selectListEntries(automations, runs, WS_A);

    expect(result.runs).toHaveLength(15);
    expect(result.runs.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(result.runs.map((r) => r.id)).toEqual(
      matchingRuns.slice(0, 15).map((r) => r.id)
    );
  });

  it("returns empty collections for a workspace with no matches", () => {
    const result = selectListEntries(automations, [], WS_A);

    expect(result.automations.map((a) => a.id)).toEqual([AUTO_A]);
    expect(result.runs).toEqual([]);
  });

  it("returns empty automations and runs for an unused workspace id", () => {
    const runs = [run("run-a", WS_A, AUTO_A, "2026-01-01 00:00:00")];
    const unused = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const result = selectListEntries(automations, runs, unused);

    expect(result.automations).toEqual([]);
    expect(result.runs).toEqual([]);
  });

  it("does not mutate caller-owned arrays", () => {
    const runs = [run("run-a", WS_A, AUTO_A, "2026-01-01 00:00:00")];
    const autoCopy = [...automations];
    const runCopy = [...runs];

    selectListEntries(automations, runs, WS_A);

    expect(automations).toEqual(autoCopy);
    expect(runs).toEqual(runCopy);
  });
});

describe("resolveWorkspaceId (list/export shared resolver)", () => {
  const workspaces = [
    workspace(WS_A, "C:\\Code\\alpha", "Alpha"),
    workspace(WS_B, "C:\\Code\\beta", "Beta"),
  ];

  function clientWithWorkspaces(): DaemonClient {
    const client = new DaemonClient("http://127.0.0.1:3747");
    vi.spyOn(client, "listWorkspaces").mockResolvedValue(workspaces);
    return client;
  }

  it("resolves an exact workspace id", async () => {
    const client = clientWithWorkspaces();
    await expect(resolveWorkspaceId(client, WS_A)).resolves.toBe(WS_A);
  });

  it("resolves a case-insensitive workspace name", async () => {
    const client = clientWithWorkspaces();
    await expect(resolveWorkspaceId(client, "alpha")).resolves.toBe(WS_A);
  });

  it("throws on ambiguous workspace selectors", async () => {
    const client = new DaemonClient("http://127.0.0.1:3747");
    vi.spyOn(client, "listWorkspaces").mockResolvedValue([
      workspace("ws-1", "C:\\Code\\foo", "Foo"),
      workspace("ws-2", "C:\\Code\\bar", "Foo"),
    ]);

    await expect(resolveWorkspaceId(client, "Foo")).rejects.toThrow(DaemonError);
    await expect(resolveWorkspaceId(client, "Foo")).rejects.toThrow(
      'Ambiguous workspace "Foo". Use the full id.'
    );
  });

  it("throws when no workspace matches", async () => {
    const client = clientWithWorkspaces();
    await expect(resolveWorkspaceId(client, "missing")).rejects.toThrow(
      DaemonError
    );
    await expect(resolveWorkspaceId(client, "missing")).rejects.toThrow(
      'No workspace matches "missing".'
    );
  });
});
