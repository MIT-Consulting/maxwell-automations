import { describe, expect, it } from "vitest";
import {
  parseUnifiedDiff,
  shortenPath,
} from "../packages/dashboard/src/diff.ts";

/** Realistic +1 -1 edit (b46.01-shaped) that motivated the inline viewer. */
const PLUS_ONE_MINUS_ONE = [
  "--- a/packages/dashboard/src/transcript.tsx",
  "+++ b/packages/dashboard/src/transcript.tsx",
  "@@ -10,3 +10,3 @@",
  " import { cn } from \"@/lib/utils\";",
  "-import { oldHelper } from \"./helpers\";",
  "+import { formatClock } from \"./helpers\";",
  " import { PromptReferenceText } from \"./PromptReferenceText\";",
].join("\n");

/** Mirrors the repaired multi-hunk seed fixture in scripts/seed-run-fixture.mjs. */
const SEED_EDIT_DIFF = [
  "--- a/packages/dashboard/src/normalizeEvent.ts",
  "+++ b/packages/dashboard/src/normalizeEvent.ts",
  "@@ -100,3 +100,3 @@",
  " function toolDetail(value) {",
  "-  return String(value);",
  "+  return asRecord(parsed.result)?.value;",
  " }",
  "@@ -520,6 +521,7 @@",
  "     case \"thinking\": {",
  "       const { text } = parsed ? extractMessageContent(parsed) : { text: \"\" };",
  "+      const thinkingDurationMs = optNum(parsed?.thinking_duration_ms);",
  "       return {",
  "         ...base(ev, \"thinking\"),",
  "         title: \"thinking\",",
  "         body: text,",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("parses a single-hunk diff with correct tags and line numbers", () => {
    const result = parseUnifiedDiff(PLUS_ONE_MINUS_ONE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks).toHaveLength(1);
    const lines = result.hunks[0]!.lines;
    expect(lines).toEqual([
      {
        kind: "context",
        text: 'import { cn } from "@/lib/utils";',
        oldLine: 10,
        newLine: 10,
      },
      {
        kind: "removed",
        text: 'import { oldHelper } from "./helpers";',
        oldLine: 11,
      },
      {
        kind: "added",
        text: 'import { formatClock } from "./helpers";',
        newLine: 11,
      },
      {
        kind: "context",
        text: 'import { PromptReferenceText } from "./PromptReferenceText";',
        oldLine: 12,
        newLine: 12,
      },
    ]);
  });

  it("parses a multi-hunk seed-shaped diff with independent numbering", () => {
    const result = parseUnifiedDiff(SEED_EDIT_DIFF);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[0]!.oldStart).toBe(100);
    expect(result.hunks[0]!.newStart).toBe(100);
    expect(result.hunks[1]!.oldStart).toBe(520);
    expect(result.hunks[1]!.newStart).toBe(521);

    const h1 = result.hunks[0]!.lines;
    expect(h1.map((l) => l.kind)).toEqual([
      "context",
      "removed",
      "added",
      "context",
    ]);
    expect(h1[1]).toMatchObject({ kind: "removed", oldLine: 101 });
    expect(h1[2]).toMatchObject({ kind: "added", newLine: 101 });

    const h2 = result.hunks[1]!.lines;
    expect(h2.map((l) => l.kind)).toEqual([
      "context",
      "context",
      "added",
      "context",
      "context",
      "context",
      "context",
    ]);
    expect(h2[2]).toMatchObject({
      kind: "added",
      newLine: 523,
      text: "      const thinkingDurationMs = optNum(parsed?.thinking_duration_ms);",
    });
    expect(h2[6]).toMatchObject({ kind: "context", oldLine: 525, newLine: 527 });
  });

  it("parses added-only and removed-only hunks", () => {
    const addedOnly = [
      "@@ -5,0 +6,2 @@",
      "+first",
      "+second",
    ].join("\n");
    const added = parseUnifiedDiff(addedOnly);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.hunks[0]!.lines).toEqual([
      { kind: "added", text: "first", newLine: 6 },
      { kind: "added", text: "second", newLine: 7 },
    ]);

    const removedOnly = [
      "@@ -8,2 +7,0 @@",
      "-gone",
      "-also",
    ].join("\n");
    const removed = parseUnifiedDiff(removedOnly);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.hunks[0]!.lines).toEqual([
      { kind: "removed", text: "gone", oldLine: 8 },
      { kind: "removed", text: "also", oldLine: 9 },
    ]);
  });

  it("parses CRLF identically to LF", () => {
    const lf = parseUnifiedDiff(PLUS_ONE_MINUS_ONE);
    const crlf = parseUnifiedDiff(PLUS_ONE_MINUS_ONE.replace(/\n/g, "\r\n"));
    expect(crlf).toEqual(lf);
  });

  it("does not double-interpret +/− inside line content", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old +value",
      "+new -value",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks[0]!.lines[1]).toEqual({
      kind: "removed",
      text: "old +value",
      oldLine: 2,
    });
    expect(result.hunks[0]!.lines[2]).toEqual({
      kind: "added",
      text: "new -value",
      newLine: 2,
    });
  });

  it("falls back on truncated mid-hunk input", () => {
    const truncated = [
      "@@ -1,4 +1,4 @@",
      " a",
      "-b",
      "+c",
      // missing final context line declared by counts
    ].join("\n");
    expect(parseUnifiedDiff(truncated)).toEqual({ ok: false });
  });

  it("falls back on empty and malformed input", () => {
    expect(parseUnifiedDiff("")).toEqual({ ok: false });
    expect(parseUnifiedDiff("--- a/x\n+++ b/x\n")).toEqual({ ok: false });
    expect(parseUnifiedDiff("not a diff at all")).toEqual({ ok: false });
    expect(parseUnifiedDiff("@@ garbage @@\n+line")).toEqual({ ok: false });
  });

  it("accepts optional file headers and the no-newline marker", () => {
    const diff = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "\\ No newline at end of file",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hunks[0]!.lines).toHaveLength(2);
  });

  it("falls back on count mismatch and unexpected prefixes", () => {
    const mismatch = [
      "@@ -1,3 +1,3 @@",
      " a",
      "-b",
      "+c",
    ].join("\n");
    expect(parseUnifiedDiff(mismatch)).toEqual({ ok: false });

    const badPrefix = [
      "@@ -1,1 +1,1 @@",
      "?weird",
    ].join("\n");
    expect(parseUnifiedDiff(badPrefix)).toEqual({ ok: false });
  });
});

describe("shortenPath", () => {
  it("anchors at known project roots", () => {
    expect(
      shortenPath(
        "C:\\Users\\dev\\app\\packages\\dashboard\\src\\transcript.tsx"
      )
    ).toBe("packages/dashboard/src/transcript.tsx");
    expect(
      shortenPath("C:/Users/dev/app/docs/roadmap/00-index.md")
    ).toBe("docs/roadmap/00-index.md");
  });
});
