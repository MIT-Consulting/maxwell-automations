import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCES,
  installSkill,
} from "../scripts/install-skill.mjs";
import { SKILL_SOURCES } from "../scripts/export-public.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const SETUP_SKILL_DIR = join(REPO_ROOT, "skills", "max-setup");
const SETUP_SKILL_PATH = join(SETUP_SKILL_DIR, "SKILL.md");
const ADOPTION_PATH = join(SETUP_SKILL_DIR, "adoption.md");

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const normalized = raw.replace(/^\uFEFF/, "");
  const open = normalized.match(/^---\r?\n/);
  if (!open) return { frontmatter: "", body: raw };
  const afterOpen = open[0]!.length;
  const close = normalized.slice(afterOpen).match(/\r?\n---\r?\n/);
  if (!close || close.index === undefined) {
    return { frontmatter: "", body: raw };
  }
  const fmEnd = afterOpen + close.index;
  return {
    frontmatter: normalized.slice(afterOpen, fmEnd),
    body: normalized.slice(fmEnd + close[0]!.length),
  };
}

function parseSimpleFrontmatter(fm: string): Record<string, string> {
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
    }
  }
  flush();
  return out;
}

function installSourceNames(sources: readonly string[]): string[] {
  return sources.map((p) => basename(p)).sort();
}

describe("b79 max-setup skill contract", () => {
  it("matches frontmatter and discoverability rules", () => {
    const raw = readFileSync(SETUP_SKILL_PATH, "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);
    const meta = parseSimpleFrontmatter(frontmatter);

    expect(meta.name).toBe("max-setup");
    expect(meta["disable-model-invocation"]).toBeUndefined();
    expect(meta.description?.length).toBeGreaterThan(0);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
    expect(meta.description).toMatch(/set up Max|register|readiness|upgrade|adopt/i);

    expect(body).toMatch(/fixable_by/);
    expect(body).toMatch(/--json/);
    expect(body).toMatch(/update check/);
    expect(body).toMatch(/--apply --dry-run/);
    expect(body).toMatch(/--report/);
    expect(body).toMatch(/green doctor/i);
    expect(body).toMatch(/never pick by mtime/i);
    expect(body).toMatch(/state\.sqlite|do not probe.*sqlite/i);
    expect(body).toMatch(/lca down|max down/);
    expect(body).toMatch(/restart the daemon|never.*restart/i);
    expect(body).not.toMatch(/disable-model-invocation/);
  });

  it("pins adoption sidecar load-bearing language", () => {
    const adoption = readFileSync(ADOPTION_PATH, "utf8");
    expect(adoption).toMatch(/never pick by mtime/i);
    expect(adoption).toMatch(/--json/);
    expect(adoption).toMatch(/green doctor/i);
    expect(adoption).toMatch(/max roadmap fix/);
  });

  it("includes max-setup in install and export skill lists", () => {
    expect(installSourceNames(DEFAULT_SOURCES)).toEqual([
      "implement-fully",
      "max-setup",
      "plan-implement-fully",
    ]);
    expect([...SKILL_SOURCES].sort()).toEqual([
      "implement-fully",
      "max-setup",
      "plan-implement-fully",
    ]);
  });

  it("installs SKILL.md and adoption.md through apply/check/dry-run", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "lca-b79-src-"));
    const destRoot = mkdtempSync(join(tmpdir(), "lca-b79-dst-"));
    const src = join(sourceRoot, "max-setup");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "# setup\n", "utf8");
    writeFileSync(join(src, "adoption.md"), "# adopt\n", "utf8");

    const apply = installSkill(src, destRoot, "apply");
    expect(apply.wrote).toBe(true);
    expect(
      readFileSync(join(destRoot, "max-setup", "SKILL.md"), "utf8")
    ).toBe("# setup\n");
    expect(
      readFileSync(join(destRoot, "max-setup", "adoption.md"), "utf8")
    ).toBe("# adopt\n");

    const check = installSkill(src, destRoot, "check");
    expect(check.drift).toBe(false);

    writeFileSync(join(src, "adoption.md"), "# adopt-v2\n", "utf8");
    const dry = installSkill(src, destRoot, "dry-run");
    expect(
      dry.files.some(
        (f) => f.path === "adoption.md" && f.action === "would-update"
      )
    ).toBe(true);
    expect(
      readFileSync(join(destRoot, "max-setup", "adoption.md"), "utf8")
    ).toBe("# adopt\n");
  });
});
