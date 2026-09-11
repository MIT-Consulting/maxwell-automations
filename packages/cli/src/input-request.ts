import type { InputRequest } from "@lca/shared";

/**
 * Pure formatter for a pending Input Hub request. Structured requests show
 * choice ids (what the daemon accepts), the recommendation, and artifacts;
 * free-form requests return the question alone.
 */
export function formatInputRequest(request: InputRequest): string {
  const choices = request.metadata?.choices;
  if (!choices || choices.length === 0) {
    return request.question;
  }

  const lines: string[] = [request.question];
  const recommended = request.metadata?.recommendedChoiceId;
  for (const choice of choices) {
    const marker = recommended === choice.id ? " (recommended)" : "";
    let line = `  ${choice.id}${marker} — ${choice.label}`;
    if (choice.description) {
      line += ` — ${choice.description}`;
    }
    lines.push(line);
  }

  const artifacts = request.metadata?.artifacts;
  if (artifacts && artifacts.length > 0) {
    for (const artifact of artifacts) {
      lines.push(`  ${artifact.label}: ${artifact.path}`);
    }
  }

  lines.push(
    `Answer with one of: ${choices.map((c) => c.id).join(", ")}`
  );
  return lines.join("\n");
}
