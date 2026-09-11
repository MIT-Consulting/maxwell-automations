import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { Archive, ArchiveRestore, MessageSquarePlus, MoreHorizontal } from "lucide-react";
import type { ChatSession } from "@lca/shared";
import { api } from "./api";
import { chatRecencyMs, displayChatTitle, sortChatsByRecency } from "./chatLifecycle";
import { ChatTitleEditor } from "./ChatTitleEditor";
import { ConfirmButton } from "./ConfirmButton";
import { formatRelativeToNow } from "./helpers";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type ChatListMode = "active" | "archived";

export type ChatListProps = {
  /** Read-only label — the sidebar is the only place workspace is selected. */
  activeWorkspaceName?: string;
  activeWorkspaceId: string | null;
  activeChatId: string | null;
  onSelectChat: (id: string | null) => void;
  onNewChat: () => void;
  creating: boolean;
  /** Bump to refetch (e.g. after run promotion). */
  refreshNonce?: number;
  onChatsChange?: (chats: ChatSession[]) => void;
  /** Controlled active chats from parent (WS merges). When set, list uses these. */
  chats?: ChatSession[];
  /** Controlled archived chats from parent (WS merges). */
  archivedChats?: ChatSession[];
  onArchivedChatsChange?: (chats: ChatSession[]) => void;
  onChatUpdated?: (chat: ChatSession) => void;
  onChatDeleted?: (chatId: string) => void;
  isNarrow?: boolean;
};

type ChatGroup = {
  label: string;
  chats: ChatSession[];
};

function groupChatsByRecency(chats: ChatSession[]): ChatGroup[] {
  const sorted = sortChatsByRecency(chats);

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const today: ChatSession[] = [];
  const earlier: ChatSession[] = [];

  for (const chat of sorted) {
    if (chatRecencyMs(chat) >= todayMs) {
      today.push(chat);
    } else {
      earlier.push(chat);
    }
  }

  const groups: ChatGroup[] = [];
  if (today.length > 0) groups.push({ label: "Today", chats: today });
  if (earlier.length > 0) groups.push({ label: "Earlier", chats: earlier });
  return groups;
}

function statusHint(chat: ChatSession): string {
  switch (chat.status) {
    case "running":
      return "Running";
    case "needs_input":
      return "Needs input";
    case "error":
      return "Error";
    case "idle":
      return formatRelativeToNow(chat.lastMessageAt ?? chat.updatedAt) ?? "";
  }
}

