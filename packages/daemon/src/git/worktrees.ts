import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { PIPELINE_WORKTREES_DIR } from "../paths.js";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;

export type GitOperationError = Error & {
  operation: string;
  exitCode: number | null;
};

export type GitPreflightResult =
  | {
      ok: true;
      headCommit: string;
      branch: string;
    }
  | {
      ok: false;
      reason:
        | "missing-git"
        | "not-work-tree"
        | "dirty-checkout"
        | "detached-head"
        | "unborn-head"
        | "invalid-worktree-state"
        | "preflight-failed";
      detail: string;
    };

export type WorktreeIdentity = {
  featureSlug: string;
  rootRunId: string;
  waveOrdinal: number;
  trackOrdinal: number;
};

function worktreesRoot(): string {
  // Resolve at call time so tests can override LCA_HOME / homedir via env.
  const home =
    process.env.LCA_HOME ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), ".cursor-local-automations");
  if (process.env.LCA_HOME) {
    return join(process.env.LCA_HOME, "worktrees");
  }
  // Prefer the module constant when env is the real home.
  void home;
  return PIPELINE_WORKTREES_DIR;
}

export function pipelineWorktreesDir(): string {
  return worktreesRoot();
}

export function trackBranchName(identity: WorktreeIdentity): string {
  const root8 = identity.rootRunId.replace(/-/g, "").slice(0, 8);
  return `lca/${identity.featureSlug}/${root8}/w${identity.waveOrdinal}-t${identity.trackOrdinal}`;
}

export function trackWorktreePath(identity: WorktreeIdentity): string {
  return join(
    pipelineWorktreesDir(),
    identity.rootRunId,
    `w${identity.waveOrdinal}`,
    `t${identity.trackOrdinal}`
  );
}

/** Prove a path is inside the daemon worktrees directory. */
export function assertInsideWorktreesDir(path: string): string {
  const root = resolve(pipelineWorktreesDir());
  const resolved = resolve(path);
  const rel = relative(root, resolved);
  if (
    rel === "" ||
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    isAbsolute(rel)
  ) {
    throw gitError("path-escape", null, `path escapes worktrees dir`);
  }
  return resolved;
}

function gitError(
  operation: string,
  exitCode: number | null,
  message: string
): GitOperationError {
  const err = new Error(`${operation}: ${message}`) as GitOperationError;
  err.operation = operation;
  err.exitCode = exitCode;
  return err;
}

export type RunGitOptions = {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
};

export type RunGitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runGit(options: RunGitOptions): Promise<RunGitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", options.args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...options.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(gitError(options.args[0] ?? "git", null, "timeout"));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      stdoutBytes += buf.length;
      if (stdoutBytes <= MAX_GIT_OUTPUT_BYTES) {
        stdout += buf.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      stderrBytes += buf.length;
      if (stderrBytes <= MAX_GIT_OUTPUT_BYTES) {
        stderr += buf.toString("utf8");
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      if (code === "ENOENT") {
        reject(gitError("git", null, "missing-git"));
        return;
      }
      reject(gitError(options.args[0] ?? "git", null, err.message));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code ?? 1,
      });
    });
  });
}

async function gitOk(
  cwd: string,
  args: string[],
  operation: string
): Promise<string> {
  const result = await runGit({ cwd, args });
  if (result.exitCode !== 0) {
    throw gitError(
      operation,
      result.exitCode,
      result.stderr || result.stdout || `exit ${result.exitCode}`
    );
  }
  return result.stdout;
}

