import { describe, expect, it } from "vitest";
import type { ChatSession } from "@lca/shared";
import {
  applyChatSessionToCollections,
  displayChatTitle,
  removeDeletedFromCollections,
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
    systemPrompt: null,
    originRunId: null,
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

describe("b33 archived chat UI collection helpers", () => {
  it("preserves displayChatTitle fallback", () => {
    expect(displayChatTitle(session({ id: "a", title: null }))).toBe(
      "Untitled chat"
    );
    expect(displayChatTitle(session({ id: "a", title: "Notes" }))).toBe(
      "Notes"
    );
  });

  it("archives by moving from active to archived", () => {
    const a = session({ id: "a", title: "A" });
    const b = session({ id: "b", title: "B" });
    const archivedA = session({
      id: "a",
      title: "A",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    const next = applyChatSessionToCollections(collections([a, b]), archivedA);
    expect(next.active).toEqual([b]);
    expect(next.archived).toEqual([archivedA]);
  });

  it("unarchives by moving from archived to active", () => {
    const archivedA = session({
      id: "a",
      title: "A",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    const b = session({ id: "b", title: "B" });
    const restored = session({ id: "a", title: "A", archivedAt: null });
    const next = applyChatSessionToCollections(
      collections([b], [archivedA]),
      restored
    );
    expect(next.archived).toEqual([]);
    expect(next.active[0]).toEqual(restored);
    expect(next.active).toContainEqual(b);
  });

  it("renames in the active collection without touching archived", () => {
    const a = session({ id: "a", title: "A" });
    const archivedB = session({
      id: "b",
      title: "B",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    const renamed = session({
      id: "a",
      title: "A renamed",
      titleSource: "user",
    });
    const next = applyChatSessionToCollections(
      collections([a], [archivedB]),
      renamed
    );
    expect(next.active).toEqual([renamed]);
    expect(next.archived).toEqual([archivedB]);
  });

  it("renames in the archived collection without touching active", () => {
    const a = session({ id: "a", title: "A" });
    const archivedB = session({
      id: "b",
      title: "B",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    const renamed = session({
      id: "b",
      title: "B renamed",
      titleSource: "user",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    const next = applyChatSessionToCollections(
      collections([a], [archivedB]),
      renamed
    );
    expect(next.active).toEqual([a]);
    expect(next.archived).toEqual([renamed]);
  });

  it("prevents duplicate ids across collections on archive and unarchive", () => {
    const a = session({ id: "a", title: "A" });
    // Simulate a stale duplicate already present in archived.
    const staleArchived = session({
      id: "a",
      title: "stale",
      archivedAt: "2026-01-01T00:00:00Z",
    });
    const archived = session({
      id: "a",
      title: "A",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    const afterArchive = applyChatSessionToCollections(
      collections([a], [staleArchived]),
      archived
    );
    expect(afterArchive.active.some((c) => c.id === "a")).toBe(false);
    expect(afterArchive.archived.filter((c) => c.id === "a")).toHaveLength(1);
    expect(afterArchive.archived[0]).toEqual(archived);

    const restored = session({ id: "a", title: "A", archivedAt: null });
    const afterUnarchive = applyChatSessionToCollections(
      afterArchive,
      restored
    );
    expect(afterUnarchive.archived.some((c) => c.id === "a")).toBe(false);
    expect(afterUnarchive.active.filter((c) => c.id === "a")).toHaveLength(1);
  });

  it("deletes ids from both collections", () => {
    const a = session({ id: "a" });
    const b = session({ id: "b" });
    const archivedC = session({
      id: "c",
      archivedAt: "2026-01-02T00:00:00Z",
    });
    const next = removeDeletedFromCollections(
      collections([a, b], [archivedC]),
      ["a", "c"]
    );
    expect(next.active).toEqual([b]);
    expect(next.archived).toEqual([]);
  });

  it("inserts a new active session at the front", () => {
    const a = session({ id: "a" });
    const c = session({ id: "c", title: "C" });
    const next = applyChatSessionToCollections(collections([a]), c);
    expect(next.active[0]).toEqual(c);
    expect(next.archived).toEqual([]);
  });
});
