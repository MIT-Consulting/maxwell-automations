import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleFilesDeepLinkClick,
  navigateFilesDeepLink,
  normalizeWorkspaceRelPath,
  onFilesDeepLink,
  parseFilesDeepLinkFromSearch,
  resolveMarkdownFilesLink,
  tryParseFilesDeepLinkHref,
  tryResolveRelativeFilesDocHref,
} from "../packages/dashboard/src/filesDeepLink.ts";

describe("files deep-link helpers", () => {
  afterEach(() => {
    onFilesDeepLink(null);
    vi.unstubAllGlobals();
  });

  it("parses path (wins over dir) and workspace from search", () => {
    const boot = parseFilesDeepLinkFromSearch(
      "?view=files&workspace=ws1&path=docs%2Fplan.md&dir=other"
    );
    expect(boot.viewOverride).toBe("files");
    expect(boot.workspaceId).toBe("ws1");
    expect(boot.location).toEqual({ dir: "docs", path: "docs/plan.md" });
  });

  it("parses dir-only location", () => {
    const boot = parseFilesDeepLinkFromSearch(
      "view=files&workspace=ws1&dir=docs%2Froadmap"
    );
    expect(boot.location).toEqual({ dir: "docs/roadmap", path: null });
  });

  it("recognizes same-origin Files hrefs and rejects external ones", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://127.0.0.1:3747" },
    });
    expect(
      tryParseFilesDeepLinkHref(
        "http://127.0.0.1:3747/?view=files&workspace=ws1&path=a.md"
      )
    ).toEqual({
      workspaceId: "ws1",
      location: { dir: "", path: "a.md" },
    });
    expect(
      tryParseFilesDeepLinkHref("/?view=files&dir=docs")
    ).toEqual({
      workspaceId: null,
      location: { dir: "docs", path: null },
    });
    expect(
      tryParseFilesDeepLinkHref("https://example.com/?view=files&path=a.md")
    ).toBeNull();
    expect(tryParseFilesDeepLinkHref("/docs/a.md")).toBeNull();
  });

  it("handleFilesDeepLinkClick prevents default and invokes handler", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://127.0.0.1:3747" },
    });
    const seen: unknown[] = [];
    onFilesDeepLink((target) => {
      seen.push(target);
    });
    const event = {
      preventDefault: vi.fn(),
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
    };
    const ok = handleFilesDeepLinkClick(
      event,
      "http://127.0.0.1:3747/?view=files&workspace=abc&path=docs/x.md"
    );
    expect(ok).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(seen).toEqual([
      {
        workspaceId: "abc",
        location: { dir: "docs", path: "docs/x.md" },
      },
    ]);
    expect(
      navigateFilesDeepLink({
        workspaceId: "abc",
        location: { dir: "", path: null },
      })
    ).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("skips modified clicks so open-in-new-tab still works", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://127.0.0.1:3747" },
    });
    onFilesDeepLink(() => {
      throw new Error("should not navigate");
    });
    const event = {
      preventDefault: vi.fn(),
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
    };
    expect(
      handleFilesDeepLinkClick(
        event,
        "http://127.0.0.1:3747/?view=files&path=a.md"
      )
    ).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("normalizes workspace-relative paths and rejects root escapes", () => {
    expect(normalizeWorkspaceRelPath("docs/./a/../b.md")).toBe("docs/b.md");
    expect(normalizeWorkspaceRelPath("../outside.md")).toBeNull();
    expect(normalizeWorkspaceRelPath("a/../../x.md")).toBeNull();
  });

  it("resolves relative markdown hrefs against the open document", () => {
    const ctx = {
      workspaceId: "ws1",
      docPath: "docs/roadmap/b64/00-index.md",
    };
    expect(
      tryResolveRelativeFilesDocHref(
        "01-sidebar-scoping-and-empty-board-hint.md",
        ctx
      )
    ).toEqual({
      workspaceId: "ws1",
      location: {
        dir: "docs/roadmap/b64",
        path: "docs/roadmap/b64/01-sidebar-scoping-and-empty-board-hint.md",
      },
    });
    expect(tryResolveRelativeFilesDocHref("../prior-art.md", ctx)).toEqual({
      workspaceId: "ws1",
      location: {
        dir: "docs/roadmap",
        path: "docs/roadmap/prior-art.md",
      },
    });
    expect(tryResolveRelativeFilesDocHref("/docs/root.md", ctx)).toEqual({
      workspaceId: "ws1",
      location: { dir: "docs", path: "docs/root.md" },
    });
    expect(tryResolveRelativeFilesDocHref("./subdir/", ctx)).toEqual({
      workspaceId: "ws1",
      location: { dir: "docs/roadmap/b64/subdir", path: null },
    });
    expect(tryResolveRelativeFilesDocHref("#section", ctx)).toBeNull();
    expect(
      tryResolveRelativeFilesDocHref("https://example.com/a.md", ctx)
    ).toBeNull();
    expect(tryResolveRelativeFilesDocHref("../../../../escape.md", ctx)).toBeNull();
  });

  it("rewrites relative markdown links to shareable Files deep links", () => {
    vi.stubGlobal("window", {
      location: { origin: "http://127.0.0.1:3747" },
    });
    const resolved = resolveMarkdownFilesLink("prd.md", {
      workspaceId: "ws1",
      docPath: "docs/roadmap/b64/00-index.md",
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.target.location.path).toBe("docs/roadmap/b64/prd.md");
    expect(resolved!.href).toBe(
      "http://127.0.0.1:3747/?view=files&workspace=ws1&path=docs%2Froadmap%2Fb64%2Fprd.md"
    );
    expect(
      resolveMarkdownFilesLink(
        "http://127.0.0.1:3747/?view=files&workspace=ws1&path=a.md",
        { workspaceId: "ws1", docPath: "docs/x.md" }
      )?.target.location.path
    ).toBe("a.md");
    expect(resolveMarkdownFilesLink("prd.md", null)).toBeNull();
  });
});
