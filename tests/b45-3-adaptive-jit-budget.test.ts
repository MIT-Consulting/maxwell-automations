import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IMPLEMENT_FULLY_PIPELINE_ID } from "../packages/shared/src/types/api.ts";
import type { ChainVariables } from "../packages/shared/src/types/config.ts";
import { renderChainTemplate } from "../packages/daemon/src/runs/chain-template.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const PROTOCOL_PATH = join(REPO_ROOT, "docs", "implement-fully-protocol.md");
const REFERENCE_PATH = join(
  REPO_ROOT,
  "skills",
  "implement-fully",
  "reference.md"
);

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

function vars(planningDepth: "jit" | "full"): ChainVariables {
  return { ...BASE_VARIABLES, planningDepth, approvalPolicy: "none" };
}

function renderPlanPhase(planningDepth: "jit" | "full"): string {
  const worker = IMPLEMENT_FULLY_WORKERS.find((w) => w.key === "plan-phase");
  if (!worker) throw new Error("missing plan-phase worker");
  const rendered = renderChainTemplate(worker.prompt, vars(planningDepth));
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) throw new Error("render failed");
  return rendered.text;
}

describe("b45.3 plan-phase adaptive admission", () => {
  it("requires evidence-based refresh and preserves valid/Done history for both depths", () => {
    for (const depth of ["jit", "full"] as const) {
      const text = renderPlanPhase(depth);
      expect(text).toMatch(/Evidence-based re-evaluation \(both planning depths\)/i);
      expect(text).toMatch(
        /Refresh[\s\S]*only[\s\S]*current code or recorded prior-phase outcomes/i
      );
      expect(text).toMatch(
        /Stylistic preference[\s\S]*is not evidence/i
      );
      expect(text).toMatch(/Valid contracts are preserved/i);
      expect(text).toMatch(/are immutable/i);
      expect(text).toMatch(/Must not[\s\S]*Renumber or rewrite `Done` history/);
      expect(text).toMatch(
        /Create or bypass the Guided approval gate from a track run/
      );
      expect(text).not.toMatch(/Must not[\s\S]*Enforce Guided approval/);
    }
  });

  it("keeps JIT first-time detail and full preserve/repair branches", () => {
    const jit = renderPlanPhase("jit");
    const full = renderPlanPhase("full");

    expect(jit).toMatch(/When `planningDepth` is `jit`/i);
    expect(jit).toMatch(/Invoke \/plan-for-speed-model/);
    expect(jit).toMatch(/scope-only stub/i);
    expect(jit).toMatch(/remains valid under evidence rules, preserve it/i);

    expect(full).toMatch(/When `planningDepth` is `full`/i);
    expect(full).toMatch(/Preserve the prewritten complete contract when it remains valid/i);
    expect(full).toMatch(/evidence-required repairs/i);
    expect(full).toMatch(/Do not silently fall back to first-time/i);
  });

  it("requires capacity admission before In Progress or fan-out", () => {
    for (const depth of ["jit", "full"] as const) {
      const text = renderPlanPhase(depth);
      expect(text).toMatch(/Candidate admission \(evidence \+ capacity\)/i);
      expect(text).toMatch(
        /before[\s\S]*`In Progress`[\s\S]*`pipeline_wave`/i
      );
      expect(text).toMatch(/Capacity invariant/i);
      expect(text).toMatch(
        /\*\*one\*\* implement worker[\s\S]*\*\*one\*\* review worker/i
      );
      expect(text).toMatch(
        /Must not[\s\S]*before capacity admission[\s\S]*budget growth after a split/i
      );
    }
  });

  it("documents retained-row expansion, dependency propagation, and re-selection", () => {
    for (const depth of ["jit", "full"] as const) {
      const text = renderPlanPhase(depth);
      expect(text).toMatch(/Capacity split \(main coordinator only\)/i);
      expect(text).toMatch(/Retain the original phase row\/file as the first narrowed unit/i);
      expect(text).toMatch(/next unused integer/i);
      expect(text).toMatch(/without\s+renumbering history/i);
      expect(text).toMatch(
        /Replace every downstream Pending dependency[\s\S]*terminal replacement/i
      );
      expect(text).toMatch(
        /Update affected downstream Pending contracts/i
      );
      expect(text).toMatch(
        /restart dependency-ready selection from the rewritten tracker/i
      );
    }
  });

  it("requires main-only split with exact additive budget growth and blocked refusal", () => {
    for (const depth of ["jit", "full"] as const) {
      const text = renderPlanPhase(depth);
      expect(text).toMatch(/Skip this section in track mode/i);
      expect(text).toMatch(
        /must \*\*not\*\* split it, alter other tracker rows, extend budget, or fan out/i
      );
      expect(text).toMatch(
        /chain_control` \*\*exactly once\*\* with[\s\S]*`extendBy: 6 × added tracker rows`/i
      );
      expect(text).toMatch(/net new executable rows only/i);
      expect(text).toMatch(
        /If extension is refused, stop with[\s\S]*`blocked:`/i
      );
      expect(text).toMatch(/leave every replacement row Pending/i);
      expect(text).toMatch(/cap\s+clamping[\s\S]*handoff `risks`/i);
      expect(text).toMatch(
        /Do not mark a replacement row `In Progress` or[\s\S]*until budget growth is accepted/i
      );
    }
  });
});

describe("b45.3 protocol and operator reference", () => {
  it("documents adaptive admission, expansion, and additive budget growth", () => {
    const protocol = readFileSync(PROTOCOL_PATH, "utf8");
    expect(protocol).toMatch(/evidence-based re-evaluation/i);
    expect(protocol).toMatch(/next\s+unused integer/i);
    expect(protocol).toMatch(/6 × added tracker rows/i);
    expect(protocol).toMatch(/monotonic/i);
    expect(protocol).toMatch(/clamped at 500/i);
    expect(protocol).toMatch(/must \*\*not\*\* split the assigned unit/i);
    expect(protocol).toMatch(/Guided approval gate/i);
    expect(protocol).not.toMatch(
      /approvalPolicy: before-implementation` is carried but not enforced/i
    );

    const reference = readFileSync(REFERENCE_PATH, "utf8");
    expect(reference).toMatch(/adaptive `plan-phase`/i);
    expect(reference).toMatch(/Full planning is not blindly regenerated/i);
    expect(reference).toMatch(/extendBy: 6 × net new rows/i);
    expect(reference).toMatch(/durable no-timeout Input Hub approval gate/i);
    expect(reference).not.toMatch(/not enforced until the Guided gate phase/i);
  });
});
