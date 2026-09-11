import type { ChatSession } from "@lca/shared";

/** Active and archived workspace chat lists; an id appears in at most one. */
export type ChatCollections = {
  active: ChatSession[];
  archived: ChatSession[];
};

/** Display label for a chat; only falls back when title is null/blank. */
export function displayChatTitle(
  chat: Pick<ChatSession, "title"> | null | undefined
): string {
  return chat?.title?.trim() || "Untitled chat";
}

function upsertChat(chats: ChatSession[], session: ChatSession): ChatSession[] {
  const idx = chats.findIndex((c) => c.id === session.id);
  if (idx === -1) {
    return [session, ...chats];
  }
  const next = [...chats];
  next[idx] = session;
  return next;
}

function withoutChatId(chats: ChatSession[], chatId: string): ChatSession[] {
  return chats.filter((c) => c.id !== chatId);
}

/**
 * Merge a live `chat_session` into dual collections.
 * Archived sessions leave active and upsert into archived; active sessions do
 * the reverse. An id never remains in both lists.
 */
export function applyChatSessionToCollections(
  collections: ChatCollections,
  session: ChatSession
): ChatCollections {
  if (session.archivedAt) {
    return {
      active: withoutChatId(collections.active, session.id),
      archived: upsertChat(collections.archived, session),
    };
  }
  return {
    active: upsertChat(collections.active, session),
    archived: withoutChatId(collections.archived, session.id),
  };
}

/** Remove deleted chat ids from both collections. */
export function removeDeletedFromCollections(
  collections: ChatCollections,
  chatIds: string[]
): ChatCollections {
  if (chatIds.length === 0) return collections;
  return {
    active: removeDeletedChats(collections.active, chatIds),
    archived: removeDeletedChats(collections.archived, chatIds),
  };
}

/**
 * Merge a live `chat_session` frame into the active workspace list.
 * Archived sessions are removed from the active list (use
 * `applyChatSessionToCollections` when tracking archived separately).
 */
export function mergeChatSession(
  chats: ChatSession[],
  session: ChatSession
): ChatSession[] {
  const idx = chats.findIndex((c) => c.id === session.id);
  if (session.archivedAt) {
    if (idx === -1) return chats;
    return [...chats.slice(0, idx), ...chats.slice(idx + 1)];
  }
  if (idx === -1) {
    return [session, ...chats];
  }
  const next = [...chats];
  next[idx] = session;
  return next;
}

/** Remove deleted chat ids from the list. */
export function removeDeletedChats(
  chats: ChatSession[],
  chatIds: string[]
): ChatSession[] {
  if (chatIds.length === 0) return chats;
  const gone = new Set(chatIds);
  return chats.filter((c) => !gone.has(c.id));
}

/** Recency for list ordering — prefers last message, else updatedAt. */
export function chatRecencyMs(chat: ChatSession): number {
  const raw = chat.lastMessageAt ?? chat.updatedAt;
  const ms = Date.parse(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Newest-first by {@link chatRecencyMs}. */
export function sortChatsByRecency(chats: ChatSession[]): ChatSession[] {
  return [...chats].sort((a, b) => chatRecencyMs(b) - chatRecencyMs(a));
}

/** Most recently active chat, or null when the list is empty. */
export function mostRecentChat(chats: ChatSession[]): ChatSession | null {
  const sorted = sortChatsByRecency(chats);
  return sorted[0] ?? null;
}
