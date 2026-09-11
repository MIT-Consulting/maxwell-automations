import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isIncluded,
  scanLeaks,
  transformContent,
} from "../scripts/export-public.mjs";
import { initRoadmap, roadmapIndexPath } from "../packages/cli/src/roadmap.ts";
import { DaemonError } from "../packages/cli/src/client.ts";

describe("export allowlist", () => {
  it("includes public docs and packages, excludes the private roadmap", () => {
    expect(isIncluded("docs/brand.md")).toBe(true);
    expect(isIncluded("docs/roadmap-format.md")).toBe(true);
    expect(isIncluded("docs/forking.md")).toBe(true);
    expect(isIncluded("packages/cli/src/index.ts")).toBe(true);
    expect(isIncluded(".cursor/rules/tech-stack.mdc")).toBe(true);
    expect(isIncluded("docs/roadmap/00-index.md")).toBe(false);
    expect(isIncluded("docs/operating-model.md")).toBe(false);
    expect(isIncluded("docs/cursor_open_source_readiness_analysis.md")).toBe(
      false
    );
  });

  it("rewrites the public package name", () => {
    const out = transformContent(
      "package.json",
      JSON.stringify({ name: "cursor-local-automations", private: true })
    );
    expect(JSON.parse(out).name).toBe("maxwell-automations");
    expect(JSON.parse(out).license).toBe("Apache-2.0");
  });
});

describe("export leak scan", () => {
  it("flags Windows profile paths, vault dirnames, and transcript links", () => {
    const user = ["Some", "one"].join("");
    const uuid = [ "d3f79bee", "51e3", "4804", "9cf1", "e5fec631d477" ].join("-");
    const hits = scanLeaks(
      "docs/example.md",
      [
        ["path: C:", "Users", user, "project"].join("\\"),
        `see [chat](${uuid})`,
        `dir: ${["second", "brain"].join("-")}/notes`,
      ].join("\n")
    );
    expect(hits.map((h) => h.id).sort()).toEqual(
      ["transcript-uuid-link", "vault-dirname", "windows-user-path"].sort()
    );
  });

  it("allows the generic C:\\Users\\dev fixture root", () => {
    const hits = scanLeaks(
      "tests/example.test.ts",
      ["path: C:", "Users", "dev", "app", "packages", "dashboard", "src", "transcript.tsx"].join("\\")
    );
    expect(hits).toEqual([]);
  });
});

describe("roadmap init", () => {
  it("writes a minimal index and refuses to overwrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "max-roadmap-"));
    try {
      const written = initRoadmap(dir);
      expect(written).toBe(roadmapIndexPath(dir));
      const body = readFileSync(written, "utf8");
      expect(body).toContain("<!-- next: b1 -->");
      expect(body).toContain("## Backlog");
      expect(() => initRoadmap(dir)).toThrow(DaemonError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
