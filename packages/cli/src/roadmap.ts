import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  isAdditiveRoadmapEdit,
  ROADMAP_INDEX_REL,
  type RoadmapFixPlan,
  type RoadmapFixPlanDraft,
} from "@lca/shared";
import { DaemonError } from "./client.js";

const MINIMAL_INDEX = `# Roadmap

<!-- next: b1 -->

## Backlog

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|

## Documented Ideas

| ID | Idea | Status | File |
|----|------|--------|------|
`;

export function roadmapIndexPath(workspace: string): string {
  return join(resolve(workspace), "docs", "roadmap", "00-index.md");
}

/**
 * Write a minimal `docs/roadmap/00-index.md` so implement-fully has a
 * backlog to allocate from. Refuses to overwrite an existing index.
 */
export function initRoadmap(workspace: string): string {
  const root = resolve(workspace);
  const indexPath = roadmapIndexPath(root);
  if (existsSync(indexPath)) {
    throw new DaemonError(
      `Roadmap already exists at ${indexPath}. Refusing to overwrite.`
    );
  }
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  writeFileSync(indexPath, MINIMAL_INDEX, "utf8");
  return indexPath;
}

export function hashRoadmapFileContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Simple unified diff for a single text file (test-friendly). */
export function formatRoadmapUnifiedDiff(
  relativePath: string,
  before: string,
  after: string
): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const lines: string[] = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
  ];

  const max = Math.max(beforeLines.length, afterLines.length);
  let i = 0;
  while (i < max) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) {
      i += 1;
      continue;
    }
    if (b !== undefined) {
      lines.push(`-${b}`);
    }
    if (a !== undefined) {
      lines.push(`+${a}`);
    }
    i += 1;
  }

  return lines.join("\n");
}

export type ApplyRoadmapFixResult =
  | { ok: true; writtenPath: string }
  | {
      ok: false;
      code: "stale" | "not-additive" | "unsafe-path" | "write-failed";
      message: string;
    };

export type RoadmapFixWriteGate =
  | { action: "apply" }
  | { action: "confirm" }
  | { action: "need-yes"; message: string };

/** Decide whether a fix may write, needs a TTY confirm, or must refuse. */
export function decideRoadmapFixWrite(opts: {
  yes: boolean;
  tty: boolean;
}): RoadmapFixWriteGate {
  if (opts.yes) return { action: "apply" };
  if (!opts.tty) {
    return {
      action: "need-yes",
      message:
        "Non-interactive shell — re-run with --yes to apply max roadmap fix.",
    };
  }
  return { action: "confirm" };
}

export function isRoadmapFixAffirmative(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

function confinedPlanTarget(
  workspaceRoot: string,
  relativePath: string
): string | null {
  if (relativePath !== ROADMAP_INDEX_REL) return null;
  const root = resolve(workspaceRoot);
  const target = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

export function applyRoadmapFixPlan(
  workspaceRoot: string,
  plan: RoadmapFixPlan,
  options: { confirmStaleHash?: string } = {}
): ApplyRoadmapFixResult {
  const normalizedTarget = confinedPlanTarget(
    workspaceRoot,
    plan.relativePath
  );
  if (normalizedTarget == null) {
    return {
      ok: false,
      code: "unsafe-path",
      message: "Refusing to write outside docs/roadmap/00-index.md.",
    };
  }

  let liveContent: string | null = null;
  if (existsSync(normalizedTarget)) {
    try {
      liveContent = readFileSync(normalizedTarget, "utf8");
    } catch {
      liveContent = null;
    }
  } else if (plan.baseContent.length > 0) {
    return {
      ok: false,
      code: "stale",
      message: "Target file changed or is missing — re-run max roadmap fix.",
    };
  }

  const observed =
    liveContent ??
    (plan.baseContent.length === 0 && !existsSync(normalizedTarget)
      ? ""
      : null);
  if (observed == null) {
    return {
      ok: false,
      code: "stale",
      message: "Could not read the target file for a stale-write check.",
    };
  }

  const observedHash = hashRoadmapFileContent(observed);
  const expectedHash =
    options.confirmStaleHash ?? plan.contentHash;
  if (observedHash !== expectedHash) {
    return {
      ok: false,
      code: "stale",
      message:
        "Roadmap index changed since the fix plan was built — re-run max roadmap fix.",
    };
  }

  if (!isAdditiveRoadmapEdit(plan.baseContent, plan.proposedContent)) {
    return {
      ok: false,
      code: "not-additive",
      message: "Refusing a non-additive fix plan.",
    };
  }

  const newline = observed.includes("\r\n") ? "\r\n" : "\n";
  const normalized = plan.proposedContent.replace(/\r?\n/g, newline);
  try {
    mkdirSync(dirname(normalizedTarget), { recursive: true });
    writeFileSync(normalizedTarget, normalized, "utf8");
  } catch (err) {
    return {
      ok: false,
      code: "write-failed",
      message:
        err instanceof Error
          ? err.message
          : "Failed to write the roadmap file.",
    };
  }
  return { ok: true, writtenPath: normalizedTarget };
}

export function describeRoadmapFixDraft(draft: RoadmapFixPlanDraft): string {
  switch (draft.kind) {
    case "noop":
      return draft.message;
    case "refused":
      return draft.message;
    case "ready":
      return `Ready to update ${draft.relativePath}.`;
  }
}

export function isRoadmapFixPlan(value: unknown): value is RoadmapFixPlan {
  if (value == null || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    typeof plan.workspaceId === "string" &&
    typeof plan.relativePath === "string" &&
    typeof plan.baseContent === "string" &&
    typeof plan.proposedContent === "string" &&
    typeof plan.contentHash === "string"
  );
}

export { MINIMAL_INDEX, ROADMAP_INDEX_REL };
