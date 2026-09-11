/**
 * Field-aware event payload capping for run_events / chat_events.
 *
 * Oversized tool_call payloads trim known heavy leaves (read content, write
 * bodies, shell streams, diffs) before falling back to the blunt
 * `{_truncated, preview}` envelope. Budgets are hard-coded so a typical
 * multi-hunk diff and normal command output survive intact.
 */

const PREVIEW_CHARS = 1000;

/** UTF-8 byte budgets for each trimmable leaf (head + marker). */
const FIELD_BUDGETS = {
  content: 8 * 1024,
  fileContentAfterWrite: 8 * 1024,
  stderr: 12 * 1024,
  stdout: 16 * 1024,
  diffString: 24 * 1024,
  fileText: 8 * 1024,
} as const;

type TruncationFlag = "result" | "args";

type TrimTarget = {
  /** Dot path recorded in trim metadata. */
  path: string;
  segments: readonly string[];
  budget: number;
  flag: TruncationFlag;
};

const TRIM_ORDER: readonly TrimTarget[] = [
  {
    path: "result.value.content",
    segments: ["result", "value", "content"],
    budget: FIELD_BUDGETS.content,
    flag: "result",
  },
  {
    path: "result.value.fileContentAfterWrite",
    segments: ["result", "value", "fileContentAfterWrite"],
    budget: FIELD_BUDGETS.fileContentAfterWrite,
    flag: "result",
  },
  {
    path: "result.value.stderr",
    segments: ["result", "value", "stderr"],
    budget: FIELD_BUDGETS.stderr,
    flag: "result",
  },
  {
    path: "result.value.stdout",
    segments: ["result", "value", "stdout"],
    budget: FIELD_BUDGETS.stdout,
    flag: "result",
  },
  {
    path: "result.value.diffString",
    segments: ["result", "value", "diffString"],
    budget: FIELD_BUDGETS.diffString,
    flag: "result",
  },
  {
    path: "args.fileText",
    segments: ["args", "fileText"],
    budget: FIELD_BUDGETS.fileText,
    flag: "args",
  },
];

type JsonObject = Record<string, unknown>;

export type LcaFieldTrim = {
  path: string;
  originalLength: number;
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString("utf8");
}

function bluntEnvelope(
  eventType: string,
  payloadJson: string,
  originalBytes: number
): string {
  return JSON.stringify({
    _truncated: true,
    eventType,
    originalBytes,
    preview: payloadJson.slice(0, PREVIEW_CHARS),
  });
}

function resolveParent(
  root: JsonObject,
  segments: readonly string[]
): { parent: JsonObject; key: string } | null {
  if (segments.length === 0) return null;
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!isObject(current)) return null;
    current = current[segments[i]!];
  }
  if (!isObject(current)) return null;
  const key = segments[segments.length - 1]!;
  return { parent: current, key };
}

function trimMarker(path: string, originalLength: number): string {
  return `\n…[truncated by Max; path=${path}; originalLength=${originalLength}]`;
}

function applyStringTrim(
  value: string,
  budget: number,
  path: string
): { next: string; originalLength: number } | null {
  if (utf8Bytes(value) <= budget) return null;
  const originalLength = value.length;
  const marker = trimMarker(path, originalLength);
  const headBudget = Math.max(0, budget - utf8Bytes(marker));
  return {
    next: truncateToUtf8Bytes(value, headBudget) + marker,
    originalLength,
  };
}

function mergeTruncationFlag(root: JsonObject, flag: TruncationFlag): void {
  const existing = isObject(root.truncated) ? { ...root.truncated } : {};
  if (flag === "result") {
    existing.result = true;
  } else {
    existing.args = true;
  }
  root.truncated = existing;
}

function recordFieldTrim(root: JsonObject, trim: LcaFieldTrim): void {
  const prior = root._lcaFieldTrims;
  const list: LcaFieldTrim[] = Array.isArray(prior)
    ? prior.filter(
        (item): item is LcaFieldTrim =>
          isObject(item) &&
          typeof item.path === "string" &&
          typeof item.originalLength === "number"
      )
    : [];
  list.push(trim);
  root._lcaFieldTrims = list;
}

/**
 * Attempt field-aware trimming of a tool_call payload. Returns a serialized
 * payload that fits `maxBytes`, or null when trimming cannot help (caller
 * should use the blunt envelope).
 */
function tryFieldAwareTrim(
  payloadJson: string,
  maxBytes: number
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.type !== "tool_call") {
    return null;
  }

  const root = parsed;
  for (const target of TRIM_ORDER) {
    const resolved = resolveParent(root, target.segments);
    if (!resolved) continue;
    const current = resolved.parent[resolved.key];
    if (typeof current !== "string") continue;

    const trimmed = applyStringTrim(current, target.budget, target.path);
    if (!trimmed) continue;

    resolved.parent[resolved.key] = trimmed.next;
    recordFieldTrim(root, {
      path: target.path,
      originalLength: trimmed.originalLength,
    });
    mergeTruncationFlag(root, target.flag);

    const nextJson = JSON.stringify(root);
    if (utf8Bytes(nextJson) <= maxBytes) {
      return nextJson;
    }
  }

  const after = JSON.stringify(root);
  return utf8Bytes(after) <= maxBytes ? after : null;
}

/**
 * Cap an event payload to `maxBytes` UTF-8. Under-limit input is returned
 * unchanged (byte-identical). Oversized `tool_call` objects may be field-trimmed
 * first; everything else uses the blunt `_truncated` preview envelope.
 */
export function capEventPayload(
  eventType: string,
  payloadJson: string,
  maxBytes: number
): string {
  const bytes = utf8Bytes(payloadJson);
  if (bytes <= maxBytes) {
    return payloadJson;
  }

  const fieldTrimmed = tryFieldAwareTrim(payloadJson, maxBytes);
  if (fieldTrimmed !== null) {
    return fieldTrimmed;
  }

  return bluntEnvelope(eventType, payloadJson, bytes);
}