export function ChatList({
  activeWorkspaceName,
  activeWorkspaceId,
  activeChatId,
  onSelectChat,
  onNewChat,
  creating,
  refreshNonce = 0,
  onChatsChange,
  chats: controlledChats,
  archivedChats: controlledArchived,
  onArchivedChatsChange,
  onChatUpdated,
  onChatDeleted,
  isNarrow = false,
}: ChatListProps): JSX.Element {
  const [listMode, setListMode] = useState<ChatListMode>("active");
  const [localChats, setLocalChats] = useState<ChatSession[]>([]);
  const [localArchived, setLocalArchived] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archivedError, setArchivedError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const chats = controlledChats ?? localChats;
  const archivedChats = controlledArchived ?? localArchived;
  const displayChats = listMode === "active" ? chats : archivedChats;
  const listLoading = listMode === "active" ? loading : archivedLoading;
  const listError = listMode === "active" ? error : archivedError;

  const loadChats = useCallback(
    async (workspaceId: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.listWorkspaceChats(workspaceId);
        setLocalChats(list);
        onChatsChange?.(list);
      } catch (err) {
        setLocalChats([]);
        onChatsChange?.([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [onChatsChange]
  );

  const loadArchivedChats = useCallback(
    async (workspaceId: string) => {
      setArchivedLoading(true);
      setArchivedError(null);
      try {
        const list = await api.listArchivedWorkspaceChats(workspaceId);
        setLocalArchived(list);
        onArchivedChatsChange?.(list);
      } catch (err) {
        setLocalArchived([]);
        onArchivedChatsChange?.([]);
        setArchivedError(err instanceof Error ? err.message : String(err));
      } finally {
        setArchivedLoading(false);
      }
    },
    [onArchivedChatsChange]
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      setLocalChats([]);
      setLocalArchived([]);
      onChatsChange?.([]);
      onArchivedChatsChange?.([]);
      setError(null);
      setArchivedError(null);
      return;
    }
    void loadChats(activeWorkspaceId);
  }, [
    activeWorkspaceId,
    refreshNonce,
    loadChats,
    onChatsChange,
    onArchivedChatsChange,
  ]);

  // Lazy-fetch archived when Archived is selected; refresh on workspace change.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (listMode !== "archived") return;
    void loadArchivedChats(activeWorkspaceId);
  }, [activeWorkspaceId, listMode, refreshNonce, loadArchivedChats]);

  const groups = useMemo(
    () => groupChatsByRecency(displayChats),
    [displayChats]
  );

  const archiveChat = async (chatId: string): Promise<void> => {
    setActionError(null);
    try {
      const updated = await api.updateChat(chatId, { archived: true });
      onChatUpdated?.(updated);
      if (activeChatId === chatId) onSelectChat(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const unarchiveChat = async (chatId: string): Promise<void> => {
    setActionError(null);
    try {
      const updated = await api.updateChat(chatId, { archived: false });
      onChatUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteChat = async (chatId: string): Promise<void> => {
    setActionError(null);
    try {
      await api.deleteChat(chatId);
      onChatDeleted?.(chatId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const emptyCopy =
    listMode === "archived"
      ? "No archived chats"
      : "No chats yet. Start one with New chat.";

  return (
    <aside
      className={cn(
        "flex flex-col bg-card",
        isNarrow
          ? "min-h-0 min-w-0 flex-1"
          : "w-[280px] shrink-0 border-r border-border"
      )}
    >
      <div className="border-b border-border px-3 py-3">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Workspace
        </p>
        <p
          className="m-0 mt-1 truncate text-sm font-medium text-foreground"
          title={activeWorkspaceName}
        >
          {activeWorkspaceName ?? "None focused"}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
            Chats
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "gap-1.5 px-2 text-xs",
              isNarrow ? "min-h-11 px-3" : "h-8"
            )}
            disabled={!activeWorkspaceId || creating || listMode === "archived"}
            onClick={onNewChat}
          >
            <MessageSquarePlus className="size-3.5" aria-hidden="true" />
            {creating ? "Creating..." : "New chat"}
          </Button>
        </div>
        <div
          className="flex gap-1"
          role="tablist"
          aria-label="Chat list mode"
        >
          {(
            [
              { id: "active", label: "Active" },
              { id: "archived", label: "Archived" },
            ] as const
          ).map((tab) => {
            const selected = listMode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "flex-1 rounded-md border text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isNarrow ? "min-h-11 px-3 py-2" : "px-2 py-1.5",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-muted text-foreground hover:border-ring hover:bg-card"
                )}
                onClick={() => setListMode(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {(listError || actionError) && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {listError ?? actionError}
        </div>
      )}

      <div className="column-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        {!activeWorkspaceId ? (
          <p className="m-0 px-1 py-4 text-center text-xs text-muted-foreground">
            Select a workspace in the sidebar to view chats.
          </p>
        ) : listLoading && displayChats.length === 0 ? (
          <p className="m-0 px-1 py-4 text-center text-xs text-muted-foreground">
            {listMode === "archived" ? "Loading archived chats…" : "Loading chats…"}
          </p>
        ) : groups.length === 0 ? (
          <p className="m-0 px-1 py-4 text-center text-xs text-muted-foreground">
            {emptyCopy}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-3">
              <p className="m-0 mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.4px] text-muted-foreground">
                {group.label}
              </p>
              <div className="flex flex-col gap-1">
                {group.chats.map((chat) => {
                  const active = chat.id === activeChatId;
                  const hint = statusHint(chat);
                  const renaming = renamingId === chat.id;
                  return (
                    <div
                      key={chat.id}
                      className={cn(
                        "group flex w-full items-start gap-1 rounded-md border transition-colors",
                        isNarrow ? "min-h-11 px-2 py-2" : "px-2 py-1.5",
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-transparent bg-transparent text-foreground hover:border-border hover:bg-muted"
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={() => {
                          if (!renaming) onSelectChat(chat.id);
                        }}
                        aria-current={active ? "true" : undefined}
                      >
                        {renaming ? (
                          <ChatTitleEditor
                            chatId={chat.id}
                            title={chat.title}
                            compact
                            autoEdit
                            onUpdated={(updated) => {
                              setRenamingId(null);
                              onChatUpdated?.(updated);
                            }}
                            onError={(msg) => {
                              setRenamingId(null);
                              setActionError(msg);
                            }}
                            onCancel={() => setRenamingId(null)}
                          />
                        ) : (
                          <span className="truncate text-xs font-medium">
                            {displayChatTitle(chat)}
                          </span>
                        )}
                        {hint && !renaming && (
                          <span
                            className={cn(
                              "truncate text-[10px]",
                              chat.status === "running"
                                ? "text-primary"
                                : chat.status === "needs_input"
                                  ? "text-status-needs-input"
                                  : chat.status === "error"
                                    ? "text-destructive"
                                    : "text-muted-foreground"
                            )}
                          >
                            {hint}
                          </span>
                        )}
                      </button>
                      <div
                        className={cn(
                          "flex shrink-0 items-center gap-0.5",
                          isNarrow
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
                        )}
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "text-muted-foreground hover:text-foreground",
                                isNarrow ? "size-9" : "size-7"
                              )}
                              aria-label={`Actions for ${displayChatTitle(chat)}`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="min-w-[9rem]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <DropdownMenuItem
                              onSelect={() => setRenamingId(chat.id)}
                            >
                              Rename
                            </DropdownMenuItem>
                            {listMode === "archived" ? (
                              <DropdownMenuItem
                                onSelect={() => {
                                  void unarchiveChat(chat.id);
                                }}
                              >
                                <ArchiveRestore
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                                Unarchive
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                onSelect={() => {
                                  void archiveChat(chat.id);
                                }}
                              >
                                <Archive
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                                Archive
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <div
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <ConfirmButton
                            label="Del"
                            confirmLabel="Delete chat"
                            className={cn(isNarrow ? "min-h-9" : "h-7")}
                            onConfirm={() => void deleteChat(chat.id)}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
