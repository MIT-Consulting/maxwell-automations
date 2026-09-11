import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { parsePromptReferences, type PromptReference } from "@lca/shared";
import type {
  ChatMessage,
  TodoItemStatus,
  ToolView,
  TranscriptProps,
} from "./transcript-types";
import {
  parseUnifiedDiff,
  shortenPath,
  type ParsedDiffHunk,
  type ParsedDiffLine,
} from "./diff";
import { formatClock } from "./helpers";
import { cn } from "@/lib/utils";
import { PromptReferenceText } from "./PromptReferenceText";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PromptReferenceJumpBar,
  usePromptReferenceJump,
} from "./PromptReferenceViewer";
import { OverlayScrollArea } from "./OverlayScrollArea";
import { MarkdownPreview, MD_CHAT_CLASS } from "./MarkdownPreview";
import {
  AuthenticatedImage,
  AuthenticatedOpenLink,
} from "./AuthenticatedMedia";

const Markdown = MarkdownPreview;
const MD_CLASS = MD_CHAT_CLASS;

const RAW_BLOCK_CLASS =
  "mt-1.5 max-h-60 no-scrollbar overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-2 font-mono text-[11px]";
const QUIET_BUTTON_CLASS =
  "cursor-pointer border-none bg-transparent p-0 text-[11px] text-muted-foreground hover:text-foreground";

/** Bounded shell output: short preview, larger expand, then an honest remainder. */
const SHELL_PREVIEW_LINES = 8;
const SHELL_MAX_LINES = 60;
/** Hide sub-second timings; success should stay quiet. */
const SHELL_DURATION_MIN_MS = 1000;
/** Expanded diff body cap — no unbounded "show all" path. */
const DIFF_MAX_LINES = 200;
/** Horizontal padding baked into the gutter width so digits never wrap. */
const GUTTER_PADDING = "0.75rem";
const GUTTER_CLASS =
  "shrink-0 select-none whitespace-pre border-r border-border/60 px-1.5 text-right tabular-nums text-muted-foreground/70";

type ShellTool = Extract<ToolView, { kind: "shell" }>;
type TodosTool = Extract<ToolView, { kind: "todos" }>;
type TaskTool = Extract<ToolView, { kind: "task" }>;
type DiffTool = Extract<ToolView, { kind: "diff" }>;

/** Whitespace-only output counts as no output, so no empty panel is rendered. */
function nonEmpty(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.trim().length > 0 ? text : undefined;
}

/** Compact humanized duration for shell executionTimeMs; null when not worth showing. */
function formatShellDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < SHELL_DURATION_MIN_MS) {
    return null;
  }
  if (ms < 60_000) {
    const secs = ms / 1000;
    return secs < 10 ? `${secs.toFixed(1)}s` : `${Math.round(secs)}s`;
  }
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function splitOutputLines(text: string): string[] {
  // Preserve a trailing newline as an empty final line so pre formatting matches.
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

function boundOutputLines(
  text: string,
  limit: number
): { text: string; hidden: number } {
  const lines = splitOutputLines(text);
  if (lines.length <= limit) {
    return { text: lines.join("\n"), hidden: 0 };
  }
  return {
    text: lines.slice(0, limit).join("\n"),
    hidden: lines.length - limit,
  };
}

function shellFailed(tool: ShellTool): boolean {
  return tool.exitCode !== undefined && tool.exitCode !== 0;
}

/** True once a shell result (or truncation/error) is present — not a streaming stub. */
function shellHasRenderableResult(tool: ShellTool): boolean {
  return (
    nonEmpty(tool.stdout) !== undefined ||
    nonEmpty(tool.stderr) !== undefined ||
    tool.exitCode !== undefined ||
    tool.truncated ||
    tool.error !== undefined
  );
}

function shellFailureCount(tools: ChatMessage[]): number {
  let n = 0;
  for (const m of tools) {
    if (m.tool?.kind === "shell" && shellFailed(m.tool)) n++;
  }
  return n;
}

function RawToggle({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button className={QUIET_BUTTON_CLASS} onClick={() => setOpen((v) => !v)}>
        {open ? "hide raw" : "raw"}
      </button>
      {open && <pre className={RAW_BLOCK_CLASS}>{raw}</pre>}
    </div>
  );
}

/** Humanize completed thinking duration; never returns "0s" / "NaN". */
function formatThinkingDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function thinkingHeaderLabel(
  active: boolean,
  durationMs: number | undefined
): string {
  // Live thoughts stay "thinking" — duration would churn under the reader.
  if (active) return "thinking";
  if (
    durationMs !== undefined &&
    Number.isFinite(durationMs) &&
    durationMs > 0
  ) {
    return `Thought for ${formatThinkingDuration(durationMs)}`;
  }
  return "thinking";
}

function ThinkingBlock({
  message,
  active = false,
}: {
  message: ChatMessage;
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [fullHeight, setFullHeight] = useState(false);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    if (active) {
      setOpen(true);
      wasActiveRef.current = true;
    } else if (wasActiveRef.current) {
      setOpen(false);
      setFullHeight(false);
      wasActiveRef.current = false;
    }
  }, [active]);

  useLayoutEffect(() => {
    const el = bodyScrollRef.current;
    if (el && active && open && !fullHeight) {
      el.scrollTop = el.scrollHeight;
    }
  }, [message.body, active, open, fullHeight]);

  const bodyText = message.body;
  const showBody = open && bodyText;
  const capped = active && !fullHeight;
  const header = thinkingHeaderLabel(active, message.thinkingDurationMs);

  return (
    <div className="w-full rounded-lg border border-dashed border-border px-3 py-1.5 text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={cn(QUIET_BUTTON_CLASS, "text-[11px]")}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="mr-1">{open ? "▾" : "▸"}</span> {header}
        </button>
        {active && open && bodyText && (
          <button
            type="button"
            className={QUIET_BUTTON_CLASS}
            onClick={() => setFullHeight((v) => !v)}
          >
            {fullHeight ? "shrink" : "expand"}
          </button>
        )}
      </div>
      {showBody &&
        (capped ? (
          <div
            ref={bodyScrollRef}
            className="mt-1.5 max-h-40 no-scrollbar overflow-y-auto text-xs"
          >
            <Markdown>{bodyText}</Markdown>
          </div>
        ) : (
          <div className="mt-1.5 text-xs">
            <Markdown>{bodyText}</Markdown>
          </div>
        ))}
    </div>
  );
}

