import {
  modelSelectionFromLifecyclePayload,
  modelSelectionSummary,
} from "@lca/shared";
import { shortenPath } from "./diff";
import type {
  ChatMessage,
  ChatRole,
  StoredEvent,
  TodoItemStatus,
  ToolView,
  TranscriptAttachment,
} from "./transcript-types";

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" ? (value as AnyRecord) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseAttachments(parsed: AnyRecord | undefined): TranscriptAttachment[] | undefined {
  const raw = parsed?.attachments;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const out: TranscriptAttachment[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const id = str(row.id);
    const name = str(row.name);
    const mimeType = str(row.mimeType);
    const kind = row.kind === "image" || row.kind === "file" ? row.kind : undefined;
    const sizeBytes =
      typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes)
        ? row.sizeBytes
        : undefined;
    if (!id || !name || !mimeType || !kind || sizeBytes === undefined) continue;
    out.push({ id, name, mimeType, sizeBytes, kind });
  }
  return out.length > 0 ? out : undefined;
}

function userBody(text: string | undefined, hasAttachments: boolean): string | undefined {
  const trimmed = text?.trim() ?? "";
  if (trimmed) return trimmed;
  if (hasAttachments) return undefined;
  return "(no text)";
}

function parsePayload(payload: string): AnyRecord | undefined {
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

/**
 * Extracts readable text + any tool_use names from an SDK message's
 * `message.content[]` array (`{type:"text",text}` / `{type:"tool_use",name}`).
 *
 * Text blocks are concatenated with no separator: the SDK streams assistant
 * output as token deltas that already carry their own whitespace, so joining
 * with anything else would corrupt the reconstructed message.
 */
function extractMessageContent(parsed: AnyRecord): {
  text: string;
  toolUses: string[];
} {
  const message = asRecord(parsed.message);
  const content = message?.content;
  const text: string[] = [];
  const toolUses: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string") {
        text.push(b.text);
      } else if (b.type === "tool_use") {
        const name = str(b.name);
        if (name) toolUses.push(name);
      }
    }
  } else if (typeof message?.content === "string") {
    text.push(message.content);
  } else if (typeof parsed.text === "string") {
    text.push(parsed.text);
  }
  return { text: text.join(""), toolUses };
}

function invokingSuffix(toolUses: string[]): string {
  if (toolUses.length === 0) return "";
  const unique = [...new Set(toolUses)];
  return `\n\n_invoking: ${unique.join(", ")}_`;
}

function base(ev: StoredEvent, role: ChatRole): ChatMessage {
  return { seq: ev.seq, role, raw: ev.payload, ts: ev.createdAt };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optNum(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A count the renderer can display verbatim: non-negative integers only. */
function optCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Max length of a tool-call detail fragment, so one collapsed row stays compact. */
const TOOL_DETAIL_MAX = 80;

/**
 * Reads the tool-call argument bag. SDK `tool_call` messages carry `args`; we also
 * tolerate `input` for older fixtures / `tool_use`-like shapes. Never throws.
 */
function toolArgs(parsed: AnyRecord): AnyRecord {
  return asRecord(parsed.args) ?? asRecord(parsed.input) ?? {};
}

/** Collapse whitespace and bound a free-form detail string for a collapsed row. */
function toolDetail(value: unknown): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > TOOL_DETAIL_MAX
    ? `${oneLine.slice(0, TOOL_DETAIL_MAX - 1)}…`
    : oneLine;
}

/**
 * Reads the SDK result envelope (`result` or legacy `output`). Never throws.
 */
function toolResultEnvelope(parsed: AnyRecord): AnyRecord | undefined {
  return asRecord(parsed.result) ?? asRecord(parsed.output);
}

/** Success payload record from `{status:"success", value:{…}}`, else undefined. */
function toolResultValue(parsed: AnyRecord): AnyRecord | undefined {
  const result = toolResultEnvelope(parsed);
  if (!result || result.status !== "success") return undefined;
  return asRecord(result.value);
}

/** Short displayable string when `result.status === "error"`. */
function toolResultError(parsed: AnyRecord): string | undefined {
  const result = toolResultEnvelope(parsed);
  if (!result || result.status !== "error") return undefined;
  const err = result.error;
  if (typeof err === "string") {
    const trimmed = err.trim();
    return trimmed || "error";
  }
  const rec = asRecord(err);
  if (rec) {
    const msg = str(rec.message) ?? str(rec.error);
    if (msg?.trim()) return msg.trim();
  }
  if (err != null && typeof err !== "object") return String(err);
  return "error";
}

/**
 * True when the SDK marked `truncated.result`, or the store replaced the payload
 * with a `_truncated` envelope (no result survives that path).
 */
function resultTruncated(parsed: AnyRecord): boolean {
  if (parsed._truncated === true) return true;
  const trunc = asRecord(parsed.truncated);
  return trunc?.result === true;
}

function parseTodoStatus(value: unknown): TodoItemStatus | undefined {
  if (
    value === "pending" ||
    value === "inProgress" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return undefined;
}

function parseTodoItems(
  raw: unknown
): Array<{ content: string; status: TodoItemStatus }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ content: string; status: TodoItemStatus }> = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const content = str(row.content);
    const status = parseTodoStatus(row.status);
    if (content === undefined || status === undefined) continue;
    out.push({ content, status });
  }
  return out;
}

