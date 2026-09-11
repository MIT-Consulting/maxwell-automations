import type { Run } from "@lca/shared";

export type ColumnKey =
  | "backlog"
  | "enabled"
  | "running"
  | "needs_input"
  | "completed"
  | "failed";

export type ColumnPref = "auto" | "open" | "collapsed";

export const COLUMN_PREFS_KEY = "lca.columnPrefs";
export const COLUMN_WIDTHS_KEY = "lca.columnWidths";
export const RECENT_WINDOW_MS = 90_000;
export const COLLAPSED_COLUMN_WIDTH_PX = 40;
export const OPEN_COLUMN_MIN_WIDTH_PX = 280;
export const OPEN_COLUMN_MAX_WIDTH_PX = 640;
/** Cap for title-fit smart layout so one long name doesn't dominate the board. */
export const OPEN_COLUMN_FIT_MAX_WIDTH_PX = 560;
export const OPEN_COLUMN_DEFAULT_WIDTH_PX = 320;
/**
 * Horizontal chrome around a card title inside a column: column padding,
 * card padding/border, trigger icon, status dot, and title-row gaps.
 */
export const COLUMN_CARD_TITLE_CHROME_PX = 96;
/**
 * Chrome around a pipeline group header line: column padding, left rail,
 * chevron, status dot, and sticky header padding (text segments measured
 * separately).
 */
export const COLUMN_PIPELINE_HEADER_CHROME_PX = 72;
/**
 * Extra width for the Docs menu trigger beyond the "Docs N" label: icon,
 * gaps, and button horizontal padding.
 */
export const PIPELINE_DOCS_BUTTON_EXTRA_PX = 44;
/** Matches board card title: body size + semibold + dashboard sans stack. */
export const CARD_TITLE_FONT =
  '600 16px -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif';
/** Pipeline header status / body (`text-[11px]`). */
export const PIPELINE_HEADER_FONT =
  '500 11px -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif';/** Feature label in the group header (`font-semibold`). */
export const PIPELINE_HEADER_FEATURE_FONT =
  '600 11px -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif';/** Pipeline id segment (`font-mono text-[11px]`). */
export const PIPELINE_HEADER_MONO_FONT =
  '500 11px "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
export const COLLAPSED_COLUMN_WIDTH = `${COLLAPSED_COLUMN_WIDTH_PX}px`;
export const OPEN_COLUMN_MIN_WIDTH = `${OPEN_COLUMN_MIN_WIDTH_PX}px`;
export const OPEN_COLUMN_MAX_WIDTH = `${OPEN_COLUMN_MAX_WIDTH_PX}px`;

export type PipelineHeaderFitSegments = {
  status?: string | null;
  featureLabel: string;
  pipelineLabel: string;
  depthBudget: string;
  runsLabel: string;
  elapsedLabel: string;
  docsCount?: number | null;
  waveProgress?: string | null;
  cleanupRequired?: boolean;
};

export type ColumnFitContent = {
  cardTitles: string[];
  /**
   * Pipeline group summary headers. Included in smart-fit so they stay on one
   * line at the fit width; they still wrap if the column is later dragged
   * narrower.
   */
  headerSegments?: PipelineHeaderFitSegments[];
};

export const COLUMN_KEYS: ColumnKey[] = [
  "backlog",
  "enabled",
  "running",
  "needs_input",
  "completed",
  "failed",
];

export type ColumnMeta = { count: number; collapsed: boolean };

function defaultColumnPrefs(): Record<ColumnKey, ColumnPref> {
  return {
    backlog: "auto",
    enabled: "auto",
    running: "auto",
    needs_input: "auto",
    completed: "auto",
    failed: "auto",
  };
}

const VALID_PREFS = new Set<ColumnPref>(["auto", "open", "collapsed"]);

export function loadColumnPrefs(): Record<ColumnKey, ColumnPref> {
  const prefs = defaultColumnPrefs();
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_KEY);
    if (!raw) return prefs;
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, ColumnPref>>;
    for (const key of COLUMN_KEYS) {
      const value = parsed[key];
      if (value && VALID_PREFS.has(value)) {
        prefs[key] = value;
      }
    }
  } catch {
    /* ignore malformed persisted prefs */
  }
  return prefs;
}

export function clampColumnWidth(px: number): number {
  if (typeof px !== "number" || !Number.isFinite(px)) {
    return OPEN_COLUMN_DEFAULT_WIDTH_PX;
  }
  const rounded = Math.round(px);
  return Math.min(
    OPEN_COLUMN_MAX_WIDTH_PX,
    Math.max(OPEN_COLUMN_MIN_WIDTH_PX, rounded)
  );
}

function defaultColumnWidths(): Record<ColumnKey, number> {
  return {
    backlog: OPEN_COLUMN_DEFAULT_WIDTH_PX,
    enabled: OPEN_COLUMN_DEFAULT_WIDTH_PX,
    running: OPEN_COLUMN_DEFAULT_WIDTH_PX,
    needs_input: OPEN_COLUMN_DEFAULT_WIDTH_PX,
    completed: OPEN_COLUMN_DEFAULT_WIDTH_PX,
    failed: OPEN_COLUMN_DEFAULT_WIDTH_PX,
  };
}

