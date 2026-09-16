import { describe, expect, it } from "vitest";
import type { ChatSession } from "@lca/shared";
import {
  applyChatSessionToCollections,
  applyChatStatusToCollections,
  decideChatAutoSelect,
  type ChatCollections,
} from "../packages/dashboard/src/chatLifecycle.ts";

function session(partial: Partial<ChatSession> & { id: string }): ChatSession {
  return {
    workspaceId: "ws",
    title: null,
    titleSource: null,
    status: "idle",
    agentId: null,
    sdkRunId: null,
    model: null,
    modelSelection: null,
    systemPrompt: null,
    originRunId: null,
    attachedRunId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastMessageAt: null,
    ...partial,
  };
}

function collections(
  active: ChatSession[] = [],
  archived: ChatSession[] = []
): ChatCollections {
  return { active, archived };
}

function decide(
  overrides: Partial<Parameters<typeof decideChatAutoSelect>[0]> & {
    workspaceChats?: ChatSession[];
    archivedChats?: ChatSession[];
    activeChatId?: string | null;
  } = {}
) {
  return decideChatAutoSelect({
    activeWorkspaceId: "ws",
    activeChatId: null,
    workspaceChats: [],
    archivedChats: [],
    alreadyAutoSelectedForWorkspace: false,
    missingChatAlreadyRefetched: false,
    ...overrides,
  });
}

describe("chat auto-select after New chat", () => {
  const older = session({
    id: "old",
    title: "Older",
    lastMessageAt: "2026-01-02T00:00:00Z",
  });
  const newest = session({
    id: "new",
    title: "Newest",
    lastMessageAt: "2026-01-03T00:00:00Z",
  });

  it("picks the most recent chat when opening with no selection", () => {
    expect(
      decide({ workspaceChats: [older, newest] })
    ).toEqual({ action: "select", chatId: "new" });
  });

  it("keeps a just-created chat that is not in the list yet", () => {
    expect(
      decide({
        activeChatId: "created",
        workspaceChats: [older, newest],
      })
    ).toEqual({ action: "keep" });
  });

  it("does not steal after the created chat is upserted into the list", () => {
    const created = session({
      id: "created",
      title: null,
      updatedAt: "2026-01-04T00:00:00Z",
    });
    const next = applyChatSessionToCollections(
      collections([older, newest]),
      created
    );
    expect(next.active[0]).toEqual(created);
    expect(
      decide({
        activeChatId: "created",
        workspaceChats: next.active,
      })
    ).toEqual({ action: "mark" });
  });

  it("falls back to most recent only after a refetch still cannot find the id", () => {
    expect(
      decide({
        activeChatId: "deleted",
        workspaceChats: [older, newest],
        missingChatAlreadyRefetched: true,
      })
    ).toEqual({ action: "select", chatId: "new" });
  });

  it("does not re-select after an intentional clear (narrow back)", () => {
    expect(
      decide({
        activeChatId: null,
        workspaceChats: [older, newest],
        alreadyAutoSelectedForWorkspace: true,
      })
    ).toEqual({ action: "keep" });
  });

  it("patches live status onto the matching chat without moving lists", () => {
    const errored = session({ id: "err", status: "error", title: "Broken" });
    const idle = session({ id: "ok", title: "Fine" });
    const archived = session({
      id: "old",
      status: "error",
      archivedAt: "2026-01-01T00:00:00Z",
    });
    const next = applyChatStatusToCollections(
      collections([errored, idle], [archived]),
      "err",
      "idle"
    );
    expect(next.active.find((c) => c.id === "err")?.status).toBe("idle");
    expect(next.active.find((c) => c.id === "ok")?.status).toBe("idle");
    expect(next.archived.find((c) => c.id === "old")?.status).toBe("error");
  });

  it("ignores one-frame stale lists from another workspace", () => {
    expect(
      decide({
        workspaceChats: [session({ id: "other", workspaceId: "other-ws" })],
      })
    ).toEqual({ action: "keep" });
  });
});
