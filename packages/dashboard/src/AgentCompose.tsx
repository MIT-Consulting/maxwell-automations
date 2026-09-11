import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import type { Attachment, AttachmentRef, ChatStatus, Run } from "@lca/shared";
import {
  filesFromClipboardEvent,
  filesFromDragEvent,
  formatFileSize,
  isImageMime,
  newLocalId,
  resolveAttachmentMimeType,
  toAttachmentRef,
} from "./chatAttachments";
import { AuthenticatedImage } from "./AuthenticatedMedia";
import { PromptArtifactSuggestions } from "./PromptArtifactSuggestions";
import { PromptReferenceTextarea } from "./PromptReferenceTextarea";
import { usePromptTypeahead } from "./usePromptTypeahead";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AgentComposeStatus = Run["status"] | ChatStatus;

export type AgentComposeProps = {
  status: AgentComposeStatus;
  canContinue: boolean;
  workspaceId?: string;
  pendingQuestion: string | null;
  onUploadAttachment?: (file: File) => Promise<Attachment>;
  attachmentUrl?: (attachmentId: string) => string;
  onSend: (text: string, attachments?: AttachmentRef[]) => Promise<void>;
  onQueue: (text: string, attachments?: AttachmentRef[]) => Promise<void>;
  onInterrupt: (text: string, attachments?: AttachmentRef[]) => Promise<void>;
  onAnswer: (text: string) => Promise<void>;
  onTypeaheadOpenChange?: (open: boolean) => void;
  placeholder?: string;
  popupDirection?: "up" | "down";
  /** Seed draft when remounting per chat (see chatUiCache). */
  initialDraft?: string;
  onDraftChange?: (text: string) => void;
  /** Left side of the compose toolbar (e.g. model picker). */
  toolbarLeft?: ReactNode;
  /** Extra error shown below the compose area (e.g. steer failures). */
  additionalError?: string | null;
};

type StagedAttachment = {
  localId: string;
  file: File;
  previewUrl: string | null;
  attachment: Attachment | null;
  error: string | null;
  uploading: boolean;
};