/**
 * Maps a recognized tool_call into a typed ToolView. Pure and total: malformed
 * or unrecognized payloads return undefined without throwing. Titles stay
 * args-derived via `toolCallTitle` — this never changes a row title.
 */
function toolView(parsed: AnyRecord): ToolView | undefined {
  const name = str(parsed.name);
  if (!name) return undefined;
  const args = toolArgs(parsed);
  const value = toolResultValue(parsed);
  const error = toolResultError(parsed);
  const truncated = resultTruncated(parsed);
  const errField = error ? { error } : {};

  switch (name.toLowerCase()) {
    case "shell": {
      const command = str(args.command) ?? "";
      if (error) {
        return { kind: "shell", command, truncated, ...errField };
      }
      const stdout = str(value?.stdout);
      const stderr = str(value?.stderr);
      const exitCode = optNum(value?.exitCode);
      const executionTimeMs = optNum(value?.executionTime);
      return {
        kind: "shell",
        command,
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(executionTimeMs !== undefined ? { executionTimeMs } : {}),
        truncated,
        ...errField,
      };
    }
    case "edit": {
      const path = str(args.path) ?? "";
      if (error) {
        return { kind: "diff", path, truncated, ...errField };
      }
      const linesAdded = optNum(value?.linesAdded);
      const linesRemoved = optNum(value?.linesRemoved);
      const diffString = str(value?.diffString);
      return {
        kind: "diff",
        path,
        ...(linesAdded !== undefined ? { linesAdded } : {}),
        ...(linesRemoved !== undefined ? { linesRemoved } : {}),
        ...(diffString !== undefined ? { diffString } : {}),
        truncated,
        ...errField,
      };
    }
    case "write": {
      const path = str(args.path) ?? str(value?.path) ?? "";
      if (error) {
        return { kind: "diff", path, truncated, ...errField };
      }
      const linesAdded = optNum(value?.linesCreated);
      return {
        kind: "diff",
        path,
        ...(linesAdded !== undefined ? { linesAdded } : {}),
        truncated,
        ...errField,
      };
    }
    case "updatetodos": {
      if (error) {
        return {
          kind: "todos",
          todos: [],
          completed: 0,
          total: 0,
          truncated,
          ...errField,
        };
      }
      const fromValue = value ? parseTodoItems(value.todos) : [];
      const fromArgs = parseTodoItems(args.todos);
      // Prefer result todos; fall back to args when result is missing/truncated.
      const useArgs = value === undefined || truncated;
      const todos = useArgs
        ? fromArgs.length > 0
          ? fromArgs
          : fromValue
        : fromValue;
      const totalFromValue = optCount(value?.totalCount);
      const total =
        !useArgs && totalFromValue !== undefined
          ? totalFromValue
          : todos.length;
      const completed = todos.filter((t) => t.status === "completed").length;
      return { kind: "todos", todos, completed, total, truncated };
    }
    case "task": {
      const subagent = asRecord(args.subagentType);
      const description = str(args.description);
      if (error) {
        return {
          kind: "task",
          ...(description !== undefined ? { description } : {}),
          truncated,
          ...errField,
        };
      }
      const prompt = str(args.prompt);
      const subagentKind = str(subagent?.kind);
      const subagentName = str(subagent?.name);
      const model = str(args.model);
      const mode = str(args.mode);
      const durationMs = optNum(value?.durationMs);
      const agentId = str(value?.agentId);
      const resultText = str(value?.resultSuffix)?.trim() || undefined;
      return {
        kind: "task",
        ...(description !== undefined ? { description } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(subagentKind !== undefined ? { subagentKind } : {}),
        ...(subagentName !== undefined ? { subagentName } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(agentId !== undefined ? { agentId } : {}),
        ...(resultText !== undefined ? { resultText } : {}),
        truncated,
      };
    }
    default:
      return undefined;
  }
}

/** `label` or `label: detail`, dropping the suffix when detail is empty. */
function labelWith(label: string, detail?: string): string {
  return detail ? `${label}: ${detail}` : label;
}

/**
 * Returns the skill name (parent directory) when a path is a skill `SKILL.md`,
 * e.g. `.../skills/backlog/SKILL.md` -> `backlog`. Otherwise undefined.
 */
function skillNameFromPath(path: string): string | undefined {
  const norm = path.replace(/\\/g, "/");
  if (!norm.endsWith("/SKILL.md")) return undefined;
  const segments = norm.split("/").filter(Boolean);
  const parent = segments[segments.length - 2];
  return parent || undefined;
}

function readPathLabel(verb: string, args: AnyRecord): string {
  const path = str(args.path);
  if (!path) return verb === "Read" ? "Read file" : `${verb} file`;
  if (verb === "Read") {
    const skill = skillNameFromPath(path);
    if (skill) return `Read skill: ${skill}`;
  }
  return `${verb} file: ${shortenPath(path)}`;
}

/**
 * Maps a `tool_call` payload to an action-oriented collapsed title (e.g.
 * `Read skill: me-agenda`, `Search code: foo`). Pure and total: unknown or
 * malformed payloads fall back to the raw tool name.
 *
 * Tool names follow the cursor-agent SDK surface (lowercase `read`/`grep`/
 * `edit`/`shell`/`mcp`/…), confirmed against real `run_events`, not the Cursor
 * IDE tool names.
 */
function toolCallTitle(parsed: AnyRecord): string {
  const name = str(parsed.name);
  if (!name) return "tool";
  const args = toolArgs(parsed);

  switch (name.toLowerCase()) {
    case "read":
      return readPathLabel("Read", args);
    case "edit":
      return readPathLabel("Edit", args);
    case "delete":
      return readPathLabel("Delete", args);
    case "grep":
      return labelWith("Search code", toolDetail(args.pattern));
    case "glob":
      return labelWith("Find files", toolDetail(args.globPattern));
    case "shell":
      return labelWith("Run command", toolDetail(args.command));
    case "task":
      return labelWith("Run agent", toolDetail(args.description));
    case "updatetodos":
      return "Update todo list";
    case "createplan":
      return "Create plan";
    case "readlints":
      return "Read lints";
    case "mcp": {
      const provider = str(args.providerIdentifier);
      const tool = str(args.toolName);
      if (provider === "automations-io" && tool === "ask_user") return "Ask user";
      if (provider && tool) return `Call MCP tool: ${provider}.${tool}`;
      return "Call MCP tool";
    }
    default:
      return name;
  }
}

/** Returns the balanced `{...}` substring starting at `open`, honoring strings. */
function balancedObject(text: string, open: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return undefined;
}

/** Pulls a top-level string field's value out of a (possibly truncated) JSON prefix. */
function jsonStringField(text: string, key: string): string | undefined {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = text.match(re);
  return m ? m[1] : undefined;
}

/**
 * The store caps oversized payloads to `{_truncated, eventType, preview}` (first
 * 1000 chars of the original JSON). For a tool_call the heavy part is the trailing
 * `result`, so `name`/`status`/`args` survive in the preview — recover them so a
 * truncated tool call still renders as a clean, labeled tool row.
 */
function recoverTruncatedToolCall(preview: string | undefined): AnyRecord | undefined {
  if (!preview) return undefined;

  try {
    const whole = asRecord(JSON.parse(preview));
    if (whole && str(whole.name)) return whole;
  } catch {
    // preview was cut mid-structure — fall through to lenient extraction
  }

  const name = jsonStringField(preview, "name");
  if (!name) return undefined;

  const recovered: AnyRecord = { type: "tool_call", name };
  const status = jsonStringField(preview, "status");
  if (status) recovered.status = status;

  const argsIdx = preview.indexOf('"args"');
  if (argsIdx !== -1) {
    const braceIdx = preview.indexOf("{", argsIdx);
    if (braceIdx !== -1) {
      const argsStr = balancedObject(preview, braceIdx);
      if (argsStr) {
        try {
          const args = asRecord(JSON.parse(argsStr));
          if (args) recovered.args = args;
        } catch {
          // truncated args — leave them off; the label degrades gracefully
        }
      }
    }
  }
  return recovered;
}

/**
 * Renders the spawn-time `run.references` event: a short, readable summary of how
 * many prompt references resolved vs. passed through unknown, naming the
 * unresolved ones so an operator can spot a typo'd `@rule` / `/skill`.
 */
function mapReferences(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const error = str(parsed?.error);
  if (error) {
    return {
      ...base(ev, "system"),
      tone: "error",
      title: "prompt references",
      body: `Reference resolution failed: ${error}`,
    };
  }

  const resolved = num(parsed?.resolved);
  const unknown = num(parsed?.unknown);
  const rawNames = Array.isArray(parsed?.unknownReferences)
    ? parsed.unknownReferences
    : [];
  const names = rawNames
    .map((entry) => str(asRecord(entry)?.raw))
    .filter((raw): raw is string => Boolean(raw));
  const truncated = num(parsed?.unknownReferencesTruncated);

  const parts = [`Resolved ${plural(resolved, "reference")}`];
  if (unknown > 0) {
    const named = names.length > 0 ? `: ${names.join(", ")}` : "";
    const more = truncated > 0 ? ` (+${truncated} more)` : "";
    parts.push(`${plural(unknown, "unresolved reference")}${named}${more}`);
  }

  return {
    ...base(ev, "system"),
    tone: unknown > 0 ? "error" : "info",
    title: "prompt references",
    body: parts.join(" · "),
  };
}

function shortRunId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Readable transcript divider for `run.pipeline-escalated`. Attribution comes
 * only from a strictly narrowed `actor` — never inferred from chain fields.
 */
function mapPipelineEscalated(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const actionRaw = str(parsed?.action);
  const action =
    actionRaw === "retry" || actionRaw === "skip" || actionRaw === "abort"
      ? actionRaw
      : undefined;
  if (!action) {
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "pipeline escalated",
      body: "Pipeline escalation recorded.",
    };
  }

  const actorRaw = str(parsed?.actor);
  const actor =
    actorRaw === "daemon" || actorRaw === "operator" ? actorRaw : undefined;
  const childRunId = str(parsed?.childRunId);
  const childPart = childRunId
    ? ` Successor: ${shortRunId(childRunId)}.`
    : "";

  if (actor === "daemon") {
    const recoveryCode = str(parsed?.recoveryCode);
    const recoveryDetail = str(parsed?.recoveryDetail);
    const recoveryBits: string[] = [];
    if (recoveryCode) recoveryBits.push(recoveryCode);
    if (recoveryDetail) recoveryBits.push(recoveryDetail);
    const recoveryPart =
      recoveryBits.length > 0 ? ` ${recoveryBits.join(" — ")}.` : "";
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "automatic recovery",
      body: `Automatic ${action}.${childPart}${recoveryPart}`.trim(),
    };
  }

  if (actor === "operator") {
    const reason = str(parsed?.reason);
    const reasonPart = reason ? ` Reason: ${reason}.` : "";
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "operator escalation",
      body: `Operator escalated with ${action}.${childPart}${reasonPart}`.trim(),
    };
  }

  return {
    ...base(ev, "system"),
    tone: "info",
    title: "pipeline escalated",
    body: `Pipeline escalated with ${action}.${childPart}`.trim(),
  };
}

