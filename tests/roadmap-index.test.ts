import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IdFormatError,
  parseBacklogEntries,
  parseRoadmapIndex,
  parseTableEntries,
  pickCanonicalEntry,
  defaultIdFormats,
  sectionBody,
} from "@lca/shared";

const REPO_INDEX = readFileSync(
  join(process.cwd(), "docs/roadmap/00-index.md"),
  "utf8"
);

/** Legacy-only parser shape for parity against pre-migration behavior. */
function legacyParseIndexEntries(markdown: string): Array<{
  featureId: string;
  section: string;
}> {
  const FEATURE_RE = /^b\d+$/;
  const out: Array<{ featureId: string; section: string }> = [];

  const backlog = sectionBody(markdown, "Backlog");
  if (backlog) {
    for (const line of backlog.split(/\r?\n/)) {
      const m = line.match(/^- \*\*(b\d+)\*\*\s+/);
      if (m) out.push({ featureId: m[1]!, section: "backlog" });
    }
  }
  for (const [heading, section] of [
    ["Completed", "completed"],
    ["Documented Ideas", "documented-ideas"],
  ] as const) {
    const body = sectionBody(markdown, heading);
    if (!body) continue;
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      const id = cells[0];
      if (!id || !FEATURE_RE.test(id) || id === "ID" || /^[-:]+$/.test(id)) {
        continue;
      }
      out.push({ featureId: id, section });
    }
  }
  return out;
}

describe("parseRoadmapIndex", () => {
  it("parses canonical sections with default formats", () => {
    const markdown = `# Roadmap

<!-- next: b99 -->

## Backlog (prioritized)

- **b67** Playoff totals — count boxes.

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
| b65 | Team pages | Roster | [docs](./x.md) |

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
| b21 | Commercial | Planned | [x](./y.md) |
`;
    const parsed = parseRoadmapIndex(markdown);
    expect(parsed.entries.map((e) => e.featureId)).toEqual(["b67", "b65", "b21"]);
    expect(parsed.markers).toHaveLength(1);
    expect(parsed.markers[0]).toMatchObject({ kind: "plain", id: "b99" });
  });

  it("accepts per-person feature ids in tables", () => {
    const markdown = `# Roadmap

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
| b-xy58 | Per-person row | Planned | [x](./z.md) |
`;
    const parsed = parseRoadmapIndex(markdown);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.featureId).toBe("b-xy58");
  });

  it("parses epics from ## Epics and ignores unrelated tables", () => {
    const markdown = `# Roadmap

## Epics

| ID | Epic | Children |
| --- | ---- | -------- |
| e-xy1 | Parent | b-xy58 |

### P1 — Other

| ID | Item |
| --- | ---- |
| p99 | Ignored |
`;
    const parsed = parseRoadmapIndex(markdown);
    expect(parsed.epics).toEqual([
      { epicId: "e-xy1", title: "Parent", raw: expect.any(String) },
    ]);
    expect(parsed.entries).toHaveLength(0);
  });

  it("collects per-person and plain markers", () => {
    const markdown = `# Roadmap

<!-- next: b44 -->
<!-- next: b-xy64 -->
<!-- next: b-qr57 -->
`;
    const parsed = parseRoadmapIndex(markdown);
    expect(parsed.markers.some((m) => m.kind === "plain" && m.id === "b44")).toBe(
      true
    );
    expect(
      parsed.markers.filter((m) => m.kind === "per-person").map((m) => m.id)
    ).toEqual(["b-xy64", "b-qr57"]);
  });

  it("throws on duplicate format declarations", () => {
    const markdown = `# Roadmap
<!-- id-format: b<n> -->
<!-- id-format: b-<owner><n> -->
`;
    expect(() => parseRoadmapIndex(markdown)).toThrow(IdFormatError);
  });

  it("throws on duplicate entries in the same section via pickCanonicalEntry", () => {
    const formats = defaultIdFormats();
    const entries = parseBacklogEntries(
      "- **b42** One — a.\n- **b42** Two — b.",
      formats.feature
    );
    expect(() => pickCanonicalEntry(entries, "b42")).toThrow(/duplicate/i);
  });

  it("ignores id-format mentions inside backlog prose", () => {
    const markdown = `# Roadmap

## Backlog

- **b77** Optional \`<!-- id-format: … -->\` mention in prose — not a declaration.
`;
    expect(() => parseRoadmapIndex(markdown)).not.toThrow();
    expect(parseRoadmapIndex(markdown).formats.feature.source).toBe("default");
  });

  it("matches legacy feature entries and order on the repository index", () => {
    const legacy = legacyParseIndexEntries(REPO_INDEX);
    const parsed = parseRoadmapIndex(REPO_INDEX);
    const canonical = parsed.entries.map((e) => ({
      featureId: e.featureId,
      section: e.section,
    }));
    const legacyIds = legacy.map((e) => e.featureId);
    const canonicalLegacy = canonical.filter((e) => /^b\d+$/.test(e.featureId));
    expect(canonicalLegacy.map((e) => e.featureId)).toEqual(legacyIds);
    for (let i = 0; i < legacy.length; i++) {
      expect(canonicalLegacy[i]!.section).toBe(legacy[i]!.section);
    }
  });

  it("honors declared id-format templates", () => {
    const markdown = `# Roadmap
<!-- id-format: dm<n>, dm-<owner><n> -->

## Backlog

- **dm58** Declared prefix — works.
- **b42** Legacy row — ignored under declared format.
`;
    const parsed = parseRoadmapIndex(markdown);
    expect(parsed.entries.map((e) => e.featureId)).toEqual(["dm58"]);
    expect(parsed.formats.feature.source).toBe("declared");
  });

  it("extracts hrefs on entries", () => {
    const formats = defaultIdFormats();
    const entries = parseTableEntries(
      "| b15 | Title | Status | [doc](./b15-x.md#section) |",
      "documented-ideas",
      formats.feature
    );
    expect(entries[0]!.hrefs).toEqual(["./b15-x.md#section"]);
  });

  it("parses Documented Ideas when Backlog is absent", () => {
    const markdown = `# Roadmap

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
| b-xy58 | Only ideas | Planned | [x](./z.md) |
`;
    const parsed = parseRoadmapIndex(markdown);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({
      featureId: "b-xy58",
      section: "documented-ideas",
    });
  });

  it("rejects substring ids that are not whole-format tokens", () => {
    const formats = defaultIdFormats();
    const entries = parseTableEntries(
      "| xb42 | Nope | Planned | x |\n| b42-extra | Nope | Planned | x |\n| b42 | Yes | Planned | x |",
      "documented-ideas",
      formats.feature
    );
    expect(entries.map((e) => e.featureId)).toEqual(["b42"]);
  });
});