type TranscriptSegment =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tools"; tools: ChatMessage[] };

function toolStatusClass(status?: string): string {
  const s = status?.toLowerCase() ?? "";
  if (s === "running" || s === "in_progress" || s === "in-progress" || s === "pending") {
    return "bg-status-running animate-pulse";
  }
  if (s === "completed" || s === "success" || s === "done") {
    return "bg-status-completed";
  }
  if (s === "error" || s === "failed" || s === "failure") {
    return "bg-status-failed";
  }
  return "bg-status-offline";
}

function groupTranscriptSegments(messages: ChatMessage[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let toolBatch: ChatMessage[] = [];

  const flushTools = () => {
    if (toolBatch.length > 0) {
      segments.push({ kind: "tools", tools: toolBatch });
      toolBatch = [];
    }
  };

  for (const message of messages) {
    if (message.role === "tool") {
      // Task launches stay standalone so they never hide behind a multi-tool summary.
      if (message.tool?.kind === "task") {
        flushTools();
        segments.push({ kind: "tools", tools: [message] });
      } else {
        toolBatch.push(message);
      }
    } else {
      flushTools();
      segments.push({ kind: "message", message });
    }
  }
  flushTools();
  return segments;
}

function ShellOutputBlock({
  label,
  text,
  tone = "stdout",
}: {
  label?: string;
  text: string;
  tone?: "stdout" | "stderr";
}) {
  return (
    <div className="min-w-0">
      {label && (
        <div
          className={cn(
            "mb-0.5 text-[10px] font-semibold uppercase tracking-wide",
            tone === "stderr" ? "text-destructive" : "text-muted-foreground/80"
          )}
        >
          {label}
        </div>
      )}
      <pre
        className={cn(
          "no-scrollbar max-h-72 min-w-0 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-2 font-mono text-[11px] leading-relaxed",
          tone === "stderr"
            ? "border-destructive/30 bg-destructive/5 text-destructive/90"
            : "border-border bg-muted/40 text-muted-foreground"
        )}
      >
        {text}
      </pre>
    </div>
  );
}

function ShellToolRow({
  message,
  tool,
}: {
  message: ChatMessage;
  tool: ShellTool;
}) {
  const stdout = nonEmpty(tool.stdout);
  const stderr = nonEmpty(tool.stderr);
  const failed = shellFailed(tool);
  const hasStream = stdout !== undefined || stderr !== undefined;
  const duration = formatShellDuration(tool.executionTimeMs);
  // Failures and stderr-only rows open by default so the signal is not click-gated.
  const defaultOpen =
    failed || (stderr !== undefined && stdout === undefined) || tool.truncated;
  const [outputOpen, setOutputOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);

  const lineLimit = expanded ? SHELL_MAX_LINES : SHELL_PREVIEW_LINES;
  const stdoutBound = stdout ? boundOutputLines(stdout, lineLimit) : null;
  const stderrBound = stderr ? boundOutputLines(stderr, lineLimit) : null;
  const hiddenLines =
    (stdoutBound?.hidden ?? 0) + (stderrBound?.hidden ?? 0);
  // Lines still hidden after a full expand — the expand control must not promise them.
  const hiddenAtMax = expanded
    ? hiddenLines
    : (stdout ? boundOutputLines(stdout, SHELL_MAX_LINES).hidden : 0) +
      (stderr ? boundOutputLines(stderr, SHELL_MAX_LINES).hidden : 0);
  const revealable = hiddenLines - hiddenAtMax;
  const canExpandFurther = !expanded && revealable > 0;
  const showContinuing = expanded && hiddenLines > 0;

  return (
    <div className="min-w-0">
      <div className="flex w-full min-w-0 items-center gap-2 py-0.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            toolStatusClass(message.status)
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-mono font-semibold">
          {message.title ?? "tool"}
        </span>
        {failed && (
          <span
            className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1 py-px text-[10px] font-medium text-destructive"
            title={`exit code ${tool.exitCode}`}
          >
            exit {tool.exitCode}
          </span>
        )}
        {duration && (
          <span className="shrink-0 text-[10px] text-muted-foreground/80">
            {duration}
          </span>
        )}
        {hasStream && (
          <button
            type="button"
            className={cn(QUIET_BUTTON_CLASS, "shrink-0")}
            onClick={() => setOutputOpen((v) => !v)}
          >
            {outputOpen ? "hide output" : "output"}
          </button>
        )}
      </div>
      {outputOpen && hasStream && (
        <div className="ml-4 mt-1 flex min-w-0 flex-col gap-1.5">
          {stdoutBound && (
            <ShellOutputBlock text={stdoutBound.text} tone="stdout" />
          )}
          {stderrBound && (
            <ShellOutputBlock
              label="stderr"
              text={stderrBound.text}
              tone="stderr"
            />
          )}
          {(canExpandFurther || expanded) && (
            <div className="flex flex-wrap items-center gap-2">
              {canExpandFurther && (
                <button
                  type="button"
                  className={QUIET_BUTTON_CLASS}
                  onClick={() => setExpanded(true)}
                >
                  show more ({revealable} lines)
                </button>
              )}
              {expanded && (
                <button
                  type="button"
                  className={QUIET_BUTTON_CLASS}
                  onClick={() => setExpanded(false)}
                >
                  show less
                </button>
              )}
              {showContinuing && (
                <span className="text-[10px] text-muted-foreground">
                  output continues ({hiddenLines} more lines)
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {tool.truncated && (
        <div className="ml-4 mt-1 text-[10px] text-muted-foreground">
          Output truncated — not shown in full.
        </div>
      )}
      {tool.error && (
        <div className="ml-4 mt-1 text-[10px] text-destructive">{tool.error}</div>
      )}
      <div className="ml-4">
        <RawToggle raw={message.raw} />
      </div>
    </div>
  );
}

/** Per-item affordance for SDK todo statuses (not tool-call status vocabulary). */
function todoStatusAffordance(status: TodoItemStatus): {
  mark: string;
  className: string;
  label: string;
} {
  switch (status) {
    case "completed":
      return {
        mark: "✓",
        className: "text-status-completed",
        label: "completed",
      };
    case "inProgress":
      return {
        mark: "●",
        className: "text-status-running animate-pulse",
        label: "in progress",
      };
    case "cancelled":
      return {
        mark: "✕",
        className: "text-muted-foreground/70",
        label: "cancelled",
      };
    case "pending":
      return {
        mark: "○",
        className: "text-status-offline",
        label: "pending",
      };
  }
}

function todoProgressLabel(tool: TodosTool, title: string | undefined): string {
  // Empty / malformed extraction still keeps the args-derived title contract.
  if (tool.total <= 0 && tool.todos.length === 0) {
    return title ?? "Update todo list";
  }
  return `${tool.completed} of ${tool.total} to-dos completed`;
}

function TodoToolRow({
  message,
  tool,
}: {
  message: ChatMessage;
  tool: TodosTool;
}) {
  const [listOpen, setListOpen] = useState(false);
  const allDone = tool.total > 0 && tool.completed >= tool.total;
  const hasItems = tool.todos.length > 0;
  const progress = todoProgressLabel(tool, message.title);

  return (
    <div className="min-w-0">
      <div className="flex w-full min-w-0 items-center gap-2 py-0.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            allDone
              ? "bg-status-completed"
              : toolStatusClass(message.status)
          )}
          aria-hidden
        />
        {allDone && (
          <span
            className="shrink-0 text-[11px] font-medium text-status-completed"
            aria-hidden
          >
            ✓
          </span>
        )}
        <span
          className={cn(
            "min-w-0 flex-1 break-words font-semibold",
            allDone && "text-status-completed"
          )}
        >
          {progress}
        </span>
        {hasItems && (
          <button
            type="button"
            className={cn(QUIET_BUTTON_CLASS, "shrink-0")}
            onClick={() => setListOpen((v) => !v)}
          >
            {listOpen ? "hide list" : "list"}
          </button>
        )}
      </div>
      {listOpen && hasItems && (
        <ul className="ml-4 mt-1 flex min-w-0 list-none flex-col gap-1 p-0">
          {tool.todos.map((item, i) => {
            const affordance = todoStatusAffordance(item.status);
            return (
              <li
                key={`${i}-${item.status}-${item.content.slice(0, 24)}`}
                className="flex min-w-0 items-start gap-2 text-[11px]"
              >
                <span
                  className={cn(
                    "mt-0.5 w-3 shrink-0 text-center font-medium",
                    affordance.className
                  )}
                  title={affordance.label}
                  aria-label={affordance.label}
                >
                  {affordance.mark}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 break-words whitespace-pre-wrap",
                    item.status === "cancelled" &&
                      "text-muted-foreground line-through",
                    item.status === "completed" && "text-foreground/90",
                    item.status === "pending" && "text-muted-foreground",
                    item.status === "inProgress" && "text-foreground"
                  )}
                >
                  {item.content}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {tool.truncated && (
        <div className="ml-4 mt-1 text-[10px] text-muted-foreground">
          Todo list truncated — not shown in full.
        </div>
      )}
      {tool.error && (
        <div className="ml-4 mt-1 text-[10px] text-destructive">{tool.error}</div>
      )}
      <div className="ml-4">
        <RawToggle raw={message.raw} />
      </div>
    </div>
  );
}

function PlainToolRow({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={cn("size-2 shrink-0 rounded-full", toolStatusClass(message.status))}
          aria-hidden
        />
        <span className="font-mono font-semibold">{message.title ?? "tool"}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && <pre className={cn(RAW_BLOCK_CLASS, "ml-4")}>{message.raw}</pre>}
    </div>
  );
}

/** True when a diff ToolView has rich content beyond a bare args-derived title. */
function diffHasRichContent(tool: DiffTool): boolean {
  return (
    nonEmpty(tool.diffString) !== undefined ||
    tool.linesAdded !== undefined ||
    tool.linesRemoved !== undefined ||
    tool.truncated ||
    tool.error !== undefined
  );
}

function diffCountBadge(
  linesAdded: number | undefined,
  linesRemoved: number | undefined
): string | null {
  const hasAdd = linesAdded !== undefined;
  const hasRem = linesRemoved !== undefined;
  if (!hasAdd && !hasRem) return null;
  if (hasAdd && hasRem) return `+${linesAdded} -${linesRemoved}`;
  if (hasAdd) return `+${linesAdded}`;
  return `-${linesRemoved}`;
}

function diffLineClass(kind: ParsedDiffLine["kind"]): string {
  switch (kind) {
    case "added":
      return "bg-status-completed/10 text-status-completed";
    case "removed":
      return "bg-destructive/10 text-destructive";
    case "context":
      return "text-muted-foreground";
  }
}

function formatGutter(n: number | undefined): string {
  return n === undefined ? "" : String(n);
}

function DiffPlainBody({
  text,
  note,
}: {
  text: string;
  note: string;
}) {
  const bound = boundOutputLines(text, DIFF_MAX_LINES);
  return (
    <div className="ml-4 mt-1 flex min-w-0 flex-col gap-1">
      <pre className="no-scrollbar max-h-72 min-w-0 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {bound.text}
      </pre>
      {bound.hidden > 0 && (
        <span className="text-[10px] text-muted-foreground">
          diff continues ({bound.hidden} more lines)
        </span>
      )}
      <span className="text-[10px] text-muted-foreground">{note}</span>
    </div>
  );
}

function DiffParsedBody({ hunks }: { hunks: ParsedDiffHunk[] }) {
  const flat: ParsedDiffLine[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) flat.push(line);
  }
  const visible = flat.slice(0, DIFF_MAX_LINES);
  const hidden = flat.length - visible.length;
  const gutterWidth = Math.max(
    2,
    ...visible.flatMap((l) => [
      formatGutter(l.oldLine).length,
      formatGutter(l.newLine).length,
    ])
  );

  return (
    <div className="ml-4 mt-1 flex min-w-0 flex-col gap-1">
      <div className="no-scrollbar max-h-72 min-w-0 overflow-x-auto overflow-y-auto rounded-md border border-border bg-muted/30 font-mono text-[11px] leading-relaxed">
        {visible.map((line, idx) => (
          <div
            key={idx}
            className={cn(
              "flex min-w-0 whitespace-pre-wrap break-words",
              diffLineClass(line.kind)
            )}
          >
            <span
              className={GUTTER_CLASS}
              style={{ width: `calc(${gutterWidth}ch + ${GUTTER_PADDING})` }}
            >
              {formatGutter(line.oldLine)}
            </span>
            <span
              className={GUTTER_CLASS}
              style={{ width: `calc(${gutterWidth}ch + ${GUTTER_PADDING})` }}
            >
              {formatGutter(line.newLine)}
            </span>
            <span className="w-4 shrink-0 select-none whitespace-pre text-center opacity-70">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
            </span>
            <span className="min-w-0 flex-1 pr-2">{line.text}</span>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <span className="text-[10px] text-muted-foreground">
          diff continues ({hidden} more lines)
        </span>
      )}
    </div>
  );
}

function DiffToolRow({
  message,
  tool,
}: {
  message: ChatMessage;
  tool: DiffTool;
}) {
  const [open, setOpen] = useState(false);
  const pathLabel =
    tool.path.trim().length > 0
      ? shortenPath(tool.path)
      : (message.title ?? "file");
  const counts = diffCountBadge(tool.linesAdded, tool.linesRemoved);
  const diffText = nonEmpty(tool.diffString);
  const canExpand = diffText !== undefined;
  const parsed =
    !tool.truncated && diffText !== undefined
      ? parseUnifiedDiff(diffText)
      : null;

  return (
    <div className="min-w-0">
      <div className="flex w-full min-w-0 items-center gap-2 py-0.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            toolStatusClass(message.status)
          )}
          aria-hidden
        />
        <span
          className="min-w-0 flex-1 truncate font-mono font-semibold"
          title={tool.path.trim().length > 0 ? tool.path : undefined}
        >
          {pathLabel}
        </span>
        {counts && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/90">
            {counts}
          </span>
        )}
        {canExpand && (
          <button
            type="button"
            className={cn(QUIET_BUTTON_CLASS, "shrink-0")}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide diff" : "diff"}
          </button>
        )}
      </div>
      {open && canExpand && diffText && tool.truncated && (
        <DiffPlainBody
          text={diffText}
          note="Diff truncated — not shown in full."
        />
      )}
      {open && canExpand && diffText && !tool.truncated && parsed?.ok && (
        <DiffParsedBody hunks={parsed.hunks} />
      )}
      {open && canExpand && diffText && !tool.truncated && parsed && !parsed.ok && (
        <DiffPlainBody
          text={diffText}
          note="Unable to parse complete diff"
        />
      )}
      {!open && tool.truncated && (
        <div className="ml-4 mt-1 text-[10px] text-muted-foreground">
          Diff truncated — not shown in full.
        </div>
      )}
      {tool.error && (
        <div className="ml-4 mt-1 text-[10px] text-destructive">{tool.error}</div>
      )}
      <div className="ml-4">
        <RawToggle raw={message.raw} />
      </div>
    </div>
  );
}

/** Humanize positive finite task duration; omit zero/invalid. */
function formatTaskDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return null;
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function taskSubagentLabel(tool: TaskTool): string | undefined {
  if (
    tool.subagentName &&
    tool.subagentKind &&
    tool.subagentName !== tool.subagentKind
  ) {
    return `${tool.subagentKind} · ${tool.subagentName}`;
  }
  return tool.subagentName ?? tool.subagentKind;
}

function taskStatusLabel(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const s = status.toLowerCase();
  if (s === "running" || s === "in_progress" || s === "in-progress" || s === "pending") {
    return "running";
  }
  if (s === "completed" || s === "success" || s === "done") {
    return "completed";
  }
  if (s === "error" || s === "failed" || s === "failure") {
    return "error";
  }
  return status;
}

function TaskMetaBlock({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        {label}
      </div>
      <pre className="no-scrollbar max-h-48 min-w-0 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {text}
      </pre>
    </div>
  );
}

function TaskToolRow({
  message,
  tool,
}: {
  message: ChatMessage;
  tool: TaskTool;
}) {
  const [open, setOpen] = useState(false);
  const subagent = taskSubagentLabel(tool);
  const statusLabel = taskStatusLabel(message.status);
  const duration =
    statusLabel === "completed" ? formatTaskDuration(tool.durationMs) : null;
  const prompt = nonEmpty(tool.prompt);
  const resultText = nonEmpty(tool.resultText);
  const hasExpandable =
    prompt !== undefined ||
    tool.model !== undefined ||
    tool.mode !== undefined ||
    tool.agentId !== undefined ||
    resultText !== undefined ||
    tool.truncated ||
    tool.error !== undefined;

  return (
    <div className="min-w-0 rounded-lg border border-border bg-muted/20 px-2.5 py-1.5">
      <div className="flex w-full min-w-0 items-center gap-2 py-0.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            toolStatusClass(message.status)
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 break-words font-semibold text-foreground/90">
          {message.title ?? tool.description ?? "Run agent"}
        </span>
        {subagent && (
          <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] font-medium text-muted-foreground">
            {subagent}
          </span>
        )}
        {statusLabel && (
          <span
            className={cn(
              "shrink-0 text-[10px] font-medium",
              statusLabel === "error" && "text-destructive",
              statusLabel === "completed" && "text-status-completed",
              statusLabel === "running" && "text-status-running"
            )}
          >
            {statusLabel}
          </span>
        )}
        {duration && (
          <span className="shrink-0 text-[10px] text-muted-foreground/80">
            {duration}
          </span>
        )}
        {hasExpandable && (
          <button
            type="button"
            className={cn(QUIET_BUTTON_CLASS, "shrink-0")}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▾" : "▸"}
          </button>
        )}
      </div>
      {open && hasExpandable && (
        <div className="mt-1.5 flex min-w-0 flex-col gap-1.5">
          {prompt && <TaskMetaBlock label="prompt" text={prompt} />}
          {tool.model && (
            <div className="text-[11px] text-muted-foreground">
              <span className="font-semibold text-muted-foreground/80">model </span>
              {tool.model}
            </div>
          )}
          {tool.mode && (
            <div className="text-[11px] text-muted-foreground">
              <span className="font-semibold text-muted-foreground/80">mode </span>
              {tool.mode}
            </div>
          )}
          {tool.agentId && (
            <div className="min-w-0 break-all text-[11px] text-muted-foreground">
              <span className="font-semibold text-muted-foreground/80">agent </span>
              {tool.agentId}
            </div>
          )}
          {resultText && <TaskMetaBlock label="result" text={resultText} />}
          {tool.truncated && (
            <div className="text-[10px] text-muted-foreground">
              Result truncated — not shown in full.
            </div>
          )}
          {tool.error && (
            <div className="text-[10px] text-destructive">{tool.error}</div>
          )}
        </div>
      )}
      {!open && tool.truncated && (
        <div className="mt-1 text-[10px] text-muted-foreground">
          Result truncated — not shown in full.
        </div>
      )}
      {!open && tool.error && (
        <div className="mt-1 text-[10px] text-destructive">{tool.error}</div>
      )}
      <RawToggle raw={message.raw} />
    </div>
  );
}

function ToolRow({ message }: { message: ChatMessage }) {
  const tool = message.tool;
  if (tool?.kind === "task") {
    return <TaskToolRow message={message} tool={tool} />;
  }
  if (tool?.kind === "shell" && shellHasRenderableResult(tool)) {
    return <ShellToolRow message={message} tool={tool} />;
  }
  if (tool?.kind === "todos") {
    return <TodoToolRow message={message} tool={tool} />;
  }
  if (tool?.kind === "diff" && diffHasRichContent(tool)) {
    return <DiffToolRow message={message} tool={tool} />;
  }
  return <PlainToolRow message={message} />;
}

/** Coarse category for a collapsed tool-row title, for group summaries. */
function toolCategory(title: string | undefined): string | undefined {
  if (!title) return undefined;
  if (title.startsWith("Read skill") || title.startsWith("Read file")) return "read";
  if (title.startsWith("Search code")) return "search";
  if (title.startsWith("Find files")) return "find";
  if (title.startsWith("Run command")) return "run command";
  if (title.startsWith("Edit file")) return "edit";
  if (title.startsWith("Delete file")) return "delete";
  if (title.startsWith("Update todo")) return "todo";
  if (title.startsWith("Create plan")) return "plan";
  if (title.startsWith("Run agent")) return "agent";
  if (title.startsWith("Read lints")) return "lint";
  if (title === "Ask user") return "ask user";
  if (title.startsWith("Call MCP")) return "mcp";
  return undefined;
}

/**
 * Summarizes a grouped batch of collapsed tool rows from their titles alone
 * (never the raw payload): `3 reads` for a uniform read batch, `4 actions: read
 * 2, search` for mixed, falling back to `N tool calls` when titles are missing
 * or unrecognized.
 */
export function toolGroupTitle(tools: ChatMessage[]): string {
  const fallback = `${tools.length} tool calls`;
  if (tools.length === 0) return "tool calls";

  const categories = tools.map((t) => toolCategory(t.title));
  if (categories.some((c) => c === undefined)) return fallback;
  const known = categories as string[];

  if (known.every((c) => c === "read")) {
    return `${tools.length} read${tools.length === 1 ? "" : "s"}`;
  }

  const counts = new Map<string, number>();
  for (const c of known) counts.set(c, (counts.get(c) ?? 0) + 1);
  const parts = [...counts.entries()].map(([c, n]) => (n > 1 ? `${c} ${n}` : c));
  return `${tools.length} actions: ${parts.join(", ")}`;
}

function ToolGroup({ tools }: { tools: ChatMessage[] }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 1) {
    return (
      <div className="w-full min-w-0 px-1 text-xs text-muted-foreground">
        <ToolRow message={tools[0]} />
      </div>
    );
  }
  const failures = shellFailureCount(tools);
  return (
    <div className="w-full min-w-0 px-1 text-xs text-muted-foreground">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="shrink-0">{open ? "▾" : "▸"}</span>
        <span className="font-medium">{toolGroupTitle(tools)}</span>
        {failures > 0 && (
          <span
            className="ml-auto shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1 py-px text-[10px] font-medium text-destructive"
            title={`${failures} shell command${failures === 1 ? "" : "s"} exited non-zero`}
          >
            {failures === 1 ? "exit failed" : `${failures} failed`}
          </span>
        )}
      </button>
      {open && (
        <div className="flex min-w-0 flex-col">
          {tools.map((m) => (
            <ToolRow key={m.seq} message={m} />
          ))}
        </div>
      )}
    </div>
  );
}

type PromptRefNav = {
  activeOccurrence: number | null;
  occurrenceOffsetBySeq: Map<number, number>;
  onPillRef: (occurrence: number, el: HTMLSpanElement | null) => void;
};

function collectUserPromptReferences(messages: ChatMessage[]): {
  references: PromptReference[];
  offsetBySeq: Map<number, number>;
} {
  const references: PromptReference[] = [];
  const offsetBySeq = new Map<number, number>();
  for (const message of messages) {
    if (
      (message.role !== "user" &&
        message.role !== "answer" &&
        message.role !== "question") ||
      !message.body
    ) {
      continue;
    }
    const refs = parsePromptReferences(message.body);
    if (refs.length === 0) continue;
    offsetBySeq.set(message.seq, references.length);
    references.push(...refs);
  }
  return { references, offsetBySeq };
}

function TranscriptSegmentView({
  segment,
  active = false,
  promptRefNav = null,
}: {
  segment: TranscriptSegment;
  active?: boolean;
  promptRefNav?: PromptRefNav | null;
}) {
  if (segment.kind === "tools") {
    return <ToolGroup tools={segment.tools} />;
  }
  return (
    <MessageView
      message={segment.message}
      active={active}
      promptRefNav={promptRefNav}
    />
  );
}

function SystemDivider({ message }: { message: ChatMessage }) {
  const time = formatClock(message.ts);
  return (
    <div className="flex justify-center">
      <div
        className={cn(
          "inline-flex max-w-[90%] items-baseline gap-2 border-t border-border px-2.5 py-0.5 text-[11px]",
          message.tone === "error" ? "text-destructive" : "text-muted-foreground"
        )}
      >
        <span className="shrink-0 font-semibold">{message.title ?? "event"}</span>
        {message.body && (
          <span className="min-w-0 break-words whitespace-pre-wrap">
            {message.body}
          </span>
        )}
        {time && (
          <span className="shrink-0 text-muted-foreground/70">{time}</span>
        )}
      </div>
    </div>
  );
}

/** Unowned top-level SDK task progress — stream order only, no launch nesting. */
function TaskProgressBlock({ message }: { message: ChatMessage }) {
  const statusLabel = taskStatusLabel(message.status);
  const body = nonEmpty(message.body);
  const time = formatClock(message.ts);

  return (
    <div className="w-full min-w-0 rounded-lg border border-border bg-muted/20 px-2.5 py-1.5">
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            toolStatusClass(message.status)
          )}
          aria-hidden
        />
        <span className="font-semibold text-foreground/90">subagent progress</span>
        {statusLabel && (
          <span
            className={cn(
              "shrink-0 text-[10px] font-medium",
              statusLabel === "error" && "text-destructive",
              statusLabel === "completed" && "text-status-completed",
              statusLabel === "running" && "text-status-running"
            )}
          >
            {statusLabel}
          </span>
        )}
        {time && (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
            {time}
          </span>
        )}
      </div>
      {body && (
        <div className="mt-1 min-w-0 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      )}
      <RawToggle raw={message.raw} />
    </div>
  );
}

/** Short role label shown above a message, Cursor-style. */
function roleLabel(message: ChatMessage): string {
  switch (message.role) {
    case "user":
      return "you";
    case "answer":
      return "you";
    case "question":
      return "needs input";
    case "assistant":
      return "agent";
    default:
      return message.role;
  }
}

function AttachmentList({ message }: { message: ChatMessage }) {
  const attachments = message.attachments;
  if (!attachments || attachments.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {attachments.map((attachment) => {
        const href = attachment.url;
        if (attachment.kind === "image" && href) {
          return (
            <AuthenticatedImage
              key={attachment.id}
              src={href}
              alt={attachment.name}
              openable
              className="block max-w-xs overflow-hidden rounded-md border border-border"
              imgClassName="max-h-48 w-full object-contain bg-background"
            />
          );
        }
        return (
          <div
            key={attachment.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">{attachment.name}</div>
              <div className="text-muted-foreground">
                {attachment.mimeType} ·{" "}
                {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB
              </div>
            </div>
            {href ? (
              <AuthenticatedOpenLink
                href={href}
                download={attachment.name}
                className="shrink-0 text-primary underline-offset-2 hover:underline"
              >
                Open
              </AuthenticatedOpenLink>
            ) : (
              <span className="shrink-0 text-muted-foreground">Unavailable</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Bubble({
  message,
  promptRefNav = null,
}: {
  message: ChatMessage;
  promptRefNav?: PromptRefNav | null;
}) {
  const isUser = message.role === "user" || message.role === "answer";
  const isQuestion = message.role === "question";
  const time = formatClock(message.ts);
  return (
    <div
      className={cn(
        "w-full rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed",
        // Agent replies read as plain full-width prose, like Cursor's chat.
        !isUser && !isQuestion && "border border-transparent bg-transparent px-1",
        isUser && "border border-border bg-muted/50",
        isQuestion && "border border-status-needs-input/50 bg-status-needs-input/10"
      )}
    >
      <div className="mb-1 text-[11px] font-semibold lowercase text-muted-foreground">
        {message.title ?? roleLabel(message)}
      </div>
      {message.body !== undefined &&
        (isUser || isQuestion ? (
          <div className={MD_CLASS}>
            <PromptReferenceText
              text={message.body}
              activeOccurrence={promptRefNav?.activeOccurrence}
              occurrenceOffset={
                promptRefNav?.occurrenceOffsetBySeq.get(message.seq) ?? 0
              }
              onPillRef={promptRefNav?.onPillRef}
            />
          </div>
        ) : (
          <Markdown>{message.body}</Markdown>
        ))}
      {isUser && <AttachmentList message={message} />}
      <div className="flex items-center justify-between gap-2">
        <RawToggle raw={message.raw} />
        {time && (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">
            {time}
          </span>
        )}
      </div>
    </div>
  );
}

function MessageView({
  message,
  active = false,
  promptRefNav = null,
}: {
  message: ChatMessage;
  active?: boolean;
  promptRefNav?: PromptRefNav | null;
}) {
  switch (message.role) {
    case "thinking":
      return <ThinkingBlock message={message} active={active} />;
    case "system":
      return <SystemDivider message={message} />;
    case "task":
      return <TaskProgressBlock message={message} />;
    default:
      return <Bubble message={message} promptRefNav={promptRefNav} />;
  }
}

function activeThinkingSeq(
  messages: ChatMessage[],
  runStatus: TranscriptProps["runStatus"]
): number | null {
  if (runStatus !== "running") return null;
  const segments = groupTranscriptSegments(messages);
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (
      segment.kind === "message" &&
      segment.message.role === "thinking"
    ) {
      return segment.message.seq;
    }
  }
  return null;
}

export function Transcript({
  messages,
  runStatus,
  pendingQuestion,
  showToolbar = true,
  showPromptJump,
  onExpandPromptJump,
  promptJumpEmptyLabel,
  emptyMessage = "No events yet.",
  scrollContainerRef,
  initialScrollTop = 0,
  onScrollPositionChange,
}: TranscriptProps) {
  const promptJumpEnabled = showPromptJump ?? showToolbar;
  const [raw, setRaw] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const restoredScrollRef = useRef(false);
  // Captured once at mount. Chat callers remount via a per-chat key, so each chat
  // re-seeds its own restore target instead of re-reading the live cache value
  // on every streaming re-render (which would fight auto-follow).
  const initialScrollTopRef = useRef(initialScrollTop);
  const scrollRestoreEnabled = onScrollPositionChange != null;
  const liveThinkingSeq = activeThinkingSeq(messages, runStatus);

  const assignScrollRef = (el: HTMLDivElement | null): void => {
    scrollRef.current = el;
    if (scrollContainerRef) {
      scrollContainerRef.current = el;
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    onScrollPositionChange?.(el.scrollTop);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (
      !restoredScrollRef.current &&
      initialScrollTopRef.current > 0 &&
      messages.length > 0
    ) {
      el.scrollTop = initialScrollTopRef.current;
      pinnedRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      restoredScrollRef.current = true;
      return;
    }
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, pendingQuestion]);

  // Re-pin to the bottom when the run identity changes — but only for callers
  // that don't manage per-conversation scroll restore (run modal, inline card
  // logs). Chat callers remount via a per-chat key, so this would clobber restore.
  useEffect(() => {
    if (scrollRestoreEnabled) return;
    pinnedRef.current = true;
  }, [runStatus, scrollRestoreEnabled]);

  const useRaw = showToolbar && raw;
  const { references: promptReferences, offsetBySeq: promptRefOffsets } =
    useMemo(
      () =>
        promptJumpEnabled && !useRaw
          ? collectUserPromptReferences(messages)
          : { references: [] as PromptReference[], offsetBySeq: new Map() },
      [messages, promptJumpEnabled, useRaw]
    );
  const promptJump = usePromptReferenceJump(promptReferences);
  const showPromptJumpChrome =
    promptJumpEnabled &&
    !useRaw &&
    (promptReferences.length > 0 ||
      onExpandPromptJump != null ||
      promptJumpEmptyLabel != null);
  const promptRefNav: PromptRefNav | null =
    showPromptJumpChrome && promptReferences.length > 0
      ? {
          activeOccurrence: promptJump.activeOccurrence,
          occurrenceOffsetBySeq: promptRefOffsets,
          onPillRef: promptJump.onPillRef,
        }
      : null;

  return (
    <>
      {showToolbar && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-muted-foreground">
            status: <strong className="text-foreground">{runStatus}</strong>
          </span>
          <button
            className={cn(
              "cursor-pointer rounded-md border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground",
              raw && "border-ring text-foreground"
            )}
            onClick={() => setRaw((v) => !v)}
          >
            {raw ? "Pretty" : "Raw"}
          </button>
        </div>
      )}
      {showPromptJumpChrome && (
        <PromptReferenceJumpBar
          references={promptReferences}
          activeOccurrence={promptJump.activeOccurrence}
          onCycle={promptJump.onCycle}
          onJumpUnique={promptJump.onJumpUnique}
          emptyLabel={
            promptJumpEmptyLabel ??
            (onExpandPromptJump ? `status: ${runStatus}` : undefined)
          }
          alwaysShow={
            onExpandPromptJump != null || promptJumpEmptyLabel != null
          }
          trailing={
            onExpandPromptJump ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                title="Expand"
                aria-label="Expand log to fullscreen"
                onClick={(e) => {
                  e.stopPropagation();
                  onExpandPromptJump();
                }}
              >
                <Maximize2 className="size-3.5" />
              </Button>
            ) : undefined
          }
          className={showToolbar ? "px-4" : undefined}
        />
      )}
      <OverlayScrollArea
        scrollRef={assignScrollRef}
        onScroll={onScroll}
        contentRevision={`${messages.length}:${pendingQuestion ?? ""}:${useRaw}`}
        contentClassName={cn(
          "flex flex-col gap-2.5",
          showToolbar && "px-4 py-3.5"
        )}
      >
        {messages.length === 0 && (
          <div className="text-muted-foreground">{emptyMessage}</div>
        )}
        {useRaw
          ? messages.map((m) => (
              <div
                key={m.seq}
                className="flex gap-2.5 border-b border-white/[0.04] py-0.5 font-mono text-xs"
              >
                <span className="min-w-7 text-right text-muted-foreground">
                  {m.seq}
                </span>
                <span className="min-w-[120px] text-primary">{m.role}</span>
                <pre className="flex-1 whitespace-pre-wrap break-words text-foreground">
                  {m.raw}
                </pre>
              </div>
            ))
          : groupTranscriptSegments(messages).map((segment) => (
              <TranscriptSegmentView
                key={
                  segment.kind === "tools"
                    ? segment.tools[0].seq
                    : segment.message.seq
                }
                segment={segment}
                active={
                  liveThinkingSeq !== null &&
                  segment.kind === "message" &&
                  segment.message.seq === liveThinkingSeq
                }
                promptRefNav={promptRefNav}
              />
            ))}
        {pendingQuestion && (
          <div className="w-full rounded-lg border border-status-needs-input/50 bg-status-needs-input/10 px-3.5 py-2.5 text-[13px] leading-relaxed">
            <div className="mb-1 text-[11px] font-semibold lowercase text-muted-foreground">
              waiting for input
            </div>
            <Markdown>{pendingQuestion}</Markdown>
          </div>
        )}
      </OverlayScrollArea>
    </>
  );
}
