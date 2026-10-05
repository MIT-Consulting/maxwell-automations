import type {
  ChainRunContext,
  PipelineDirectiveBody,
  PipelineDirectiveKind,
  PipelineModelRole,
} from "@lca/shared";
import { normalizeModelSelection } from "@lca/shared";
import { CHAIN_RENDERED_PROMPT_MAX_BYTES } from "@lca/shared";

export type StoredPipelineDirective = {
  id: string;
  kind: PipelineDirectiveKind;
  actorId: string | null;
  body: PipelineDirectiveBody;
  createdAt: string;
};

const DIRECTIVE_BLOCK_HEADER = "--- operator directives";
const DIRECTIVE_BLOCK_RESERVE_BYTES = 512;

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Escape operator note text for untrusted prompt injection. */
export function escapeOperatorDirectiveText(text: string): string {
  return text.replace(/`/g, "\\`").replace(/\r\n/g, "\n");
}

function renderNoteLine(
  index: number,
  actorId: string | null,
  text: string
): string {
  const actor = actorId?.trim() || "operator";
  return `${index}. [${actor}] ${escapeOperatorDirectiveText(text)}`;
}

/** Merge accumulated role-override directives into a child chain context copy. */
export function mergeDirectiveRoleOverrides(
  chainContext: ChainRunContext,
  directives: readonly StoredPipelineDirective[]
): ChainRunContext {
  let roleModels = { ...chainContext.roleModels };
  for (const directive of directives) {
    if (directive.kind !== "role-override") {
      continue;
    }
    if (!("roleModels" in directive.body)) {
      continue;
    }
    for (const [role, selection] of Object.entries(directive.body.roleModels)) {
      if (selection == null || typeof selection !== "object") {
        continue;
      }
      if (!("id" in selection) || typeof selection.id !== "string") {
        continue;
      }
      roleModels = {
        ...roleModels,
        [role as PipelineModelRole]: normalizeModelSelection(selection),
      };
    }
  }
  return { ...chainContext, roleModels };
}

/**
 * Append a byte-capped operator directives block after the composed chained prompt.
 * Preserves newest notes when truncating; renders oldest-to-newest.
 */
export function appendOperatorDirectivesBlock(
  composedPrompt: string,
  directives: readonly StoredPipelineDirective[]
): string {
  const notes = directives.filter((d) => d.kind === "note");
  if (notes.length === 0) {
    return composedPrompt;
  }

  const budget =
    CHAIN_RENDERED_PROMPT_MAX_BYTES -
    utf8ByteLength(composedPrompt) -
    DIRECTIVE_BLOCK_RESERVE_BYTES;
  if (budget <= 0) {
    return composedPrompt;
  }

  const lines: string[] = [];
  let used = utf8ByteLength(
    `\n\n${DIRECTIVE_BLOCK_HEADER} (${notes.length}) ---\n`
  );

  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i]!;
    if (!("text" in note.body)) {
      continue;
    }
    const line = renderNoteLine(i + 1, note.actorId, note.body.text);
    const lineBytes = utf8ByteLength(line) + 1;
    if (used + lineBytes > budget) {
      continue;
    }
    lines.unshift(line);
    used += lineBytes;
  }

  if (lines.length === 0) {
    return composedPrompt;
  }

  const block = `\n\n${DIRECTIVE_BLOCK_HEADER} (${lines.length}) ---\n${lines.join("\n")}`;
  return `${composedPrompt}${block}`;
}