/**
 * Halted divider for reason-coded auto-recovery declines. Operator controls
 * remain available because the transition claim stays null.
 */
function mapPipelineHaltUnrecovered(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const code = str(parsed?.code);
  const detail = str(parsed?.detail);
  if (!code || !detail) {
    return {
      ...base(ev, "system"),
      tone: "error",
      title: "pipeline remains halted",
      body: "Automatic recovery declined. Operator escalation remains available.",
    };
  }
  const observedReason = str(parsed?.observedReason);
  const observedPart = observedReason
    ? ` Observed reason: ${observedReason}.`
    : "";
  return {
    ...base(ev, "system"),
    tone: "error",
    title: "pipeline remains halted",
    body:
      `Automatic recovery declined (${code}: ${detail}).${observedPart} ` +
      `Operator escalation remains available.`,
  };
}

const DISCOVERY_SKIP_CODES = new Set([
  "disabled",
  "wave-scoped",
  "source-resolved",
  "ineligible-source",
  "invalid-trigger",
]);

const DISCOVERY_FAILURE_STAGES = new Set(["spawn", "diagnosis", "briefing"]);

const DISCOVERY_ACTION_OUTCOMES = new Set([
  "acted",
  "refused",
  "internal-failure",
]);

const ESCALATION_ACTIONS = new Set(["retry", "skip", "abort"]);

