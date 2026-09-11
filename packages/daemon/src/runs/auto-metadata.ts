import { Agent } from "@cursor/sdk";
import { DEFAULT_AUTOMATION_MODEL } from "@lca/shared";
import type { ParsedHandoffPacket } from "./pipeline-handoff.js";

const MAX_EVIDENCE_CHARS = 4000;
const MAX_TITLE_CHARS = 56;
const MAX_SUMMARY_CHARS = 180;

export type GeneratedRunMetadata = {
  title: string;
  summary: string;
};

export type GenerateRunMetadataParams = {
  apiKey: string;
  cwd: string;
  automationName: string;
  status: "completed" | "failed";
  prompt: string | null;
  /** Bounded outcome evidence (finished result or error text). */
  outcomeEvidence: string | null;
};

export type ImplementFullyMetadataParams = {
  workerKey: string;
  featureId: string | null;
  status: "completed" | "failed";
  /** Validated handoff when available; ignored for failed/missing paths. */
  packet: ParsedHandoffPacket | null;
  /** Short error/stop hint for failed runs. */
  errorHint?: string | null;
};

function boundEvidence(label: string, value: string | null): string {
  const raw = (value ?? "").trim();
  if (!raw) return `(no ${label})`;
  if (raw.length <= MAX_EVIDENCE_CHARS) return raw;
  return `${raw.slice(0, MAX_EVIDENCE_CHARS)}\n…[truncated ${label}; original ${raw.length} chars]`;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function collapseOneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateAtWordBoundary(text: string, maxChars: number): string | null {
  const collapsed = collapseOneLine(text);
  if (!collapsed) return null;
  if (collapsed.length <= maxChars) return collapsed;

  const slice = collapsed.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[.,;:!?-]+$/g, "").trim() || slice.trim();
}

function parseMetadataJson(raw: string): GeneratedRunMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { title?: unknown; summary?: unknown };
  if (typeof obj.title !== "string" || typeof obj.summary !== "string") {
    return null;
  }
  const title = truncateAtWordBoundary(obj.title, MAX_TITLE_CHARS);
  const summary = truncateAtWordBoundary(obj.summary, MAX_SUMMARY_CHARS);
  if (!title || !summary) return null;
  return { title, summary };
}

/**
 * Deterministic title/summary for context-aware implement-fully workers.
 * Never calls the model. Always returns capped metadata.
 */
export function buildImplementFullyRunMetadata(
  params: ImplementFullyMetadataParams
): GeneratedRunMetadata {
  const feature = (params.featureId ?? "feature").trim() || "feature";
  const phase =
    params.packet?.phase && params.packet.phase !== "-"
      ? params.packet.phase
      : null;

  let titleBase =
    phase != null
      ? `${params.workerKey} · ${feature} · ${phase}`
      : `${params.workerKey} · ${feature}`;
  if (params.status === "failed") {
    titleBase = `Failed: ${titleBase}`;
  }
  const title =
    truncateAtWordBoundary(titleBase, MAX_TITLE_CHARS) ??
    titleBase.slice(0, MAX_TITLE_CHARS);

  let summaryRaw: string;
  if (params.status === "failed") {
    const hint = (params.errorHint ?? "").trim();
    summaryRaw = hint
      ? `${params.workerKey} failed: ${hint}`
      : `${params.workerKey} failed`;
  } else if (params.packet?.summary) {
    summaryRaw = params.packet.summary;
  } else {
    summaryRaw = `${params.workerKey} finished without a valid handoff packet`;
  }
  const summary =
    truncateAtWordBoundary(summaryRaw, MAX_SUMMARY_CHARS) ??
    summaryRaw.slice(0, MAX_SUMMARY_CHARS);

  return { title, summary };
}

/**
 * One-shot run title+summary via Agent.prompt. Never throws — returns null on
 * any failure so settlement stays unaffected. Uses settingSources: ["all"].
 */
export async function generateRunMetadata(
  params: GenerateRunMetadataParams
): Promise<GeneratedRunMetadata | null> {
  const outcomeKind =
    params.status === "completed"
      ? "successful outcome summary (what the run accomplished)"
      : "failure explanation (what went wrong and why)";

  const prompt = [
    "You are naming a finished local automation run. This task is READ-ONLY.",
    "Do not use tools, edit files, run commands, or explore the workspace.",
    "Return ONLY one JSON object with keys \"title\" and \"summary\".",
    "No markdown outside a single optional JSON fence. No other keys.",
    "",
    `Automation name: ${params.automationName}`,
    `Terminal status: ${params.status}`,
    `Title: short, run-specific identity (max ~8 words / ${MAX_TITLE_CHARS} chars).`,
    `Summary: concise ${outcomeKind} (max ~${MAX_SUMMARY_CHARS} chars).`,
    "",
    "Stored prompt:",
    boundEvidence("prompt", params.prompt),
    "",
    "Outcome evidence:",
    boundEvidence("outcome", params.outcomeEvidence),
  ].join("\n");

  try {
    const result = await Agent.prompt(prompt, {
      apiKey: params.apiKey,
      model: { id: DEFAULT_AUTOMATION_MODEL },
      local: {
        cwd: params.cwd,
        settingSources: ["all"],
      },
    });
    if (result.status !== "finished") return null;
    if (typeof result.result !== "string") return null;
    return parseMetadataJson(result.result);
  } catch {
    return null;
  }
}
