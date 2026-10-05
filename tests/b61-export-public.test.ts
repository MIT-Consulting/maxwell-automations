import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_GIT_IDENTITY,
  exportPublic,
  isIncluded,
  pinPublicGitIdentity,
  scanLeaks,
  transformContent,
} from "../scripts/export-public.mjs";
import { runReleasePreflight } from "../scripts/release-preflight.mjs";
import { initRoadmap, roadmapIndexPath } from "../packages/cli/src/roadmap.ts";
import { DaemonError } from "../packages/cli/src/client.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const AGENTS_MD = join(REPO_ROOT, "AGENTS.md");

/** Relative markdown link targets in body text (ignores headings and http URLs). */
function markdownRelativeLinks(body: string): string[] {
  const links: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of body.matchAll(re)) {
    const target = (match[1] ?? "").trim();
    if (!target || /^https?:\/\//i.test(target) || target.startsWith("#")) {
      continue;
    }
    const pathPart = target.split("#")[0]!.split("?")[0]!;
    if (pathPart) links.push(pathPart);
  }
  return links;
}

describe("export allowlist", () => {
  it("includes public docs and packages, excludes the private roadmap", () => {
    expect(isIncluded("AGENTS.md")).toBe(true);
    expect(isIncluded(".npmrc")).toBe(true);
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

describe("export release preflight gate", () => {
  it("rejects malformed Upgrade actions in fixture changelog", () => {
    const dir = mkdtempSync(join(tmpdir(), "max-export-preflight-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ engines: { node: ">=22.13" } })
      );
      const bad = runReleasePreflight({
        repoRoot: dir,
        changelogText: `# Changelog\n\n## [Unreleased]\n\n## [1.0.7]\n`,
        packageJsonText: readFileSync(join(dir, "package.json"), "utf8"),
        clonePath: join(dir, "missing-clone"),
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.errors.some((e) => e.includes("Upgrade actions"))).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exportPublic invokes preflight before export work", () => {
    expect(() =>
      exportPublic({
        outDir: join(tmpdir(), "max-export-dry"),
        dryRun: true,
        runPreflight: () => ({
          ok: false,
          errors: ["1.0.8: missing Upgrade actions section"],
        }),
      })
    ).toThrow(/release preflight failed/);
  });
});

describe("AGENTS.md export contract", () => {
  it("is allowlisted and every relative link resolves inside the public export", () => {
    expect(existsSync(AGENTS_MD)).toBe(true);
    const body = readFileSync(AGENTS_MD, "utf8");
    for (const link of markdownRelativeLinks(body)) {
      const abs = normalize(resolve(REPO_ROOT, link));
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, "/");
      expect(rel.startsWith("..")).toBe(false);
      expect(existsSync(abs)).toBe(true);
      expect(isIncluded(rel)).toBe(true);
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
