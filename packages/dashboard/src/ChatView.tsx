import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import type { ChatSession, Workspace } from "@lca/shared";
import { cn } from "@/lib/utils";
import { api } from "./api";
import {
  applyChatSessionToCollections,
  mostRecentChat,
  removeDeletedFromCollections,
  type ChatCollections,
} from "./chatLifecycle";
import { workspaceLabel } from "./helpers";
import { ChatConversation } from "./ChatConversation";
import { ChatList } from "./ChatList";
import { connectLiveSocket } from "./liveSocket";

export type ChatViewProps = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeChatId: string | null;
  onSelectChat: (id: string | null) => void;
  isNarrow: boolean;
  /** Bump to refetch chat list (e.g. after run promotion). */
  refreshNonce?: number;
};

const emptyCollections = (): ChatCollections => ({
  active: [],
  archived: [],
});

export function ChatView({
  workspaces,
  activeWorkspaceId,
  activeChatId,
  onSelectChat,
  isNarrow,
  refreshNonce = 0,
}: ChatViewProps): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [collections, setCollections] =
    useState<ChatCollections>(emptyCollections);
  const missingChatRefetchRef = useRef<string | null>(null);
  /** Workspace we already auto-selected for; lets narrow "back" keep the list. */
  const autoSelectedForWsRef = useRef<string | null>(null);
  const activeChatIdRef = useRef(activeChatId);
  activeChatIdRef.current = activeChatId;
  const workspaceIdRef = useRef(activeWorkspaceId);
  workspaceIdRef.current = activeWorkspaceId;

  const workspaceChats = collections.active;
  const archivedChats = collections.archived;

  const activeSession = useMemo(
    () =>
      activeChatId
        ? workspaceChats.find((c) => c.id === activeChatId) ??
          archivedChats.find((c) => c.id === activeChatId) ??
          null
        : null,
    [activeChatId, workspaceChats, archivedChats]
  );

  const workspaceName =
    activeWorkspaceId !== null
      ? workspaceLabel(activeWorkspaceId, workspaces)
      : undefined;

  // Clear both collections when the workspace changes so stale rows never linger.
  useEffect(() => {
    setCollections(emptyCollections());
    missingChatRefetchRef.current = null;
    autoSelectedForWsRef.current = null;
  }, [activeWorkspaceId]);

  // When opening Chats (or switching workspace), pick the newest active chat if
  // nothing valid is selected. Skip re-select after an intentional clear (narrow back).
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (workspaceChats.length === 0) return;
    // Ignore one-frame stale lists after a workspace switch (clear runs in an effect).
    if (workspaceChats.some((c) => c.workspaceId !== activeWorkspaceId)) {
      return;
    }

    const selectionValid =
      activeChatId != null &&
      (workspaceChats.some((c) => c.id === activeChatId) ||
        archivedChats.some((c) => c.id === activeChatId));

    if (selectionValid) {
      autoSelectedForWsRef.current = activeWorkspaceId;
      return;
    }

    if (
      activeChatId == null &&
      autoSelectedForWsRef.current === activeWorkspaceId
    ) {
      return;
    }

    const first = mostRecentChat(workspaceChats);
    if (!first) return;
    autoSelectedForWsRef.current = activeWorkspaceId;
    onSelectChat(first.id);
  }, [
    activeWorkspaceId,
    activeChatId,
    workspaceChats,
    archivedChats,
    onSelectChat,
  ]);

  const handleChatsChange = useCallback((chats: ChatSession[]) => {
    setCollections((prev) => ({ ...prev, active: chats }));
  }, []);

  const handleArchivedChatsChange = useCallback((chats: ChatSession[]) => {
    setCollections((prev) => ({ ...prev, archived: chats }));
  }, []);

  const handleChatUpdated = useCallback(
    (chat: ChatSession) => {
      let shouldDeselect = false;
      setCollections((prev) => {
        const wasActive = prev.active.some((c) => c.id === chat.id);
        if (
          chat.archivedAt &&
          wasActive &&
          activeChatIdRef.current === chat.id
        ) {
          shouldDeselect = true;
        }
        return applyChatSessionToCollections(prev, chat);
      });
      if (shouldDeselect) onSelectChat(null);
    },
    [onSelectChat]
  );

  const handleChatDeleted = useCallback(
    (chatId: string) => {
      setCollections((prev) => removeDeletedFromCollections(prev, [chatId]));
      if (activeChatIdRef.current === chatId) {
        onSelectChat(null);
      }
    },
    [onSelectChat]
  );

  useEffect(() => {
    if (!activeChatId) {
      missingChatRefetchRef.current = null;
      return;
    }
    if (
      workspaceChats.some((c) => c.id === activeChatId) ||
      archivedChats.some((c) => c.id === activeChatId)
    ) {
      missingChatRefetchRef.current = null;
      return;
    }
    if (workspaceChats.length === 0 && archivedChats.length === 0) return;
    if (missingChatRefetchRef.current === activeChatId) return;
    missingChatRefetchRef.current = activeChatId;
    setListRefresh((n) => n + 1);
  }, [activeChatId, workspaceChats, archivedChats]);

  // Live chat_session / chats_deleted for list + header sync.
  useEffect(() => {
    return connectLiveSocket({
      onOpen: () => {
        // List REST refetch covers updates missed while the socket was zombie.
        setListRefresh((n) => n + 1);
      },
      onMessage: (msg) => {
        if (msg.type === "chat_session") {
          const wsId = workspaceIdRef.current;
          if (!wsId || msg.session.workspaceId !== wsId) return;
          let shouldDeselect = false;
          setCollections((prev) => {
            const wasActive = prev.active.some((c) => c.id === msg.session.id);
            if (
              msg.session.archivedAt &&
              wasActive &&
              activeChatIdRef.current === msg.chatId
            ) {
              shouldDeselect = true;
            }
            return applyChatSessionToCollections(prev, msg.session);
          });
          if (shouldDeselect) onSelectChat(null);
        } else if (msg.type === "chats_deleted") {
          setCollections((prev) =>
            removeDeletedFromCollections(prev, msg.chatIds)
          );
          if (
            activeChatIdRef.current &&
            msg.chatIds.includes(activeChatIdRef.current)
          ) {
            onSelectChat(null);
          }
        }
      },
    });
  }, [onSelectChat]);

  const handleNewChat = useCallback(async () => {
    if (!activeWorkspaceId || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const chat = await api.createChat(activeWorkspaceId);
      onSelectChat(chat.id);
      setListRefresh((n) => n + 1);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [activeWorkspaceId, creating, onSelectChat]);

  if (workspaces.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col bg-card",
          isNarrow && "pb-16"
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center border border-border bg-card p-6 text-center">
          <p className="m-0 text-sm text-muted-foreground">
            Map a workspace to start chatting with an agent.
          </p>
        </div>
      </div>
    );
  }

  const listProps = {
    activeWorkspaceName: workspaceName,
    activeWorkspaceId,
    activeChatId,
    onSelectChat,
    onNewChat: () => void handleNewChat(),
    creating,
    refreshNonce: refreshNonce + listRefresh,
    onChatsChange: handleChatsChange,
    chats: workspaceChats,
    archivedChats,
    onArchivedChatsChange: handleArchivedChatsChange,
    onChatUpdated: handleChatUpdated,
    onChatDeleted: handleChatDeleted,
  };

  const conversationProps = {
    chatId: activeChatId,
    workspaceId: activeWorkspaceId,
    session: activeSession,
    workspaceName,
    onSelectChat,
    onChatUpdated: handleChatUpdated,
    onChatDeleted: handleChatDeleted,
  };

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-card",
        isNarrow && "pb-16"
      )}
    >
      {createError && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {createError}
        </div>
      )}

      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          isNarrow ? "flex-col" : "flex-row"
        )}
      >
        {isNarrow ? (
          activeChatId == null ? (
            <ChatList {...listProps} isNarrow />
          ) : (
            <ChatConversation {...conversationProps} isNarrow />
          )
        ) : (
          <>
            <ChatList {...listProps} />
            <ChatConversation
              {...conversationProps}
              onNewChat={() => void handleNewChat()}
            />
          </>
        )}
      </div>
    </div>
  );
}