/**
 * Source-side informational divider when halt discovery was requested after an
 * unrecovered b43 decline.
 */
function mapHaltDiscoveryRequested(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const code = str(parsed?.code);
  const recoveryCode = str(parsed?.recoveryCode);
  if (code !== "unrecovered-halt" || !recoveryCode) {
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "halt discovery requested",
      body: "Halt discovery requested after an unrecovered halt.",
    };
  }
  return {
    ...base(ev, "system"),
    tone: "info",
    title: "halt discovery requested",
    body: `Halt discovery requested after unrecovered halt (${recoveryCode}).`,
  };
}

/**
 * Source-side informational skip: best-effort only; existing source controls
 * remain available.
 */
function mapHaltDiscoverySkipped(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const code = str(parsed?.code);
  if (!code || !DISCOVERY_SKIP_CODES.has(code)) {
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "halt discovery skipped",
      body:
        "Halt discovery skipped. Existing source controls remain available.",
    };
  }
  return {
    ...base(ev, "system"),
    tone: "info",
    title: "halt discovery skipped",
    body:
      `Halt discovery skipped (${code}). Existing source controls remain available.`,
  };
}

/**
 * Source-side error-toned failure for spawn/diagnosis/briefing stages. Never
 * dumps raw stack text — only stage and stable code.
 */
