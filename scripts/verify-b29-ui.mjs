/**
 * Static checks that b29 file-viewer + deep-link wiring is present.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dashSrc = join(root, "packages", "dashboard", "src");
const daemonSrc = join(root, "packages", "daemon", "src");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function readDash(rel) {
  return readFileSync(join(dashSrc, rel), "utf8");
}

function readDaemon(rel) {
  return readFileSync(join(daemonSrc, rel), "utf8");
}

const api = readDash("api.ts");
assert(
  api.includes("async listWorkspaceFiles("),
  "api.listWorkspaceFiles exists"
);
assert(
  api.includes("async getWorkspaceFileContent("),
  "api.getWorkspaceFileContent exists"
);
assert(api.includes("/files"), "list endpoint contains /files");
assert(
  api.includes("/files/content"),
  "content endpoint contains /files/content"
);

const app = readDash("App.tsx");
assert(
  app.includes('"files"') || app.includes("'files'"),
  "App handles files ActiveView"
);
assert(
  app.includes('view") === "files"') ||
    app.includes("view=files") ||
    (app.includes("workspace") && app.includes("path") && app.includes("dir")),
  "App parses files deep-link params"
);
assert(app.includes("replaceState"), "App syncs URL via replaceState");

const filesView = readDash("FilesView.tsx");
assert(
  filesView.includes('from "./MarkdownPreview"') ||
    filesView.includes("from './MarkdownPreview'"),
  "FilesView imports MarkdownPreview"
);
assert(
  filesView.includes("onLocationChange"),
  "FilesView has onLocationChange"
);
assert(
  filesView.includes("location:") || filesView.includes("location,"),
  "FilesView takes location prop"
);
assert(
  app.includes("filesLocationByWorkspace") ||
    app.includes("filesLocationByWorkspace,"),
  "App keeps Files browse state by workspace"
);
assert(
  readDash("filesDeepLink.ts").includes("handleFilesDeepLinkClick"),
  "filesDeepLink has in-SPA click handler"
);
assert(
  readDash("MarkdownPreview.tsx").includes("handleFilesDeepLinkClick"),
  "MarkdownPreview intercepts Files deep links"
);
assert(
  readDash("pipelineDocLinks.ts").includes("featureIndexPath"),
  "pipelineDocLinks derives feature index paths"
);
assert(
  app.includes("collectGroupPhaseDocLinks") ||
    app.includes("featureIndexPath"),
  "App links feature docs on pipeline groups"
);
assert(
  readDash("cards.tsx").includes("pipelineRunDocPath"),
  "RunCard pipeline chip links to feature/phase docs"
);
assert(filesView.includes("truncated"), "FilesView handles truncated");
assert(filesView.includes("binary"), "FilesView handles binary");

const transcript = readDash("transcript.tsx");
assert(
  transcript.includes("MarkdownPreview"),
  "transcript imports from MarkdownPreview"
);

const controlBar = readDash("ControlBar.tsx");
assert(
  controlBar.includes("Files") && controlBar.includes('"files"'),
  "ControlBar has Files entry"
);

const readHelper = readDaemon("files/read.ts");
assert(
  readHelper.includes("export function resolveWorkspaceFile"),
  "daemon resolveWorkspaceFile exported"
);
assert(
  readHelper.includes("realpathSync") || readHelper.includes("realpath"),
  "daemon containment uses realpath"
);

const server = readDaemon("http/server.ts");
assert(
  server.includes("/files/content") ||
    server.includes("files\\/content"),
  "server has files/content route"
);
assert(
  server.includes("/files") || server.includes("\\/files"),
  "server has files list route"
);

console.log("b29 UI static checks passed");
