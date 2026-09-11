import { describe, expect, it, vi } from "vitest";
import type {
  ChatEvent,
  ChatSession,
  ChatSnapshot,
  Run,
  Workspace,
} from "@lca/shared";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import { DaemonError } from "../packages/cli/src/client.ts";
import {
  diagnoseChat,
  diagnoseRun,
  resolveDoctorTarget,
  type DoctorLookupClient,
} from "../packages/cli/src/doctor.ts";

function runEvent(
  seq: number,
  event_type: string,
  payload: Record<string, unknown> = {}
): RunSnapshot["events"][number] {
  return { seq, event_type, payload: JSON.stringify(payload) };
}

function chatEvent(
  seq: number,
  eventType: string,
  payload: Record<string, unknown> = {},
  createdAt = "2026-07-10 12:00:00"
): ChatEvent {
  return {
    id: seq,
    chatId: "chat-1",
    seq,
    eventType,
    payload: JSON.stringify(payload),
    createdAt,
  };
}

function baseRun(
  overrides: Partial<RunSnapshot["run"]> = {}
): RunSnapshot["run"] {
  return {
    id: "run-aaaaaaaa",
    status: "failed",
    automation_id: "auto-1",
    workspace_id: "ws-1",
    trigger_kind: "manual",
    agent_id: null,
    sdk_run_id: null,
    prompt: null,
    title: null,
    summary: null,
    started_at: "2026-07-10 12:00:00",
    ended_at: "2026-07-10 12:01:00",
    created_at: "2026-07-10 12:00:00",
    ...overrides,
  };
}

function baseSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "chat-bbbbbbbb",
    workspaceId: "ws-1",
    title: "Test chat",
    titleSource: "user",
    status: "error",
    agentId: "agent-1",
    sdkRunId: null,
    model: null,
    systemPrompt: null,
    originRunId: null,
    archivedAt: null,
    createdAt: "2026-07-10 12:00:00",
    updatedAt: "2026-07-10 12:01:00",
    lastMessageAt: "2026-07-10 12:01:00",
    ...overrides,
  };
}

function listRun(id: string, status: Run["status"] = "completed"): Run {
  return {
    id,
    automationId: "auto-1",
    workspaceId: "ws-1",
    status,
    agentId: null,
    sdkRunId: null,
    triggerKind: "manual",
    parentRunId: null,
    title: null,
    summary: null,
    model: null,
    modelSelection: null,
    startedAt: null,
    endedAt: null,
    createdAt: "2026-07-10 12:00:00",
    updatedAt: "2026-07-10 12:00:00",
  };
}

function workspace(id: string): Workspace {
  return {
    id,
    path: `/tmp/${id}`,
    name: id,
    createdAt: "2026-07-10 12:00:00",
    updatedAt: "2026-07-10 12:00:00",
  };
}