function mapHaltDiscoveryFailed(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const stage = str(parsed?.stage);
  const code = str(parsed?.code);
  if (
    !stage ||
    !DISCOVERY_FAILURE_STAGES.has(stage) ||
    !code
  ) {
    return {
      ...base(ev, "system"),
      tone: "error",
      title: "halt discovery failed",
      body: "Halt discovery failed. Operator escalation on the source remains available.",
    };
  }
  const advisoryRunId = str(parsed?.advisoryRunId);
  const advisoryPart = advisoryRunId
    ? ` Advisory: ${shortRunId(advisoryRunId)}.`
    : "";
  return {
    ...base(ev, "system"),
    tone: "error",
    title: "halt discovery failed",
    body:
      `Halt discovery failed at ${stage} (${code}).${advisoryPart} ` +
      `Operator escalation on the source remains available.`,
  };
}

/**
 * Advisory-side outcome after the operator answers a briefing. Distinguishes
 * acted / refused / internal-failure without claiming source recovery on
 * unsuccessful outcomes.
 */
function mapHaltDiscoveryActionResult(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const outcome = str(parsed?.outcome);
  const action = str(parsed?.action);
  const sourceRunId = str(parsed?.sourceRunId);
  const advisoryRunId = str(parsed?.advisoryRunId);
  if (
    !outcome ||
    !DISCOVERY_ACTION_OUTCOMES.has(outcome) ||
    !action ||
    !ESCALATION_ACTIONS.has(action) ||
    !sourceRunId ||
    !advisoryRunId
  ) {
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "halt discovery action result",
      body: "Halt discovery action result recorded.",
    };
  }

  const sourcePart = ` Source: ${shortRunId(sourceRunId)}.`;
  const advisoryPart = ` Advisory: ${shortRunId(advisoryRunId)}.`;
  const code = str(parsed?.code);
  const codePart = code ? ` (${code})` : "";

  if (outcome === "acted") {
    const childRunId = str(parsed?.childRunId);
    const childPart = childRunId
      ? ` Child: ${shortRunId(childRunId)}.`
      : "";
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "halt discovery action applied",
      body:
        `Operator approved ${action} via halt discovery.${sourcePart}${advisoryPart}${childPart}`.trim(),
    };
  }

  if (outcome === "refused") {
    return {
      ...base(ev, "system"),
      tone: "error",
      title: "halt discovery action refused",
      body:
        `Halt discovery ${action} refused${codePart}.${sourcePart}${advisoryPart} ` +
        `The halted source was not recovered; escalate the source directly if still needed.`,
    };
  }

  return {
    ...base(ev, "system"),
    tone: "error",
    title: "halt discovery action failed",
    body:
      `Halt discovery internal failure applying ${action}${codePart}.${sourcePart}${advisoryPart} ` +
      `The halted source was not recovered; escalate the source directly if still needed.`,
  };
}

