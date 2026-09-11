import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp, Maximize2 } from "lucide-react";
import { parsePromptReferences, type PromptReference } from "@lca/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  PROMPT_REFERENCE_PILL_CLASS,
  PromptReferenceText,
} from "./PromptReferenceText";
import { HeroExpandDialog } from "./HeroExpandDialog";
import { useIsNarrowViewport } from "./useIsNarrowViewport";

export type PromptReferenceViewerProps = {
  text: string;
  className?: string;
  /** Scroll container max-height classes (e.g. max-h-40). */
  bodyClassName?: string;
  /** Dialog title when expanded on mobile. */
  title?: string;
  /** Status line when there are no @ / / tokens (mobile header). */
  emptyLabel?: string;
};

export type PromptReferenceJumpBarProps = {
  references: PromptReference[];
  activeOccurrence: number | null;
  onCycle: (delta: number) => void;
  onJumpUnique: (key: string, firstIndex: number) => void;
  className?: string;
  /** Shown when there are no references (keeps the bar visible). */
  emptyLabel?: string;
  /** Trailing control (e.g. fullscreen expand). */
  trailing?: ReactNode;
  /** Render even with no references / empty label (for trailing-only chrome). */
  alwaysShow?: boolean;
};

function uniqueReferenceEntries(
  references: PromptReference[]
): Array<{ key: string; raw: string; firstIndex: number }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; raw: string; firstIndex: number }> = [];
  for (let index = 0; index < references.length; index += 1) {
    const ref = references[index]!;
    const key = `${ref.kind}:${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, raw: ref.raw, firstIndex: index });
  }
  return out;
}

/** ↑/↓ + unique skill/rule chips for jumping to @ / / tokens. */
export function PromptReferenceJumpBar({
  references,
  activeOccurrence,
  onCycle,
  onJumpUnique,
  className,
  emptyLabel,
  trailing,
  alwaysShow = false,
}: PromptReferenceJumpBarProps): ReactElement | null {
  const uniqueRefs = useMemo(
    () => uniqueReferenceEntries(references),
    [references]
  );
  if (
    references.length === 0 &&
    emptyLabel == null &&
    trailing == null &&
    !alwaysShow
  ) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-border px-1.5 py-1",
        className
      )}
    >
      {references.length > 0 ? (
        <>
          <div className="flex shrink-0 items-center">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              title="Previous reference"
              aria-label="Previous skill or rule"
              onClick={() => onCycle(-1)}
            >
              <ChevronUp className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              title="Next reference"
              aria-label="Next skill or rule"
              onClick={() => onCycle(1)}
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </div>
          {activeOccurrence !== null ? (
            <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
              {activeOccurrence + 1}/{references.length}
            </span>
          ) : (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {references.length}
            </span>
          )}
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-contain">
            {uniqueRefs.map((entry) => {
              const activeRef =
                activeOccurrence !== null
                  ? references[activeOccurrence]
                  : undefined;
              const active =
                activeRef !== undefined &&
                `${activeRef.kind}:${activeRef.name}` === entry.key;
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={cn(
                    PROMPT_REFERENCE_PILL_CLASS,
                    "shrink-0 cursor-pointer border-none text-[10px] outline-none",
                    "hover:brightness-110 focus-visible:ring-1 focus-visible:ring-[#e8a35a]",
                    active && "ring-1 ring-[#e8a35a] bg-[#5c4228]"
                  )}
                  title={`Jump to ${entry.raw}`}
                  aria-label={`Jump to ${entry.raw}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onJumpUnique(entry.key, entry.firstIndex)}
                >
                  {entry.raw}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {emptyLabel ?? ""}
        </span>
      )}
      {trailing}
    </div>
  );
}

