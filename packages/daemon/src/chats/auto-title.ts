import { Agent } from "@cursor/sdk";
import { DEFAULT_AUTOMATION_MODEL } from "@lca/shared";

const MAX_TITLE_CHARS = 56;

const GENERIC_GREETINGS = new Set([
  "hi",
  "hello",
  "hey",
  "help",
  "thanks",
  "thank you",
  "yo",
  "sup",
  "ok",
  "okay",
  "test",
  "testing",
]);

/** Strip light markdown / collapse whitespace / truncate on a word boundary. */
export function deriveHeuristicTitle(input: {
  text?: string | null;
  attachmentNames?: string[];
}): string | null {
  const raw = (input.text ?? "").trim();
  let candidate = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!candidate) {
    const names = (input.attachmentNames ?? [])
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.length === 0) return null;
    candidate = names.length === 1 ? names[0]! : `Attachments: ${names.join(", ")}`;
  }

  return truncateTitle(candidate);
}

export function shouldRefineWithLlm(heuristic: string | null): boolean {
  if (!heuristic) return true;
  const normalized = heuristic.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 8) return true;
  if (GENERIC_GREETINGS.has(normalized)) return true;
  // Single-token greetings with punctuation
  const bare = normalized.replace(/[!?.]+$/g, "");
  return GENERIC_GREETINGS.has(bare);
}

export type RefineTitleParams = {
  apiKey: string;
  cwd: string;
  heuristic: string | null;
  firstMessageText: string | null;
  attachmentNames?: string[];
  modelId?: string;
};

/**
 * One-shot title refine via Agent.prompt. Never throws — returns null on failure
 * so the caller keeps the heuristic. Uses settingSources: [] and no MCP.
 */
export async function refineTitleWithLlm(
  params: RefineTitleParams
): Promise<string | null> {
  const contextBits = [
    params.firstMessageText?.trim()
      ? `First user message:\n${params.firstMessageText.trim().slice(0, 800)}`
      : null,
    params.attachmentNames?.length
      ? `Attachments: ${params.attachmentNames.join(", ")}`
      : null,
    params.heuristic ? `Heuristic title: ${params.heuristic}` : null,
  ].filter(Boolean);

  if (contextBits.length === 0) return null;

  const prompt = [
    "Propose a short chat title (max ~8 words) for this conversation.",
    "Return ONLY the title text — no quotes, no markdown, no explanation.",
    "",
    ...contextBits,
  ].join("\n");

  try {
    const result = await Agent.prompt(prompt, {
      apiKey: params.apiKey,
      model: { id: params.modelId ?? DEFAULT_AUTOMATION_MODEL },
      local: {
        cwd: params.cwd,
        settingSources: [],
      },
    });
    const raw =
      typeof result.result === "string"
        ? result.result
        : result.result != null
          ? String(result.result)
          : "";
    const cleaned = raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!cleaned) return null;
    const stripped = cleaned
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^Title:\s*/i, "")
      .trim();
    return truncateTitle(stripped);
  } catch {
    return null;
  }
}

function truncateTitle(text: string): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed;

  const slice = collapsed.slice(0, MAX_TITLE_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[.,;:!?-]+$/g, "").trim() || slice.trim();
}
