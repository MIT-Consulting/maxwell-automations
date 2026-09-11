import { forwardRef, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  PROMPT_REFERENCE_OVERLAY_PILL_CLASS,
  PromptReferenceText,
} from "./PromptReferenceText";

/**
 * Textarea that paints committed `@rule` / `/skill` tokens as Cursor-style pills
 * via a mirrored overlay behind a transparent textarea. The overlay shares the
 * textarea's exact box metrics (padding, border, font, wrapping) and the pill
 * adds no horizontal width, so the caret stays aligned while typing. The token
 * under the caret is left unstyled until committed.
 */
export const PromptReferenceTextarea = forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<typeof Textarea>
>(function PromptReferenceTextarea({ className, value = "", onScroll, ...props }, ref) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const text = typeof value === "string" ? value : String(value ?? "");

  return (
    <div className="relative">
      <div
        ref={overlayRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden rounded-md border border-transparent px-3 py-2 text-base whitespace-pre-wrap break-words md:text-sm",
          className
        )}
      >
        {text ? (
          <PromptReferenceText
            text={text}
            pillClassName={PROMPT_REFERENCE_OVERLAY_PILL_CLASS}
            requireTrailingBoundary
          />
        ) : (
          "\u00a0"
        )}
      </div>
      <Textarea
        ref={ref}
        value={value}
        onScroll={(event) => {
          const overlay = overlayRef.current;
          if (overlay) {
            overlay.scrollTop = event.currentTarget.scrollTop;
            overlay.scrollLeft = event.currentTarget.scrollLeft;
          }
          onScroll?.(event);
        }}
        className={cn(
          "relative bg-transparent text-transparent caret-foreground selection:bg-primary/30",
          className
        )}
        {...props}
      />
    </div>
  );
});
