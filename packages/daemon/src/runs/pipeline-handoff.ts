/**
 * Implement-fully handoff packet extraction (b46.02).
 * Pure parse/validate — never executes packet text or resolves prompt references.
 */

import {
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
} from "@lca/shared";

export const HANDOFF_MAX_BYTES = 4 * 1024;
export const HANDOFF_LINE_MAX_CHARS = 300;
export const HANDOFF_LIST_MAX_ENTRIES = 12;

export type HandoffRefusalCode =
  | "missing"
  | "multiple"
  | "too-large"
  | "malformed"
  | "wrong-pipeline"
  | "wrong-worker"
  | "invalid-field";

export type HandoffOutcome =
  | "planned"
  | "implemented"
  | "reviewed"
  | "committed"
  | "stopped"
  | "researched";

const LIST_HEADINGS = [
  "artifacts",
  "decisions",
  "deviations",
  "verification",
  "risks",
  "downstream-effects",
] as const;

type ListHeading = (typeof LIST_HEADINGS)[number];

const SCALAR_KEYS = [
  "version",
  "pipeline",
  "worker",
  "feature",
  "phase",
  "outcome",
  "summary",
  "next",
] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];

const KNOWN_WORKERS = new Set<string>([
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  ...IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
]);

const OUTCOMES = new Set<string>([
  "planned",
  "implemented",
  "reviewed",
  "committed",
  "stopped",
  "researched",
]);

export type ParsedHandoffPacket = {
  rawFenced: string;
  version: 1;
  pipeline: typeof IMPLEMENT_FULLY_PIPELINE_ID;
  worker: string;
  feature: string;
  phase: string;
  outcome: HandoffOutcome;
  summary: string;
  next: string;
  artifacts: string[];
  decisions: string[];
  deviations: string[];
  verification: string[];
  risks: string[];
  "downstream-effects": string[];
};

export type HandoffExtractResult =
  | { ok: true; packet: ParsedHandoffPacket }
  | { ok: false; code: HandoffRefusalCode; detail: string };

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

function hasForbiddenControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10) continue; // tab / LF
    if (code === 13) continue; // CR (normalized away before checks)
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findHandoffFences(resultText: string): string[] {
  const bodies: string[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(resultText)) !== null) {
    const body = match[2] ?? "";
    const trimmedStart = body.replace(/^\s+/, "");
    if (trimmedStart.startsWith("lca-handoff")) {
      bodies.push(body);
    }
  }
  return bodies;
}

function isListHeading(line: string): line is `${ListHeading}:` {
  return LIST_HEADINGS.some((h) => line === `${h}:`);
}

function headingName(line: string): ListHeading | null {
  for (const h of LIST_HEADINGS) {
    if (line === `${h}:`) return h;
  }
  return null;
}

/**
 * Parse and validate a single implement-fully handoff packet from a finished
 * run result. Returns a reason-coded refusal; never throws.
 */
