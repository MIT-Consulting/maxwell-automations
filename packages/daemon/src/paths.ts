import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const LCA_HOME = join(homedir(), ".cursor-local-automations");

/**
 * Built dashboard SPA. Resolved relative to this file at runtime:
 * packages/daemon/dist/paths.js → packages/dashboard/dist. Present only after
 * `npm run build -w @lca/dashboard`; the daemon serves it when it exists.
 */
export const DASHBOARD_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dashboard",
  "dist"
);

export const GLOBAL_CONFIG_PATH = join(LCA_HOME, "automations.yaml");

export const DB_PATH = join(LCA_HOME, "state.sqlite");

/** Disk-backed chat/run attachment blobs (metadata lives in SQLite). */
export const ATTACHMENTS_DIR = join(LCA_HOME, "attachments");

/** Daemon-owned git worktrees for parallel pipeline tracks (b36.06). */
export const PIPELINE_WORKTREES_DIR = join(LCA_HOME, "worktrees");

export function workspaceAutomationsDir(workspacePath: string): string {
  return join(workspacePath, ".cursor", "automations");
}

export function workspaceChatConfigPath(workspacePath: string): string {
  return join(workspacePath, ".cursor", "chat.yaml");
}
