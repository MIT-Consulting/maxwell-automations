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
const ORCHESTRATE_SKILL_DIR = join(REPO_ROOT, "skills", "max-orchestrate");
const ORCHESTRATE_SKILL_PATH = join(ORCHESTRATE_SKILL_DIR, "SKILL.md");
const AGENTS_MD = join(REPO_ROOT, "AGENTS.md");
const SKILLS_README_OVERLAY = join(
  REPO_ROOT,
  "scripts",
  "export-overlays",
  "skills-README.md"
);

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

describe("b80 max-orchestrate skill contract", () => {
  it("matches frontmatter and discoverability rules", () => {
    const raw = readFileSync(ORCHESTRATE_SKILL_PATH, "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);
    const meta = parseSimpleFrontmatter(frontmatter);

    expect(meta.name).toBe("max-orchestrate");
    expect(meta["disable-model-invocation"]).toBeUndefined();
    expect(meta.description?.length).toBeGreaterThan(0);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
    expect(meta.description).toMatch(/kick off|run b/i);
    expect(meta.description).toMatch(/what should Max do|is Max done/i);

    expect(body).toMatch(/max capabilities --json/);
    expect(body).toMatch(/--workspace/);
    expect(body).toMatch(/bestFor/);
    expect(body).toMatch(/anti-patterns/i);
    expect(body).toMatch(/version mismatch/i);
    expect(body).toMatch(/outcome: green/i);
    expect(body).toMatch(/quiet output|notification/i);
    expect(body).toMatch(/status --json/);
    expect(body).toMatch(/list --json/);
    expect(body).toMatch(/\bhost\b/);
    expect(body).toMatch(/`next`|next field/i);
    expect(body).toMatch(/LCA_ACTOR/);
    expect(body).toMatch(/actorId/);
    expect(body).toMatch(/Never.*max down|never.*max down/i);
    expect(body).toMatch(/200.*started|started.*200/i);
    expect(body).toMatch(/state\.sqlite|do not probe.*sqlite/i);
    expect(body).not.toMatch(/disable-model-invocation/);
    expect(body).not.toMatch(/max implement-fully --feature/);
    expect(body).not.toMatch(/max watch b\d+/);
  });

  it("includes max-orchestrate in install and export skill lists", () => {
    expect(installSourceNames(DEFAULT_SOURCES)).toEqual([
      "implement-fully",
      "max-orchestrate",
      "max-setup",
      "plan-implement-fully",
    ]);
    expect([...SKILL_SOURCES].sort()).toEqual([
      "implement-fully",
      "max-orchestrate",
      "max-setup",
      "plan-implement-fully",
    ]);
    const installer = readFileSync(
      join(REPO_ROOT, "scripts", "install-skill.mjs"),
      "utf8"
    );
    expect(installer).toMatch(/max-setup, max-orchestrate/);
  });

  it("lists max-orchestrate in the skills companion overlay", () => {
    const overlay = readFileSync(SKILLS_README_OVERLAY, "utf8");
    expect(overlay).toContain("max-orchestrate");
    expect(overlay).toContain("max capabilities");
  });

  it("installs SKILL.md through apply/check/dry-run", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "lca-b80-src-"));
    const destRoot = mkdtempSync(join(tmpdir(), "lca-b80-dst-"));
    const src = join(sourceRoot, "max-orchestrate");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "# orchestrate\n", "utf8");

    const apply = installSkill(src, destRoot, "apply");
    expect(apply.wrote).toBe(true);
    expect(
      readFileSync(join(destRoot, "max-orchestrate", "SKILL.md"), "utf8")
    ).toBe("# orchestrate\n");

    const check = installSkill(src, destRoot, "check");
    expect(check.drift).toBe(false);

    writeFileSync(join(src, "SKILL.md"), "# orchestrate-v2\n", "utf8");
    const dry = installSkill(src, destRoot, "dry-run");
    expect(
      dry.files.some(
        (f) => f.path === "SKILL.md" && f.action === "would-update"
      )
    ).toBe(true);
    expect(
      readFileSync(join(destRoot, "max-orchestrate", "SKILL.md"), "utf8")
    ).toBe("# orchestrate\n");
  });

  it("AGENTS.md routes to capabilities without copying the catalog", () => {
    const agents = readFileSync(AGENTS_MD, "utf8");
    expect(agents).toMatch(/Orchestrating Max/);
    expect(agents).toContain("max-orchestrate");
    expect(agents).toContain("max capabilities --json");
    expect(agents).toMatch(/bestFor/);
    expect(agents).toMatch(/anti-patterns/);
    expect(agents).not.toMatch(/max implement-fully --feature/);
    expect(agents).not.toMatch(/max watch b\d+/);
  });
});
