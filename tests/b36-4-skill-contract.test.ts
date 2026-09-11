import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PIPELINE_REQUIRED_MODEL_ROLES } from "../packages/shared/src/types/api.ts";
import { parsePromptReferences } from "../packages/shared/src/prompt-references.ts";
import { parseImplementFullyArgs } from "../packages/cli/src/implement-fully.ts";
import { installSkill } from "../scripts/install-skill.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const SKILL_DIR = join(REPO_ROOT, "skills", "implement-fully");
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");
const REFERENCE_PATH = join(SKILL_DIR, "reference.md");

/** Skill references allowed outside fenced blocks in the skill body. */
const ALLOWED_SKILL_REFS = new Set<string>([
  // Intentionally empty: every slash-token in the body must live in a fence.
]);

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const open = normalized.match(/^---\r?\n/);
  if (!open) {
    return { frontmatter: "", body: raw };
  }
  const afterOpen = open[0]!.length;
  const close = normalized.slice(afterOpen).match(/\r?\n---\r?\n/);
  if (!close || close.index === undefined) {
    return { frontmatter: "", body: raw };
  }
  const fmStart = afterOpen;
  const fmEnd = afterOpen + close.index;
  const bodyStart = fmEnd + close[0]!.length;
  return {
    frontmatter: normalized.slice(fmStart, fmEnd),
    body: normalized.slice(bodyStart),
  };
}

function parseSimpleFrontmatter(
  fm: string
): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = fm.split(/\r?\n/);
  let key: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (!key) return;
    out[key] = buf.join("\n").trim();
    key = undefined;
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && !line.startsWith(" ")) {
      flush();
      key = m[1];
      const rest = (m[2] ?? "").trim();
      // YAML block scalars: >, >-, |, |-
      if (/^[>|]-?$/.test(rest)) {
        buf = [];
      } else {
        buf = [rest.replace(/^["']|["']$/g, "")];
        flush();
      }
      continue;
    }
    if (key && (line.startsWith("  ") || line.startsWith("\t"))) {
      buf.push(line.trim());
      continue;
    }
    if (key && line.trim() === "") {
      buf.push("");
      continue;
    }
  }
  flush();
  return out;
}

/** Long flags mentioned in prose/fences (`--foo`). */
function extractLongFlags(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/--[a-z][a-z0-9-]*/g)) {
    found.add(m[0]!);
  }
  return [...found].sort();
}