/**
 * Advisory-side informational promotion into chat. Explicitly states the
 * halted source was not escalated.
 */
function mapHaltDiscoveryPromoted(
  ev: StoredEvent,
  parsed: AnyRecord | undefined
): ChatMessage {
  const sourceRunId = str(parsed?.sourceRunId);
  const advisoryRunId = str(parsed?.advisoryRunId);
  const chatId = str(parsed?.chatId);
  if (!sourceRunId || !advisoryRunId || !chatId) {
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "halt discovery promoted to chat",
      body:
        "Halt discovery briefing promoted to chat. The halted source was not escalated.",
    };
  }
  return {
    ...base(ev, "system"),
    tone: "info",
    title: "halt discovery promoted to chat",
    body:
      `Halt discovery briefing promoted to chat ${shortRunId(chatId)}. ` +
      `Source: ${shortRunId(sourceRunId)}. Advisory: ${shortRunId(advisoryRunId)}. ` +
      `The halted source was not escalated.`,
  };
}

/**
 * Converts one stored run event into a single ChatMessage for the transcript.
 * Pure and total — never throws; unparseable payloads fall back to a system row.
 */
export function normalizeEvent(ev: StoredEvent): ChatMessage {
  let parsed: AnyRecord | undefined;
  try {
    parsed = asRecord(JSON.parse(ev.payload));
  } catch {
    return { ...base(ev, "system"), tone: "error", body: ev.payload };
  }

  return mapParsed(ev, parsed);
}

