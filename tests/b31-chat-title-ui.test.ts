import { describe, expect, it } from "vitest";
import type { ChatSession } from "@lca/shared";
import {
  displayChatTitle,
  mergeChatSession,
  removeDeletedChats,
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
    systemPrompt: null,
    originRunId: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastMessageAt: null,
    ...partial,
  };
}

describe("b31.3 chat lifecycle UI helpers", () => {
  it("displayChatTitle falls back only when title is blank", () => {
    expect(displayChatTitle(null)).toBe("Untitled chat");
    expect(displayChatTitle(session({ id: "a", title: null }))).toBe(
      "Untitled chat"
    );
    expect(displayChatTitle(session({ id: "a", title: "  " }))).toBe(
      "Untitled chat"
    );
    expect(displayChatTitle(session({ id: "a", title: "Fix CI" }))).toBe(
      "Fix CI"
    );
  });

  it("mergeChatSession updates, inserts, and drops archived", () => {
    const a = session({ id: "a", title: "A" });
    const b = session({ id: "b", title: "B" });
    const updatedA = session({
      id: "a",
      title: "A renamed",
      titleSource: "user",
    });
    expect(mergeChatSession([a, b], updatedA)).toEqual([updatedA, b]);

    const c = session({ id: "c", title: "C", titleSource: "auto" });
    expect(mergeChatSession([a, b], c)[0]).toEqual(c);

    const archived = session({
      id: "a",
      title: "A",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    expect(mergeChatSession([a, b], archived)).toEqual([b]);
  });

  it("removeDeletedChats drops matching ids", () => {
    const a = session({ id: "a" });
    const b = session({ id: "b" });
    expect(removeDeletedChats([a, b], ["a"])).toEqual([b]);
    expect(removeDeletedChats([a, b], [])).toEqual([a, b]);
  });
});
