import { useEffect, useRef, useState, type JSX } from "react";
import {
  ChevronLeft,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  Link2,
} from "lucide-react";
import type {
  ListWorkspaceFilesResponse,
  Workspace,
  WorkspaceFileContentResponse,
  WorkspaceFileEntry,
} from "@lca/shared";
import { api } from "./api";
import { workspaceLabel } from "./helpers";
import { MarkdownPreview } from "./MarkdownPreview";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export type FilesLocation = {
  dir: string;
  path: string | null;
};

type FilesViewProps = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  isNarrow: boolean;
  /** Browse position for the active workspace (parent keeps this per workspace). */
  location: FilesLocation;
  onLocationChange?: (loc: FilesLocation) => void;
  /** Session Files history availability and callbacks (owned by App). */
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
};

const MARKDOWN_EXT = /\.(md|mdc|markdown)$/i;

function parentDir(dir: string): string {
  if (!dir) return "";
  const parts = dir.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function joinDir(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function formatBytes(size: number | null): string {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function breadcrumbParts(dir: string): Array<{ label: string; dir: string }> {
  const parts: Array<{ label: string; dir: string }> = [
    { label: "Root", dir: "" },
  ];
  if (!dir) return parts;
  const segs = dir.split("/").filter(Boolean);
  let acc = "";
  for (const seg of segs) {
    acc = acc ? `${acc}/${seg}` : seg;
    parts.push({ label: seg, dir: acc });
  }
  return parts;
}

function entryIcon(entry: WorkspaceFileEntry) {
  if (entry.kind === "dir") return Folder;
  if (entry.kind === "symlink") return Link2;
  if (MARKDOWN_EXT.test(entry.name)) return FileText;
  return File;
}

export function FilesView({
  workspaces,
  activeWorkspaceId,
  isNarrow,
  location,
  onLocationChange,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: FilesViewProps): JSX.Element {
  const [dir, setDir] = useState(location.dir);
  const [openPath, setOpenPath] = useState<string | null>(location.path);
  const [listing, setListing] = useState<ListWorkspaceFilesResponse | null>(
    null
  );
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [content, setContent] = useState<WorkspaceFileContentResponse | null>(
    null
  );
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const onLocationChangeRef = useRef(onLocationChange);
  onLocationChangeRef.current = onLocationChange;

  // Follow parent location (workspace restore, deep link, remount).
  useEffect(() => {
    setDir(location.dir);
    setOpenPath(location.path);
  }, [activeWorkspaceId, location.dir, location.path]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setListing(null);
      setListError(null);
      return;
    }
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void api
      .listWorkspaceFiles(activeWorkspaceId, dir)
      .then((data) => {
        if (!cancelled) setListing(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setListing(null);
          setListError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, dir]);

  useEffect(() => {
    if (!activeWorkspaceId || !openPath) {
      setContent(null);
      setContentError(null);
      setContentLoading(false);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setContentError(null);
    void api
      .getWorkspaceFileContent(activeWorkspaceId, openPath)
      .then((data) => {
        if (!cancelled) setContent(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setContent(null);
          setContentError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, openPath]);

  const navigateDir = (nextDir: string) => {
    setDir(nextDir);
    setOpenPath(null);
    onLocationChangeRef.current?.({ dir: nextDir, path: null });
  };

  const openFile = (name: string) => {
    const path = joinDir(dir, name);
    setOpenPath(path);
    onLocationChangeRef.current?.({ dir, path });
  };

  const closeFile = () => {
    setOpenPath(null);
    onLocationChangeRef.current?.({ dir, path: null });
  };

  const retryList = () => {
    setDir((d) => d);
    setListError(null);
    if (!activeWorkspaceId) return;
    setListLoading(true);
    void api
      .listWorkspaceFiles(activeWorkspaceId, dir)
      .then(setListing)
      .catch((err: unknown) => {
        setListError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setListLoading(false));
  };

  const retryContent = () => {
    if (!activeWorkspaceId || !openPath) return;
    setContentLoading(true);
    setContentError(null);
    void api
      .getWorkspaceFileContent(activeWorkspaceId, openPath)
      .then(setContent)
      .catch((err: unknown) => {
        setContentError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setContentLoading(false));
  };

  const historyToolbar = (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/40 px-2 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        onClick={onGoBack}
        disabled={!canGoBack}
        aria-label="Go back in Files history"
        title="Go back in Files history"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        onClick={onGoForward}
        disabled={!canGoForward}
        aria-label="Go forward in Files history"
        title="Go forward in Files history"
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );

  if (workspaces.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col bg-card",
          isNarrow && "pb-16"
        )}
      >
        {historyToolbar}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center border border-border bg-card p-6 text-center">
          <p className="m-0 text-sm text-muted-foreground">
            Map a workspace to browse its files.
          </p>
        </div>
      </div>
    );
  }

  const showPreview = openPath !== null;
  const crumbs = breadcrumbParts(dir);

  const listPane = (
    <aside
      className={cn(
        "flex flex-col bg-card",
        isNarrow
          ? "min-h-0 min-w-0 flex-1"
          : "w-[300px] shrink-0 border-r border-border"
      )}
    >
      <div className="border-b border-border px-3 py-3">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          Workspace
        </p>
        <p
          className="m-0 mt-1 truncate text-sm font-medium text-foreground"
          title={activeWorkspaceId ? workspaceLabel(activeWorkspaceId, workspaces) : undefined}
        >
          {activeWorkspaceId
            ? workspaceLabel(activeWorkspaceId, workspaces)
            : "None focused"}
        </p>
      </div>

      {!activeWorkspaceId ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          Select a workspace in the sidebar to browse files.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs">
            {crumbs.map((crumb, i) => (
              <span key={crumb.dir || "root"} className="flex items-center gap-1">
                {i > 0 && (
                  <span className="text-muted-foreground" aria-hidden="true">
                    /
                  </span>
                )}
                <button
                  type="button"
                  className={cn(
                    "rounded px-1 py-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                    i === crumbs.length - 1 && !showPreview
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => navigateDir(crumb.dir)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>

          {listError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
              <p className="m-0 text-sm text-destructive">{listError}</p>
              <Button type="button" variant="outline" size="sm" onClick={retryList}>
                Retry
              </Button>
            </div>
          ) : listLoading && !listing ? (
            <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-0.5 p-2">
                {dir !== "" && (
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left text-xs text-muted-foreground hover:border-border hover:bg-muted",
                      isNarrow && "min-h-11"
                    )}
                    onClick={() => navigateDir(parentDir(dir))}
                  >
                    <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
                    ..
                  </button>
                )}
                {listing?.entries.length === 0 && (
                  <p className="m-0 px-2 py-4 text-center text-xs text-muted-foreground">
                    This directory is empty.
                  </p>
                )}
                {listing?.entries.map((entry) => {
                  const Icon = entryIcon(entry);
                  const clickable = entry.kind !== "symlink";
                  return (
                    <button
                      key={`${entry.kind}:${entry.name}`}
                      type="button"
                      disabled={!clickable}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        isNarrow && "min-h-11",
                        clickable
                          ? "text-foreground hover:border-border hover:bg-muted"
                          : "cursor-default text-muted-foreground opacity-70",
                        openPath === joinDir(dir, entry.name) &&
                          "border-primary bg-primary/10"
                      )}
                      onClick={() => {
                        if (entry.kind === "dir") {
                          navigateDir(joinDir(dir, entry.name));
                        } else if (entry.kind === "file") {
                          openFile(entry.name);
                        }
                      }}
                      title={
                        entry.kind === "symlink"
                          ? "Symlink (not followed)"
                          : entry.name
                      }
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      {entry.kind === "file" && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatBytes(entry.size)}
                        </span>
                      )}
                    </button>
                  );
                })}
                {listing?.truncated && (
                  <p className="m-0 px-2 py-2 text-center text-[11px] text-amber-600 dark:text-amber-400">
                    Listing truncated — too many entries.
                  </p>
                )}
              </div>
            </ScrollArea>
          )}
        </>
      )}
    </aside>
  );

  const previewPane = (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-card",
        isNarrow && "min-h-0"
      )}
    >
      {isNarrow && showPreview && (
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            onClick={closeFile}
            aria-label="Back to file list"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Button>
          <p className="m-0 min-w-0 flex-1 truncate text-sm font-medium">
            {openPath}
          </p>
        </header>
      )}

      {!showPreview ? (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {activeWorkspaceId
            ? "Select a file to preview."
            : "Select a workspace in the sidebar to browse files."}
        </div>
      ) : contentLoading && !content ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Loading…
        </div>
      ) : contentError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="m-0 text-sm text-destructive">{contentError}</p>
          <Button type="button" variant="outline" size="sm" onClick={retryContent}>
            Retry
          </Button>
        </div>
      ) : content ? (
        <>
          {!isNarrow && (
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <p className="m-0 min-w-0 truncate font-mono text-xs text-muted-foreground">
                {content.path}
              </p>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatBytes(content.size)}
                {content.mtime
                  ? ` · ${new Date(content.mtime).toLocaleString()}`
                  : ""}
              </span>
            </header>
          )}
          {content.truncated && (
            <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300">
              File truncated at the viewer size limit ({formatBytes(content.size)}{" "}
              on disk).
            </div>
          )}
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              {content.encoding === "binary" ? (
                <div className="rounded-md border border-border bg-muted/40 p-4 text-sm">
                  <p className="m-0 mb-2 font-medium">Binary file — preview unavailable</p>
                  <dl className="m-0 grid gap-1 text-xs text-muted-foreground">
                    <div>
                      <dt className="inline font-medium text-foreground">Name: </dt>
                      <dd className="inline">{content.path.split("/").pop()}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Size: </dt>
                      <dd className="inline">{formatBytes(content.size)}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Modified: </dt>
                      <dd className="inline">
                        {new Date(content.mtime).toLocaleString()}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : content.content !== null && MARKDOWN_EXT.test(content.path) ? (
                <MarkdownPreview
                  variant="document"
                  docLinkContext={
                    activeWorkspaceId
                      ? {
                          workspaceId: activeWorkspaceId,
                          docPath: content.path,
                        }
                      : null
                  }
                >
                  {content.content}
                </MarkdownPreview>
              ) : (
                <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-foreground">
                  {content.content ?? ""}
                </pre>
              )}
            </div>
          </ScrollArea>
        </>
      ) : null}
    </section>
  );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-card",
        isNarrow && "pb-16"
      )}
    >
      {historyToolbar}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          isNarrow ? "flex-col" : "flex-row"
        )}
      >
        {isNarrow ? (
          showPreview ? (
            previewPane
          ) : (
            listPane
          )
        ) : (
          <>
            {listPane}
            {previewPane}
          </>
        )}
      </div>
    </div>
  );
}