function mapParsed(ev: StoredEvent, parsed: AnyRecord | undefined): ChatMessage {
  if (parsed?._truncated === true) {
    if (ev.eventType === "tool_call") {
      const recovered = recoverTruncatedToolCall(str(parsed.preview));
      if (recovered) {
        // Store envelope destroyed the result — mark truncated so renderers
        // can show an honest note while titles still come from recovered args.
        const tool = toolView({ ...recovered, _truncated: true });
        return {
          ...base(ev, "tool"),
          title: toolCallTitle(recovered),
          status: str(recovered.status),
          ...(tool ? { tool } : {}),
        };
      }
    }
    const bytes = typeof parsed.originalBytes === "number" ? parsed.originalBytes : undefined;
    const preview = str(parsed.preview) ?? "";
    return {
      ...base(ev, "system"),
      tone: "info",
      title: "truncated payload",
      body: `${bytes ? `${bytes} bytes` : "oversized"} — preview:\n${preview}`,
    };
  }

  switch (ev.eventType) {
    case "assistant": {
      const { text, toolUses } = parsed ? extractMessageContent(parsed) : { text: "", toolUses: [] };
      const body = text.concat(invokingSuffix(toolUses));
      return { ...base(ev, "assistant"), body: body || "(no text)" };
    }
    case "user": {
      const { text } = parsed ? extractMessageContent(parsed) : { text: "" };
      const attachments = parseAttachments(parsed);
      return {
        ...base(ev, "user"),
        body: userBody(text, Boolean(attachments?.length)),
        ...(attachments ? { attachments } : {}),
      };
    }
    case "run.message":
    case "chat.message": {
      const attachments = parseAttachments(parsed);
      return {
        ...base(ev, "user"),
        body: userBody(str(parsed?.text), Boolean(attachments?.length)),
        ...(attachments ? { attachments } : {}),
      };
    }
    case "run.message.queued":
    case "chat.message.queued": {
      const attachments = parseAttachments(parsed);
      return {
        ...base(ev, "user"),
        title: "Queued",
        body: userBody(str(parsed?.text), Boolean(attachments?.length)),
        ...(attachments ? { attachments } : {}),
      };
    }
    case "chat.steer.queued": {
      const runId = str(parsed?.runId);
      const shortRun = runId ? runId.slice(0, 8) : "?";
      return {
        ...base(ev, "user"),
        title: "Steered",
        body: userBody(
          `Queued on run ${shortRun}: ${str(parsed?.text) ?? ""}`,
          false
        ),
      };
    }
    case "run.interrupted":
    case "chat.interrupted": {
      const attachments = parseAttachments(parsed);
      return {
        ...base(ev, "user"),
        title: "Interrupted",
        body: userBody(str(parsed?.text), Boolean(attachments?.length)),
        ...(attachments ? { attachments } : {}),
      };
    }
    case "thinking": {
      const { text } = parsed ? extractMessageContent(parsed) : { text: "" };
      const thinkingDurationMs = optNum(parsed?.thinking_duration_ms);
      return {
        ...base(ev, "thinking"),
        title: "thinking",
        body: text || str(parsed?.text) || "",
        ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
      };
    }
    case "tool_call": {
      const tool = parsed ? toolView(parsed) : undefined;
      return {
        ...base(ev, "tool"),
        title: parsed ? toolCallTitle(parsed) : "tool",
        status: str(parsed?.status),
        ...(tool ? { tool } : {}),
      };
    }
    case "request":
    case "input.asked": {
      return { ...base(ev, "question"), body: str(parsed?.question) ?? "(awaiting input)" };
    }
    case "input.delivered": {
      return { ...base(ev, "answer"), body: str(parsed?.answer) ?? "" };
    }
    case "run.started":
    case "chat.started": {
      const selection = modelSelectionFromLifecyclePayload(parsed);
      const summary = selection ? modelSelectionSummary(selection) : "";
      return {
        ...base(ev, "system"),
        tone: "info",
        title: summary ? `started (${summary})` : "started",
      };
    }
    case "run.resumed":
    case "chat.resumed": {
      const selection = modelSelectionFromLifecyclePayload(parsed);
      const summary = selection ? modelSelectionSummary(selection) : "";
      return {
        ...base(ev, "system"),
        tone: "info",
        title: summary ? `resumed (${summary})` : "resumed",
      };
    }
    case "run.model": {
      const selection = modelSelectionFromLifecyclePayload(parsed);
      const summary = selection ? modelSelectionSummary(selection) : "";
      return {
        ...base(ev, "system"),
        tone: "info",
        title: "model changed",
        body: summary
          ? `Next turn uses ${summary}`
          : "Next turn uses the automation default",
      };
    }
    case "run.metadata": {
      const summary = str(parsed?.summary);
      return {
        ...base(ev, "system"),
        tone: "info",
        title: "run named",
        body: summary,
      };
    }
    case "chat.promoted_from_run": {
      const originRunId = str(parsed?.originRunId);
      return {
        ...base(ev, "system"),
        tone: "info",
        title: "continued from run",
        body: originRunId ? `Run ${originRunId.slice(0, 8)}` : undefined,
      };
    }
    case "run.revived":
    case "chat.revived": {
      const model = str(parsed?.model);
      const condensed = parsed?.truncated === true ? " Older context was condensed." : "";
      return {
        ...base(ev, "system"),
        tone: "info",
        title: "session revived",
        body:
          `The prior session was lost; a fresh agent was seeded from the stored transcript` +
          `${model ? ` (${model})` : ""}.${condensed}`,
      };
    }
    case "chat.reconciled": {
      const prior = str(parsed?.priorStatus);
      return {
        ...base(ev, "system"),
        tone: "info",
        title: "reconciled",
        body: prior ? `was ${prior}` : undefined,
      };
    }
    case "run.pipeline-escalated": {
      return mapPipelineEscalated(ev, parsed);
    }
    case "run.pipeline-halt-unrecovered": {
      return mapPipelineHaltUnrecovered(ev, parsed);
    }
    case "run.pipeline-halt-discovery-requested": {
      return mapHaltDiscoveryRequested(ev, parsed);
    }
    case "run.pipeline-halt-discovery-skipped": {
      return mapHaltDiscoverySkipped(ev, parsed);
    }
    case "run.pipeline-halt-discovery-failed": {
      return mapHaltDiscoveryFailed(ev, parsed);
    }
    case "run.pipeline-halt-discovery-action-result": {
      return mapHaltDiscoveryActionResult(ev, parsed);
    }
    case "run.pipeline-halt-discovery-promoted": {
      return mapHaltDiscoveryPromoted(ev, parsed);
    }
    case "run.finished":
    case "chat.finished": {
      // The final result text already streamed in as assistant token deltas, so
      // only emit a compact lifecycle divider — never re-dump the result payload.
      const sdkStatus = str(parsed?.sdkStatus);
      return {
        ...base(ev, "system"),
        tone: "info",
        title: sdkStatus ? `finished (${sdkStatus})` : "finished",
      };
    }
    case "run.error":
    case "chat.error": {
      if (parsed?.reason === "auth_expired") {
        const msg = str(parsed?.message);
        return {
          ...base(ev, "system"),
          tone: "error",
          title: "Cursor auth expired",
          body: msg
            ? `${msg} — refresh CURSOR_API_KEY or run cursor-agent login`
            : "Refresh CURSOR_API_KEY or run cursor-agent login",
        };
      }
      const stale = parsed?.stale === true;
      const reviveFailed = parsed?.reviveFailed === true;
      return {
        ...base(ev, "system"),
        tone: "error",
        title: stale ? "session unavailable" : "error",
        body: stale
          ? `This conversation's local session is no longer available${
              reviveFailed
                ? "; automatic revive was attempted but failed"
                : ""
            }`
          : (str(parsed?.message) ?? ev.payload),
      };
    }
    case "run.references": {
      return mapReferences(ev, parsed);
    }
    case "system":
    case "status": {
      return { ...base(ev, "system"), tone: "info", title: ev.eventType };
    }
    case "task": {
      // SDKTaskMessage: status? + text? only — no call_id / parent correlation.
      const status = str(parsed?.status);
      const text = str(parsed?.text)?.trim();
      return {
        ...base(ev, "task"),
        title: "task",
        ...(status !== undefined ? { status } : {}),
        ...(text ? { body: text } : {}),
      };
    }
    default: {
      return {
        ...base(ev, "system"),
        tone: "info",
        title: ev.eventType,
        body: parsed ? JSON.stringify(parsed) : ev.payload,
      };
    }
  }
}

