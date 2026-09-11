import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LCA_GIT_MARKER_BEGIN = "# >>> lca-git-trigger (cursor-local-automations)";
export const LCA_GIT_MARKER_END = "# <<< lca-git-trigger";

const HOOK_EVENTS = ["post-commit", "pre-push", "post-merge"] as const;

export type GitHookEvent = (typeof HOOK_EVENTS)[number];

// Git has no `post-push` hook; `pre-push` is the only client-side push hook. It
// fires on push attempt and receives the pushed refs on stdin
// (`<local ref> <local sha> <remote ref> <remote sha>` per line) rather than a
// single HEAD, so the pre-push variant reads the first local SHA from stdin and
// falls back to `git rev-parse HEAD`.
function shaLine(event: GitHookEvent): string {
  if (event === "pre-push") {
    return `read -r LCA_LOCAL_REF LCA_LOCAL_SHA LCA_REMOTE_REF LCA_REMOTE_SHA || true
LCA_SHA="\${LCA_LOCAL_SHA:-}"
if [ -z "\${LCA_SHA}" ] || [ "\${LCA_SHA}" = "0000000000000000000000000000000000000000" ]; then
  LCA_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
fi`;
  }
  return `LCA_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"`;
}

function hookBlock(event: GitHookEvent, port: number): string {
  return `${LCA_GIT_MARKER_BEGIN}
LCA_PORT="${port}"
LCA_WS="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
${shaLine(event)}
LCA_EVENT="${event}"
if command -v curl >/dev/null 2>&1; then
  curl -sS -X POST "http://127.0.0.1:\${LCA_PORT}/api/triggers/git" \\
    -H "Content-Type: application/json" \\
    -d "{\\"workspace\\":\\"\${LCA_WS}\\",\\"event\\":\\"\${LCA_EVENT}\\",\\"sha\\":\\"\${LCA_SHA}\\"}" \\
    >/dev/null 2>&1 &
fi
${LCA_GIT_MARKER_END}`;
}

function upsertBlock(existing: string, block: string): string {
  const begin = existing.indexOf(LCA_GIT_MARKER_BEGIN);
  const end = existing.indexOf(LCA_GIT_MARKER_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin).trimEnd();
    const after = existing.slice(end + LCA_GIT_MARKER_END.length).trimStart();
    const parts = [before, block, after].filter((p) => p.length > 0);
    return `${parts.join("\n\n")}\n`;
  }
  const trimmed = existing.trimEnd();
  if (!trimmed) {
    return `#!/bin/sh\n\n${block}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

function installHook(
  hooksDir: string,
  event: GitHookEvent,
  port: number
): { path: string; created: boolean; updated: boolean } {
  const hookPath = join(hooksDir, event);
  const block = hookBlock(event, port);
  const existed = existsSync(hookPath);
  const prior = existed ? readFileSync(hookPath, "utf8") : "";
  const hadMarker = prior.includes(LCA_GIT_MARKER_BEGIN);
  const next = upsertBlock(prior, block);

  if (prior === next) {
    return { path: hookPath, created: false, updated: false };
  }

  writeFileSync(hookPath, next, "utf8");
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* Windows may ignore mode */
  }

  return {
    path: hookPath,
    created: !existed,
    updated: existed && (hadMarker || prior.length > 0),
  };
}

export function installGitHooksForWorkspace(
  workspacePath: string,
  port: number
): Array<{ event: GitHookEvent; path: string; created: boolean; updated: boolean }> {
  const root = resolve(workspacePath);
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir)) {
    return [];
  }

  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  return HOOK_EVENTS.map((event) => {
    const result = installHook(hooksDir, event, port);
    return { event, ...result };
  });
}

export function installGitHooksForWorkspaces(
  workspacePaths: string[],
  port: number
): number {
  let count = 0;
  for (const workspacePath of workspacePaths) {
    const results = installGitHooksForWorkspace(workspacePath, port);
    count += results.filter((r) => r.created || r.updated).length;
  }
  return count;
}