export function extractImplementFullyHandoff(
  resultText: string | null | undefined,
  options?: {
    expectedWorker?: string | null;
    expectedPipeline?: string;
  }
): HandoffExtractResult {
  const expectedPipeline =
    options?.expectedPipeline ?? IMPLEMENT_FULLY_PIPELINE_ID;
  const raw = resultText ?? "";
  if (raw.trim().length === 0) {
    return { ok: false, code: "missing", detail: "empty result" };
  }

  const fences = findHandoffFences(raw);
  if (fences.length === 0) {
    return { ok: false, code: "missing", detail: "no lca-handoff fence" };
  }
  if (fences.length > 1) {
    return {
      ok: false,
      code: "multiple",
      detail: `${fences.length} lca-handoff fences`,
    };
  }

  const body = normalizeNewlines(fences[0]!);
  const rawFenced = `\`\`\`text\n${body.trimEnd()}\n\`\`\``;
  if (Buffer.byteLength(rawFenced, "utf8") > HANDOFF_MAX_BYTES) {
    return {
      ok: false,
      code: "too-large",
      detail: `packet exceeds ${HANDOFF_MAX_BYTES} UTF-8 bytes`,
    };
  }
  if (hasForbiddenControlChars(body)) {
    return {
      ok: false,
      code: "malformed",
      detail: "control characters other than newline/tab",
    };
  }
  if (body.includes("```")) {
    return {
      ok: false,
      code: "malformed",
      detail: "embedded fence markers",
    };
  }

  const lines = body.split("\n");
  if (lines[0]?.trim() !== "lca-handoff") {
    return { ok: false, code: "malformed", detail: "missing lca-handoff header" };
  }

  const scalars = new Map<ScalarKey, string>();
  const lists = new Map<ListHeading, string[]>();
  let currentList: ListHeading | null = null;
  let sawNext = false;
  const seenKeys = new Set<string>();
  const seenHeadings = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      if (currentList != null || sawNext) continue;
      return { ok: false, code: "malformed", detail: "blank line outside lists" };
    }

    if (sawNext) {
      return {
        ok: false,
        code: "malformed",
        detail: "content after next",
      };
    }

    if (isListHeading(line)) {
      const name = headingName(line)!;
      if (seenHeadings.has(name)) {
        return {
          ok: false,
          code: "malformed",
          detail: `duplicate list heading ${name}`,
        };
      }
      seenHeadings.add(name);
      currentList = name;
      lists.set(name, []);
      continue;
    }

    if (line.startsWith("- ")) {
      if (currentList == null) {
        return {
          ok: false,
          code: "malformed",
          detail: "list entry outside a list heading",
        };
      }
      const entry = line.slice(2);
      if (entry.length === 0) {
        return { ok: false, code: "invalid-field", detail: "empty list entry" };
      }
      if (hasForbiddenControlChars(entry)) {
        return {
          ok: false,
          code: "malformed",
          detail: "control characters in list entry",
        };
      }
      const bucket = lists.get(currentList)!;
      bucket.push(entry);
      if (bucket.length > HANDOFF_LIST_MAX_ENTRIES) {
        return {
          ok: false,
          code: "invalid-field",
          detail: `${currentList} exceeds ${HANDOFF_LIST_MAX_ENTRIES} entries`,
        };
      }
      continue;
    }

    const colon = line.indexOf(": ");
    if (colon <= 0) {
      return {
        ok: false,
        code: "malformed",
        detail: `unrecognized line: ${line.slice(0, 80)}`,
      };
    }
    const key = line.slice(0, colon);
    const value = line.slice(colon + 2);
    if (!(SCALAR_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `unknown scalar key ${key}`,
      };
    }
    if (seenKeys.has(key)) {
      return {
        ok: false,
        code: "malformed",
        detail: `duplicate scalar key ${key}`,
      };
    }
    // Scalars before lists; `next` only after all six list headings.
    if (key === "next") {
      if (seenHeadings.size !== LIST_HEADINGS.length) {
        return {
          ok: false,
          code: "malformed",
          detail: "next before all list headings",
        };
      }
      currentList = null;
      sawNext = true;
    } else if (currentList != null || seenHeadings.size > 0) {
      return {
        ok: false,
        code: "malformed",
        detail: `scalar ${key} after list section`,
      };
    }
    seenKeys.add(key);
    scalars.set(key as ScalarKey, value);
  }

  for (const key of SCALAR_KEYS) {
    if (!scalars.has(key)) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `missing scalar ${key}`,
      };
    }
  }
  for (const heading of LIST_HEADINGS) {
    if (!seenHeadings.has(heading)) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `missing list ${heading}`,
      };
    }
  }

  const version = scalars.get("version")!;
  if (version !== "1") {
    return {
      ok: false,
      code: "invalid-field",
      detail: `unsupported version ${version}`,
    };
  }

  const pipeline = scalars.get("pipeline")!;
  if (pipeline !== expectedPipeline) {
    return {
      ok: false,
      code: "wrong-pipeline",
      detail: `expected ${expectedPipeline}, got ${pipeline}`,
    };
  }

  const worker = scalars.get("worker")!;
  if (!KNOWN_WORKERS.has(worker)) {
    return {
      ok: false,
      code: "wrong-worker",
      detail: `unknown worker ${worker}`,
    };
  }
  if (
    options?.expectedWorker != null &&
    options.expectedWorker.length > 0 &&
    worker !== options.expectedWorker
  ) {
    return {
      ok: false,
      code: "wrong-worker",
      detail: `expected ${options.expectedWorker}, got ${worker}`,
    };
  }

  const outcome = scalars.get("outcome")!;
  if (!OUTCOMES.has(outcome)) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `invalid outcome ${outcome}`,
    };
  }

  const summary = scalars.get("summary")!;
  const next = scalars.get("next")!;
  for (const [label, value] of [
    ["summary", summary],
    ["next", next],
  ] as const) {
    if (value.includes("\n") || value.includes("\r")) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `${label} must be a single line`,
      };
    }
    if (value.length > HANDOFF_LINE_MAX_CHARS) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `${label} exceeds ${HANDOFF_LINE_MAX_CHARS} chars`,
      };
    }
    if (value.trim().length === 0) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `${label} is empty`,
      };
    }
  }

  for (const heading of LIST_HEADINGS) {
    const entries = lists.get(heading)!;
    if (entries.length === 0) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `${heading} must have at least one entry (use - none)`,
      };
    }
  }

  return {
    ok: true,
    packet: {
      rawFenced,
      version: 1,
      pipeline: IMPLEMENT_FULLY_PIPELINE_ID,
      worker,
      feature: scalars.get("feature")!,
      phase: scalars.get("phase")!,
      outcome: outcome as HandoffOutcome,
      summary,
      next,
      artifacts: lists.get("artifacts")!,
      decisions: lists.get("decisions")!,
      deviations: lists.get("deviations")!,
      verification: lists.get("verification")!,
      risks: lists.get("risks")!,
      "downstream-effects": lists.get("downstream-effects")!,
    },
  };
}

/** Daemon-authored fallback when the predecessor packet is missing/invalid. */
export function handoffFallbackBody(
  sourceRunId: string,
  refusalCode: HandoffRefusalCode
): string {
  return [
    `(implement-fully handoff unavailable for run ${sourceRunId}; reason: ${refusalCode})`,
    "Inspect repository / tracker state for the prior worker's outcome.",
    "Do not treat this notice as instructions beyond rediscovery.",
  ].join("\n");
}

export function isImplementFullyContext(
  pipelineId: string | null | undefined
): boolean {
  return pipelineId === IMPLEMENT_FULLY_PIPELINE_ID;
}