export function loadColumnWidths(): Record<ColumnKey, number> {
  const widths = defaultColumnWidths();
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_KEY);
    if (!raw) return widths;
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, unknown>>;
    for (const key of COLUMN_KEYS) {
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        widths[key] = clampColumnWidth(value);
      }
    }
  } catch {
    /* ignore malformed persisted widths */
  }
  return widths;
}

export function saveColumnWidths(widths: Record<ColumnKey, number>): void {
  try {
    const payload = {} as Record<ColumnKey, number>;
    for (const key of COLUMN_KEYS) {
      payload[key] = clampColumnWidth(widths[key]);
    }
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable (private mode) */
  }
}

export function defaultOpenColumnWidths(): Record<ColumnKey, number> {
  return defaultColumnWidths();
}

let titleMeasureCanvas: HTMLCanvasElement | null = null;

function measureTextWidth(text: string, font: string, fallbackEm = 9): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (typeof document !== "undefined") {
    titleMeasureCanvas ??= document.createElement("canvas");
    const ctx = titleMeasureCanvas.getContext("2d");
    if (ctx) {
      ctx.font = font;
      return Math.ceil(ctx.measureText(trimmed).width);
    }
  }
  return Math.ceil(trimmed.length * fallbackEm);
}

/** Measure a card title string in the board title font (canvas when available). */
export function measureCardTitleWidth(title: string): number {
  return measureTextWidth(title, CARD_TITLE_FONT, 9);
}

const HEADER_SEP_PX = 14; // " · " at 11px

/** Measure a pipeline group header from typed segments (mono / Docs chrome). */
export function measurePipelineHeaderSegments(
  segments: PipelineHeaderFitSegments
): number {
  let width = COLUMN_PIPELINE_HEADER_CHROME_PX;
  const add = (text: string, font: string, fallbackEm: number): void => {
    width += measureTextWidth(text, font, fallbackEm) + HEADER_SEP_PX;
  };

  if (segments.status) {
    add(segments.status, PIPELINE_HEADER_FONT, 6.5);
  }
  add(segments.featureLabel, PIPELINE_HEADER_FEATURE_FONT, 7);
  add(segments.pipelineLabel, PIPELINE_HEADER_MONO_FONT, 7.5);
  add(segments.depthBudget, PIPELINE_HEADER_FONT, 6.5);
  add(segments.runsLabel, PIPELINE_HEADER_FONT, 6.5);
  // Last text segment before optional Docs — still followed by sep when Docs/wave exist.
  width += measureTextWidth(segments.elapsedLabel, PIPELINE_HEADER_FONT, 6.5);

  if (segments.docsCount != null && segments.docsCount > 0) {
    width += HEADER_SEP_PX;
    width +=
      measureTextWidth(`Docs ${segments.docsCount}`, PIPELINE_HEADER_FONT, 6.5) +
      PIPELINE_DOCS_BUTTON_EXTRA_PX;
  }
  if (segments.waveProgress) {
    width += HEADER_SEP_PX;
    width += measureTextWidth(
      segments.waveProgress,
      PIPELINE_HEADER_FONT,
      6.5
    );
  }
  if (segments.cleanupRequired) {
    width += HEADER_SEP_PX;
    width += measureTextWidth(
      "cleanup required",
      PIPELINE_HEADER_FONT,
      6.5
    );
  }
  return Math.ceil(width);
}

function clampFitWidth(raw: number): number {
  return Math.min(
    OPEN_COLUMN_FIT_MAX_WIDTH_PX,
    Math.max(OPEN_COLUMN_MIN_WIDTH_PX, Math.round(raw))
  );
}

/** Column width that fits the longest card title, clamped to fit min/max. */
export function fitColumnWidthForTitles(titles: string[]): number {
  return fitColumnWidthForContent({ cardTitles: titles });
}

/** Column width that fits card titles and pipeline header lines. */
export function fitColumnWidthForContent(content: ColumnFitContent): number {
  const titles = content.cardTitles;
  const headers = content.headerSegments ?? [];
  if (titles.length === 0 && headers.length === 0) {
    return OPEN_COLUMN_DEFAULT_WIDTH_PX;
  }
  let needed = 0;
  for (const title of titles) {
    needed = Math.max(
      needed,
      measureCardTitleWidth(title) + COLUMN_CARD_TITLE_CHROME_PX
    );
  }
  for (const segments of headers) {
    needed = Math.max(needed, measurePipelineHeaderSegments(segments));
  }
  return clampFitWidth(needed);
}