export async function preflightMainCheckout(
  repoPath: string
): Promise<GitPreflightResult> {
  try {
    const inside = await runGit({
      cwd: repoPath,
      args: ["rev-parse", "--is-inside-work-tree"],
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      if (
        inside.stderr.includes("not a git repository") ||
        inside.exitCode === 128
      ) {
        return {
          ok: false,
          reason: "not-work-tree",
          detail: inside.stderr || "not a git work tree",
        };
      }
      if (inside.stderr.includes("missing-git") || inside.exitCode === null) {
        return { ok: false, reason: "missing-git", detail: "git not found" };
      }
      return {
        ok: false,
        reason: "preflight-failed",
        detail: inside.stderr || "rev-parse failed",
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("missing-git")) {
      return { ok: false, reason: "missing-git", detail: message };
    }
    return { ok: false, reason: "preflight-failed", detail: message };
  }

  try {
    const abbrev = await runGit({
      cwd: repoPath,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    });
    if (abbrev.exitCode !== 0 || abbrev.stdout.trim() === "") {
      // Detached or unborn.
      const head = await runGit({
        cwd: repoPath,
        args: ["rev-parse", "--verify", "HEAD"],
      });
      if (head.exitCode !== 0) {
        return {
          ok: false,
          reason: "unborn-head",
          detail: head.stderr || "unborn HEAD",
        };
      }
      return {
        ok: false,
        reason: "detached-head",
        detail: "HEAD is detached",
      };
    }

    const branch = abbrev.stdout.trim();
    const headCommit = (
      await gitOk(repoPath, ["rev-parse", "HEAD"], "rev-parse")
    ).trim();

    const status = await runGit({
      cwd: repoPath,
      args: ["status", "--porcelain"],
    });
    if (status.exitCode !== 0) {
      return {
        ok: false,
        reason: "preflight-failed",
        detail: status.stderr || "status failed",
      };
    }
    if (status.stdout.trim() !== "") {
      return {
        ok: false,
        reason: "dirty-checkout",
        detail: "working tree is dirty",
      };
    }

    return { ok: true, headCommit, branch };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "preflight-failed", detail: message };
  }
}

export async function refExists(
  repoPath: string,
  ref: string
): Promise<boolean> {
  const result = await runGit({
    cwd: repoPath,
    args: ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`],
  });
  return result.exitCode === 0;
}

export async function addWorktree(input: {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  startPoint: string;
}): Promise<void> {
  const target = assertInsideWorktreesDir(input.worktreePath);
  if (existsSync(target)) {
    throw gitError("worktree-add", null, "target directory already exists");
  }
  if (await refExists(input.repoPath, input.branchName)) {
    throw gitError("worktree-add", null, "target branch already exists");
  }

  mkdirSync(resolve(target, ".."), { recursive: true });

  const result = await runGit({
    cwd: input.repoPath,
    args: [
      "worktree",
      "add",
      "-b",
      input.branchName,
      target,
      input.startPoint,
    ],
  });
  if (result.exitCode !== 0) {
    throw gitError(
      "worktree-add",
      result.exitCode,
      result.stderr || result.stdout || "worktree add failed"
    );
  }
}

export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const resolved = assertInsideWorktreesDir(worktreePath);
  const status = await runGit({
    cwd: resolved,
    args: ["status", "--porcelain"],
  });
  if (status.exitCode !== 0) return false;
  return status.stdout.trim() === "";
}

export async function getHeadCommit(cwd: string): Promise<string> {
  return (await gitOk(cwd, ["rev-parse", "HEAD"], "rev-parse")).trim();
}

export async function isAncestor(input: {
  cwd: string;
  ancestor: string;
  descendant: string;
}): Promise<boolean> {
  const result = await runGit({
    cwd: input.cwd,
    args: ["merge-base", "--is-ancestor", input.ancestor, input.descendant],
  });
  return result.exitCode === 0;
}

export async function removeWorktreeSafe(input: {
  repoPath: string;
  worktreePath: string;
  forceCleanOnly: boolean;
}): Promise<{ removed: boolean; reason?: string }> {
  let resolved: string;
  try {
    resolved = assertInsideWorktreesDir(input.worktreePath);
  } catch {
    return { removed: false, reason: "path-escape" };
  }

  if (!existsSync(resolved)) {
    return { removed: true };
  }

  const clean = await isWorktreeClean(resolved);
  if (!clean && input.forceCleanOnly) {
    return { removed: false, reason: "dirty" };
  }

  const args = ["worktree", "remove"];
  if (clean) {
    args.push("--force");
  }
  args.push(resolved);

  const result = await runGit({ cwd: input.repoPath, args });
  if (result.exitCode !== 0) {
    return {
      removed: false,
      reason: result.stderr || "worktree remove failed",
    };
  }
  return { removed: true };
}

export async function deleteMergedBranch(input: {
  repoPath: string;
  branchName: string;
  intoCommit: string;
}): Promise<{ deleted: boolean; reason?: string }> {
  const tip = await runGit({
    cwd: input.repoPath,
    args: ["rev-parse", "--verify", `refs/heads/${input.branchName}`],
  });
  if (tip.exitCode !== 0) {
    return { deleted: true };
  }
  const tipSha = tip.stdout.trim();
  const merged = await isAncestor({
    cwd: input.repoPath,
    ancestor: tipSha,
    descendant: input.intoCommit,
  });
  if (!merged) {
    return { deleted: false, reason: "unmerged" };
  }
  // Never --force.
  const del = await runGit({
    cwd: input.repoPath,
    args: ["branch", "-d", input.branchName],
  });
  if (del.exitCode !== 0) {
    return { deleted: false, reason: del.stderr || "branch -d failed" };
  }
  return { deleted: true };
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await runGit({ cwd: repoPath, args: ["worktree", "prune"] });
}

export function normalizePath(path: string): string {
  return normalize(resolve(path));
}
