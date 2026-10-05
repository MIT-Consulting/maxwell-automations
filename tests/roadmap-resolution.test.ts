import { describe, expect, it } from "vitest";
import {
  deriveSlug,
  linkPathStem,
  matchingSlugCandidates,
  resolveSlugFromChildren,
  selectByLink,
  splitHrefPathFragment,
  SYMLINK_CANDIDATE_MESSAGE,
  type RoadmapChild,
} from "@lca/shared";

describe("roadmap-resolution pure helpers", () => {
  it("derives slugs from title text", () => {
    const result = deriveSlug("b37", "Cleaner board columns — resize and persist widths.");
    expect(result).toEqual({
      ok: true,
      slug: "b37-cleaner-board-columns-resize-and-persist",
    });
  });

  it("selects candidates by index link stem", () => {
    const candidates = ["b10-chosen-slug", "b10-other-slug"];
    const links = ["docs/roadmap/b10-chosen-slug/00-index.md"];
    expect(selectByLink(candidates, links)).toBe("b10-chosen-slug");
    expect(selectByLink(candidates, [])).toBeNull();
  });

  it("extracts link path stems with fragments preserved separately", () => {
    expect(
      linkPathStem("docs/roadmap/b-xy58-thin-feature.md#child-section")
    ).toBe("b-xy58-thin-feature");
    expect(splitHrefPathFragment("./x.md#frag")).toEqual({
      path: "./x.md",
      fragment: "#frag",
    });
  });

  it("resolves a single matching directory", () => {
    const children: RoadmapChild[] = [
      { name: "b42-thinner-impl-fully", kind: "dir" },
    ];
    const result = resolveSlugFromChildren(
      "b42",
      children,
      [],
      { title: "Thinner kickoff", description: "from backlog" }
    );
    expect(result).toEqual({
      outcome: "resolved",
      slug: "b42-thinner-impl-fully",
      kind: "dir",
    });
  });

  it("reports ambiguous folders and symlink refusal", () => {
    const children: RoadmapChild[] = [
      { name: "b11-alpha-slug", kind: "dir" },
      { name: "b11-beta-slug", kind: "dir" },
    ];
    const ambiguous = resolveSlugFromChildren(
      "b11",
      children,
      [],
      { title: "Ambiguous", description: "" }
    );
    expect(ambiguous).toMatchObject({
      outcome: "blocked",
      reason: "ambiguous",
    });

    const symlinkChildren: RoadmapChild[] = [
      { name: "b50-link-slug", kind: "symlink" },
    ];
    const dirs = matchingSlugCandidates(symlinkChildren, "b50", "dir");
    expect(dirs.symlinkBlocked).toBe(true);

    const blocked = resolveSlugFromChildren(
      "b50",
      symlinkChildren,
      [],
      { title: "Symlink", description: "" }
    );
    expect(blocked).toEqual({
      outcome: "blocked",
      reason: "symlink",
      message: SYMLINK_CANDIDATE_MESSAGE,
    });
  });

  it("reports ambiguous documents when two matching files exist", () => {
    const children: RoadmapChild[] = [
      { name: "b11-alpha.md", kind: "file" },
      { name: "b11-beta.md", kind: "file" },
    ];
    const result = resolveSlugFromChildren(
      "b11",
      children,
      [],
      { title: "Ambiguous files", description: "" }
    );
    expect(result).toMatchObject({
      outcome: "blocked",
      reason: "ambiguous",
      message: "Ambiguous roadmap documents for b11",
    });
  });
});
