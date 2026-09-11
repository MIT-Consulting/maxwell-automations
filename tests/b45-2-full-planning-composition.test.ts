import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IMPLEMENT_FULLY_PIPELINE_ID } from "../packages/shared/src/types/api.ts";
import type { ChainVariables } from "../packages/shared/src/types/config.ts";
import { parsePromptReferences } from "../packages/shared/src/prompt-references.ts";
import { renderChainTemplate } from "../packages/daemon/src/runs/chain-template.ts";
import {
  IMPLEMENT_FULLY_REQUIRED_SKILLS,
  IMPLEMENT_FULLY_WORKERS,
} from "../packages/daemon/src/pipelines/implement-fully.ts";
import { installSkill } from "../scripts/install-skill.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const PLAN_SKILL_DIR = join(REPO_ROOT, "skills", "plan-implement-fully");
const PLAN_SKILL_PATH = join(PLAN_SKILL_DIR, "SKILL.md");

const BASE_VARIABLES: Omit<ChainVariables, "planningDepth" | "approvalPolicy"> =
  {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b45",
    featureSlug: "b45-configurable-implement-fully-planning",
    featureDir: "docs/roadmap/b45-configurable-implement-fully-planning",
    featureIndex:
      "docs/roadmap/b45-configurable-implement-fully-planning/00-index.md",
    idea: "Configurable implement-fully planning profiles",
    researchApprovalPolicy: "none",
    loopMode: "normal",
  };

function vars(
  planningDepth: "jit" | "full",
  approvalPolicy: "none" | "before-implementation" = "none"
): ChainVariables {
  return { ...BASE_VARIABLES, planningDepth, approvalPolicy };
}

function workerPrompt(key: string): string {
  const worker = IMPLEMENT_FULLY_WORKERS.find((w) => w.key === key);
  if (!worker) throw new Error(`missing worker ${key}`);
  return worker.prompt;
}

function renderWorker(key: string, planningDepth: "jit" | "full"): string {
  const rendered = renderChainTemplate(workerPrompt(key), vars(planningDepth));
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error("render failed");
  return rendered.text;
}

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

describe("b45.2 plan-skeleton depth branches", () => {
  it("keeps JIT scope-only and requires full contracts before successor work", () => {
    const jit = renderWorker("plan-skeleton", "jit");
    const full = renderWorker("plan-skeleton", "full");

    expect(jit).toContain("planningDepth");
    expect(jit).toMatch(/When `planningDepth` is `jit`/i);
    expect(jit).toMatch(/scope-only/i);
    expect(jit).toMatch(/Invoke no planning skill/i);
    expect(jit).toMatch(/No detailed per-step contracts/i);

    expect(full).toMatch(/When `planningDepth` is `full`/i);
    expect(full).toMatch(/implementation-ready/i);
    expect(full).toMatch(/Leave every executable tracker row `Pending`/i);
    expect(full).toMatch(/chains to `plan-phase`/i);
    expect(full).toContain("## Implementation Checks");
    expect(full).toContain("## Review Gate");

    for (const text of [jit, full]) {
      expect(text).not.toMatch(/approval gate|before-implementation pause/i);
      expect(text).toMatch(
        /Must not[\s\S]*transition-budget extension authority/
      );
      expect(text).toContain(IMPLEMENT_FULLY_PIPELINE_ID);
    }
  });

  it("names caller and delegate skills for full planning", () => {
    const prompt = workerPrompt("plan-skeleton");
    const refs = parsePromptReferences(prompt)
      .filter((r) => r.kind === "skill")
      .map((r) => r.name)
      .sort();
    expect(refs).toEqual(
      [...IMPLEMENT_FULLY_REQUIRED_SKILLS["plan-skeleton"]].sort()
    );
    expect(refs).toContain("plan-implement-fully");
    expect(refs).toContain("plan-for-speed-model-fully");
    expect(prompt).toMatch(/\/plan-implement-fully/);
    expect(prompt).toMatch(/\/plan-for-speed-model-fully/);
  });
});

describe("b45.2 plan-phase depth branches", () => {
  it("preserves JIT first-time detail and full-depth contract validation", () => {
    const jit = renderWorker("plan-phase", "jit");
    const full = renderWorker("plan-phase", "full");

    expect(jit).toMatch(/When `planningDepth` is `jit`/i);
    expect(jit).toMatch(/Invoke \/plan-for-speed-model/);
    expect(jit).toMatch(/Write or rewrite that[\s\S]*phase file/i);

    expect(full).toMatch(/When `planningDepth` is `full`/i);
    expect(full).toMatch(/Preserve the prewritten complete contract/i);
    expect(full).toMatch(/evidence-required repairs/i);
    expect(full).toMatch(/Do not silently fall back to first-time/i);
    expect(full).toMatch(/to `In Progress`/);

    for (const text of [jit, full]) {
      expect(text).toMatch(/Evidence-based re-evaluation/i);
      expect(text).toMatch(/Capacity split \(main coordinator only\)/i);
      expect(text).toMatch(
        /Create or bypass the Guided approval gate from a track run/
      );
      expect(text).not.toMatch(/Must not[\s\S]*Enforce Guided approval/);
      expect(text).toContain("## Implementation Checks");
      expect(text).toContain("## Review Gate");
    }
  });
});

