/**
 * Pure unified-diff parser and path-shortening helper for transcript edit rows.
 * Total: never throws; malformed or incomplete input yields an explicit fallback.
 */

export type DiffLineKind = "context" | "added" | "removed";

export type ParsedDiffLine = {
  kind: DiffLineKind;
  /** Line content without the unified-diff prefix character. */
  text: string;
  /** 1-based old-file line number (context / removed). */
  oldLine?: number;
  /** 1-based new-file line number (context / added). */
  newLine?: number;
};

export type ParsedDiffHunk = {
  oldStart: number;
  newStart: number;
  /** Full `@@ … @@` header line, when present. */
  header: string;
  lines: ParsedDiffLine[];
};

export type ParseDiffResult =
  | { ok: true; hunks: ParsedDiffHunk[] }
  | { ok: false };

const HUNK_HEADER_RE =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/**
 * Compacts an absolute Windows/POSIX path into a user-meaningful label: anchored
 * at a known project root when present, otherwise the trailing few segments.
 */
export function shortenPath(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const anchors = ["/docs/roadmap/", "/.cursor/", "/packages/", "/tests/"];
  for (const anchor of anchors) {
    const idx = norm.indexOf(anchor);
    if (idx !== -1) return norm.slice(idx + 1);
  }
  const segments = norm.split("/").filter(Boolean);
  return segments.slice(-3).join("/") || norm;
}

function splitDiffLines(input: string): string[] {
  // Normalize CRLF and lone CR so Windows payloads match LF parsing.
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

function isFileHeaderLine(line: string): boolean {
  return (
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  );
}

function parseHunkHeader(
  line: string
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const m = HUNK_HEADER_RE.exec(line);
  if (!m) return null;
  const oldStart = Number(m[1]);
  const oldCount = m[2] !== undefined ? Number(m[2]) : 1;
  const newStart = Number(m[3]);
  const newCount = m[4] !== undefined ? Number(m[4]) : 1;
  if (
    !Number.isSafeInteger(oldStart) ||
    !Number.isSafeInteger(oldCount) ||
    !Number.isSafeInteger(newStart) ||
    !Number.isSafeInteger(newCount) ||
    oldStart < 0 ||
    oldCount < 0 ||
    newStart < 0 ||
    newCount < 0
  ) {
    return null;
  }
  return { oldStart, oldCount, newStart, newCount };
}

/**
 * Parse a unified diff string into tagged, line-numbered hunks.
 * Returns `{ ok: false }` for empty, incomplete, count-mismatched, or
 * unrecognized input — never a partial structure.
 */
export function parseUnifiedDiff(diffString: string): ParseDiffResult {
  if (typeof diffString !== "string" || diffString.length === 0) {
    return { ok: false };
  }

  const lines = splitDiffLines(diffString);
  let i = 0;

  // Optional file / git headers before the first hunk.
  while (i < lines.length && isFileHeaderLine(lines[i]!)) {
    i++;
  }

  // Skip blank lines between headers and hunks.
  while (i < lines.length && lines[i] === "") {
    i++;
  }

  if (i >= lines.length || !lines[i]!.startsWith("@@")) {
    return { ok: false };
  }

  const hunks: ParsedDiffHunk[] = [];

  while (i < lines.length) {
    const headerLine = lines[i]!;
    if (headerLine === "") {
      i++;
      continue;
    }
    if (headerLine === NO_NEWLINE_MARKER) {
      return { ok: false };
    }

    const header = parseHunkHeader(headerLine);
    if (!header) {
      return { ok: false };
    }
    i++;

    const hunkLines: ParsedDiffLine[] = [];
    let oldSeen = 0;
    let newSeen = 0;
    let oldLine = header.oldStart;
    let newLine = header.newStart;

    while (
      i < lines.length &&
      (oldSeen < header.oldCount || newSeen < header.newCount)
    ) {
      const raw = lines[i]!;
      if (raw.startsWith("@@")) {
        // Next hunk before this one finished its declared counts.
        return { ok: false };
      }
      if (raw === NO_NEWLINE_MARKER) {
        // Marker does not consume old/new counts; allow between body lines.
        i++;
        continue;
      }
      if (raw.length === 0) {
        // Empty line has no prefix — not valid inside a hunk.
        return { ok: false };
      }

      const prefix = raw[0]!;
      const text = raw.slice(1);

      if (prefix === " ") {
        if (oldSeen >= header.oldCount || newSeen >= header.newCount) {
          return { ok: false };
        }
        hunkLines.push({
          kind: "context",
          text,
          oldLine,
          newLine,
        });
        oldSeen++;
        newSeen++;
        oldLine++;
        newLine++;
      } else if (prefix === "-") {
        if (oldSeen >= header.oldCount) {
          return { ok: false };
        }
        hunkLines.push({
          kind: "removed",
          text,
          oldLine,
        });
        oldSeen++;
        oldLine++;
      } else if (prefix === "+") {
        if (newSeen >= header.newCount) {
          return { ok: false };
        }
        hunkLines.push({
          kind: "added",
          text,
          newLine,
        });
        newSeen++;
        newLine++;
      } else {
        return { ok: false };
      }
      i++;
    }

    if (oldSeen !== header.oldCount || newSeen !== header.newCount) {
      return { ok: false };
    }

    // Trailing no-newline marker after a complete hunk is fine.
    if (i < lines.length && lines[i] === NO_NEWLINE_MARKER) {
      i++;
    }

    hunks.push({
      oldStart: header.oldStart,
      newStart: header.newStart,
      header: headerLine,
      lines: hunkLines,
    });
  }

  if (hunks.length === 0) {
    return { ok: false };
  }

  return { ok: true, hunks };
}
