import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { RoadmapSummaryEntry } from "./useRoadmapReadinessSummaries";
import { describeReadinessSummaryLabel } from "./roadmapReadinessUi";

const STATE_STYLE: Record<string, string> = {
  ready: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  empty: "border-border bg-muted text-muted-foreground",
  adoptable: "border-amber-500/40 bg-amber-500/10 text-amber-100",
  unavailable: "border-border bg-muted/60 text-muted-foreground",
  loading: "border-border bg-muted/40 text-muted-foreground",
};

export function RoadmapReadinessBadge({
  entry,
  className,
}: {
  entry?: RoadmapSummaryEntry;
  className?: string;
}): ReactNode {
  if (!entry || entry.status === "loading") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          STATE_STYLE.loading,
          className
        )}
        aria-label="Roadmap readiness loading"
      >
        …
      </span>
    );
  }

  if (entry.status === "unavailable") {
    return (
      <span
        className={cn(
          "inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
          STATE_STYLE.unavailable,
          className
        )}
        aria-label="Roadmap readiness unavailable"
        title={entry.error}
      >
        —
      </span>
    );
  }

  const { summary } = entry;
  const label = describeReadinessSummaryLabel(summary);
  const short =
    summary.state === "ready" &&
    summary.counts["blocks-all"] + summary.counts["blocks-some"] === 0
      ? "ready"
      : summary.state;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        STATE_STYLE[summary.state] ?? STATE_STYLE.empty,
        className
      )}
      aria-label={label}
      title={label}
    >
      {short}
    </span>
  );
}
