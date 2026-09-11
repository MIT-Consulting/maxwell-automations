import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Archive, ArchiveRestore, ChevronLeft, Link2, MoreHorizontal, X } from "lucide-react";
import type { Automation, ChatSession, ModelSelection, Run, RunStatus } from "@lca/shared";
import { modelSelectionsEqual } from "@lca/shared";
import { cn } from "@/lib/utils";
import { AgentCompose } from "./AgentCompose";
import { api } from "./api";
import {
  getChatDraft,
  getChatScrollTop,
  setChatDraft,
  setChatScrollTop,
} from "./chatUiCache";
import { ChatTitleEditor } from "./ChatTitleEditor";
import { ConfirmButton } from "./ConfirmButton";
import { selectionLabel } from "./modelControls";
import { ModelSelect } from "./ModelSelect";
import { Transcript } from "./transcript";
import { chatStatusToRunStatus, useChatStream } from "./useChatStream";
import { useAvailableModels } from "./useAvailableModels";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export type ChatConversationProps = {
  chatId: string | null;
  workspaceId: string | null;
  session: ChatSession | null;
  workspaceName?: string;
  onNewChat?: () => void;
  isNarrow?: boolean;
  onSelectChat?: (id: string | null) => void;
  onChatUpdated?: (chat: ChatSession) => void;
  onChatDeleted?: (chatId: string) => void;
};

