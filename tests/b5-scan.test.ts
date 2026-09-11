import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

let tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

async function importScanner(home: string) {
  vi.resetModules();
  vi.doMock("node:os", () => ({
    homedir: () => home,
  }));
  return import("../packages/daemon/src/artifacts/scan.ts");
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe("scanWorkspaceArtifacts", () => {
  it("scans project rules, project skills, and user skills", async () => {
    const workspace = makeTempRoot("lca-b5-workspace-");
    const home = makeTempRoot("lca-b5-home-");

    writeFile(
      join(workspace, ".cursor", "rules", "tech-stack.mdc"),
      [
        "---",
        "description: Project stack",
        "alwaysApply: true",
        "globs:",
        "  - '*.ts'",
        "---",
        "# Tech Stack",
      ].join("\n")
    );
    writeFile(
      join(workspace, ".cursor", "skills", "lca-dev", "SKILL.md"),
      [
        "---",
        "name: lca-dev",
        "description: Start dev",
        "keywords:",
        "  - lca",
        "---",
        "# LCA Dev",
      ].join("\n")
    );
    writeFile(
      join(home, ".cursor", "skills", "catchup", "SKILL.md"),
      ["---", "name: catchup", "description: Catch up", "---", "# Catchup"].join(
        "\n"
      )
    );

    const { scanWorkspaceArtifacts } = await importScanner(home);
    const artifacts = scanWorkspaceArtifacts(workspace);

    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "rule",
          source: "project",
          name: "tech-stack",
          description: "Project stack",
          alwaysApply: true,
          globs: ["*.ts"],
        }),
        expect.objectContaining({
          kind: "skill",
          source: "project",
          name: "lca-dev",
          description: "Start dev",
          keywords: ["lca"],
        }),
        expect.objectContaining({
          kind: "skill",
          source: "user",
          name: "catchup",
          relativePath: "~/.cursor/skills/catchup/SKILL.md",
        }),
      ])
    );
  });

  it("scans this repo's b5 fixtures with a user-scoped skill", async () => {
    const home = makeTempRoot("lca-b5-home-");
    writeFile(
      join(home, ".cursor", "skills", "catchup", "SKILL.md"),
      ["---", "name: catchup", "description: Catch up", "---", "# Catchup"].join(
        "\n"
      )
    );

    const { scanWorkspaceArtifacts } = await importScanner(home);
    const artifacts = scanWorkspaceArtifacts(process.cwd());

    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "rule",
          source: "project",
          name: "tech-stack",
          relativePath: ".cursor/rules/tech-stack.mdc",
        }),
        expect.objectContaining({
          kind: "skill",
          source: "project",
          name: "lca-dev",
          relativePath: ".cursor/skills/lca-dev/SKILL.md",
        }),
        expect.objectContaining({
          kind: "skill",
          source: "user",
          name: "catchup",
          relativePath: "~/.cursor/skills/catchup/SKILL.md",
        }),
      ])
    );
  });

  it("lets project skills override user skills with the same name", async () => {
    const workspace = makeTempRoot("lca-b5-workspace-");
    const home = makeTempRoot("lca-b5-home-");

    writeFile(
      join(workspace, ".cursor", "skills", "lca-dev", "SKILL.md"),
      ["---", "name: lca-dev", "description: Project", "---", "# Project"].join(
        "\n"
      )
    );
    writeFile(
      join(home, ".cursor", "skills", "lca-dev", "SKILL.md"),
      ["---", "name: lca-dev", "description: User", "---", "# User"].join("\n")
    );

    const { scanWorkspaceArtifacts } = await importScanner(home);
    const matches = scanWorkspaceArtifacts(workspace).filter(
      (artifact) => artifact.kind === "skill" && artifact.name === "lca-dev"
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      source: "project",
      description: "Project",
    });
  });

  it("splits scalar comma-separated keywords but keeps brace globs intact", async () => {
    const workspace = makeTempRoot("lca-b5-workspace-");
    const home = makeTempRoot("lca-b5-home-");

    writeFile(
      join(workspace, ".cursor", "rules", "frontend.mdc"),
      ["---", "description: UI", "globs: '*.{ts,tsx}'", "---", "# UI"].join("\n")
    );
    writeFile(
      join(workspace, ".cursor", "skills", "amos", "SKILL.md"),
      [
        "---",
        "name: amos",
        "keywords: amos, link workspace, amos backlog",
        "---",
        "# Amos",
      ].join("\n")
    );

    const { scanWorkspaceArtifacts } = await importScanner(home);
    const artifacts = scanWorkspaceArtifacts(workspace);

    const rule = artifacts.find((artifact) => artifact.kind === "rule");
    expect(rule?.globs).toEqual(["*.{ts,tsx}"]);

    const skill = artifacts.find((artifact) => artifact.kind === "skill");
    expect(skill?.keywords).toEqual(["amos", "link workspace", "amos backlog"]);
  });

  it("skips malformed files and returns user skills when workspace is undefined", async () => {
    const workspace = makeTempRoot("lca-b5-workspace-");
    const home = makeTempRoot("lca-b5-home-");

    writeFile(
      join(workspace, ".cursor", "rules", "broken.mdc"),
      ["---", "description: [", "---", "# Broken"].join("\n")
    );
    writeFile(
      join(home, ".cursor", "skills", "gc", "SKILL.md"),
      ["---", "name: gc", "---", "# Git Commit"].join("\n")
    );

    const { scanWorkspaceArtifacts } = await importScanner(home);

    expect(scanWorkspaceArtifacts(workspace)).toEqual([
      expect.objectContaining({ kind: "skill", source: "user", name: "gc" }),
    ]);
    expect(scanWorkspaceArtifacts(undefined)).toEqual([
      expect.objectContaining({ kind: "skill", source: "user", name: "gc" }),
    ]);
  });
});
