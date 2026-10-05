import { describe, expect, it } from "vitest";
import {
  classifyId,
  compileIdTemplate,
  defaultIdFormats,
  hasPerPersonNextMarker,
  IdFormatError,
  isEpicId,
  isRoadmapIdCandidate,
  isValidFeatureSlug,
  KickoffError,
  parseIdFormatDeclarations,
  parseNextMarkers,
  ROADMAP_FORMAT_DOC,
  ROADMAP_ID_CANDIDATE_SOURCE,
  slugRegexForFeatureId,
  validateFeatureSlugIdea,
  resolveImplementFullyKickoffSchema,
} from "@lca/shared";

describe("roadmap-ids candidate shape", () => {
  it("accepts legacy, per-person, epic, and declared-prefix tokens", () => {
    for (const id of ["b42", "b-xy58", "e-xy1", "dm58", "zz1"]) {
      expect(isRoadmapIdCandidate(id), id).toBe(true);
    }
  });

  it("rejects feature-42, nope, and ux-v2", () => {
    for (const id of ["feature-42", "nope", "ux-v2"]) {
      expect(isRoadmapIdCandidate(id), id).toBe(false);
    }
  });

  it("enforces prefix, owner, and digit bounds", () => {
    expect(isRoadmapIdCandidate("abcdefgh1")).toBe(true);
    expect(isRoadmapIdCandidate("abcdefghi1")).toBe(false);
    expect(isRoadmapIdCandidate("b-ab1")).toBe(true);
    expect(isRoadmapIdCandidate("b-abc1")).toBe(true);
    expect(isRoadmapIdCandidate("b-a1")).toBe(false);
    expect(isRoadmapIdCandidate("b-abcd1")).toBe(false);
    expect(isRoadmapIdCandidate("b1")).toBe(true);
    expect(isRoadmapIdCandidate("b123456")).toBe(true);
    expect(isRoadmapIdCandidate("b1234567")).toBe(false);
  });

  it("exports a stable candidate source string", () => {
    expect(ROADMAP_ID_CANDIDATE_SOURCE).toBe(
      "^[a-z]{1,8}(?:-[a-z]{2,3})?\\d{1,6}$"
    );
  });
});

describe("roadmap-ids default formats", () => {
  const formats = defaultIdFormats();

  it("classifies legacy and per-person feature ids", () => {
    expect(classifyId("b42", formats)).toBe("feature");
    expect(classifyId("b-xy58", formats)).toBe("feature");
  });

  it("classifies epic ids separately from features", () => {
    expect(classifyId("e1", formats)).toBe("epic");
    expect(classifyId("e-xy1", formats)).toBe("epic");
    expect(isEpicId("e-xy1", formats)).toBe(true);
  });

  it("marks non-default prefixes as unknown against defaults", () => {
    expect(classifyId("dm58", formats)).toBe("unknown");
    expect(classifyId("zz1", formats)).toBe("unknown");
  });
});

