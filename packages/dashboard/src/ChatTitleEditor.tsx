import { useEffect, useRef, useState, type JSX } from "react";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { displayChatTitle } from "./chatLifecycle";
import type { ChatSession } from "@lca/shared";

export type ChatTitleEditorProps = {
  chatId: string;
  title: string | null;
  className?: string;
  /** Compact styling for list rows. */
  compact?: boolean;
  /** Start in edit mode (e.g. after choosing Rename from a menu). */
  autoEdit?: boolean;
  onUpdated: (chat: ChatSession) => void;
  onError?: (message: string) => void;
  /** Called when edit is cancelled without saving. */
  onCancel?: () => void;
};

/**
 * Click title → edit; Enter/blur saves via updateChat; Escape cancels.
 * Empty trim does not save.
 */
export function ChatTitleEditor({
  chatId,
  title,
  className,
  compact = false,
  autoEdit = false,
  onUpdated,
  onError,
  onCancel,
}: ChatTitleEditorProps): JSX.Element {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(title ?? "");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(title ?? "");
    }
  }, [title, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const cancel = (): void => {
    setDraft(title ?? "");
    setEditing(false);
    onCancel?.();
  };

  const save = async (): Promise<void> => {
    const next = draft.trim();
    if (!next || next === (title ?? "").trim()) {
      setEditing(false);
      setDraft(title ?? "");
      onCancel?.();
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateChat(chatId, { title: next });
      onUpdated(updated);
      setEditing(false);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
      setDraft(title ?? "");
      setEditing(false);
      onCancel?.();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        disabled={saving}
        aria-label="Chat title"
        className={cn(
          "m-0 w-full min-w-0 rounded border border-border bg-background px-1.5 font-medium text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          compact ? "h-7 text-xs" : "h-8 text-sm",
          className
        )}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          void save();
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={cn(
        "m-0 min-w-0 truncate rounded text-left font-semibold outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        compact ? "px-1 py-0.5 text-xs font-medium" : "px-1 py-0.5 text-sm",
        className
      )}
      title="Click to rename"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {displayChatTitle({ title })}
    </button>
  );
}
