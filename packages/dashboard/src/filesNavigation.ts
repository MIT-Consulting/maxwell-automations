import type { FilesLocation } from "./FilesView";

/** Top-level dashboard views that can be recorded as Files history origins. */
export type DashboardNavView = "board" | "chat" | "settings";

export type FilesNavEntry =
  | { kind: "view"; view: DashboardNavView }
  | { kind: "files"; workspaceId: string | null; location: FilesLocation };

export type FilesNavState = {
  readonly entries: readonly FilesNavEntry[];
  readonly index: number;
};

export function createFilesNavState(entry: FilesNavEntry): FilesNavState {
  return { entries: [entry], index: 0 };
}

export function currentFilesNavEntry(state: FilesNavState): FilesNavEntry {
  const entry = state.entries[state.index];
  if (!entry) {
    throw new Error("files navigation state has no current entry");
  }
  return entry;
}

export function canGoBack(state: FilesNavState): boolean {
  return state.index > 0;
}

export function canGoForward(state: FilesNavState): boolean {
  return state.index < state.entries.length - 1;
}

export function entriesEqual(a: FilesNavEntry, b: FilesNavEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "view" && b.kind === "view") {
    return a.view === b.view;
  }
  if (a.kind === "files" && b.kind === "files") {
    return (
      a.workspaceId === b.workspaceId &&
      a.location.dir === b.location.dir &&
      a.location.path === b.location.path
    );
  }
  return false;
}

/** Push a destination; no-op when equal to current; truncates stale Forward. */
export function pushFilesNav(
  state: FilesNavState,
  entry: FilesNavEntry
): FilesNavState {
  const current = currentFilesNavEntry(state);
  if (entriesEqual(current, entry)) return state;
  const kept = state.entries.slice(0, state.index + 1);
  return {
    entries: [...kept, entry],
    index: kept.length,
  };
}

/** Replace the current entry (system reconciliation); preserves Forward. */
export function replaceFilesNav(
  state: FilesNavState,
  entry: FilesNavEntry
): FilesNavState {
  const entries = state.entries.slice();
  entries[state.index] = entry;
  return { entries, index: state.index };
}

export type FilesNavMoveResult = {
  state: FilesNavState;
  entry: FilesNavEntry;
};

/** Move Back; no-op at the lower bound. */
export function goBackFilesNav(state: FilesNavState): FilesNavMoveResult {
  if (!canGoBack(state)) {
    return { state, entry: currentFilesNavEntry(state) };
  }
  const next: FilesNavState = {
    entries: state.entries,
    index: state.index - 1,
  };
  return { state: next, entry: currentFilesNavEntry(next) };
}

/** Move Forward; no-op at the upper bound. */
export function goForwardFilesNav(state: FilesNavState): FilesNavMoveResult {
  if (!canGoForward(state)) {
    return { state, entry: currentFilesNavEntry(state) };
  }
  const next: FilesNavState = {
    entries: state.entries,
    index: state.index + 1,
  };
  return { state: next, entry: currentFilesNavEntry(next) };
}
