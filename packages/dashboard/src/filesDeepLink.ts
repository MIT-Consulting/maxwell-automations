import type { FilesLocation } from "./FilesView";

/** Build a Files-view deep link for a validated workspace-relative path. */
export function filesArtifactHref(
  workspaceId: string,
  relativePath: string
): string {
  const params = new URLSearchParams({
    view: "files",
    workspace: workspaceId,
    path: relativePath,
  });
  return `${window.location.origin}/?${params.toString()}`;
}

export type FilesDeepLinkTarget = {
  workspaceId: string | null;
  location: FilesLocation;
};

export type FilesDeepLinkBoot = {
  viewOverride: "files" | null;
  workspaceId: string | null;
  location: FilesLocation | null;
};

const FILES_URL_KEYS = ["view", "workspace", "path", "dir"] as const;

let filesDeepLinkHandler: ((target: FilesDeepLinkTarget) => void) | null = null;

/** Register the in-SPA handler for Files deep links (App mounts this). */
export function onFilesDeepLink(
  cb: ((target: FilesDeepLinkTarget) => void) | null
): void {
  filesDeepLinkHandler = cb;
}

/** Apply a Files deep link in the current SPA when a handler is registered. */
export function navigateFilesDeepLink(target: FilesDeepLinkTarget): boolean {
  if (!filesDeepLinkHandler) return false;
  filesDeepLinkHandler(target);
  return true;
}

function normalizeRelPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeRelDir(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function locationFromPathParam(pathRaw: string): FilesLocation {
  const path = normalizeRelPath(pathRaw);
  const segs = path.split("/").filter(Boolean);
  segs.pop();
  return { dir: segs.join("/"), path };
}

function locationFromDirParam(dirRaw: string): FilesLocation {
  return { dir: normalizeRelDir(dirRaw), path: null };
}

/** Parse location from path/dir search params (`path` wins). */
export function locationFromFilesSearchParams(
  params: URLSearchParams
): FilesLocation | null {
  const pathRaw = params.get("path");
  const dirRaw = params.get("dir");
  if (pathRaw !== null && pathRaw !== "") {
    return locationFromPathParam(pathRaw);
  }
  if (dirRaw !== null) {
    return locationFromDirParam(dirRaw);
  }
  return null;
}

/** Parse shareable Files deep-link params (boot or click). */
export function parseFilesDeepLinkFromSearch(
  search: string
): FilesDeepLinkBoot {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search
  );
  const viewOverride = params.get("view") === "files" ? ("files" as const) : null;
  const workspaceRaw = params.get("workspace");
  const workspaceId =
    workspaceRaw && workspaceRaw.length > 0 ? workspaceRaw : null;
  const location = locationFromFilesSearchParams(params);
  return { viewOverride, workspaceId, location };
}

/** Parse shareable Files deep-link params once at boot (params are not stripped). */
export function parseFilesDeepLinkBoot(): FilesDeepLinkBoot {
  if (typeof window === "undefined") {
    return { viewOverride: null, workspaceId: null, location: null };
  }
  return parseFilesDeepLinkFromSearch(window.location.search);
}

/**
 * Same-origin dashboard URL with `view=files` → in-SPA Files target.
 * Returns null for external links or non-Files URLs.
 */
