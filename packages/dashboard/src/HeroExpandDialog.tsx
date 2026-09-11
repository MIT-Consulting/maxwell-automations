import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Rect = { top: number; left: number; width: number; height: number };

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const OPEN_MS = 420;
const CLOSE_MS = 340;
const CONTENT_FADE_MS = 180;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readRect(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function viewportRect(): Rect {
  return {
    top: 0,
    left: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/** Map a fullscreen shell's visual box onto `source` via transform-origin top-left. */
function transformToSource(source: Rect, target: Rect): string {
  const scaleX = source.width / Math.max(target.width, 1);
  const scaleY = source.height / Math.max(target.height, 1);
  const x = source.left - target.left;
  const y = source.top - target.top;
  return `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})`;
}

export type HeroExpandDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Card / panel the surface grows from and shrinks back to. */
  sourceRef: RefObject<HTMLElement | null>;
  title: string;
  children: ReactNode;
  /** Extra chrome under the title row (e.g. jump bar). */
  header?: ReactNode;
  className?: string;
};

/**
 * Fullscreen dialog that FLIP-expands from `sourceRef` and shrinks back on
 * close. Default motion for “opened from this place” surfaces — GPU transforms
 * only, content fades after the shell starts moving.
 */
export function HeroExpandDialog({
  open,
  onOpenChange,
  sourceRef,
  title,
  children,
  header,
  className,
}: HeroExpandDialogProps): ReactElement | null {
  const contentRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [shellStyle, setShellStyle] = useState<CSSProperties>({});
  const [overlayOpacity, setOverlayOpacity] = useState(0);
  const [contentOpacity, setContentOpacity] = useState(0);
  const closingRef = useRef(false);
  const sourceSnapshotRef = useRef<Rect | null>(null);

  const finishClose = useCallback(() => {
    setMounted(false);
    closingRef.current = false;
    setShellStyle({});
    setOverlayOpacity(0);
    setContentOpacity(0);
    onOpenChange(false);
  }, [onOpenChange]);

  const showWithoutMotion = useCallback(() => {
    setShellStyle({
      transform: "none",
      borderRadius: 0,
      transition: "none",
    });
    setOverlayOpacity(1);
    setContentOpacity(1);
  }, []);

  const runOpen = useCallback(() => {
    const el = contentRef.current;
    // Portal Content can lag one frame behind mount — caller retries.
    if (!el) return false;
    const reduced = prefersReducedMotion();
    const source = sourceSnapshotRef.current ?? readRect(sourceRef.current);
    const target = viewportRect();

    if (reduced || !source) {
      showWithoutMotion();
      return true;
    }

    const from = transformToSource(source, target);
    setShellStyle({
      transform: from,
      borderRadius: 8,
      transition: "none",
    });
    setOverlayOpacity(0);
    setContentOpacity(0);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Content unmounted mid-open (strict mode / fast close).
        if (!contentRef.current) return;
        setShellStyle({
          transform: "none",
          borderRadius: 0,
          transition: `transform ${OPEN_MS}ms ${EASE}, border-radius ${OPEN_MS}ms ${EASE}`,
        });
        setOverlayOpacity(1);
        window.setTimeout(() => setContentOpacity(1), 90);
      });
    });
    return true;
  }, [showWithoutMotion, sourceRef]);

  const revealSource = useCallback(() => {
    const source = sourceRef.current;
    if (source) source.style.visibility = "";
  }, [sourceRef]);

  const hideSource = useCallback(() => {
    const source = sourceRef.current;
    if (source) source.style.visibility = "hidden";
  }, [sourceRef]);

  const runClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const el = contentRef.current;
    const reduced = prefersReducedMotion();
    // Reveal before measuring so getBoundingClientRect is valid, then the
    // shrink lands on the real card instead of an empty hole.
    revealSource();
    const source = readRect(sourceRef.current) ?? sourceSnapshotRef.current;
    const target = viewportRect();

    if (reduced || !el || !source) {
      finishClose();
      return;
    }

    setContentOpacity(0);
    window.setTimeout(() => {
      const to = transformToSource(source, target);
      setShellStyle({
        transform: to,
        borderRadius: 8,
        transition: `transform ${CLOSE_MS}ms ${EASE}, border-radius ${CLOSE_MS}ms ${EASE}`,
      });
      setOverlayOpacity(0);
      window.setTimeout(finishClose, CLOSE_MS + 20);
    }, CONTENT_FADE_MS);
  }, [finishClose, revealSource, sourceRef]);

  // Mount when open requested; snapshot source before paint.
  useLayoutEffect(() => {
    if (!open) return;
    sourceSnapshotRef.current = readRect(sourceRef.current);
    closingRef.current = false;
    setMounted(true);
  }, [open, sourceRef]);

  // Hide the source once the hero shell is up — avoids a double-card flash.
  useEffect(() => {
    if (!mounted || !open) return;
    const id = window.setTimeout(hideSource, 48);
    return () => {
      window.clearTimeout(id);
      revealSource();
    };
  }, [mounted, open, hideSource, revealSource]);

  // Drive enter after mount. Retry until portal Content attaches — a single
  // early runOpen() used to return with contentOpacity stuck at 0 (gray
  // empty shell).
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    let cancelled = false;
    let attempts = 0;

    const tryOpen = (): void => {
      if (cancelled) return;
      if (runOpen()) return;
      attempts += 1;
      if (attempts < 45) {
        requestAnimationFrame(tryOpen);
        return;
      }
      showWithoutMotion();
    };

    tryOpen();
    return () => {
      cancelled = true;
    };
  }, [open, mounted, runOpen, showWithoutMotion]);

  // When parent sets open=false while mounted, play exit (Escape / overlay).
  useEffect(() => {
    if (open || !mounted || closingRef.current) return;
    runClose();
  }, [open, mounted, runClose]);

  const requestClose = (): void => {
    if (!mounted || closingRef.current) return;
    runClose();
  };

  if (!mounted) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogPortal>
        <DialogOverlay
          className="duration-0 data-[state=closed]:animate-none data-[state=open]:animate-none"
          style={{
            opacity: overlayOpacity,
            transition: `opacity ${OPEN_MS}ms ${EASE}`,
          }}
          onClick={requestClose}
        />
        <DialogPrimitive.Content
          ref={contentRef}
          data-slot="dialog-content"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            requestClose();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className={cn(
            "fixed inset-0 z-50 flex h-dvh w-full min-h-0 flex-col overflow-hidden border-0 bg-background p-0 shadow-none outline-none",
            "origin-top-left will-change-transform",
            className
          )}
          style={{
            ...shellStyle,
            // Avoid fighting Radix / tw animate utilities.
            animation: "none",
            transformOrigin: "top left",
          }}
        >
          <div
            className="flex min-h-0 flex-1 flex-col"
            style={{
              opacity: contentOpacity,
              transition: `opacity ${CONTENT_FADE_MS}ms ${EASE}`,
            }}
          >
            <div className="flex shrink-0 flex-row items-center justify-between border-b border-border px-4 py-3 text-left">
              <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
                onClick={requestClose}
              >
                <X />
              </Button>
            </div>
            {header}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {children}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
