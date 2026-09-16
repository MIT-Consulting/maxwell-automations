import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_GIT_IDENTITY,
  isIncluded,
  pinPublicGitIdentity,
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
    const rooted = scanLeaks(
      "tests/example.test.ts",
      ["path: C:", "Users", "dev", "app", "packages", "dashboard", "src", "transcript.tsx"].join("\\")
    );
    const bare = scanLeaks(
      ".cursor/rules/tech-stack.mdc",
      "use `C:\\Users\\dev` as the profile path"
    );
    expect(rooted).toEqual([]);
    expect(bare).toEqual([]);
  });

  it("flags any tailnet address except the documentation placeholders", () => {
    const real = ["100", "77", "138", "106"].join(".");
    const hits = scanLeaks(
      "tests/example.test.ts",
      [
        `host: "${real}"`,
        'ok: "100.64.0.2"',
        'ok: "100.64.1.9"',
        'ok: "100.127.255.1"',
        "range: 100.64.0.0/10",
      ].join("\n")
    );
    expect(hits.map((h) => [h.id, h.line])).toEqual([["operator-tailnet", 1]]);
  });

  it("flags the operator's personal email address in content", () => {
    const addr = ["the.david", "jmiller", "@gmail.com"].join("");
    const hits = scanLeaks("CHANGELOG.md", `Author: ${addr}`);
    expect(hits.map((h) => h.id)).toEqual(["operator-email"]);
  });
});

describe("export git identity", () => {
  it("pins the public identity into a clone at the destination", () => {
    const dir = mkdtempSync(join(tmpdir(), "max-export-id-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" })
          .toString()
          .trim();
      git("init", "-q");
      git("config", "user.email", "operator@example.invalid");
      expect(pinPublicGitIdentity(dir)).toBe(true);
      expect(git("config", "--get", "user.email")).toBe(
        PUBLIC_GIT_IDENTITY.email
      );
      expect(git("config", "--get", "user.name")).toBe(PUBLIC_GIT_IDENTITY.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op for a plain directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "max-export-plain-"));
    try {
      expect(pinPublicGitIdentity(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
