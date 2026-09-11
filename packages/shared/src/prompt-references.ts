export type PromptReferenceKind = "rule" | "skill";

export type PromptReference = {
  kind: PromptReferenceKind;
  name: string;
  raw: string;
  index: number;
  length: number;
};

const NAME_RE = /^[A-Za-z0-9._-]$/;
const START_BOUNDARY_RE = /[\s([{]/;
const TRAILING_PUNCTUATION_RE = /[.,]+$/;

function isNameChar(char: string | undefined): boolean {
  return Boolean(char && NAME_RE.test(char));
}

function canStartToken(prompt: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return START_BOUNDARY_RE.test(prompt[index - 1] ?? "");
}

function fencedCodeMask(prompt: string): boolean[] {
  const mask = Array.from({ length: prompt.length }, () => false);
  let inFence = false;
  let lineStart = 0;

  for (let i = 0; i <= prompt.length; i += 1) {
    const atLineEnd = i === prompt.length || prompt[i] === "\n";
    if (!atLineEnd) {
      continue;
    }

    const line = prompt.slice(lineStart, i);
    const trimmedStart = line.match(/^\s*/)?.[0].length ?? 0;
    const fenceIndex = lineStart + trimmedStart;
    const togglesFence = prompt.startsWith("```", fenceIndex);

    if (inFence) {
      for (let j = lineStart; j < Math.min(i + 1, prompt.length); j += 1) {
        mask[j] = true;
      }
    }

    if (togglesFence) {
      if (!inFence) {
        for (let j = lineStart; j < Math.min(i + 1, prompt.length); j += 1) {
          mask[j] = true;
        }
      }
      inFence = !inFence;
    }

    lineStart = i + 1;
  }

  return mask;
}

function readName(
  prompt: string,
  index: number
): { name: string; end: number } | null {
  let end = index;
  while (isNameChar(prompt[end])) {
    end += 1;
  }

  const name = prompt.slice(index, end).replace(TRAILING_PUNCTUATION_RE, "");
  if (!name) {
    return null;
  }

  const trimmedEnd = index + name.length;
  return { name, end: trimmedEnd };
}

export function parsePromptReferences(prompt: string): PromptReference[] {
  try {
    if (typeof prompt !== "string" || !prompt) {
      return [];
    }

    const codeMask = fencedCodeMask(prompt);
    const references: PromptReference[] = [];

    for (let i = 0; i < prompt.length; i += 1) {
      if (codeMask[i] || !canStartToken(prompt, i)) {
        continue;
      }

      const char = prompt[i];
      if (char === "@") {
        const longMatch = prompt.startsWith("@rule:", i)
          ? { kind: "rule" as const, prefix: "@rule:" }
          : prompt.startsWith("@skill:", i)
            ? { kind: "skill" as const, prefix: "@skill:" }
            : null;

        if (longMatch) {
          const parsed = readName(prompt, i + longMatch.prefix.length);
          if (parsed) {
            const raw = prompt.slice(i, parsed.end);
            references.push({
              kind: longMatch.kind,
              name: parsed.name,
              raw,
              index: i,
              length: raw.length,
            });
            i = parsed.end - 1;
          }
          continue;
        }

        const parsed = readName(prompt, i + 1);
        if (parsed) {
          const raw = prompt.slice(i, parsed.end);
          references.push({
            kind: "rule",
            name: parsed.name,
            raw,
            index: i,
            length: raw.length,
          });
          i = parsed.end - 1;
        }
        continue;
      }

      if (char === "/") {
        const parsed = readName(prompt, i + 1);
        if (parsed) {
          const raw = prompt.slice(i, parsed.end);
          references.push({
            kind: "skill",
            name: parsed.name,
            raw,
            index: i,
            length: raw.length,
          });
          i = parsed.end - 1;
        }
      }
    }

    return references;
  } catch {
    return [];
  }
}
