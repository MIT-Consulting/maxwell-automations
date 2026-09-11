/**
 * Halt-discovery briefing packet parse + Input Hub card construction (b44.03).
 * Pure parse/validate/build — never executes packet text or mutates runs.
 */

import {
  HALT_DISCOVERY_INPUT_KIND,
  INPUT_QUESTION_MAX_LENGTH,
  RUN_ESCALATION_ACTIONS,
  inputRequestMetadataSchema,
  type InputChoice,
  type InputRequestMetadata,
  type RunEscalationAction,
} from "@lca/shared";

export const HALT_DISCOVERY_PACKET_MAX_BYTES = 4 * 1024;
export const HALT_DISCOVERY_LINE_MAX_CHARS = 400;
export const HALT_DISCOVERY_LIST_MAX_ENTRIES = 12;

const PACKET_HEADER = "lca-halt-discovery";

const PARTIAL_WORK_VALUES = ["none", "partial", "complete-unknown"] as const;
const CONFIDENCE_VALUES = ["low", "medium", "high"] as const;
const RECOMMENDATION_VALUES = ["retry", "skip", "abort", "chat"] as const;

type PartialWork = (typeof PARTIAL_WORK_VALUES)[number];
type Confidence = (typeof CONFIDENCE_VALUES)[number];
type Recommendation = (typeof RECOMMENDATION_VALUES)[number];

const SCALAR_KEYS = [
  "version",
  "summary",
  "likely-cause",
  "partial-work",
  "recommendation",
  "confidence",
  "operator-notes",
] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];

const LIST_HEADINGS = ["evidence", "alternatives"] as const;
type ListHeading = (typeof LIST_HEADINGS)[number];

export type HaltDiscoveryBriefingRefusalCode =
  | "missing"
  | "multiple"
  | "too-large"
  | "malformed"
  | "invalid-field"
  | "question-overflow";

export type ParsedHaltDiscoveryPacket = {
  rawFenced: string;
  version: 1;
  summary: string;
  "likely-cause": string;
  "partial-work": PartialWork;
  evidence: string[];
  recommendation: Recommendation;
  alternatives: string[];
  confidence: Confidence;
  "operator-notes": string;
};

export type HaltDiscoveryExtractResult =
  | { ok: true; packet: ParsedHaltDiscoveryPacket }
  | {
      ok: false;
      code: HaltDiscoveryBriefingRefusalCode;
      detail: string;
    };

export type EscalationEligibility = Record<RunEscalationAction, boolean>;

export type HaltDiscoveryBriefingCard = {
  question: string;
  metadata: InputRequestMetadata;
};

export type HaltDiscoveryBriefingBuildResult =
  | { ok: true; card: HaltDiscoveryBriefingCard }
  | {
      ok: false;
      code: HaltDiscoveryBriefingRefusalCode;
      detail: string;
    };

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

const ACTION_LABELS: Record<RunEscalationAction, string> = {
  retry: "Retry",
  skip: "Skip",
  abort: "Abort",
};

const ACTION_DESCRIPTIONS: Record<RunEscalationAction, string> = {
  retry: "Retry the halted pipeline step (operator escalate).",
  skip: "Skip the halted step and continue (operator escalate).",
  abort: "Abort the pipeline at the halted source (operator escalate).",
};

function hasForbiddenControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findPacketFences(resultText: string): string[] {
  const bodies: string[] = [];
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(resultText)) !== null) {
    const body = match[2] ?? "";
    const trimmedStart = body.replace(/^\s+/, "");
    if (trimmedStart.startsWith(PACKET_HEADER)) {
      bodies.push(body);
    }
  }
  return bodies;
}

function isListHeading(line: string): boolean {
  return LIST_HEADINGS.some((h) => line === `${h}:`);
}

function headingName(line: string): ListHeading | null {
  for (const h of LIST_HEADINGS) {
    if (line === `${h}:`) return h;
  }
  return null;
}

function isSingleLine(value: string): boolean {
  return !value.includes("\n") && !value.includes("\r");
}

function validateLineBound(
  label: string,
  value: string
): HaltDiscoveryExtractResult | null {
  if (!isSingleLine(value)) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `${label} must be a single line`,
    };
  }
  if (value.trim().length === 0) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `${label} is empty`,
    };
  }
  if (value.length > HALT_DISCOVERY_LINE_MAX_CHARS) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `${label} exceeds ${HALT_DISCOVERY_LINE_MAX_CHARS} chars`,
    };
  }
  if (hasForbiddenControlChars(value)) {
    return {
      ok: false,
      code: "malformed",
      detail: `control characters in ${label}`,
    };
  }
  return null;
}

/**
 * Parse and validate a single halt-discovery packet from diagnosis result text.
 * Returns a reason-coded refusal; never throws.
 */
