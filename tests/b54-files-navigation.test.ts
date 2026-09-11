import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canGoBack,
  canGoForward,
  createFilesNavState,
  currentFilesNavEntry,
  goBackFilesNav,
  goForwardFilesNav,
  pushFilesNav,
  replaceFilesNav,
  type FilesNavEntry,
} from "../packages/dashboard/src/filesNavigation.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

/** Attributes of the one `<Button>` opening tag carrying `aria-label`. */
function buttonProps(src: string, ariaLabel: string): string {
  const tags = (src.match(/<Button\b[^>]*>/g) ?? []).filter((tag) =>
    tag.includes(`aria-label="${ariaLabel}"`)
  );
  expect(tags).toHaveLength(1);
  return tags[0] as string;
}

function viewEntry(view: "board" | "chat" | "settings"): FilesNavEntry {
  return { kind: "view", view };
}

function filesEntry(
  workspaceId: string | null,
  dir: string,
  path: string | null = null
): FilesNavEntry {
  return { kind: "files", workspaceId, location: { dir, path } };
}

describe("files navigation model", () => {
  it("initializes with a current entry and no back/forward", () => {
    const state = createFilesNavState(viewEntry("board"));
    expect(currentFilesNavEntry(state)).toEqual(viewEntry("board"));
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(false);
  });

  it("suppresses structural duplicate pushes", () => {
    let state = createFilesNavState(filesEntry("ws1", "docs"));
    state = pushFilesNav(state, filesEntry("ws1", "docs"));
    expect(state.entries).toHaveLength(1);
    expect(canGoBack(state)).toBe(false);
  });

  it("treats identical locations in different workspaces as distinct", () => {
    let state = createFilesNavState(filesEntry("ws1", "docs", "a.md"));
    state = pushFilesNav(state, filesEntry("ws2", "docs", "a.md"));
    expect(state.entries).toHaveLength(2);
    expect(currentFilesNavEntry(state)).toEqual(
      filesEntry("ws2", "docs", "a.md")
    );
  });

  it("moves back and forward to exact cursor destinations", () => {
    let state = createFilesNavState(viewEntry("board"));
    state = pushFilesNav(state, filesEntry("ws1", "", null));
    state = pushFilesNav(state, filesEntry("ws1", "docs", "plan.md"));

    const back1 = goBackFilesNav(state);
    expect(back1.entry).toEqual(filesEntry("ws1", "", null));
    expect(canGoBack(back1.state)).toBe(true);
    expect(canGoForward(back1.state)).toBe(true);

    const back2 = goBackFilesNav(back1.state);
    expect(back2.entry).toEqual(viewEntry("board"));
    expect(canGoBack(back2.state)).toBe(false);

    const fwd = goForwardFilesNav(back2.state);
    expect(fwd.entry).toEqual(filesEntry("ws1", "", null));
  });

  it("no-ops at back and forward bounds", () => {
    const state = createFilesNavState(viewEntry("chat"));
    const back = goBackFilesNav(state);
    expect(back.state).toBe(state);
    expect(back.entry).toEqual(viewEntry("chat"));

    const fwd = goForwardFilesNav(state);
    expect(fwd.state).toBe(state);
  });

  it("replaces the current entry without moving the cursor", () => {
    let state = createFilesNavState(filesEntry(null, "docs"));
    state = pushFilesNav(state, filesEntry(null, "docs", "a.md"));
    state = replaceFilesNav(state, filesEntry("ws1", "docs", "a.md"));
    expect(state.index).toBe(1);
    expect(currentFilesNavEntry(state)).toEqual(
      filesEntry("ws1", "docs", "a.md")
    );
    expect(canGoBack(state)).toBe(true);
  });

  it("truncates stale forward entries after divergent navigation", () => {
    let state = createFilesNavState(viewEntry("board"));
    state = pushFilesNav(state, filesEntry("ws1", "a"));
    state = pushFilesNav(state, filesEntry("ws1", "b"));
    state = goBackFilesNav(state).state;
    state = goBackFilesNav(state).state;
    expect(canGoForward(state)).toBe(true);

    state = pushFilesNav(state, filesEntry("ws1", "c"));
    expect(currentFilesNavEntry(state)).toEqual(filesEntry("ws1", "c"));
    expect(canGoForward(state)).toBe(false);
    expect(state.entries).toEqual([
      viewEntry("board"),
      filesEntry("ws1", "c"),
    ]);
  });

  it("covers top-level view entries alongside files entries", () => {
    let state = createFilesNavState(viewEntry("settings"));
    state = pushFilesNav(state, filesEntry("ws1", "docs"));
    expect(state.entries).toHaveLength(2);
    state = pushFilesNav(state, viewEntry("chat"));
    expect(currentFilesNavEntry(state)).toEqual(viewEntry("chat"));
    expect(canGoBack(state)).toBe(true);
  });
});

