import type { ReactNode } from "react";
import { parsePromptReferences } from "@lca/shared";
import { cn } from "@/lib/utils";

/** Padded pill for committed tokens where layout alignment does not matter (transcript). */
export const PROMPT_REFERENCE_PILL_CLASS =
  "inline rounded-[4px] bg-[#4a3621] px-1 py-px text-[#e8a35a]";

export const PROMPT_REFERENCE_PILL_ACTIVE_CLASS =
  "ring-1 ring-[#e8a35a]/bg-[#5c4228]";

/**
 * Pill for the compose overlay. Uses a box-shadow spread instead of horizontal
 * padding so the styled token occupies the exact same width as the raw glyphs —
 * otherwise the textarea caret drifts out of sync with the highlight layer.
 */
export const PROMPT_REFERENCE_OVERLAY_PILL_CLASS =
  "rounded-[3px] bg-[#4a3621] text-[#e8a35a] shadow-[0_0_0_1px_#4a3621]";

type BuildOptions = {
  pillClassName?: string;
  activePillClassName?: string;
  /**
   * When true, only style references followed by a boundary char (or trailing
   * space). This keeps the token currently being typed at the caret unstyled
   * until it is committed (selected from the list or a space is added).
   */
  requireTrailingBoundary?: boolean;
  /** 0-based index into committed references painted as pills (global). */
  activeOccurrence?: number | null;
  /** Added to local indices when one navigator spans multiple texts. */
  occurrenceOffset?: number;
  onPillRef?: (occurrence: number, el: HTMLSpanElement | null) => void;
};

function isBoundaryChar(char: string | undefined): boolean {
  return char === undefined ? false : /[\s.,;:!?)\]}]/.test(char);
}

export function buildPromptReferenceNodes(
  text: string,
  options: BuildOptions = {}
): ReactNode[] {
  const {
    pillClassName = PROMPT_REFERENCE_PILL_CLASS,
    activePillClassName = PROMPT_REFERENCE_PILL_ACTIVE_CLASS,
    requireTrailingBoundary = false,
    activeOccurrence = null,
    occurrenceOffset = 0,
    onPillRef,
  } = options;
  const references = parsePromptReferences(text);
  if (references.length === 0) {
    return [text];
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let occurrence = 0;

  for (const reference of references) {
    const end = reference.index + reference.length;
    const committed =
      !requireTrailingBoundary || isBoundaryChar(text[end]);

    if (!committed) {
      continue;
    }

    if (reference.index > cursor) {
      nodes.push(text.slice(cursor, reference.index));
    }
    const thisOccurrence = occurrenceOffset + occurrence;
    occurrence += 1;
    const active = activeOccurrence === thisOccurrence;
    nodes.push(
      <span
        key={`${reference.index}-${reference.raw}`}
        ref={
          onPillRef
            ? (el) => onPillRef(thisOccurrence, el)
            : undefined
        }
        data-prompt-ref={thisOccurrence}
        className={cn(pillClassName, active && activePillClassName)}
      >
        {reference.raw}
      </span>
    );
    cursor = end;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

export function PromptReferenceText({
  text,
  className,
  pillClassName,
  activePillClassName,
  requireTrailingBoundary,
  activeOccurrence,
  occurrenceOffset,
  onPillRef,
}: {
  text: string;
  className?: string;
  pillClassName?: string;
  activePillClassName?: string;
  requireTrailingBoundary?: boolean;
  activeOccurrence?: number | null;
  occurrenceOffset?: number;
  onPillRef?: (occurrence: number, el: HTMLSpanElement | null) => void;
}) {
  return (
    <span className={cn("whitespace-pre-wrap break-words", className)}>
      {buildPromptReferenceNodes(text, {
        pillClassName,
        activePillClassName,
        requireTrailingBoundary,
        activeOccurrence,
        occurrenceOffset,
        onPillRef,
      })}
    </span>
  );
}