type StreamRole = "assistant" | "thinking";

type Pending = {
  role: StreamRole;
  firstSeq: number;
  firstTs?: string;
  texts: string[];
  raws: string[];
  toolUses: string[];
  /** Max `thinking_duration_ms` observed across coalesced thinking deltas. */
  thinkingDurationMs?: number;
};

function flush(pending: Pending): ChatMessage {
  const body = pending.texts.join("").concat(invokingSuffix(pending.toolUses));
  return {
    seq: pending.firstSeq,
    role: pending.role,
    ...(pending.role === "thinking" ? { title: "thinking" } : {}),
    ...(pending.firstTs ? { ts: pending.firstTs } : {}),
    ...(pending.thinkingDurationMs !== undefined
      ? { thinkingDurationMs: pending.thinkingDurationMs }
      : {}),
    body: body || "(no text)",
    raw: pending.raws.join("\n"),
  };
}

/**
 * Builds the rendered transcript from ordered stored events, coalescing runs of
 * consecutive assistant (or thinking) token deltas into a single growing
 * message. This keeps live streaming but accumulates into one formatted bubble
 * instead of emitting one bubble per token. Any non-stream event (tool call,
 * question, answer, system, truncated payload) flushes the current group and is
 * mapped 1:1 via `normalizeEvent`.
 */
export function coalesceTranscript(events: StoredEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending: Pending | null = null;

  for (const ev of events) {
    const isStream = ev.eventType === "assistant" || ev.eventType === "thinking";
    const parsed = isStream ? parsePayload(ev.payload) : undefined;

    // A truncated assistant payload is not a token delta — render it standalone.
    if (!isStream || parsed?._truncated === true) {
      if (pending) {
        out.push(flush(pending));
        pending = null;
      }
      out.push(normalizeEvent(ev));
      continue;
    }

    const role = ev.eventType as StreamRole;
    const { text, toolUses } = parsed
      ? extractMessageContent(parsed)
      : { text: "", toolUses: [] };
    const duration =
      role === "thinking" ? optNum(parsed?.thinking_duration_ms) : undefined;

    if (pending && pending.role === role) {
      pending.texts.push(text);
      pending.raws.push(ev.payload);
      pending.toolUses.push(...toolUses);
      if (duration !== undefined) {
        pending.thinkingDurationMs =
          pending.thinkingDurationMs === undefined
            ? duration
            : Math.max(pending.thinkingDurationMs, duration);
      }
    } else {
      if (pending) out.push(flush(pending));
      pending = {
        role,
        firstSeq: ev.seq,
        firstTs: ev.createdAt,
        texts: [text],
        raws: [ev.payload],
        toolUses: [...toolUses],
        ...(duration !== undefined ? { thinkingDurationMs: duration } : {}),
      };
    }
  }

  if (pending) out.push(flush(pending));
  return out;
}
