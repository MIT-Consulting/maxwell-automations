import type { Run } from "@lca/shared";
import { cn } from "@/lib/utils";

/**
 * Presentational status indicator dot. Maps a daemon-connection or run status
 * to its design-system color via the `--status-*` Tailwind utilities, so the
 * palette stays in one place (no inline hex).
 */
const STATUS_DOT_CLASS = {
  live: "bg-status-live",
  offline: "bg-status-offline",
  queued: "bg-status-needs-input",
  running: "bg-status-running",
  needs_input: "bg-status-needs-input",
  paused: "bg-status-paused",
  completed: "bg-status-completed",
  failed: "bg-status-failed",
  cancelled: "bg-status-offline",
} as const satisfies Record<"live" | "offline" | Run["status"], string>;

export type StatusKind = keyof typeof STATUS_DOT_CLASS;

export function StatusDot({
  status,
  title,
  className,
  pulse = false,
}: {
  status: StatusKind;
  title?: string;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-block size-[9px] shrink-0 rounded-full",
        STATUS_DOT_CLASS[status],
        pulse && "animate-pulse",
        className
      )}
      title={title ?? status}
      aria-hidden="true"
    />
  );
}
