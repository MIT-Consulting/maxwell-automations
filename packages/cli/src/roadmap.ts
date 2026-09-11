import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