export function tryParseFilesDeepLinkHref(
  href: string
): FilesDeepLinkTarget | null {
  if (typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const path = url.pathname;
  if (path !== "/" && path !== "" && path !== "/index.html") return null;
  if (url.searchParams.get("view") !== "files") return null;

  const workspaceRaw = url.searchParams.get("workspace");
  const workspaceId =
    workspaceRaw && workspaceRaw.length > 0 ? workspaceRaw : null;
  const location =
    locationFromFilesSearchParams(url.searchParams) ?? {
      dir: "",
      path: null,
    };
  return { workspaceId, location };
}

/** Context for resolving relative markdown hrefs inside a Files document preview. */
export type MarkdownDocLinkContext = {
  workspaceId: string;
  /** Workspace-relative path of the document currently being previewed. */
  docPath: string;
};

function hasUrlScheme(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
}

/**
 * Collapse `.` / `..` segments for a workspace-relative path.
 * Returns null when the path would escape the workspace root.
 */
export function normalizeWorkspaceRelPath(raw: string): string | null {
  const normalized = raw.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return null;
  const parts = normalized.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

function parentDirOfDoc(docPath: string): string {
  const normalized = normalizeRelPath(docPath);
  const segs = normalized.split("/").filter(Boolean);
  segs.pop();
  return segs.join("/");
}

/**
 * Resolve a markdown href relative to a Files document into an in-SPA target.
 * Absolute http(s)/mailto/etc. links and hash-only anchors return null.
 * Leading `/` means workspace-root relative (repo-style), not host-root.
 */
export function tryResolveRelativeFilesDocHref(
  href: string,
  context: MarkdownDocLinkContext
): FilesDeepLinkTarget | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (hasUrlScheme(trimmed) || trimmed.startsWith("//")) return null;

  // Already a Files deep link — leave to tryParseFilesDeepLinkHref.
  if (trimmed.startsWith("?") || trimmed.startsWith("/?")) return null;

  const hashIdx = trimmed.indexOf("#");
  const pathAndQuery = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  if (!pathAndQuery) return null;

  const qIdx = pathAndQuery.indexOf("?");
  const pathOnly = qIdx >= 0 ? pathAndQuery.slice(0, qIdx) : pathAndQuery;
  if (!pathOnly) return null;

  const joined = pathOnly.startsWith("/")
    ? pathOnly.slice(1)
    : (() => {
        const base = parentDirOfDoc(context.docPath);
        return base ? `${base}/${pathOnly}` : pathOnly;
      })();

  const asDir = pathOnly.endsWith("/");
  const normalized = normalizeWorkspaceRelPath(
    asDir ? joined.replace(/\/+$/, "") : joined
  );
  if (normalized === null) return null;
  // Root dir link (`/` or `./` collapsing to "") is a valid Files location.
  if (asDir || normalized === "") {
    return {
      workspaceId: context.workspaceId,
      location: { dir: normalized, path: null },
    };
  }
  return {
    workspaceId: context.workspaceId,
    location: locationFromPathParam(normalized),
  };
}

/**
 * Prefer an explicit Files deep link; otherwise resolve a relative doc href
 * when document context is available.
 */
export function resolveMarkdownFilesLink(
  href: string,
  docContext?: MarkdownDocLinkContext | null
): { target: FilesDeepLinkTarget; href: string } | null {
  const deep = tryParseFilesDeepLinkHref(href);
  if (deep) {
    return { target: deep, href };
  }
  if (!docContext) return null;
  const relative = tryResolveRelativeFilesDocHref(href, docContext);
  if (!relative || !relative.workspaceId) return null;
  const loc = relative.location;
  const nextHref = loc.path
    ? filesArtifactHref(relative.workspaceId, loc.path)
    : (() => {
        const params = new URLSearchParams({
          view: "files",
          workspace: relative.workspaceId,
        });
        if (loc.dir) params.set("dir", loc.dir);
        return `${window.location.origin}/?${params.toString()}`;
      })();
  return { target: relative, href: nextHref };
}

function replaceSearchParams(params: URLSearchParams): void {
  const query = params.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
  window.history.replaceState(null, "", url);
}

export function syncFilesViewUrl(
  workspaceId: string | null,
  loc: FilesLocation
): void {
  const params = new URLSearchParams(window.location.search);
  params.set("view", "files");
  if (workspaceId) {
    params.set("workspace", workspaceId);
  } else {
    params.delete("workspace");
  }
  if (loc.path) {
    params.set("path", loc.path);
    params.delete("dir");
  } else if (loc.dir) {
    params.set("dir", loc.dir);
    params.delete("path");
  } else {
    params.delete("path");
    params.delete("dir");
  }
  replaceSearchParams(params);
}

export function clearFilesViewUrlParams(): void {
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  for (const key of FILES_URL_KEYS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  replaceSearchParams(params);
}

/**
 * Intercept a primary click on a same-origin Files deep link.
 * Returns true when navigation was handled in-SPA.
 */
export function handleFilesDeepLinkClick(
  event: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number },
  href: string | undefined
): boolean {
  if (!href) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  if (event.button !== 0) return false;
  const target = tryParseFilesDeepLinkHref(href);
  if (!target) return false;
  event.preventDefault();
  return navigateFilesDeepLink(target);
}