describe("diagnoseRun (extracted)", () => {
  it("classifies auth_expired as re-auth required, not restart", () => {
    const snapshot: RunSnapshot = {
      run: baseRun(),
      events: [
        runEvent(1, "run.error", {
          reason: "auth_expired",
          message: "ERROR_NOT_LOGGED_IN",
        }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/auth expired/i);
    expect(verdict).toMatch(/CURSOR_API_KEY|cursor-agent login/i);
    expect(verdict).toMatch(/restart will not fix/i);
  });

  it("classifies stale + reviveFailed as exhausted revive", () => {
    const snapshot: RunSnapshot = {
      run: baseRun(),
      events: [
        runEvent(1, "run.error", {
          message: "spawn failed",
          stale: true,
          reviveFailed: true,
        }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/revive spawn failed/i);
    expect(verdict).toMatch(/re-trigger/i);
  });

  it("reports completed OK", () => {
    const snapshot: RunSnapshot = {
      run: baseRun({ status: "completed", ended_at: "2026-07-10 12:02:00" }),
      events: [runEvent(1, "run.finished", { sdkStatus: "finished" })],
      inputRequests: [],
    };
    expect(diagnoseRun(snapshot, [])).toMatch(/completed OK/i);
  });

  it("reports self-healed after run.revived", () => {
    const snapshot: RunSnapshot = {
      run: baseRun({ status: "running" }),
      events: [
        runEvent(1, "run.error", { message: "stale", stale: true }),
        runEvent(2, "run.revived", { model: "composer-2" }),
      ],
      inputRequests: [],
    };
    // Last error still present; stale+revived path or revived fallback.
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/self-healed|revived/i);
  });

  it("describes parked halt-discovery briefing and tolerates malformed discovery payloads", () => {
    const pending: RunSnapshot = {
      run: baseRun({
        id: "advisory-aaaaaaaa",
        status: "needs_input",
        trigger_kind: "halt-discovery",
        parent_run_id: "source-bbbbbbbb",
        ended_at: null,
      }),
      events: [
        runEvent(1, "run.pipeline-halt-discovery-action-result", {
          // malformed — missing required fields
          outcome: "acted",
        }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(pending, []);
    expect(verdict).toMatch(/briefing awaiting/i);
    expect(verdict).toMatch(/no timeout/i);
    expect(verdict).toContain("lca escalate source-bbbbbbbb");
  });
});

describe("diagnoseChat", () => {
  it("classifies auth_expired as re-auth required, not restart", () => {
    const snapshot: ChatSnapshot = {
      session: baseSession({ status: "error" }),
      events: [
        chatEvent(1, "chat.error", {
          reason: "auth_expired",
          message: "not logged in",
        }),
      ],
    };
    const verdict = diagnoseChat(snapshot, []);
    expect(verdict).toMatch(/auth expired/i);
    expect(verdict).toMatch(/CURSOR_API_KEY|cursor-agent login/i);
    expect(verdict).toMatch(/restart will not fix/i);
    expect(verdict).not.toMatch(/lca restart will fix/i);
  });

  it("classifies revive success as self-healed when no later terminal error", () => {
    const snapshot: ChatSnapshot = {
      session: baseSession({ status: "idle" }),
      events: [
        chatEvent(1, "chat.error", { message: "stale", stale: true }),
        chatEvent(2, "chat.revived", { model: "composer-2" }),
      ],
    };
    const verdict = diagnoseChat(snapshot, []);
    expect(verdict).toMatch(/self-healed/i);
    expect(verdict).toMatch(/revived/i);
  });

  it("classifies stale + reviveFailed as exhausted revive", () => {
    const snapshot: ChatSnapshot = {
      session: baseSession({ status: "error" }),
      events: [
        chatEvent(1, "chat.error", {
          message: "spawn blew up",
          stale: true,
          reviveFailed: true,
        }),
      ],
    };
    const verdict = diagnoseChat(snapshot, []);
    expect(verdict).toMatch(/revive spawn failed/i);
    expect(verdict).toMatch(/fresh chat|re-send/i);
  });

  it("mentions reconciliation evidence", () => {
    const snapshot: ChatSnapshot = {
      session: baseSession({ status: "idle" }),
      events: [
        chatEvent(1, "chat.reconciled", { priorStatus: "running" }),
        chatEvent(2, "chat.revived", {}),
      ],
    };
    const verdict = diagnoseChat(snapshot, []);
    expect(verdict).toMatch(/self-healed/i);
    expect(verdict).toMatch(/reconciliation/i);
  });

  it("mentions resume retry evidence when retry is followed by failure", () => {
    const snapshot: ChatSnapshot = {
      session: baseSession({ status: "error" }),
      events: [
        chatEvent(1, "chat.resume.retry", {
          attempt: 1,
          maxAttempts: 3,
          delayMs: 15,
          message: "transient",
        }),
        chatEvent(2, "chat.error", {
          message: "still broken",
          stale: true,
          reviveFailed: true,
        }),
      ],
    };
    const verdict = diagnoseChat(snapshot, []);
    expect(verdict).toMatch(/revive spawn failed/i);
    expect(verdict).toMatch(/resume retry/i);
  });

  it("treats idle as a normal usable success state", () => {
    const snapshot: ChatSnapshot = {
      session: baseSession({ status: "idle" }),
      events: [chatEvent(1, "chat.finished", { sdkStatus: "finished" })],
    };
    const verdict = diagnoseChat(snapshot, []);
    expect(verdict).toMatch(/idle OK/i);
    expect(verdict).toMatch(/usable/i);
  });

  it("preserves camelCase chat event fields (eventType, createdAt)", () => {
    const ev = chatEvent(1, "chat.error", { reason: "auth_expired" }, "2026-07-10 15:00:00");
    expect(ev.eventType).toBe("chat.error");
    expect(ev.createdAt).toBe("2026-07-10 15:00:00");
    expect(
      (ev as unknown as { event_type?: string }).event_type
    ).toBeUndefined();

    const snapshot: ChatSnapshot = {
      session: baseSession(),
      events: [ev],
    };
    // diagnoseChat must read eventType, not coerce to snake_case.
    expect(diagnoseChat(snapshot, [])).toMatch(/auth expired/i);
  });
});

describe("resolveDoctorTarget", () => {
  function mockClient(opts: {
    runs?: Map<string, RunSnapshot>;
    chats?: Map<string, ChatSnapshot>;
    listRuns?: Run[];
    workspaces?: Workspace[];
    workspaceChats?: Map<string, ChatSession[]>;
    failWorkspaceChats?: Set<string>;
  }): DoctorLookupClient {
    const runs = opts.runs ?? new Map();
    const chats = opts.chats ?? new Map();
    return {
      getRun: vi.fn(async (id: string) => {
        const snap = runs.get(id);
        if (!snap) throw new DaemonError("404 Not Found: run not found");
        return snap;
      }),
      getChat: vi.fn(async (id: string) => {
        const snap = chats.get(id);
        if (!snap) throw new DaemonError("404 Not Found: chat not found");
        return snap;
      }),
      listRuns: vi.fn(async () => opts.listRuns ?? [...runs.values()].map((s) => listRun(s.run.id, s.run.status))),
      listWorkspaces: vi.fn(async () => opts.workspaces ?? [workspace("ws-1")]),
      listWorkspaceChats: vi.fn(async (workspaceId: string) => {
        if (opts.failWorkspaceChats?.has(workspaceId)) {
          throw new DaemonError("404 Not Found: workspace not found");
        }
        return opts.workspaceChats?.get(workspaceId) ?? [];
      }),
    };
  }

  it("resolves an exact run id", async () => {
    const snap: RunSnapshot = {
      run: baseRun({ id: "run-exact-1" }),
      events: [],
      inputRequests: [],
    };
    const client = mockClient({ runs: new Map([["run-exact-1", snap]]) });
    const target = await resolveDoctorTarget(client, "run-exact-1");
    expect(target.kind).toBe("run");
    if (target.kind === "run") {
      expect(target.snapshot.run.id).toBe("run-exact-1");
    }
  });

  it("resolves an exact active chat id", async () => {
    const snap: ChatSnapshot = {
      session: baseSession({ id: "chat-exact-1", status: "idle" }),
      events: [],
    };
    const client = mockClient({ chats: new Map([["chat-exact-1", snap]]) });
    const target = await resolveDoctorTarget(client, "chat-exact-1");
    expect(target.kind).toBe("chat");
    if (target.kind === "chat") {
      expect(target.snapshot.session.id).toBe("chat-exact-1");
      expect(target.snapshot.session.archivedAt).toBeNull();
    }
  });

  it("resolves an exact archived chat by full id", async () => {
    const snap: ChatSnapshot = {
      session: baseSession({
        id: "chat-archived-1",
        status: "idle",
        archivedAt: "2026-07-09 10:00:00",
      }),
      events: [chatEvent(1, "chat.finished", {})],
    };
    const client = mockClient({
      chats: new Map([["chat-archived-1", snap]]),
      // Prefix list would not include archived; exact still works.
      workspaceChats: new Map([["ws-1", []]]),
    });
    const target = await resolveDoctorTarget(client, "chat-archived-1");
    expect(target.kind).toBe("chat");
    if (target.kind === "chat") {
      expect(target.snapshot.session.archivedAt).toBe("2026-07-09 10:00:00");
    }
  });

  it("resolves a unique run prefix with no minimum length", async () => {
    const snap: RunSnapshot = {
      run: baseRun({ id: "abcdef12-run" }),
      events: [],
      inputRequests: [],
    };
    const client = mockClient({
      listRuns: [listRun("abcdef12-run")],
      runs: new Map([["abcdef12-run", snap]]),
    });
    // Short prefix (<4) still works for runs.
    const target = await resolveDoctorTarget(client, "ab");
    expect(target.kind).toBe("run");
    if (target.kind === "run") {
      expect(target.snapshot.run.id).toBe("abcdef12-run");
    }
  });

  it("resolves a unique chat prefix when query is ≥4 chars", async () => {
    const session = baseSession({ id: "chatdeadbeef01", status: "idle" });
    const snap: ChatSnapshot = { session, events: [] };
    const client = mockClient({
      listRuns: [],
      workspaces: [workspace("ws-1")],
      workspaceChats: new Map([["ws-1", [session]]]),
      chats: new Map([["chatdeadbeef01", snap]]),
    });
    const target = await resolveDoctorTarget(client, "chat");
    expect(target.kind).toBe("chat");
    if (target.kind === "chat") {
      expect(target.snapshot.session.id).toBe("chatdeadbeef01");
    }
  });

  it("errors on cross-kind ambiguous prefix", async () => {
    const runSnap: RunSnapshot = {
      run: baseRun({ id: "abcd-run-xxxx" }),
      events: [],
      inputRequests: [],
    };
    const session = baseSession({ id: "abcd-chat-yyyy", status: "idle" });
    const chatSnap: ChatSnapshot = { session, events: [] };
    const client = mockClient({
      listRuns: [listRun("abcd-run-xxxx")],
      runs: new Map([["abcd-run-xxxx", runSnap]]),
      workspaces: [workspace("ws-1")],
      workspaceChats: new Map([["ws-1", [session]]]),
      chats: new Map([["abcd-chat-yyyy", chatSnap]]),
    });
    await expect(resolveDoctorTarget(client, "abcd")).rejects.toThrow(
      /Ambiguous id prefix/i
    );
  });

  it("skips workspace chat list failures during prefix fan-out", async () => {
    const session = baseSession({ id: "uniqchat9999", status: "idle" });
    const snap: ChatSnapshot = { session, events: [] };
    const client = mockClient({
      listRuns: [],
      workspaces: [workspace("ws-bad"), workspace("ws-1")],
      failWorkspaceChats: new Set(["ws-bad"]),
      workspaceChats: new Map([["ws-1", [session]]]),
      chats: new Map([["uniqchat9999", snap]]),
    });
    const target = await resolveDoctorTarget(client, "uniq");
    expect(target.kind).toBe("chat");
  });

  it("says no run or chat when nothing matches", async () => {
    const client = mockClient({ listRuns: [], workspaceChats: new Map() });
    await expect(resolveDoctorTarget(client, "zzzz")).rejects.toThrow(
      /No run or chat matches/i
    );
  });
});
