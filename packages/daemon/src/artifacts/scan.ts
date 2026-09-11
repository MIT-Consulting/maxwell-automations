import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkspaceArtifact } from "@lca/shared";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next"]);

type Frontmatter = Record<string, unknown>;

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toStringArray(
  value: unknown,
  { splitCommas = false }: { splitCommas?: boolean } = {}
): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    // Scalar `keywords: a, b, c` is comma-separated; `globs` is not split because
    // brace globs (e.g. `*.{ts,tsx}`) legitimately contain commas.
    const parts = splitCommas ? trimmed.split(",") : [trimmed];
    const strings = parts.map((part) => part.trim()).filter(Boolean);
    return strings.length ? strings : undefined;
  }
  if (Array.isArray(value)) {
    const strings = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return strings.length ? strings : undefined;
  }
  return undefined;
}

function parseFrontmatter(filePath: string): Frontmatter {
  const raw = readFileSync(filePath, "utf8");
  if (!raw.startsWith("---")) {
    return {};
  }

  const endMatch = raw.slice(3).match(/\r?\n---\r?\n/);
  if (!endMatch || endMatch.index === undefined) {
    return {};
  }

  const yaml = raw.slice(3, endMatch.index + 3);
  const parsed = parseYaml(yaml);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Frontmatter)
    : {};
}

function tryReadFrontmatter(filePath: string): Frontmatter | null {
  try {
    return parseFrontmatter(filePath);
  } catch {
    return null;
  }
}

function projectRelativePath(workspaceRoot: string, filePath: string): string {
  return toPosixPath(relative(workspaceRoot, filePath));
}

function userRelativePath(filePath: string): string {
  return `~/${toPosixPath(relative(homedir(), filePath))}`;
}

function scanRule(workspaceRoot: string, filePath: string): WorkspaceArtifact | null {
  const frontmatter = tryReadFrontmatter(filePath);
  if (!frontmatter) {
    return null;
  }

  const path = resolve(filePath);
  return {
    kind: "rule",
    source: "project",
    name: basename(filePath, ".mdc"),
    path,
    relativePath: projectRelativePath(workspaceRoot, path),
    description: toStringValue(frontmatter.description),
    alwaysApply: toBooleanValue(frontmatter.alwaysApply),
    globs: toStringArray(frontmatter.globs),
  };
}

function scanSkill(
  filePath: string,
  source: WorkspaceArtifact["source"],
  workspaceRoot?: string
): WorkspaceArtifact | null {
  const frontmatter = tryReadFrontmatter(filePath);
  if (!frontmatter) {
    return null;
  }

  const path = resolve(filePath);
  const fallbackName = basename(dirname(filePath));
  return {
    kind: "skill",
    source,
    name: toStringValue(frontmatter.name) ?? fallbackName,
    path,
    relativePath: workspaceRoot
      ? projectRelativePath(workspaceRoot, path)
      : userRelativePath(path),
    description: toStringValue(frontmatter.description),
    keywords: toStringArray(frontmatter.keywords, { splitCommas: true }),
  };
}

function safeReadDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function scanCursorDir(workspaceRoot: string, cursorDir: string): WorkspaceArtifact[] {
  const artifacts: WorkspaceArtifact[] = [];
  const rulesDir = join(cursorDir, "rules");
  for (const entry of safeReadDir(rulesDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".mdc")) {
      continue;
    }
    const artifact = scanRule(workspaceRoot, join(rulesDir, entry.name));
    if (artifact) {
      artifacts.push(artifact);
    }
  }

  const skillsDir = join(cursorDir, "skills");
  for (const entry of safeReadDir(skillsDir)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const artifact = scanSkill(
      join(skillsDir, entry.name, "SKILL.md"),
      "project",
      workspaceRoot
    );
    if (artifact) {
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

function walkWorkspace(workspaceRoot: string): WorkspaceArtifact[] {
  const artifacts: WorkspaceArtifact[] = [];
  const root = resolve(workspaceRoot);
  if (!existsSync(root)) {
    return artifacts;
  }

  function walk(dir: string): void {
    let entries;
    try {
      if (!statSync(dir).isDirectory()) {
        return;
      }
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const child = join(dir, entry.name);
      if (entry.name === ".cursor") {
        artifacts.push(...scanCursorDir(root, child));
        continue;
      }
      walk(child);
    }
  }

  walk(root);
  return artifacts;
}

function scanUserSkills(): WorkspaceArtifact[] {
  const skillsDir = join(homedir(), ".cursor", "skills");
  const artifacts: WorkspaceArtifact[] = [];
  for (const entry of safeReadDir(skillsDir)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const artifact = scanSkill(join(skillsDir, entry.name, "SKILL.md"), "user");
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function mergeProjectAndUserSkills(
  projectArtifacts: WorkspaceArtifact[],
  userArtifacts: WorkspaceArtifact[]
): WorkspaceArtifact[] {
  const projectSkillNames = new Set(
    projectArtifacts
      .filter((artifact) => artifact.kind === "skill")
      .map((artifact) => artifact.name)
  );
  return [
    ...projectArtifacts,
    ...userArtifacts.filter((artifact) => !projectSkillNames.has(artifact.name)),
  ].sort((a, b) =>
    `${a.kind}:${a.name}:${a.source}`.localeCompare(`${b.kind}:${b.name}:${b.source}`)
  );
}

export function scanWorkspaceArtifacts(
  workspaceRoot: string | undefined
): WorkspaceArtifact[] {
  const projectArtifacts = workspaceRoot ? walkWorkspace(workspaceRoot) : [];
  return mergeProjectAndUserSkills(projectArtifacts, scanUserSkills());
}
