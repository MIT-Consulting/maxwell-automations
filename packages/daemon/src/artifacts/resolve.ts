import {
  parsePromptReferences,
  type PromptReference,
  type WorkspaceArtifact,
} from "@lca/shared";

export type ResolvedPromptReferences = {
  prompt: string;
  resolved: PromptReference[];
  unknown: PromptReference[];
};

function findArtifact(
  reference: PromptReference,
  artifacts: WorkspaceArtifact[]
): WorkspaceArtifact | undefined {
  const matches = artifacts.filter(
    (artifact) =>
      artifact.kind === reference.kind && artifact.name === reference.name
  );
  return (
    matches.find((artifact) => artifact.source === "project") ??
    matches.find((artifact) => artifact.source === "user")
  );
}

function instructionForArtifact(artifact: WorkspaceArtifact): string {
  if (artifact.kind === "rule") {
    return `Apply the \`${artifact.name}\` rule (${artifact.relativePath})`;
  }
  return `Use the \`${artifact.name}\` skill (${artifact.relativePath})`;
}

export function resolvePromptReferences(
  prompt: string,
  artifacts: WorkspaceArtifact[]
): ResolvedPromptReferences {
  const references = parsePromptReferences(prompt);
  if (references.length === 0) {
    return { prompt, resolved: [], unknown: [] };
  }

  const resolved: PromptReference[] = [];
  const unknown: PromptReference[] = [];
  let nextIndex = 0;
  let expanded = "";

  for (const reference of references) {
    const artifact = findArtifact(reference, artifacts);
    expanded += prompt.slice(nextIndex, reference.index);
    if (artifact) {
      resolved.push(reference);
      expanded += instructionForArtifact(artifact);
    } else {
      unknown.push(reference);
      expanded += prompt.slice(reference.index, reference.index + reference.length);
    }
    nextIndex = reference.index + reference.length;
  }

  expanded += prompt.slice(nextIndex);
  return { prompt: expanded, resolved, unknown };
}