/** Per-column widths from visible card titles + headers (smart layout / auto-fit). */
export function smartOpenColumnWidths(
  contentByColumn: Record<ColumnKey, ColumnFitContent | string[]>
): Record<ColumnKey, number> {
  const widths = defaultColumnWidths();
  for (const key of COLUMN_KEYS) {
    const entry = contentByColumn[key];
    const content: ColumnFitContent = Array.isArray(entry)
      ? { cardTitles: entry }
      : (entry ?? { cardTitles: [] });
    widths[key] = fitColumnWidthForContent(content);
  }
  return widths;
}

export function resolveColumnCollapsed(args: {
  key: ColumnKey;
  pref: ColumnPref;
  count: number;
  hasPendingInput: boolean;
  recentlyActive: boolean;
  liveWorkActive: boolean;
}): boolean {
  const { key, pref, count, hasPendingInput, recentlyActive, liveWorkActive } =
    args;

  if (key === "needs_input" && hasPendingInput) {
    return false;
  }

  if (pref === "open") {
    return false;
  }

  if (pref === "collapsed") {
    return true;
  }

  if (count === 0) {
    return true;
  }

  if (key === "failed") {
    return !recentlyActive;
  }

  if (liveWorkActive && (key === "backlog" || key === "enabled")) {
    return true;
  }

  return false;
}

export function buildColumnMeta(args: {
  columnPrefs: Record<ColumnKey, ColumnPref>;
  visibleAutomations: Array<{ enabled: boolean }>;
  visibleRuns: Run[];
  pendingInputByRun: Record<string, unknown>;
  recentlyActiveFailed: boolean;
  runColumn: (status: Run["status"]) => ColumnKey;
}): Record<ColumnKey, ColumnMeta> {
  const {
    columnPrefs,
    visibleAutomations,
    visibleRuns,
    pendingInputByRun,
    recentlyActiveFailed,
    runColumn,
  } = args;

  const backlogCount = visibleAutomations.filter((a) => !a.enabled).length;
  const enabledCount = visibleAutomations.filter((a) => a.enabled).length;

  const runsByColumn = new Map<ColumnKey, Run[]>();
  for (const key of COLUMN_KEYS) {
    if (key !== "backlog" && key !== "enabled") {
      runsByColumn.set(key, []);
    }
  }
  for (const run of visibleRuns) {
    const col = runColumn(run.status);
    runsByColumn.get(col)?.push(run);
  }

  const runningCount = runsByColumn.get("running")?.length ?? 0;
  const needsInputRuns = runsByColumn.get("needs_input") ?? [];
  const hasPendingInput = needsInputRuns.some((r) => r.id in pendingInputByRun);
  const liveWorkActive = runningCount > 0 || hasPendingInput;

  const counts: Record<ColumnKey, number> = {
    backlog: backlogCount,
    enabled: enabledCount,
    running: runningCount,
    needs_input: needsInputRuns.length,
    completed: runsByColumn.get("completed")?.length ?? 0,
    failed: runsByColumn.get("failed")?.length ?? 0,
  };

  const meta = {} as Record<ColumnKey, ColumnMeta>;
  for (const key of COLUMN_KEYS) {
    const hasColPendingInput =
      key === "needs_input" &&
      (needsInputRuns.some((r) => r.id in pendingInputByRun) ?? false);
    meta[key] = {
      count: counts[key],
      collapsed: resolveColumnCollapsed({
        key,
        pref: columnPrefs[key],
        count: counts[key],
        hasPendingInput: hasColPendingInput,
        recentlyActive: key === "failed" ? recentlyActiveFailed : false,
        liveWorkActive,
      }),
    };
  }

  return meta;
}

/**
 * Choose the column the mobile board should open on, most attention-worthy first:
 * a run waiting on you, then live work, then results/failures, then idle columns.
 * Failed only outranks Completed when the latest failure is newer than the latest
 * completion (`failureNewerThanCompletion`), so an old failure doesn't shadow a
 * fresh successful run. Falls back to "running" when the board is empty so the
 * landing tab matches the historical default.
 */
/** Columns shown in the mobile swipe pager (empty columns are skipped unless selected). */
export function mobilePagerColumnKeys(
  meta: Record<ColumnKey, ColumnMeta>,
  activeColumn: ColumnKey
): ColumnKey[] {
  return COLUMN_KEYS.filter((key) => meta[key].count > 0 || key === activeColumn);
}

export function pickInitialMobileColumn(
  meta: Record<ColumnKey, ColumnMeta>,
  failureNewerThanCompletion = false
): ColumnKey {
  const priority: ColumnKey[] = [
    "needs_input",
    "running",
    ...(failureNewerThanCompletion
      ? (["failed", "completed"] as ColumnKey[])
      : (["completed", "failed"] as ColumnKey[])),
    "enabled",
    "backlog",
  ];
  return priority.find((key) => meta[key].count > 0) ?? "running";
}

export function buildGridTemplateColumns(
  meta: Record<ColumnKey, ColumnMeta>,
  widths: Record<ColumnKey, number>
): string {
  return COLUMN_KEYS.map((key) =>
    meta[key].collapsed
      ? COLLAPSED_COLUMN_WIDTH
      : `${clampColumnWidth(widths[key])}px`
  ).join(" ");
}
