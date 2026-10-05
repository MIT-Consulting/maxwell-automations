/**
 * Pure feature-folder phase tracker parsing.
 * No fs, fetch, process, daemon, or dashboard imports.
 */

export type TrackerPhaseStatus =
  | "Pending"
  | "In Progress"
  | "Done"
  | "Complete";

export type TrackerPhase = {
  number: number;
  title: string;
  /** Linked href or plain path; `""` when the row has no file (legacy `—`). */
  file: string;
  status: TrackerPhaseStatus;
  dependsOn: string[];
  commit: string;
};

export type ParsedRoadmapTracker = {
  phases: TrackerPhase[];
  /** First Pending or In Progress phase, if any. */
  nextExecutable: { number: number; status: TrackerPhaseStatus } | null;
};

export type RoadmapTrackerErrorCode =
  | "missing-header"
  | "misordered-header"
  | "extra-header"
  | "unknown-status"
  | "duplicate-phase"
  | "malformed-phase"
  | "malformed-dependency"
  | "missing-link";

export class RoadmapTrackerError extends Error {
  constructor(
    public readonly code: RoadmapTrackerErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RoadmapTrackerError";
  }
}

const FIVE_COLUMN_HEADERS = [
  "Phase",
  "File",
  "Status",
  "Depends on",
  "Commit",
] as const;

const FOUR_COLUMN_HEADERS = ["Phase", "File", "Status", "Commit"] as const;

const HEADER_MISMATCH_MESSAGE =
  "Tracker table must have exactly five columns: Phase | File | Status | Depends on | Commit";

const STATUS_PREFIXES: { word: string; status: TrackerPhaseStatus }[] = [
  { word: "in progress", status: "In Progress" },
  { word: "pending", status: "Pending" },
  { word: "done", status: "Done" },
  { word: "complete", status: "Complete" },
];

// Accepted Phase cells: `1`, `1 — Title`, `1 - Title`, `1. Title`, `1: Title`,
// `P0 — Title`, `Phase 2 — Title`. The number is what the pipeline keys on.
const PHASE_CELL_RE =
  /^(?:P(?:hase)?\s*)?(\d+)(?:\s*(?:—|–|-|\.|:|\))\s*(.*))?$/i;

function normalizeStatus(raw: string): TrackerPhaseStatus {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  for (const { word, status } of STATUS_PREFIXES) {
    if (lower === word) return status;
    if (lower.startsWith(word)) {
      const rest = trimmed.slice(word.length);
      if (rest.length === 0) return status;
      if (/^\s*(?:—|-|:|\()/.test(rest)) return status;
      break;
    }
  }

  throw new RoadmapTrackerError(
    "unknown-status",
    `Unknown tracker status "${trimmed}"`
  );
}

function parseDependsOn(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "—" || trimmed === "-") {
    return [];
  }
  const parts = trimmed.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  const numbers: string[] = [];
  for (const part of parts) {
    // Same prefixes the Phase cell accepts, so `P1` can depend on `P0`.
    const match = /^(?:P(?:hase)?\s*)?(\d+)$/i.exec(part);
    if (!match) {
      throw new RoadmapTrackerError(
        "malformed-dependency",
        `Malformed tracker dependency "${part}"`
      );
    }
    numbers.push(match[1]!);
  }
  return numbers;
}

type HeaderLayout = { columns: 4 | 5 };

function headerCellMatches(actual: string, expected: string): boolean {
  return actual.trim().toLowerCase() === expected.toLowerCase();
}

function parseHeaderRow(cells: string[]): HeaderLayout {
  if (cells.length > FIVE_COLUMN_HEADERS.length) {
    throw new RoadmapTrackerError("extra-header", HEADER_MISMATCH_MESSAGE);
  }

  const tryMatch = (
    expected: readonly string[],
    columns: 4 | 5
  ): HeaderLayout | null => {
    if (cells.length !== expected.length) return null;
    for (let i = 0; i < expected.length; i++) {
      if (!headerCellMatches(cells[i]!, expected[i]!)) return null;
    }
    return { columns };
  };

  const five = tryMatch(FIVE_COLUMN_HEADERS, 5);
  if (five) return five;

  const four = tryMatch(FOUR_COLUMN_HEADERS, 4);
  if (four) return four;

  throw new RoadmapTrackerError("misordered-header", HEADER_MISMATCH_MESSAGE);
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function extractLinkedFile(cell: string): string {
  const linkMatch = cell.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (linkMatch) {
    const href = linkMatch[2]!.trim();
    if (!href) {
      throw new RoadmapTrackerError(
        "missing-link",
        "Tracker phase row is missing a linked file"
      );
    }
    return href;
  }
  // Legacy trackers leave the File cell blank or `—` for phases that never
  // had a doc (often already Done). Read the row; the number is what matters.
  const trimmed = cell.trim();
  if (!trimmed || trimmed === "—" || trimmed === "-") {
    return "";
  }
  return trimmed;
}

function findNextExecutable(
  phases: TrackerPhase[]
): { number: number; status: TrackerPhaseStatus } | null {
  for (const phase of phases) {
    if (phase.status === "In Progress") {
      return { number: phase.number, status: phase.status };
    }
  }
  for (const phase of phases) {
    if (phase.status === "Pending") {
      return { number: phase.number, status: phase.status };
    }
  }
  return null;
}

/**
 * Parse a feature-folder `00-index.md` phase tracker table.
 * An empty but valid tracker (header + separator only) is valid.
 */
export function parseRoadmapTracker(markdown: string): ParsedRoadmapTracker {
  const lines = markdown.split(/\r?\n/);
  let headerFound = false;
  let pastSeparator = false;
  let columnCount: 4 | 5 = 5;
  const phases: TrackerPhase[] = [];
  const seenNumbers = new Set<number>();

  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length === 0) continue;

    if (!headerFound) {
      columnCount = parseHeaderRow(cells).columns;
      headerFound = true;
      continue;
    }

    if (!pastSeparator) {
      if (!isSeparatorRow(cells)) {
        throw new RoadmapTrackerError(
          "extra-header",
          "Tracker table separator row is missing or malformed"
        );
      }
      pastSeparator = true;
      continue;
    }

    if (cells.length !== columnCount) continue;
    if (isSeparatorRow(cells)) continue;

    const phaseCell = cells[0]!;
    const phaseMatch = PHASE_CELL_RE.exec(phaseCell);
    if (!phaseMatch) {
      throw new RoadmapTrackerError(
        "malformed-phase",
        `Malformed tracker phase cell "${phaseCell}"`
      );
    }

    const number = Number.parseInt(phaseMatch[1]!, 10);
    if (seenNumbers.has(number)) {
      throw new RoadmapTrackerError(
        "duplicate-phase",
        `Duplicate tracker phase number ${number}`
      );
    }
    seenNumbers.add(number);

    const file = extractLinkedFile(cells[1]!);
    const status = normalizeStatus(cells[2]!);
    const dependsOn =
      columnCount === 5 ? parseDependsOn(cells[3]!) : [];
    const commit =
      columnCount === 5 ? cells[4]!.trim() : cells[3]!.trim();

    phases.push({
      number,
      title: phaseMatch[2]?.trim() ?? "",
      file,
      status,
      dependsOn,
      commit,
    });
  }

  if (!headerFound) {
    throw new RoadmapTrackerError(
      "missing-header",
      "Tracker table is missing the required header row"
    );
  }

  return {
    phases,
    nextExecutable: findNextExecutable(phases),
  };
}
