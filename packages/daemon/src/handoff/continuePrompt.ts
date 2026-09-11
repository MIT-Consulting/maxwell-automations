import type { HandoffMessage } from "@lca/shared";

export const MAX_PRIMER_TRANSCRIPT_CHARS = 24_000;

type PrimerInput = {
  transcript: HandoffMessage[];
  newMessage: string;
};

function render(message: HandoffMessage): string {
  const label =
    message.role === "user"
      ? "User"
      : message.role === "assistant"
        ? "Assistant"
        : message.role === "tool"
          ? `Tool${message.toolName ? ` (${message.toolName})` : ""}`
          : "System";
  return `${label}: ${message.text}`;
}

function fitHeadTail(lines: string[]): { lines: string[]; truncated: boolean } {
  const full = lines.join("\n");
  if (full.length <= MAX_PRIMER_TRANSCRIPT_CHARS) {
    return { lines, truncated: false };
  }

  const marker = "[… older context condensed …]";
  const tailBudget = Math.ceil(MAX_PRIMER_TRANSCRIPT_CHARS / 2);
  const headBudget =
    MAX_PRIMER_TRANSCRIPT_CHARS - tailBudget - marker.length - 2;
  const tail: string[] = [];
  let tailLength = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = lines[i].length + (tail.length > 0 ? 1 : 0);
    if (tailLength + next > tailBudget) break;
    tail.unshift(lines[i]);
    tailLength += next;
  }
  const head: string[] = [];
  let headLength = 0;
  for (const line of lines) {
    const next = line.length + (head.length > 0 ? 1 : 0);
    if (headLength + next > headBudget) break;
    head.push(line);
    headLength += next;
  }
  return {
    lines: [...head, marker, ...tail],
    truncated: true,
  };
}

export function buildRevivePrimer(input: PrimerInput): {
  text: string;
  transcriptMessages: number;
  truncated: boolean;
} {
  const rendered = input.transcript.map(render);
  const fitted = fitHeadTail(rendered);
  const transcript = fitted.lines.join("\n");
  const text = [
    "You are continuing a prior conversation whose agent session was lost.",
    "Continue seamlessly from the transcript below. Do not re-introduce yourself or redo completed work.",
    "Prior conversation:",
    transcript || "(no prior transcript)",
    "The operator's new message is:",
    input.newMessage,
  ].join("\n\n");
  return {
    text,
    transcriptMessages: fitted.truncated
      ? fitted.lines.filter((line) => line !== "[… older context condensed …]").length
      : input.transcript.length,
    truncated: fitted.truncated,
  };
}
