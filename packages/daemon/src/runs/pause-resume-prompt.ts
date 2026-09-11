import type { ChainRunContext } from "@lca/shared";

/**
 * Daemon-owned resume instruction after an operator pause. Pure — no store access.
 */
export function buildPauseResumePrompt(args: {
  chainContext: ChainRunContext | null;
}): string {
  const lines = [
    "Resume the automation goal you were given before the pause.",
    "Treat the operator conversation since the pause as steering that overrides earlier assumptions where they conflict.",
    "Continue without waiting for further confirmation.",
  ];

  const vars = args.chainContext?.variables;
  if (vars) {
    const contextLines: string[] = [];
    if (typeof vars.featureId === "string" && vars.featureId.trim()) {
      contextLines.push(`Feature id: ${vars.featureId.trim()}`);
    }
    if (typeof vars.featureSlug === "string" && vars.featureSlug.trim()) {
      contextLines.push(`Feature slug: ${vars.featureSlug.trim()}`);
    }
    if (typeof vars.pipelineId === "string" && vars.pipelineId.trim()) {
      contextLines.push(`Pipeline: ${vars.pipelineId.trim()}`);
    }
    if (typeof vars.workerRole === "string" && vars.workerRole.trim()) {
      contextLines.push(`Worker role: ${vars.workerRole.trim()}`);
    }
    if (contextLines.length > 0) {
      lines.push("", "Pipeline context:", ...contextLines);
    }
  }

  return lines.join("\n");
}