/** Shared jump state for a flat list of prompt references (one text or many). */
export function usePromptReferenceJump(references: PromptReference[]): {
  activeOccurrence: number | null;
  onCycle: (delta: number) => void;
  onJumpUnique: (key: string, firstIndex: number) => void;
  onPillRef: (occurrence: number, el: HTMLSpanElement | null) => void;
} {
  const [activeOccurrence, setActiveOccurrence] = useState<number | null>(null);
  const pillEls = useRef(new Map<number, HTMLSpanElement>());

  const jumpTo = useCallback(
    (occurrence: number) => {
      if (references.length === 0) return;
      const next =
        ((occurrence % references.length) + references.length) %
        references.length;
      setActiveOccurrence(next);
      const el = pillEls.current.get(next);
      el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [references.length]
  );

  const onJumpUnique = useCallback(
    (key: string, firstIndex: number) => {
      const indices = references
        .map((ref, index) => (`${ref.kind}:${ref.name}` === key ? index : -1))
        .filter((index) => index >= 0);
      if (indices.length === 0) return;
      if (activeOccurrence !== null && indices.includes(activeOccurrence)) {
        const pos = indices.indexOf(activeOccurrence);
        jumpTo(indices[(pos + 1) % indices.length]!);
        return;
      }
      jumpTo(firstIndex);
    },
    [activeOccurrence, jumpTo, references]
  );

  const onCycle = useCallback(
    (delta: number) => {
      if (references.length === 0) return;
      const current = activeOccurrence ?? (delta > 0 ? -1 : 0);
      jumpTo(current + delta);
    },
    [activeOccurrence, jumpTo, references.length]
  );

  const onPillRef = useCallback(
    (occurrence: number, el: HTMLSpanElement | null) => {
      if (el) pillEls.current.set(occurrence, el);
      else pillEls.current.delete(occurrence);
    },
    []
  );

  return { activeOccurrence, onCycle, onJumpUnique, onPillRef };
}

function ExpandTrailing({
  onExpand,
}: {
  onExpand: () => void;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
      title="Expand"
      aria-label="Expand to fullscreen"
      onClick={(e) => {
        e.stopPropagation();
        onExpand();
      }}
    >
      <Maximize2 className="size-3.5" />
    </Button>
  );
}

export function PromptReferenceViewer({
  text,
  className,
  bodyClassName,
  title = "prompt",
  emptyLabel = "no skills or rules",
}: PromptReferenceViewerProps): ReactElement {
  const isNarrow = useIsNarrowViewport();
  const sourceRef = useRef<HTMLDivElement>(null);
  const references = useMemo(() => parsePromptReferences(text), [text]);
  const { activeOccurrence, onCycle, onJumpUnique, onPillRef } =
    usePromptReferenceJump(references);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenJump = usePromptReferenceJump(references);

  const showHeader = references.length > 0 || isNarrow;
  const expandTrailing =
    isNarrow ? <ExpandTrailing onExpand={() => setFullscreen(true)} /> : null;

  return (
    <div
      ref={sourceRef}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-background",
        className
      )}
      onClick={(e) => e.stopPropagation()}
    >
      {showHeader ? (
        <PromptReferenceJumpBar
          references={references}
          activeOccurrence={activeOccurrence}
          onCycle={onCycle}
          onJumpUnique={onJumpUnique}
          emptyLabel={isNarrow ? emptyLabel : undefined}
          trailing={expandTrailing}
          alwaysShow={isNarrow}
        />
      ) : null}
      <div
        className={cn(
          "column-scrollbar min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px] text-muted-foreground",
          bodyClassName
        )}
      >
        <PromptReferenceText
          text={text}
          activeOccurrence={activeOccurrence}
          onPillRef={onPillRef}
        />
      </div>

      {isNarrow ? (
        <HeroExpandDialog
          open={fullscreen}
          onOpenChange={setFullscreen}
          sourceRef={sourceRef}
          title={title}
          header={
            <PromptReferenceJumpBar
              references={references}
              activeOccurrence={fullscreenJump.activeOccurrence}
              onCycle={fullscreenJump.onCycle}
              onJumpUnique={fullscreenJump.onJumpUnique}
              emptyLabel={emptyLabel}
              alwaysShow
              className="px-3"
            />
          }
        >
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-4 font-mono text-[13px] text-muted-foreground">
            <PromptReferenceText
              text={text}
              activeOccurrence={fullscreenJump.activeOccurrence}
              onPillRef={fullscreenJump.onPillRef}
            />
          </div>
        </HeroExpandDialog>
      ) : null}
    </div>
  );
}