function isRunTerminalStatus(status: AgentComposeStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

export function AgentCompose({
  status,
  canContinue,
  workspaceId,
  pendingQuestion,
  onUploadAttachment,
  attachmentUrl,
  onSend,
  onQueue,
  onInterrupt,
  onAnswer,
  onTypeaheadOpenChange,
  placeholder: placeholderProp,
  popupDirection = "up",
  initialDraft = "",
  onDraftChange,
  toolbarLeft,
  additionalError,
}: AgentComposeProps) {
  const [message, setMessage] = useState(initialDraft);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>(
    []
  );
  const [draggingAttachments, setDraggingAttachments] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stagedAttachmentsRef = useRef<StagedAttachment[]>([]);

  const needsInput = status === "needs_input";
  const running = status === "running";
  const paused = status === "paused";
  const continuable = canContinue && !needsInput && !running;
  const enabled = needsInput || running || continuable;
  const busy = sending || interrupting;
  const attachmentsEnabled = !needsInput && Boolean(onUploadAttachment);
  const uploadsPending = stagedAttachments.some((attachment) => attachment.uploading);
  const attachmentErrors = stagedAttachments.some(
    (attachment) => attachment.error !== null
  );
  const attachmentRefs = stagedAttachments.flatMap((attachment) =>
    attachment.attachment ? [toAttachmentRef(attachment.attachment)] : []
  );
  const typeaheadEnabled =
    !needsInput &&
    Boolean(workspaceId) &&
    enabled &&
    !busy &&
    (running || continuable);
  const trimmed = message.trim();
  const hasContent = needsInput
    ? trimmed.length > 0
    : trimmed.length > 0 || attachmentRefs.length > 0;
  const primaryDisabled =
    !enabled ||
    busy ||
    !hasContent ||
    (!needsInput && (uploadsPending || attachmentErrors));
  const interruptDisabled =
    !running || busy || !hasContent || uploadsPending || attachmentErrors;
  const isRunTerminal = isRunTerminalStatus(status);
  const placeholder =
    placeholderProp ??
    (needsInput
      ? "Type your answer..."
      : running
        ? "Queue a message..."
        : paused
          ? "Steer while paused — sends directly to the agent..."
          : continuable
            ? "Continue the conversation..."
            : isRunTerminal
              ? "This run can't be continued"
              : "Agent is working...");
  const submitLabel = needsInput
    ? "Answer"
    : running
      ? "Queue message"
      : paused
        ? "Send"
        : "Send";

  const typeahead = usePromptTypeahead({
    workspaceId,
    value: message,
    setValue: setMessage,
    textareaRef,
    enabled: typeaheadEnabled,
  });

  useEffect(() => {
    onTypeaheadOpenChange?.(typeahead.showTypeahead);
  }, [onTypeaheadOpenChange, typeahead.showTypeahead]);

  useEffect(() => {
    if (status !== "running") {
      setQueuedCount(0);
    }
  }, [status]);

  useEffect(() => {
    stagedAttachmentsRef.current = stagedAttachments;
  }, [stagedAttachments]);

  useEffect(() => {
    return () => {
      for (const attachment of stagedAttachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const removeAttachment = (localId: string) => {
    setStagedAttachments((current) => {
      const attachment = current.find((entry) => entry.localId === localId);
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      return current.filter((entry) => entry.localId !== localId);
    });
  };

  const clearAttachments = () => {
    setStagedAttachments((current) => {
      for (const attachment of current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
  };

  const uploadAttachment = async (staged: StagedAttachment) => {
    if (!onUploadAttachment) return;
    try {
      const attachment = await onUploadAttachment(staged.file);
      setStagedAttachments((current) =>
        current.map((entry) =>
          entry.localId === staged.localId
            ? { ...entry, attachment, uploading: false }
            : entry
        )
      );
    } catch (err) {
      setStagedAttachments((current) =>
        current.map((entry) =>
          entry.localId === staged.localId
            ? {
                ...entry,
                error: err instanceof Error ? err.message : String(err),
                uploading: false,
              }
            : entry
        )
      );
    }
  };

  const stageFiles = (files: File[]) => {
    if (!attachmentsEnabled || files.length === 0) return;
    try {
      const additions = files.map<StagedAttachment>((file) => {
        const mimeType = resolveAttachmentMimeType(file);
        return {
          localId: newLocalId(),
          file,
          previewUrl: isImageMime(mimeType) ? URL.createObjectURL(file) : null,
          attachment: null,
          error: null,
          uploading: true,
        };
      });
      setStagedAttachments((current) => [...current, ...additions]);
      setComposeError(null);
      for (const attachment of additions) {
        void uploadAttachment(attachment);
      }
    } catch (err) {
      setComposeError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async () => {
    if (primaryDisabled) return;
    setSending(true);
    setComposeError(null);
    try {
      if (needsInput) {
        await onAnswer(trimmed);
      } else if (running) {
        await onQueue(trimmed, attachmentRefs);
        setQueuedCount((prev) => prev + 1);
      } else {
        await onSend(trimmed, attachmentRefs);
      }
      setMessage("");
      onDraftChange?.("");
      clearAttachments();
    } catch (err) {
      setComposeError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (interruptDisabled) return;
    setInterrupting(true);
    setComposeError(null);
    try {
      await onInterrupt(trimmed, attachmentRefs);
      setMessage("");
      onDraftChange?.("");
      clearAttachments();
    } catch (err) {
      setComposeError(err instanceof Error ? err.message : String(err));
    } finally {
      setInterrupting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (typeahead.handleKeyDown(event)) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="border-t border-border bg-card px-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (!attachmentsEnabled || !Array.from(event.dataTransfer.types).includes("Files")) {
          return;
        }
        event.preventDefault();
        setDraggingAttachments(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDraggingAttachments(false);
        }
      }}
      onDrop={(event) => {
        if (!attachmentsEnabled) return;
        const files = filesFromDragEvent(event.nativeEvent);
        if (files.length === 0) return;
        event.preventDefault();
        setDraggingAttachments(false);
        stageFiles(files);
      }}
    >
      {needsInput && pendingQuestion && (
        <div className="mb-2 text-xs text-status-needs-input">
          {pendingQuestion}
        </div>
      )}
      <div
        className={cn(
          "rounded-xl border border-border bg-background transition-[box-shadow,background-color]",
          draggingAttachments && "bg-muted/40 ring-2 ring-inset ring-primary"
        )}
      >
        {!needsInput && stagedAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pt-2">
            {stagedAttachments.map((attachment) => {
              // Prefer the local object URL while staging — after upload the API
              // path needs the control token on remote, which plain <img> can't send.
              const imageUrl =
                attachment.previewUrl ??
                (attachment.attachment && attachmentUrl
                  ? attachmentUrl(attachment.attachment.id)
                  : null);
              return (
                <div
                  key={attachment.localId}
                  className="flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/60 p-1.5 text-xs"
                >
                  {imageUrl ? (
                    imageUrl.startsWith("blob:") || imageUrl.startsWith("data:") ? (
                      <img
                        src={imageUrl}
                        alt=""
                        className="size-10 rounded object-cover"
                      />
                    ) : (
                      <AuthenticatedImage
                        src={imageUrl}
                        alt=""
                        className="size-10 rounded object-cover"
                        loading="eager"
                      />
                    )
                  ) : (
                    <div className="flex size-10 items-center justify-center rounded bg-background text-muted-foreground">
                      {attachment.file.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium" title={attachment.file.name}>
                      {attachment.file.name}
                    </div>
                    <div className="text-muted-foreground">
                      {attachment.error
                        ? attachment.error
                        : attachment.uploading
                          ? "Uploading…"
                          : formatFileSize(attachment.file.size)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={`Remove ${attachment.file.name}`}
                    onClick={() => removeAttachment(attachment.localId)}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <div className="relative">
          <PromptReferenceTextarea
            ref={textareaRef}
            className={cn(
              "max-h-[160px] min-h-[3.5rem] w-full resize-none border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:ring-0",
              !enabled && "text-muted-foreground"
            )}
            value={message}
            placeholder={placeholder}
            disabled={!enabled || busy}
            rows={2}
            onChange={(event) => {
              const next = event.target.value;
              setMessage(next);
              onDraftChange?.(next);
              setComposeError(null);
              typeahead.updatePromptToken(next);
            }}
            onKeyDown={onKeyDown}
            onSelect={() => typeahead.updatePromptToken()}
            onClick={() => typeahead.updatePromptToken()}
            onFocus={() => typeahead.updatePromptToken()}
            onBlur={typeahead.clearToken}
            onPaste={(event) => {
              if (!attachmentsEnabled) return;
              const files = filesFromClipboardEvent(event.nativeEvent);
              if (files.length === 0) return;
              event.preventDefault();
              stageFiles(files);
            }}
            aria-autocomplete={typeaheadEnabled ? "list" : undefined}
            aria-expanded={typeahead.showTypeahead}
            aria-controls={
              typeahead.showTypeahead ? "agent-compose-suggestions" : undefined
            }
          />
          {typeahead.showTypeahead && typeahead.promptToken && (
            <PromptArtifactSuggestions
              id="agent-compose-suggestions"
              open={typeahead.showTypeahead}
              artifacts={typeahead.suggestions}
              loading={typeahead.artifacts.loading}
              error={typeahead.artifacts.error}
              highlightedIndex={typeahead.highlightedIndex}
              onHighlight={typeahead.setHighlightedIndex}
              onSelect={typeahead.insertArtifact}
              kind={typeahead.promptToken.kind}
              className={
                popupDirection === "up"
                  ? "bottom-[calc(100%+6px)] top-auto"
                  : undefined
              }
            />
          )}
        </div>
        <div className="flex items-center justify-between gap-1.5 px-1.5 pb-1.5">
          <div className="min-w-0">{toolbarLeft}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            {attachmentsEnabled && (
              <>
                {/* Opacity hide (not display:none / clip) so Android Chrome delivers
                    the FileList after DocumentsUI returns — common on Pixel + remote HTTP. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="pointer-events-none absolute h-px w-px opacity-0"
                  multiple
                  accept="image/*,text/plain,text/markdown,text/csv,application/json,.yaml,.yml,.log,.md"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    stageFiles(files);
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Attach files"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="size-3.5" />
                </Button>
              </>
            )}
            {running && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={interruptDisabled}
                onClick={() => void interrupt()}
              >
                {interrupting ? "Sending..." : "Send now"}
              </Button>
            )}
            {queuedCount > 0 && (
              <span className="px-1 text-[10px] text-muted-foreground">
                {queuedCount} queued
              </span>
            )}
            <Button
              type="submit"
              size="icon-xs"
              className="rounded-full bg-white text-neutral-900 hover:bg-white/90 disabled:bg-white/40 disabled:text-neutral-900/50"
              disabled={primaryDisabled}
              aria-label={sending ? "Sending..." : submitLabel}
              title={submitLabel}
            >
              {sending ? (
                <span className="text-[9px] font-medium">…</span>
              ) : (
                <ArrowUp className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
      </div>
      {(composeError || additionalError) && (
        <div className="mt-1.5 text-xs text-destructive">
          {composeError ?? additionalError}
        </div>
      )}
    </form>
  );
}