export function ChatConversation({
  chatId,
  workspaceId,
  session,
  workspaceName,
  onNewChat,
  isNarrow = false,
  onSelectChat,
  onChatUpdated,
  onChatDeleted,
}: ChatConversationProps): JSX.Element {
  const { messages, chatStatus, pendingQuestion, canContinue, error, resync } =
    useChatStream(chatId);

  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [steerError, setSteerError] = useState<string | null>(null);
  const [steering, setSteering] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const [composeResetKey, setComposeResetKey] = useState(0);
  const [workspaceRuns, setWorkspaceRuns] = useState<Run[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [workspaceDefaultSelection, setWorkspaceDefaultSelection] =
    useState<ModelSelection | null>(null);
  const { models: availableModels } = useAvailableModels();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isArchived = Boolean(session?.archivedAt);
  const canStop =
    !isArchived && (chatStatus === "running" || chatStatus === "needs_input");
  const composeCanContinue =
    chatStatus === "idle" || chatStatus === "error" || canContinue;

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceDefaultSelection(null);
      return;
    }
    let cancelled = false;
    api
      .getWorkspaceChatDefaults(workspaceId)
      .then((defaults) => {
        if (!cancelled) {
          setWorkspaceDefaultSelection(defaults.modelSelection ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) setWorkspaceDefaultSelection(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceRuns([]);
      setAutomations([]);
      return;
    }
    let cancelled = false;
    Promise.all([api.listRuns(), api.listAutomations()])
      .then(([runs, autos]) => {
        if (cancelled) return;
        setWorkspaceRuns(
          runs.filter(
            (r) =>
              r.workspaceId === workspaceId &&
              !TERMINAL_RUN_STATUSES.has(r.status)
          )
        );
        setAutomations(autos);
      })
      .catch(() => {
        if (!cancelled) {
          setWorkspaceRuns([]);
          setAutomations([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const automationNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const auto of automations) {
      map.set(auto.id, auto.name);
    }
    return map;
  }, [automations]);

  const attachedRun = useMemo((): Run | null => {
    const id = session?.attachedRunId;
    if (!id) return null;
    return workspaceRuns.find((r) => r.id === id) ?? null;
  }, [session?.attachedRunId, workspaceRuns]);

  const attachableRuns = useMemo(() => {
    const attachedId = session?.attachedRunId;
    return workspaceRuns.filter((r) => r.id !== attachedId);
  }, [session?.attachedRunId, workspaceRuns]);

  const modelDefaultLabel = workspaceDefaultSelection
    ? `Default (${selectionLabel(workspaceDefaultSelection, availableModels)})`
    : undefined;

  const changeModel = async (next: ModelSelection | null): Promise<void> => {
    if (!chatId || isArchived || modelSaving) return;
    if (modelSelectionsEqual(session?.modelSelection ?? null, next)) return;
    setModelSaving(true);
    setActionError(null);
    try {
      const updated = await api.updateChat(chatId, { modelSelection: next });
      onChatUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelSaving(false);
    }
  };

  const stopChat = async (): Promise<void> => {
    if (!chatId || stopping || isArchived) return;
    setStopping(true);
    setActionError(null);
    try {
      await api.cancelChat(chatId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const archiveChat = async (): Promise<void> => {
    if (!chatId || busy || isArchived) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.updateChat(chatId, { archived: true });
      onChatUpdated?.(updated);
      onSelectChat?.(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unarchiveChat = async (): Promise<void> => {
    if (!chatId || busy || !isArchived) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.updateChat(chatId, { archived: false });
      onChatUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const deleteChat = async (): Promise<void> => {
    if (!chatId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.deleteChat(chatId);
      onChatDeleted?.(chatId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const attachRun = async (runId: string): Promise<void> => {
    if (!chatId || attachBusy || isArchived) return;
    setAttachBusy(true);
    setActionError(null);
    try {
      const updated = await api.updateChat(chatId, { attachedRunId: runId });
      onChatUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttachBusy(false);
    }
  };

  const detachRun = async (): Promise<void> => {
    if (!chatId || attachBusy || isArchived || !session?.attachedRunId) return;
    setAttachBusy(true);
    setActionError(null);
    try {
      const updated = await api.updateChat(chatId, { attachedRunId: null });
      onChatUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAttachBusy(false);
    }
  };

  const steerAttachedRun = async (): Promise<void> => {
    if (!chatId || steering || isArchived || !session?.attachedRunId) return;
    const message = getChatDraft(chatId).trim();
    if (!message) {
      setSteerError("Enter guidance to steer the attached run");
      return;
    }
    setSteering(true);
    setSteerError(null);
    try {
      await api.steerChat(chatId, message);
      setChatDraft(chatId, "");
      setComposeResetKey((k) => k + 1);
      resync();
    } catch (err) {
      setSteerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSteering(false);
    }
  };

  if (!chatId) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center bg-card p-8 text-center">
        <p className="m-0 max-w-sm text-sm text-muted-foreground">
          Select a chat from the list or start a new conversation.
        </p>
        {onNewChat && workspaceId && (
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onClick={onNewChat}
          >
            New chat
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-card">
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-border",
          isNarrow ? "px-3 py-2" : "justify-between px-4 py-3"
        )}
      >
        {isNarrow && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Back to chat list"
            onClick={() => onSelectChat?.(null)}
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Button>
        )}
        <div className={cn("flex min-w-0 flex-1 flex-col", isNarrow && "flex-1")}>
          {session ? (
            <ChatTitleEditor
              chatId={chatId}
              title={session.title}
              className={isNarrow ? "text-base tracking-[0.2px]" : undefined}
              onUpdated={(chat) => onChatUpdated?.(chat)}
              onError={setActionError}
            />
          ) : (
            <h2
              className={cn(
                "m-0 truncate font-semibold",
                isNarrow ? "text-base tracking-[0.2px]" : "text-sm"
              )}
            >
              Untitled chat
            </h2>
          )}
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {workspaceName && (
              <span
                className="min-w-0 truncate rounded border border-border bg-muted px-1.5 py-0.5"
                title={workspaceName}
              >
                {workspaceName}
              </span>
            )}
            {isArchived && (
              <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px]">
                Archived · read-only
              </span>
            )}
            {session?.attachedRunId && (
              <span
                className="inline-flex max-w-full shrink-0 items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                title={session.attachedRunId}
              >
                <StatusDot
                  status={attachedRun?.status ?? "running"}
                  title={attachedRun?.status ?? "attached"}
                />
                <span className="truncate">
                  {attachedRun
                    ? automationNameById.get(attachedRun.automationId) ??
                      attachedRun.id.slice(0, 8)
                    : session.attachedRunId.slice(0, 8)}
                </span>
                {!isArchived && (
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    aria-label="Detach run"
                    disabled={attachBusy}
                    onClick={() => void detachRun()}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!isArchived && attachableRuns.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn("gap-1.5", isNarrow && "min-h-11 px-3")}
                  disabled={attachBusy}
                  aria-label="Attach run"
                >
                  <Link2 className="size-3.5" aria-hidden="true" />
                  {!isNarrow && "Attach"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
                {attachableRuns.map((run) => (
                  <DropdownMenuItem
                    key={run.id}
                    disabled={attachBusy}
                    onSelect={() => {
                      void attachRun(run.id);
                    }}
                  >
                    <StatusDot status={run.status} title={run.status} />
                    <span className="ml-2 font-mono">{run.id.slice(0, 8)}</span>
                    <span className="ml-1 truncate text-muted-foreground">
                      {automationNameById.get(run.automationId) ?? run.automationId.slice(0, 8)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canStop && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "text-destructive hover:text-destructive",
                isNarrow && "min-h-11 px-3"
              )}
              disabled={stopping}
              onClick={() => void stopChat()}
            >
              {stopping ? "Stopping..." : "Stop"}
            </Button>
          )}
          {isArchived ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn("gap-1.5", isNarrow && "min-h-11 px-3")}
              disabled={busy}
              onClick={() => void unarchiveChat()}
            >
              <ArchiveRestore className="size-3.5" aria-hidden="true" />
              Unarchive
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "text-muted-foreground hover:text-foreground",
                    isNarrow ? "size-11" : "size-8"
                  )}
                  aria-label="Chat actions"
                  disabled={busy}
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[10rem]">
                <DropdownMenuItem
                  disabled={busy}
                  onSelect={() => {
                    void archiveChat();
                  }}
                >
                  <Archive className="size-3.5" aria-hidden="true" />
                  Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete chat"
            className={cn(isNarrow && "min-h-11")}
            onConfirm={() => void deleteChat()}
          />
        </div>
      </header>

      {(error || actionError) && (
        <div className="shrink-0 px-4 py-3 text-sm text-destructive">
          {error ?? actionError}
        </div>
      )}

      {isArchived && (
        <div className="shrink-0 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          This chat is archived and read-only. Unarchive it to send messages.
        </div>
      )}

      <Transcript
        key={`transcript-${chatId}`}
        messages={messages}
        runStatus={chatStatusToRunStatus(chatStatus)}
        pendingQuestion={pendingQuestion}
        showToolbar={false}
        emptyMessage="Start the conversation"
        scrollContainerRef={scrollRef}
        initialScrollTop={getChatScrollTop(chatId)}
        onScrollPositionChange={(scrollTop) => setChatScrollTop(chatId, scrollTop)}
      />

      {!isArchived && (
        <AgentCompose
          key={`compose-${chatId}-${composeResetKey}`}
          status={chatStatus}
          canContinue={composeCanContinue}
          workspaceId={workspaceId ?? undefined}
          pendingQuestion={pendingQuestion}
          popupDirection="up"
          placeholder="Message this workspace… @ files / skills"
          initialDraft={getChatDraft(chatId)}
          onDraftChange={(text) => setChatDraft(chatId, text)}
          additionalError={steerError}
          onUploadAttachment={(file) => api.uploadChatAttachment(chatId, file)}
          attachmentUrl={(id) => api.chatAttachmentUrl(chatId, id)}
          onSend={async (text, attachments) => {
            await api.sendChatMessage(chatId, text, attachments);
            // REST catch-up in case the live socket is a mobile half-open zombie.
            resync();
          }}
          onQueue={async (text, attachments) => {
            await api.queueChatMessage(chatId, text, attachments);
            resync();
          }}
          onInterrupt={async (text, attachments) => {
            await api.interruptChat(chatId, text, attachments);
            resync();
          }}
          onAnswer={async (text) => {
            await api.answerChat(chatId, text);
            resync();
          }}
          toolbarLeft={
            session ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <ModelSelect
                  id={`chat-model-${chatId}`}
                  value={session.modelSelection ?? null}
                  onChange={(next) => void changeModel(next)}
                  defaultLabel={modelDefaultLabel}
                  disabled={modelSaving}
                  commitOnBlur
                  variant="ghost"
                />
                {session.attachedRunId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={steering}
                    onClick={() => void steerAttachedRun()}
                  >
                    {steering ? "Steering…" : "Steer run"}
                  </Button>
                )}
              </div>
            ) : null
          }
        />
      )}
    </div>
  );
}
