import {
  CHAIN_KEY_MAX_LENGTH,
  CHAIN_RENDERED_PROMPT_MAX_BYTES,
  isDangerousChainKey,
  type ChainVariables,
} from "@lca/shared";

export type ChainTemplateErrorCode =
  | "missing"
  | "malformed"
  | "type-mismatch"
  | "oversized";

export type ChainTemplateError = {
  ok: false;
  code: ChainTemplateErrorCode;
  message: string;
  placeholder?: string;
};

export type ChainTemplateSuccess = {
  ok: true;
  text: string;
};

export type ChainTemplateResult = ChainTemplateSuccess | ChainTemplateError;

/** `{{name}}` or `{{name.segment}}` — single-pass, non-recursive. */
const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

function resolvePath(
  variables: ChainVariables,
  rawPath: string
): { ok: true; value: string } | ChainTemplateError {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return {
      ok: false,
      code: "malformed",
      message: "empty placeholder path",
      placeholder: `{{${rawPath}}}`,
    };
  }

  const segments = trimmed.split(".");
  if (segments.length === 0 || segments.length > 2) {
    return {
      ok: false,
      code: "malformed",
      message: "placeholder path must be one or two segments",
      placeholder: `{{${trimmed}}}`,
    };
  }

  for (const segment of segments) {
    if (
      !segment ||
      segment.length > CHAIN_KEY_MAX_LENGTH ||
      isDangerousChainKey(segment)
    ) {
      return {
        ok: false,
        code: "malformed",
        message: "invalid placeholder path segment",
        placeholder: `{{${trimmed}}}`,
      };
    }
  }

  const top = segments[0]!;
  const nested = segments[1];
  if (!Object.prototype.hasOwnProperty.call(variables, top)) {
    return {
      ok: false,
      code: "missing",
      message: `missing variable "${top}"`,
      placeholder: `{{${trimmed}}}`,
    };
  }

  const value = variables[top]!;
  if (nested === undefined) {
    if (typeof value !== "string") {
      return {
        ok: false,
        code: "type-mismatch",
        message: `variable "${top}" is a map; use {{${top}.key}}`,
        placeholder: `{{${trimmed}}}`,
      };
    }
    return { ok: true, value };
  }

  if (typeof value === "string") {
    return {
      ok: false,
      code: "type-mismatch",
      message: `variable "${top}" is a string; cannot resolve {{${trimmed}}}`,
      placeholder: `{{${trimmed}}}`,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(value, nested)) {
    return {
      ok: false,
      code: "missing",
      message: `missing nested key "${top}.${nested}"`,
      placeholder: `{{${trimmed}}}`,
    };
  }

  return { ok: true, value: value[nested]! };
}

/**
 * Render pipeline template variables into a prompt.
 * Single-pass and non-recursive: replacement text is never re-scanned.
 */
export function renderChainTemplate(
  template: string,
  variables: ChainVariables
): ChainTemplateResult {
  let out = "";
  let lastIndex = 0;
  PLACEHOLDER_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_RE.exec(template)) !== null) {
    const literal = template.slice(lastIndex, match.index);
    if (literal.includes("{{")) {
      return {
        ok: false,
        code: "malformed",
        message: "unbalanced or nested placeholder delimiters",
      };
    }
    out += literal;
    const resolved = resolvePath(variables, match[1] ?? "");
    if (!resolved.ok) {
      return resolved;
    }
    out += resolved.value;
    lastIndex = match.index + match[0].length;
  }
  const tail = template.slice(lastIndex);
  if (tail.includes("{{")) {
    return {
      ok: false,
      code: "malformed",
      message: "unbalanced or nested placeholder delimiters",
    };
  }
  out += tail;

  return assertPromptWithinByteLimit(out);
}

/** Final composed prompt size gate (after handoff / trusted blocks). */
export function assertPromptWithinByteLimit(text: string): ChainTemplateResult {
  if (Buffer.byteLength(text, "utf8") > CHAIN_RENDERED_PROMPT_MAX_BYTES) {
    return {
      ok: false,
      code: "oversized",
      message: `rendered prompt exceeds ${CHAIN_RENDERED_PROMPT_MAX_BYTES} bytes`,
    };
  }
  return { ok: true, text };
}