describe("roadmap-ids template compilation", () => {
  it("compiles comma-separated alternatives", () => {
    const compiled = compileIdTemplate("b<n>, b-<owner><n>");
    expect(compiled.anchored.test("b42")).toBe(true);
    expect(compiled.anchored.test("b-xy58")).toBe(true);
    expect(compiled.anchored.test("e-xy1")).toBe(false);
    expect(compiled.anchored.source).toContain("\\d+");
    expect(compiled.unanchored.source).toContain("\\d+");
  });

  it("rejects missing trailing <n>", () => {
    expect(() => compileIdTemplate("b-<owner>")).toThrow(IdFormatError);
    try {
      compileIdTemplate("b-<owner>");
    } catch (err) {
      expect(err).toBeInstanceOf(IdFormatError);
      expect((err as IdFormatError).code).toBe("missing_trailing_n");
      expect((err as IdFormatError).message).toContain(ROADMAP_FORMAT_DOC);
    }
  });

  it("rejects empty alternatives, non-terminal <n>, and repeated placeholders", () => {
    expect(() => compileIdTemplate("b<n>,")).toThrow(IdFormatError);
    try {
      compileIdTemplate("b<n>,");
    } catch (err) {
      expect((err as IdFormatError).code).toBe("empty_alternative");
    }
    try {
      compileIdTemplate("b<n>x");
    } catch (err) {
      expect((err as IdFormatError).code).toBe("missing_trailing_n");
    }
    try {
      compileIdTemplate("b<n><n>");
    } catch (err) {
      expect((err as IdFormatError).code).toBe("multiple_n");
    }
    try {
      compileIdTemplate("b-<owner><owner><n>");
    } catch (err) {
      expect((err as IdFormatError).code).toBe("invalid_syntax");
    }
  });

  it("rejects duplicate declarations from index markdown", () => {
    const markdown = [
      "<!-- id-format: b<n> -->",
      "<!-- id-format: b-<owner><n> -->",
    ].join("\n");
    expect(() => parseIdFormatDeclarations(markdown)).toThrow(IdFormatError);
    try {
      parseIdFormatDeclarations(markdown);
    } catch (err) {
      expect((err as IdFormatError).code).toBe("duplicate_declaration");
      expect((err as IdFormatError).declarationKind).toBe("feature");
      expect((err as IdFormatError).message).toContain(ROADMAP_FORMAT_DOC);
    }
  });

  it("labels epic declaration errors as epic", () => {
    try {
      parseIdFormatDeclarations("<!-- epic-format: e.*<n> -->");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IdFormatError);
      expect((err as IdFormatError).code).toBe("raw_regex");
      expect((err as IdFormatError).declarationKind).toBe("epic");
      expect((err as IdFormatError).message).toContain(ROADMAP_FORMAT_DOC);
    }
  });

  it("rejects an empty id-format declaration", () => {
    try {
      parseIdFormatDeclarations("<!-- id-format: -->");
      expect.unreachable();
    } catch (err) {
      expect((err as IdFormatError).code).toBe("empty_alternative");
      expect((err as IdFormatError).declarationKind).toBe("feature");
    }
  });

  it("parses declared formats and falls back to defaults", () => {
    const markdown = "<!-- id-format: dm<owner><n> -->";
    const formats = parseIdFormatDeclarations(markdown);
    expect(formats.feature.source).toBe("declared");
    expect(formats.feature.anchored.test("dmxy58")).toBe(true);
    expect(formats.epic.source).toBe("default");
    expect(formats.epic.anchored.test("e-xy1")).toBe(true);
  });

  it("rejects raw regex syntax in templates", () => {
    expect(() => compileIdTemplate("b.*<n>")).toThrow(IdFormatError);
  });
});

describe("roadmap-ids slug derivation", () => {
  it("derives slug regex from the concrete feature id", () => {
    expect(isValidFeatureSlug("b42", "b42-my-feature")).toBe(true);
    expect(isValidFeatureSlug("b-xy58", "b-xy58-some-feature")).toBe(true);
    expect(slugRegexForFeatureId("b-xy58").test("b-xy58-some-feature")).toBe(
      true
    );
    expect(isValidFeatureSlug("b-xy58", "b42-other")).toBe(false);
  });
});

describe("roadmap-ids next markers", () => {
  const markdown = [
    "<!-- next: b42 -->",
    "<!-- next: b-xy58 -->",
  ].join("\n");

  it("exposes plain and per-person marker matches", () => {
    const markers = parseNextMarkers(markdown);
    expect(markers).toEqual([
      { kind: "plain", id: "b42", raw: "<!-- next: b42 -->" },
      { kind: "per-person", id: "b-xy58", raw: "<!-- next: b-xy58 -->" },
    ]);
  });

  it("detects per-person marker presence", () => {
    expect(hasPerPersonNextMarker(markdown)).toBe(true);
    expect(hasPerPersonNextMarker("<!-- next: b42 -->")).toBe(false);
  });
});

describe("roadmap-ids kickoff shape integration", () => {
  it("passes b-xy58 and e-xy1 through schema shape validation", () => {
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "feature-id", featureId: "b-xy58" },
      }).success
    ).toBe(true);
    expect(
      resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "feature-id", featureId: "e-xy1" },
      }).success
    ).toBe(true);
  });

  it("rejects feature-42, nope, and ux-v2 at schema layer", () => {
    for (const featureId of ["feature-42", "nope", "ux-v2"]) {
      const parsed = resolveImplementFullyKickoffSchema.safeParse({
        workspaceId: "ws",
        input: { kind: "feature-id", featureId },
      });
      expect(parsed.success, featureId).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toMatch(/^featureId must match/);
      }
    }
  });

  it("accepts b-xy58 slug triple validation and keeps pinned prefixes", () => {
    expect(() =>
      validateFeatureSlugIdea("b-xy58", "b-xy58-some-feature", "ship it")
    ).not.toThrow();
    expect(() => validateFeatureSlugIdea("42", "42-x", "idea")).toThrow(
      KickoffError
    );
    expect(() => validateFeatureSlugIdea("42", "42-x", "idea")).toThrow(
      /^Invalid --feature/
    );
    expect(() =>
      validateFeatureSlugIdea("b42", "b99-other", "idea")
    ).toThrow(/^Slug "b99-other" must start with "b42-"/);
    expect(() => validateFeatureSlugIdea("b42", "b42_Bad", "idea")).toThrow(
      /^Invalid --slug/
    );
  });
});
