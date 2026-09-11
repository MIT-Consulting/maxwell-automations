import { describe, expect, it } from "vitest";
import type { WorkspaceArtifact } from "@lca/shared";
import { resolvePromptReferences } from "../packages/daemon/src/artifacts/resolve.ts";

const artifacts: WorkspaceArtifact[] = [
  {
    kind: "rule",
    source: "project",
    name: "tech-stack",
    path: "/repo/.cursor/rules/tech-stack.mdc",
    relativePath: ".cursor/rules/tech-stack.mdc",
  },
  {
    kind: "skill",
    source: "project",
    name: "lca-dev",
    path: "/repo/.cursor/skills/lca-dev/SKILL.md",
    relativePath: ".cursor/skills/lca-dev/SKILL.md",
  },
];

describe("resolvePromptReferences", () => {
  it("expands known rule and skill references with path-qualified instructions", () => {
    const result = resolvePromptReferences(
      "Before running, check @tech-stack and use /lca-dev",
      artifacts
    );

    expect(result.prompt).toBe(
      [
        "Before running, check Apply the `tech-stack` rule (.cursor/rules/tech-stack.mdc)",
        " and use Use the `lca-dev` skill (.cursor/skills/lca-dev/SKILL.md)",
      ].join("")
    );
    expect(result.resolved.map((ref) => ref.raw)).toEqual([
      "@tech-stack",
      "/lca-dev",
    ]);
    expect(result.unknown).toEqual([]);
  });

  it("leaves unknown references unchanged and reports them", () => {
    const result = resolvePromptReferences(
      "Use @missing with @rule:tech-stack",
      artifacts
    );

    expect(result.prompt).toBe(
      "Use @missing with Apply the `tech-stack` rule (.cursor/rules/tech-stack.mdc)"
    );
    expect(result.resolved.map((ref) => ref.raw)).toEqual(["@rule:tech-stack"]);
    expect(result.unknown).toEqual([
      expect.objectContaining({ kind: "rule", name: "missing", raw: "@missing" }),
    ]);
  });

  it("returns reference-free prompts byte-for-byte unchanged", () => {
    const prompt = "Run the usual checks without explicit artifacts.";
    expect(resolvePromptReferences(prompt, artifacts)).toEqual({
      prompt,
      resolved: [],
      unknown: [],
    });
  });

  it("prefers project artifacts when duplicates are provided", () => {
    const result = resolvePromptReferences("@skill:gc", [
      {
        kind: "skill",
        source: "user",
        name: "gc",
        path: "/home/user/.cursor/skills/gc/SKILL.md",
        relativePath: "~/.cursor/skills/gc/SKILL.md",
      },
      {
        kind: "skill",
        source: "project",
        name: "gc",
        path: "/repo/.cursor/skills/gc/SKILL.md",
        relativePath: ".cursor/skills/gc/SKILL.md",
      },
    ]);

    expect(result.prompt).toBe("Use the `gc` skill (.cursor/skills/gc/SKILL.md)");
  });
});