function outsideFencedCode(text: string): string {
  let inFence = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

describe("b36.04d skill frontmatter and size", () => {
  const raw = readFileSync(SKILL_PATH, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const meta = parseSimpleFrontmatter(frontmatter);

  it("has name implement-fully matching the directory", () => {
    expect(meta.name).toBe("implement-fully");
    expect(SKILL_DIR.replace(/\\/g, "/").endsWith("/implement-fully")).toBe(
      true
    );
  });

  it("has a non-empty description ≤ 1024 chars and disable-model-invocation", () => {
    expect(meta.description?.length).toBeGreaterThan(0);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
    expect(meta.description).toContain("/implement-fully");
    expect(meta.description).toContain("implement fully");
    expect(meta.description).toContain("take this feature all the way");
    expect(meta.description).toMatch(/\bb\d+\b/);
    expect(meta.description).toContain("commits");
    expect(meta["disable-model-invocation"]).toBe("true");
  });

  it("is under 500 lines", () => {
    const lines = raw.split(/\r?\n/).length;
    expect(lines).toBeLessThan(500);
  });

  it("names the verb, roles, and both thin command forms", () => {
    expect(body).toContain("lca implement-fully");
    for (const role of PIPELINE_REQUIRED_MODEL_ROLES) {
      expect(body).toContain(role);
    }
    expect(body).toContain("--feature");
    expect(body).toContain("--idea");
    expect(body).not.toContain("--slug");
    expect(body).toMatch(/canonical feature id/i);
    expect(body).toMatch(/\bslug\b/i);
    expect(body).toMatch(/\bidea\b/i);
    expect(body).not.toMatch(/<!--\s*next:/);
    expect(body).not.toMatch(/docs\/roadmap\/b<n>/);
  });

  it("is self-contained (no repo-internal paths)", () => {
    for (const text of [body, readFileSync(REFERENCE_PATH, "utf8")]) {
      expect(text).not.toMatch(/\bpackages\//);
      expect(text).not.toContain("docs/implement-fully-protocol.md");
      expect(text).not.toContain("docs/configuration.md");
      expect(text).not.toMatch(/\btests\//);
    }
  });

  it("avoids teardown footguns", () => {
    for (const text of [body, readFileSync(REFERENCE_PATH, "utf8")]) {
      expect(text).not.toContain("lca down");
      expect(text).not.toContain("/api/shutdown");
    }
  });

  it("keeps literal commands, flags, and target paths in fenced blocks", () => {
    for (const text of [body, readFileSync(REFERENCE_PATH, "utf8")]) {
      const prose = outsideFencedCode(text);
      expect(prose).not.toMatch(/\blca(?:\s|$)/);
      expect(prose).not.toMatch(/--[a-z][a-z0-9-]*/);
      expect(prose).not.toMatch(
        /(?:^|[\s(])(?:docs|packages|scripts|skills|tests)[\\/][A-Za-z0-9]/m
      );
    }
  });
});

describe("b36.04d skill flag drift", () => {
  it("mentions only flags the 04c parser accepts", () => {
    const raw = readFileSync(SKILL_PATH, "utf8");
    const { body } = splitFrontmatter(raw);
    const flags = extractLongFlags(body);
    expect(flags.length).toBeGreaterThan(0);

    // Each mentioned flag is exercised with exactly one valid thin intent.
    for (const flag of flags) {
      if (flag === "--feature") {
        expect(() =>
          parseImplementFullyArgs(["--feature", "b42"])
        ).not.toThrow();
        continue;
      }
      if (flag === "--idea") {
        expect(() =>
          parseImplementFullyArgs(["--idea", "contract test"])
        ).not.toThrow();
        continue;
      }
      const base = ["--feature", "b42"];
      if (flag === "--dry-run" || flag === "--force" || flag === "--prune") {
        expect(() =>
          parseImplementFullyArgs([...base, flag])
        ).not.toThrow();
        continue;
      }
      if (flag === "--execute") {
        expect(() =>
          parseImplementFullyArgs([...base, flag, "--profile", "deep"])
        ).not.toThrow();
        continue;
      }
      if (flag === "--workspace") {
        expect(() =>
          parseImplementFullyArgs([...base, flag, "some-ws"])
        ).not.toThrow();
        continue;
      }
      if (flag === "--role") {
        expect(() =>
          parseImplementFullyArgs([
            ...base,
            flag,
            "planner=composer-2.5",
          ])
        ).not.toThrow();
        continue;
      }
      if (flag === "--profile") {
        expect(() =>
          parseImplementFullyArgs([...base, flag, "deep"])
        ).not.toThrow();
        continue;
      }
      if (flag === "--role-profile") {
        expect(() =>
          parseImplementFullyArgs([...base, flag, "cheap"])
        ).not.toThrow();
        continue;
      }
      if (flag === "--research-approval") {
        expect(() =>
          parseImplementFullyArgs([...base, flag, "none"])
        ).not.toThrow();
        continue;
      }
      // Any other long flag must still be accepted by the parser.
      expect(() => parseImplementFullyArgs([...base, flag])).not.toThrow();
    }
  });
});

describe("b36.04d skill prompt-reference safety", () => {
  it("only allows listed skill references outside fences", () => {
    const raw = readFileSync(SKILL_PATH, "utf8");
    const { body } = splitFrontmatter(raw);
    for (const text of [body, readFileSync(REFERENCE_PATH, "utf8")]) {
      const refs = parsePromptReferences(text).filter((r) => r.kind === "skill");
      for (const ref of refs) {
        expect(ALLOWED_SKILL_REFS.has(ref.name)).toBe(true);
      }
    }
  });
});

describe("b36.04d install-skill", () => {
  it("apply / check / dry-run against temp dirs without touching ~/.cursor", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "lca-skill-src-"));
    const destRoot = mkdtempSync(join(tmpdir(), "lca-skill-dst-"));
    const sourceDir = join(sourceRoot, "implement-fully");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "SKILL.md"), "# skill\n", "utf8");
    writeFileSync(join(sourceDir, "reference.md"), "# ref\n", "utf8");

    const first = installSkill(sourceDir, destRoot, "apply");
    expect(first.wrote).toBe(true);
    expect(first.files.map((f) => f.action).sort()).toEqual([
      "created",
      "created",
    ]);
    expect(
      readFileSync(join(destRoot, "implement-fully", "SKILL.md"), "utf8")
    ).toBe("# skill\n");

    const second = installSkill(sourceDir, destRoot, "apply");
    expect(second.wrote).toBe(false);
    expect(second.files.every((f) => f.action === "unchanged")).toBe(true);

    const checkClean = installSkill(sourceDir, destRoot, "check");
    expect(checkClean.drift).toBe(false);

    writeFileSync(
      join(destRoot, "implement-fully", "SKILL.md"),
      "# mutated\n",
      "utf8"
    );
    const checkDirty = installSkill(sourceDir, destRoot, "check");
    expect(checkDirty.drift).toBe(true);
    const dirtySkill = checkDirty.files.find((f) => f.path === "SKILL.md");
    expect(dirtySkill).toBeDefined();
    expect(dirtySkill!.action).not.toBe("unchanged");

    writeFileSync(
      join(destRoot, "implement-fully", "SKILL.md"),
      "# skill\n",
      "utf8"
    );
    writeFileSync(
      join(destRoot, "implement-fully", "extra.md"),
      "leave me\n",
      "utf8"
    );
    const checkExtra = installSkill(sourceDir, destRoot, "check");
    expect(checkExtra.drift).toBe(true);
    expect(
      checkExtra.files.some((f) => f.path === "extra.md" && f.action === "extra")
    ).toBe(true);

    const afterApplyExtra = installSkill(sourceDir, destRoot, "apply");
    expect(
      readFileSync(join(destRoot, "implement-fully", "extra.md"), "utf8")
    ).toBe("leave me\n");
    expect(
      afterApplyExtra.files.some(
        (f) => f.path === "extra.md" && f.action === "extra"
      )
    ).toBe(true);

    // dry-run writes nothing even when destination is behind
    writeFileSync(
      join(destRoot, "implement-fully", "SKILL.md"),
      "# old\n",
      "utf8"
    );
    const dry = installSkill(sourceDir, destRoot, "dry-run");
    expect(dry.wrote).toBe(false);
    expect(
      dry.files.some(
        (f) => f.path === "SKILL.md" && f.action === "would-update"
      )
    ).toBe(true);
    expect(
      readFileSync(join(destRoot, "implement-fully", "SKILL.md"), "utf8")
    ).toBe("# old\n");
  });
});
