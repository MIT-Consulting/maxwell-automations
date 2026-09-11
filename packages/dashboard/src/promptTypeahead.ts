import type { WorkspaceArtifact } from "./api";

export type PromptToken = {
  trigger: "@" | "/";
  kind: WorkspaceArtifact["kind"];
  query: string;
  tokenStart: number;
  tokenEnd: number;
};

const NAME_CHAR_RE = /^[A-Za-z0-9._-]$/;
const START_BOUNDARY_RE = /[\s([{]/;

function isNameChar(char: string | undefined): boolean {
  return Boolean(char && NAME_CHAR_RE.test(char));
}

function isInsideFencedCode(value: string, caret: number): boolean {
  let inFence = false;
  for (const line of value.slice(0, caret).split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
    }
  }
  return inFence;
}

export function detectPromptToken(
  value: string,
  selectionStart: number,
  selectionEnd: number
): PromptToken | null {
  if (selectionStart !== selectionEnd || isInsideFencedCode(value, selectionStart)) {
    return null;
  }

  let nameStart = selectionStart;
  while (nameStart > 0 && isNameChar(value[nameStart - 1])) {
    nameStart -= 1;
  }

  const tokenStart = nameStart - 1;
  if (tokenStart < 0) {
    return null;
  }

  const trigger = value[tokenStart];
  if (trigger !== "@" && trigger !== "/") {
    return null;
  }

  if (tokenStart > 0 && !START_BOUNDARY_RE.test(value[tokenStart - 1] ?? "")) {
    return null;
  }

  return {
    trigger,
    kind: trigger === "@" ? "rule" : "skill",
    query: value.slice(nameStart, selectionStart),
    tokenStart,
    tokenEnd: selectionStart,
  };
}

export function artifactMatchesQuery(
  artifact: WorkspaceArtifact,
  query: string
): boolean {
  const normalized = query.toLowerCase();
  if (!normalized) {
    return true;
  }

  if (artifact.name.toLowerCase().includes(normalized)) {
    return true;
  }

  return Boolean(
    artifact.kind === "skill" &&
      artifact.keywords?.some((keyword) =>
        keyword.toLowerCase().includes(normalized)
      )
  );
}

export function artifactReference(
  artifact: WorkspaceArtifact,
  artifacts: WorkspaceArtifact[]
): string {
  const collides = artifacts.some(
    (other) => other.kind !== artifact.kind && other.name === artifact.name
  );
  if (collides) {
    return artifact.kind === "rule"
      ? `@rule:${artifact.name}`
      : `@skill:${artifact.name}`;
  }
  return artifact.kind === "rule" ? `@${artifact.name}` : `/${artifact.name}`;
}

export function getPromptArtifactSuggestions(
  artifacts: WorkspaceArtifact[],
  token: PromptToken
): WorkspaceArtifact[] {
  return artifacts
    .filter((artifact) => artifact.kind === token.kind)
    .filter((artifact) => artifactMatchesQuery(artifact, token.query))
    .sort((a, b) => {
      if (a.source !== b.source) {
        return a.source === "project" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}