export function extractHaltDiscoveryBriefing(
  resultText: string | null | undefined
): HaltDiscoveryExtractResult {
  const raw = resultText ?? "";
  if (raw.trim().length === 0) {
    return { ok: false, code: "missing", detail: "empty result" };
  }

  const fences = findPacketFences(raw);
  if (fences.length === 0) {
    return {
      ok: false,
      code: "missing",
      detail: `no ${PACKET_HEADER} fence`,
    };
  }
  if (fences.length > 1) {
    return {
      ok: false,
      code: "multiple",
      detail: `${fences.length} ${PACKET_HEADER} fences`,
    };
  }

  const body = normalizeNewlines(fences[0]!).trimEnd();
  const rawFenced = `\`\`\`text\n${body}\n\`\`\``;
  if (Buffer.byteLength(rawFenced, "utf8") > HALT_DISCOVERY_PACKET_MAX_BYTES) {
    return {
      ok: false,
      code: "too-large",
      detail: `packet exceeds ${HALT_DISCOVERY_PACKET_MAX_BYTES} UTF-8 bytes`,
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
  if (lines[0]?.trim() !== PACKET_HEADER) {
    return {
      ok: false,
      code: "malformed",
      detail: `missing ${PACKET_HEADER} header`,
    };
  }

  const scalars = new Map<ScalarKey, string>();
  const lists = new Map<ListHeading, string[]>();
  let currentList: ListHeading | null = null;
  const seenKeys = new Set<string>();
  const seenHeadings = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      // Blank lines only allowed while inside a list section.
      if (currentList != null) continue;
      return {
        ok: false,
        code: "malformed",
        detail: "blank line outside lists",
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
      const bound = validateLineBound(`${currentList} entry`, entry);
      if (bound) return bound;
      const bucket = lists.get(currentList)!;
      bucket.push(entry);
      if (bucket.length > HALT_DISCOVERY_LIST_MAX_ENTRIES) {
        return {
          ok: false,
          code: "invalid-field",
          detail: `${currentList} exceeds ${HALT_DISCOVERY_LIST_MAX_ENTRIES} entries`,
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
    currentList = null;
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
    const entries = lists.get(heading)!;
    if (entries.length === 0) {
      return {
        ok: false,
        code: "invalid-field",
        detail: `${heading} must have at least one entry (use - none)`,
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

  for (const key of [
    "summary",
    "likely-cause",
    "partial-work",
    "recommendation",
    "confidence",
    "operator-notes",
  ] as const) {
    const bound = validateLineBound(key, scalars.get(key)!);
    if (bound) return bound;
  }

  const partialWork = scalars.get("partial-work")!;
  if (!(PARTIAL_WORK_VALUES as readonly string[]).includes(partialWork)) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `invalid partial-work ${partialWork}`,
    };
  }

  const recommendation = scalars.get("recommendation")!;
  if (!(RECOMMENDATION_VALUES as readonly string[]).includes(recommendation)) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `invalid recommendation ${recommendation}`,
    };
  }

  const confidence = scalars.get("confidence")!;
  if (!(CONFIDENCE_VALUES as readonly string[]).includes(confidence)) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `invalid confidence ${confidence}`,
    };
  }

  return {
    ok: true,
    packet: {
      rawFenced,
      version: 1,
      summary: scalars.get("summary")!,
      "likely-cause": scalars.get("likely-cause")!,
      "partial-work": partialWork as PartialWork,
      evidence: lists.get("evidence")!,
      recommendation: recommendation as Recommendation,
      alternatives: lists.get("alternatives")!,
      confidence: confidence as Confidence,
      "operator-notes": scalars.get("operator-notes")!,
    },
  };
}

function renderList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderQuestion(packet: ParsedHaltDiscoveryPacket): string {
  const lines = [
    "## Halt discovery briefing",
    "",
    "### Summary",
    packet.summary,
    "",
    "### Likely cause",
    packet["likely-cause"],
    "",
    "### Partial work",
    packet["partial-work"],
    "",
    "### Evidence",
    renderList(packet.evidence),
    "",
    "### Recommendation",
    packet.recommendation,
  ];

  if (packet.recommendation === "chat") {
    lines.push(
      "",
      "_No escalation action is recommended from this card. Continue diagnosis via chat promotion._"
    );
  }

  lines.push(
    "",
    "### Alternatives",
    renderList(packet.alternatives),
    "",
    "### Confidence",
    packet.confidence,
    "",
    "### Operator notes",
    packet["operator-notes"]
  );

  return lines.join("\n");
}

function buildChoices(eligibility: EscalationEligibility): InputChoice[] {
  const choices: InputChoice[] = [];
  for (const action of RUN_ESCALATION_ACTIONS) {
    if (!eligibility[action]) continue;
    choices.push({
      id: action,
      label: ACTION_LABELS[action],
      description: ACTION_DESCRIPTIONS[action],
    });
  }
  return choices;
}

/**
 * Pure builder: validated packet + eligibility → generic Input Hub card.
 * Never claims or mutates the source run.
 */
export function buildHaltDiscoveryBriefing(
  packet: ParsedHaltDiscoveryPacket,
  eligibility: EscalationEligibility
): HaltDiscoveryBriefingBuildResult {
  const question = renderQuestion(packet);
  if (question.length > INPUT_QUESTION_MAX_LENGTH) {
    return {
      ok: false,
      code: "question-overflow",
      detail: `question exceeds ${INPUT_QUESTION_MAX_LENGTH} chars`,
    };
  }

  const choices = buildChoices(eligibility);
  const metadata: InputRequestMetadata = {
    kind: HALT_DISCOVERY_INPUT_KIND,
  };
  if (choices.length > 0) {
    metadata.choices = choices;
  }

  const rec = packet.recommendation;
  if (
    (RUN_ESCALATION_ACTIONS as readonly string[]).includes(rec) &&
    eligibility[rec as RunEscalationAction]
  ) {
    metadata.recommendedChoiceId = rec;
  }

  const check = inputRequestMetadataSchema.safeParse(metadata);
  if (!check.success) {
    return {
      ok: false,
      code: "invalid-field",
      detail: `metadata schema: ${check.error.issues[0]?.message ?? "invalid"}`,
    };
  }

  return {
    ok: true,
    card: {
      question,
      metadata: check.data,
    },
  };
}
