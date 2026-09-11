import { useEffect, useState } from "react";
import type { Run, TriggerConfig, Workspace } from "@lca/shared";

export const TRIGGER_ICON: Record<TriggerConfig["type"], string> = {
  cron: "⏱",
  git: "⎇",
  "file-watch": "👁",
  command: "⌘",
  manual: "✋",
};

/** Icons for run-level trigger kinds (includes chain and git:* variants). */
const TRIGGER_KIND_ICON: Record<string, string> = {
  ...TRIGGER_ICON,
  chain: "🔗",
  "halt-discovery": "🩺",
};

export function triggerLabel(trigger: TriggerConfig): string {
  switch (trigger.type) {
    case "cron":
      return `cron · ${trigger.expression}`;
    case "git":
      return `git · ${trigger.events.join(", ")}`;
    case "file-watch":
      return `file-watch · ${trigger.globs.join(", ")}`;
    case "command":
      return `command · ${trigger.command}`;
    case "manual":
      return "manual";
  }
}

/** Label for a run's stored trigger_kind (may differ from the automation trigger). */
export function triggerKindLabel(kind: string): string {
  if (kind === "chain") {
    return "Chain";
  }
  if (kind === "halt-discovery") {
    return "Halt discovery";
  }
  if (kind.startsWith("git:")) {
    return `git · ${kind.slice("git:".length)}`;
  }
  if (kind in TRIGGER_ICON) {
    return kind;
  }
  return kind;
}

/** Icon for a run's stored trigger_kind; unknown kinds get a neutral fallback. */
export function triggerKindIcon(kind: string): string {
  return TRIGGER_KIND_ICON[kind] ?? "•";
}

export const STATUS_COLOR: Record<Run["status"], string> = {
  queued: "#9aa0a6",
  running: "#3b82f6",
  needs_input: "#f59e0b",
  paused: "#a371f7",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#9aa0a6",
};

export function workspaceLabel(
  workspaceId: string,
  workspaces: Workspace[]
): string {
  const ws = workspaces.find((w) => w.id === workspaceId);
  if (!ws) return workspaceId.slice(0, 6);
  if (ws.name) return ws.name;
  const parts = ws.path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || ws.path;
}

/** Ticks every second; used to keep running-run elapsed timers live. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function parseTs(ts: string | null): number | null {
  if (!ts) return null;
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC.
  const normalized = ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** Local wall-clock time (e.g. "12:43 AM") for a stored event timestamp. */
export function formatClock(ts: string | null | undefined): string | null {
  const ms = parseTs(ts ?? null);
  if (ms === null) return null;
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Compact absolute timestamp: clock-only when it falls on the current day,
 * otherwise prefixed with a short month/day (e.g. "Jun 2, 9:58 AM").
 */
export function formatTimestamp(ts: string | null | undefined): string | null {
  const ms = parseTs(ts ?? null);
  if (ms === null) return null;
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(
    [],
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  );
}

/** Short relative distance from now, e.g. "in 5m", "in 3h", "in 2d". */
export function formatRelativeToNow(
  ts: string | null | undefined,
  now: number = Date.now()
): string | null {
  const ms = parseTs(ts ?? null);
  if (ms === null) return null;
  const deltaSec = Math.round((ms - now) / 1000);
  const ahead = deltaSec >= 0;
  const abs = Math.abs(deltaSec);
  let value: string;
  if (abs < 60) value = `${abs}s`;
  else if (abs < 3600) value = `${Math.round(abs / 60)}m`;
  else if (abs < 86400) value = `${Math.round(abs / 3600)}h`;
  else value = `${Math.round(abs / 86400)}d`;
  return ahead ? `in ${value}` : `${value} ago`;
}

export function formatElapsed(
  startedAt: string | null,
  endedAt: string | null,
  now: number
): string {
  const start = parseTs(startedAt);
  if (start === null) return "—";
  const end = parseTs(endedAt) ?? now;
  const totalSec = Math.max(0, Math.floor((end - start) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
