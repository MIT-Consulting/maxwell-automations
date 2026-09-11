import { describe, expect, it } from "vitest";
import { parsePromptReferences } from "../packages/shared/src/prompt-references.ts";

describe("parsePromptReferences", () => {
  it("detects short-form rule and skill references with offsets", () => {
    const prompt = "Follow @tech-stack and then use /lca-dev please.";
    expect(parsePromptReferences(prompt)).toEqual([
      {
        kind: "rule",
        name: "tech-stack",
        raw: "@tech-stack",
        index: prompt.indexOf("@tech-stack"),
        length: "@tech-stack".length,
      },
      {
        kind: "skill",
        name: "lca-dev",
        raw: "/lca-dev",
        index: prompt.indexOf("/lca-dev"),
        length: "/lca-dev".length,
      },
    ]);
  });

  it("detects long-form rule and skill references", () => {
    const prompt = "Use @rule:tech-stack with @skill:lca-dev";
    expect(parsePromptReferences(prompt)).toEqual([
      {
        kind: "rule",
        name: "tech-stack",
        raw: "@rule:tech-stack",
        index: prompt.indexOf("@rule:tech-stack"),
        length: "@rule:tech-stack".length,
      },
      {
        kind: "skill",
        name: "lca-dev",
        raw: "@skill:lca-dev",
        index: prompt.indexOf("@skill:lca-dev"),
        length: "@skill:lca-dev".length,
      },
    ]);
  });

  it("does not match mid-word at-signs or slash paths", () => {
    const prompt = "Email me@example.com and inspect src/app/main.ts before /lca-dev";
    expect(parsePromptReferences(prompt)).toEqual([
      {
        kind: "skill",
        name: "lca-dev",
        raw: "/lca-dev",
        index: prompt.indexOf("/lca-dev"),
        length: "/lca-dev".length,
      },
    ]);
  });

  it("skips references inside fenced code blocks", () => {
    const prompt = [
      "Use @tech-stack",
      "```ts",
      "const ignored = '/lca-dev and @rule:other';",
      "```",
      "Then /lca-dev",
    ].join("\n");

    expect(parsePromptReferences(prompt).map((ref) => ref.raw)).toEqual([
      "@tech-stack",
      "/lca-dev",
    ]);
  });

  it("preserves order and excludes trailing punctuation", () => {
    const prompt = "(@tech-stack), [/lca-dev]. Also @skill:gcx.";
    expect(parsePromptReferences(prompt)).toEqual([
      {
        kind: "rule",
        name: "tech-stack",
        raw: "@tech-stack",
        index: prompt.indexOf("@tech-stack"),
        length: "@tech-stack".length,
      },
      {
        kind: "skill",
        name: "lca-dev",
        raw: "/lca-dev",
        index: prompt.indexOf("/lca-dev"),
        length: "/lca-dev".length,
      },
      {
        kind: "skill",
        name: "gcx",
        raw: "@skill:gcx",
        index: prompt.indexOf("@skill:gcx"),
        length: "@skill:gcx".length,
      },
    ]);
  });

  it("returns an empty array for empty or non-string runtime input", () => {
    expect(parsePromptReferences("")).toEqual([]);
    expect(parsePromptReferences(undefined as unknown as string)).toEqual([]);
  });
});
