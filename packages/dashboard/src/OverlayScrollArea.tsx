import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
  type UIEvent,
} from "react";
import { cn } from "@/lib/utils";

type Metrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

/**
 * Scroll container whose thumb paints over content on hover — no layout
 * gutter and no content-width shift when the scrollbar appears.
 *
 * Uses a normal flex child (not absolute fill) so auto-height parents
 * (e.g. the run logs dialog before it's been resized) still get height
 * from transcript content.
 */
export function OverlayScrollArea({
  className,
  contentClassName,
  children,
  scrollRef,
  onScroll,
  contentRevision,
}: {
  className?: string;
  contentClassName?: string;
  children: ReactNode;
  /** Forwarded to the real scrolling element (pin-to-bottom / restore). */
  scrollRef?: Ref<HTMLDivElement | null>;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  /** Bump when content changes so the overlay thumb metrics refresh. */
  contentRevision?: unknown;
}): ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [metrics, setMetrics] = useState<Metrics>({
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
  });

  const updateMetrics = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    setMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateMetrics();
    const ro = new ResizeObserver(() => updateMetrics());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    updateMetrics();
  }, [contentRevision]);

  const overflow = metrics.scrollHeight > metrics.clientHeight + 1;
  const maxScroll = Math.max(1, metrics.scrollHeight - metrics.clientHeight);
  const thumbHeight = Math.max(
    20,
    (metrics.clientHeight / Math.max(metrics.scrollHeight, 1)) *
      metrics.clientHeight
  );
  const thumbTop =
    (metrics.scrollTop / maxScroll) *
    Math.max(0, metrics.clientHeight - thumbHeight);

  const handleScroll = (event: UIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    setMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    onScroll?.(event);
  };

  return (
    <div
      className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", className)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        ref={(el) => {
          scrollerRef.current = el;
          assignRef(scrollRef, el);
        }}
        className={cn(
          "no-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto",
          contentClassName
        )}
        onScroll={handleScroll}
      >
        {children}
      </div>
      {overflow && hover ? (
        <div
          className="pointer-events-none absolute inset-y-1 right-0.5 z-10 w-1"
          aria-hidden
        >
          <div
            className="absolute w-full rounded-full bg-border"
            style={{ height: thumbHeight, top: thumbTop }}
          />
        </div>
      ) : null}
    </div>
  );
}