describe("b45.2 plan-implement-fully skill artifact", () => {
  it("matches frontmatter, delegation, and fixed contract rules", () => {
    const raw = readFileSync(PLAN_SKILL_PATH, "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);
    const meta = parseSimpleFrontmatter(frontmatter);

    expect(meta.name).toBe("plan-implement-fully");
    expect(meta["disable-model-invocation"]).toBe("true");
    expect(meta.description?.length).toBeGreaterThan(0);
    expect(meta.description!.length).toBeLessThanOrEqual(1024);
    expect(meta.description).toMatch(/implement-fully/i);
    expect(meta.description).toMatch(/planningDepth|full/i);

    expect(body).toMatch(/\/plan-for-speed-model-fully/);
    expect(body).toMatch(/featureDir/);
    expect(body).toMatch(/featureIndex/);
    expect(body).toMatch(/featureId/);
    expect(body).toContain("| Phase | File | Status | Depends on | Commit |");
    expect(body).toContain("## Implementation Checks");
    expect(body).toContain("## Review Gate");
    expect(body).toMatch(/Parallel Safety/);
    expect(body).toMatch(/[Ii]dempotent/);
    expect(body).toMatch(/Pending/);
    expect(body).toMatch(/Must not[\s\S]*pipeline_wave/);
    expect(body).toMatch(/Must not[\s\S]*chain_control/);
    expect(body).toMatch(/Must not[\s\S]*[Cc]ommit/);
    expect(body).toMatch(/Do not use a single `## Verification` block/);
    expect(body).not.toMatch(/^## Verification\s*$/m);
  });
});

describe("b45.2 two-skill install", () => {
  it("installs distinct source skill dirs to distinct destinations", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "lca-b45-2-src-"));
    const destRoot = mkdtempSync(join(tmpdir(), "lca-b45-2-dst-"));

    const entrySrc = join(sourceRoot, "implement-fully");
    const planSrc = join(sourceRoot, "plan-implement-fully");
    mkdirSync(entrySrc, { recursive: true });
    mkdirSync(planSrc, { recursive: true });
    writeFileSync(join(entrySrc, "SKILL.md"), "# entry\n", "utf8");
    writeFileSync(join(planSrc, "SKILL.md"), "# plan\n", "utf8");
    writeFileSync(join(planSrc, "notes.md"), "# notes\n", "utf8");

    const applyEntry = installSkill(entrySrc, destRoot, "apply");
    const applyPlan = installSkill(planSrc, destRoot, "apply");
    expect(applyEntry.destDir.replace(/\\/g, "/")).toMatch(
      /\/implement-fully$/
    );
    expect(applyPlan.destDir.replace(/\\/g, "/")).toMatch(
      /\/plan-implement-fully$/
    );
    expect(applyEntry.destDir).not.toBe(applyPlan.destDir);
    expect(
      readFileSync(join(destRoot, "implement-fully", "SKILL.md"), "utf8")
    ).toBe("# entry\n");
    expect(
      readFileSync(join(destRoot, "plan-implement-fully", "SKILL.md"), "utf8")
    ).toBe("# plan\n");

    writeFileSync(
      join(destRoot, "plan-implement-fully", "extra.md"),
      "keep\n",
      "utf8"
    );
    const checkPlan = installSkill(planSrc, destRoot, "check");
    expect(checkPlan.drift).toBe(true);
    expect(
      checkPlan.files.some((f) => f.path === "extra.md" && f.action === "extra")
    ).toBe(true);

    writeFileSync(join(planSrc, "SKILL.md"), "# plan-v2\n", "utf8");
    const dry = installSkill(planSrc, destRoot, "dry-run");
    expect(dry.wrote).toBe(false);
    expect(
      dry.files.some(
        (f) => f.path === "SKILL.md" && f.action === "would-update"
      )
    ).toBe(true);
    expect(
      readFileSync(join(destRoot, "plan-implement-fully", "SKILL.md"), "utf8")
    ).toBe("# plan\n");
    expect(
      readFileSync(join(destRoot, "plan-implement-fully", "extra.md"), "utf8")
    ).toBe("keep\n");

    const reapply = installSkill(planSrc, destRoot, "apply");
    expect(reapply.wrote).toBe(true);
    expect(
      readFileSync(join(destRoot, "plan-implement-fully", "SKILL.md"), "utf8")
    ).toBe("# plan-v2\n");
    expect(
      readFileSync(join(destRoot, "plan-implement-fully", "extra.md"), "utf8")
    ).toBe("keep\n");
  });
});
