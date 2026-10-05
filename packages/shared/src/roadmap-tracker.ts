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

const REQUIRED_HEADERS = [
  "Phase",
  "File",
  "Status",
  "Depends on",
  "Commit",
] as const;

const STATUS_ALIASES: Record<string, TrackerPhaseStatus> = {
  pending: "Pending",
  "in progress": "In Progress",
  done: "Done",
  complete: "Complete",
};

const PHASE_CELL_RE = /^(\d+)\s*(?:—|-)\s*(.+)$/;

function normalizeStatus(raw: string): TrackerPhaseStatus {
  const key = raw.trim().toLowerCase();
  const mapped = STATUS_ALIASES[key];
  if (!mapped) {
    throw new RoadmapTrackerError(
      "unknown-status",
      `Unknown tracker status "${raw.trim()}"`
    );
  }
  return mapped;
}

function parseDependsOn(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "—" || trimmed === "-") {
    return [];
  }
  const parts = trimmed.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      throw new RoadmapTrackerError(
        "malformed-dependency",
        `Malformed tracker dependency "${part}"`
      );
    }
  }
  return parts;
}

function parseHeaderRow(cells: string[]): void {
  if (cells.length > REQUIRED_HEADERS.length) {
    throw new RoadmapTrackerError(
      "extra-header",
      "Tracker table must have exactly five columns: Phase | File | Status | Depends on | Commit"
    );
  }
  if (cells.length !== REQUIRED_HEADERS.length) {
    throw new RoadmapTrackerError(
      "misordered-header",
      "Tracker table must have exactly five columns: Phase | File | Status | Depends on | Commit"
    );
  }
  for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
    if (cells[i]!.trim() !== REQUIRED_HEADERS[i]) {
      throw new RoadmapTrackerError(
        "misordered-header",
        "Tracker table must have exactly five columns: Phase | File | Status | Depends on | Commit"
      );
    }
  }
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
  const trimmed = cell.trim();
  if (!trimmed || trimmed === "—" || trimmed === "-") {
    throw new RoadmapTrackerError(
      "missing-link",
      "Tracker phase row is missing a linked file"
    );
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
      parseHeaderRow(cells);
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

    if (cells.length !== REQUIRED_HEADERS.length) continue;
    if (isSeparatorRow(cells)) continue;

    const phaseCell = cells[0]!;
    const phaseMatch = PHASE_CELL_RE.exec(phaseCell);
    if (!phaseMatch) {
      throw new RoadmapTrackerError(
        "malformed-dependency",
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
    const dependsOn = parseDependsOn(cells[3]!);
    const commit = cells[4]!.trim();

    phases.push({
      number,
      title: phaseMatch[2]!.trim(),
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
