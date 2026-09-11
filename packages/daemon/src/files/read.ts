import {
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  closeSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type {
  ListWorkspaceFilesResponse,
  WorkspaceFileContentResponse,
  WorkspaceFileEntry,
} from "@lca/shared";

const BINARY_SNIFF_BYTES = 8192;
const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules"]);

export class FileViewerError extends Error {
  constructor(
    public code: "bad_request" | "not_found",
    message: string
  ) {
    super(message);
    this.name = "FileViewerError";
  }
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function splitSegments(relPath: string): string[] {
  return relPath
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0 && segment !== ".");
}

function assertInsideRoot(root: string, candidate: string): void {
  const resolvedRoot = resolve(root);
  const rootPrefix = resolvedRoot + sep;
  const normalized = resolve(candidate);
  if (normalized !== resolvedRoot && !normalized.startsWith(rootPrefix)) {
    throw new FileViewerError("bad_request", "Path escapes workspace root");
  }
}

/**
 * Resolve a workspace-relative path under `workspaceRoot`, rejecting traversal
 * and symlink escapes. Returns the resolved absolute path (pre-realpath).
 */
export function resolveWorkspaceFile(
  workspaceRoot: string,
  relPath: string
): string {
  if (relPath.includes("\0")) {
    throw new FileViewerError("bad_request", "Invalid path");
  }
  if (isAbsolute(relPath)) {
    throw new FileViewerError("bad_request", "Absolute paths are not allowed");
  }
  const segments = splitSegments(relPath);
  if (segments.some((segment) => segment === "..")) {
    throw new FileViewerError("bad_request", "Path traversal is not allowed");
  }

  const resolvedRoot = resolve(workspaceRoot);
  const target = resolve(resolvedRoot, ...segments);
  assertInsideRoot(resolvedRoot, target);

  if (!existsSync(target)) {
    throw new FileViewerError("not_found", "File not found");
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(resolvedRoot);
    realTarget = realpathSync(target);
  } catch {
    throw new FileViewerError("not_found", "File not found");
  }
  assertInsideRoot(realRoot, realTarget);

  return target;
}

function assertNotExcludedDir(relDir: string): void {
  const segments = splitSegments(relDir);
  if (segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment))) {
    throw new FileViewerError(
      "bad_request",
      "Listing inside .git or node_modules is not allowed"
    );
  }
}

function toIsoMtime(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString();
}

export function listWorkspaceDir(
  workspaceRoot: string,
  relDir: string,
  opts: { maxEntries: number }
): ListWorkspaceFilesResponse {
  const normalizedDir = normalizeRel(relDir);
  assertNotExcludedDir(normalizedDir);

  const absDir =
    normalizedDir === ""
      ? resolve(workspaceRoot)
      : resolveWorkspaceFile(workspaceRoot, normalizedDir);

  let dirStat;
  try {
    dirStat = lstatSync(absDir);
  } catch {
    throw new FileViewerError("not_found", "Directory not found");
  }
  // Symlinked directories are reported in parent listings but not followed.
  // Must be checked before isDirectory(): lstat reports a symlink as non-dir.
  if (dirStat.isSymbolicLink()) {
    throw new FileViewerError("bad_request", "Symlinked directories are not followed");
  }
  if (!dirStat.isDirectory()) {
    throw new FileViewerError("bad_request", "Path is not a directory");
  }

  let names: string[];
  try {
    names = readdirSync(absDir);
  } catch {
    throw new FileViewerError("not_found", "Directory not found");
  }

  const dirs: WorkspaceFileEntry[] = [];
  const others: WorkspaceFileEntry[] = [];

  for (const name of names) {
    const childPath = resolve(absDir, name);
    let entry: WorkspaceFileEntry;
    try {
      const st = lstatSync(childPath);
      if (st.isSymbolicLink()) {
        entry = { name, kind: "symlink", size: null, mtime: null };
        others.push(entry);
      } else if (st.isDirectory()) {
        entry = {
          name,
          kind: "dir",
          size: null,
          mtime: toIsoMtime(st.mtimeMs),
        };
        dirs.push(entry);
      } else {
        entry = {
          name,
          kind: "file",
          size: st.size,
          mtime: toIsoMtime(st.mtimeMs),
        };
        others.push(entry);
      }
    } catch {
      entry = { name, kind: "file", size: null, mtime: null };
      others.push(entry);
    }
  }

  const byName = (a: WorkspaceFileEntry, b: WorkspaceFileEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  dirs.sort(byName);
  others.sort(byName);

  const all = [...dirs, ...others];
  const truncated = all.length > opts.maxEntries;
  const entries = truncated ? all.slice(0, opts.maxEntries) : all;

  return {
    dir: normalizedDir,
    entries,
    truncated,
  };
}

function isBinaryBuffer(buf: Buffer): boolean {
  const window = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < window; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function readWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  opts: { maxBytes: number }
): WorkspaceFileContentResponse {
  const normalizedPath = normalizeRel(relPath);
  if (normalizedPath === "") {
    throw new FileViewerError("bad_request", "Path is required");
  }

  const absPath = resolveWorkspaceFile(workspaceRoot, normalizedPath);

  let st;
  try {
    st = lstatSync(absPath);
  } catch {
    throw new FileViewerError("not_found", "File not found");
  }
  if (st.isSymbolicLink()) {
    // resolveWorkspaceFile already realpath-checked; still refuse to treat
    // the symlink node itself as readable content via lstat kind.
    st = statSync(absPath);
  }
  if (st.isDirectory()) {
    throw new FileViewerError("bad_request", "Path is a directory");
  }

  const size = st.size;
  const mtime = toIsoMtime(st.mtimeMs);
  const readLen = Math.min(size, opts.maxBytes);
  const truncated = size > opts.maxBytes;

  const buf = Buffer.alloc(readLen);
  if (readLen > 0) {
    const fd = openSync(absPath, "r");
    try {
      readSync(fd, buf, 0, readLen, 0);
    } finally {
      closeSync(fd);
    }
  }

  if (isBinaryBuffer(buf)) {
    return {
      path: normalizedPath,
      size,
      mtime,
      encoding: "binary",
      content: null,
      truncated,
    };
  }

  return {
    path: normalizedPath,
    size,
    mtime,
    encoding: "utf8",
    content: buf.toString("utf8"),
    truncated,
  };
}
