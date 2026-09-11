import type { AttachmentKind, RunStatus } from "@lca/shared";
import type { RefObject } from "react";

/** A run event in the shape the normalizer consumes (camelCase). */
export type StoredEvent = {
  seq: number;
  eventType: string;
  payload: string;
  /** ISO/SQLite timestamp the event was recorded, when known. */
  createdAt?: string;
};

export type ChatRole =
  | "assistant"
  | "user"
  | "thinking"
  | "tool"
  | "question"
  | "answer"
  | "system"
  /** Top-level SDK task progress (unowned — not correlated to a task tool_call). */
  | "task";

/** Attachment metadata shown in transcript bubbles (bytes fetched lazily via URL). */
export type TranscriptAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** Absolute or same-origin URL to fetch bytes (set by stream hooks when known). */
  url?: string;
};

/** SDK todo item status (camelCase — not the tool-status vocabulary). */
export type TodoItemStatus =
  | "pending"
  | "inProgress"
  | "completed"
  | "cancelled";

/**
 * Typed view model for rich tool rows. Produced by the normalizer; the
 * transcript renderer must never parse raw JSON to obtain these fields.
 */
export type ToolView =
  | {
      kind: "shell";
      command: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      executionTimeMs?: number;
      truncated: boolean;
      error?: string;
    }
  | {
      kind: "diff";
      path: string;
      linesAdded?: number;
      linesRemoved?: number;
      diffString?: string;
      truncated: boolean;
      error?: string;
    }
  | {
      kind: "todos";
      todos: Array<{ content: string; status: TodoItemStatus }>;
      completed: number;
      total: number;
      truncated: boolean;
      error?: string;
    }
  | {
      kind: "task";
      description?: string;
      prompt?: string;
      subagentKind?: string;
      subagentName?: string;
      model?: string;
      mode?: string;
      durationMs?: number;
      agentId?: string;
      resultText?: string;
      truncated: boolean;
      error?: string;
    };

/** A single rendered transcript entry derived from one stored run event. */
export type ChatMessage = {
  seq: number;
  role: ChatRole;
  /** Short heading, e.g. a tool name or "run finished". */
  title?: string;
  /** Main content — markdown for assistant/thinking/answer, plain text otherwise. */
  body?: string;
  /** Tool or run status string, when applicable. */
  status?: string;
  /** System-divider styling hint. */
  tone?: "info" | "error";
  /** Timestamp of the (first) source event, for display in the transcript. */
  ts?: string;
  /** Operator attachments referenced by the message payload. */
  attachments?: TranscriptAttachment[];
  /** Typed rich tool content when the normalizer recognized the tool family. */
  tool?: ToolView;
  /** Elapsed thinking time from the SDK (`thinking_duration_ms`), when known. */
  thinkingDurationMs?: number;
  /** Original payload JSON, for the per-message raw expander / Raw mode. */
  raw: string;
};

export type TranscriptProps = {
  messages: ChatMessage[];
  runStatus: RunStatus;
  pendingQuestion?: string | null;
  /** Status row + Raw toggle. Off for inline Kanban card logs. Default true. */
  showToolbar?: boolean;
  /**
   * Skill/rule jump bar over user/question prompt references.
   * Defaults to `showToolbar` (on in the run dialog, off for chat/inline).
   */
  showPromptJump?: boolean;
  /**
   * When set (mobile), always show the jump header — with this label if there
   * are no @ / / tokens — and a trailing expand control that calls this.
   */
  onExpandPromptJump?: () => void;
  /** Status line when the jump header has no skill/rule tokens. */
  promptJumpEmptyLabel?: string;
  /** Override the default empty-state copy. */
  emptyMessage?: string;
  /** External ref to the scroll container (for per-chat scroll restore). */
  scrollContainerRef?: RefObject<HTMLDivElement | null>;
  /** Restore scroll position when switching back to a chat. */
  initialScrollTop?: number;
  onScrollPositionChange?: (scrollTop: number) => void;
};