describe("files navigation integration seams", () => {
  it("App supplies history props and centralized Files transition paths", () => {
    const app = readSrc("packages/dashboard/src/App.tsx");
    expect(app).toMatch(/canGoBack=\{canGoBack\(filesNav\)\}/);
    expect(app).toMatch(/canGoForward=\{canGoForward\(filesNav\)\}/);
    expect(app).toMatch(/onGoBack=\{onFilesGoBack\}/);
    expect(app).toMatch(/onGoForward=\{onFilesGoForward\}/);
    expect(app).toMatch(/onSelectWorkspace=\{selectWorkspace\}/);
    expect(app).toMatch(/onLocationChange=\{onFilesLocationChange\}/);
    expect(app).toMatch(/onSelectView=\{selectView\}/);
    expect(app).toMatch(/pushToFilesDestination/);
    expect(app).toMatch(/onFilesDeepLink\(openFilesDeepLink\)/);
    expect(app).toMatch(
      /if \(activeViewRef\.current === "files"\) \{\s*onSelectFilesWorkspace\(id\);/
    );
    expect(app).toMatch(
      /activeView === "files"\s*\?\s*\(\s*<FilesView[\s\S]*?onLocationChange=\{onFilesLocationChange\}/
    );
  });

  it("FilesView renders shared Back/Forward controls wired to history props", () => {
    const filesView = readSrc("packages/dashboard/src/FilesView.tsx");
    expect(filesView).toMatch(/canGoBack:\s*boolean/);
    expect(filesView).toMatch(/canGoForward:\s*boolean/);
    expect(filesView).toMatch(/onGoBack:\s*\(\)\s*=>\s*void/);
    expect(filesView).toMatch(/onGoForward:\s*\(\)\s*=>\s*void/);
    const back = buttonProps(filesView, "Go back in Files history");
    expect(back).toMatch(/onClick=\{onGoBack\}/);
    expect(back).toMatch(/disabled=\{!canGoBack\}/);
    expect(back).not.toMatch(/onGoForward|canGoForward/);

    const forward = buttonProps(filesView, "Go forward in Files history");
    expect(forward).toMatch(/onClick=\{onGoForward\}/);
    expect(forward).toMatch(/disabled=\{!canGoForward\}/);

    const previewBack = buttonProps(filesView, "Back to file list");
    expect(previewBack).toMatch(/onClick=\{closeFile\}/);
    expect(previewBack).not.toMatch(/onGoBack|onGoForward/);

    expect(filesView).toMatch(
      /\{historyToolbar\}[\s\S]*?isNarrow\s*\?\s*\([\s\S]*?showPreview\s*\?/
    );
    const paneStart = filesView.indexOf("const listPane = (");
    const shellStart = filesView.indexOf("\n  return (");
    expect(paneStart).toBeGreaterThan(0);
    expect(shellStart).toBeGreaterThan(paneStart);
    expect(filesView.slice(paneStart, shellStart)).not.toContain(
      "{historyToolbar}"
    );
  });

  it("filesDeepLink keeps replaceState and avoids pushState/popstate", () => {
    const deepLink = readSrc("packages/dashboard/src/filesDeepLink.ts");
    expect(deepLink).toMatch(/history\.replaceState/);
    expect(deepLink).not.toMatch(/history\.pushState/);
    expect(deepLink).not.toMatch(/popstate/);
  });
});
