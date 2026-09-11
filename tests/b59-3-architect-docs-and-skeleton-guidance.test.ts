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
const PLAN_SKILL_PATH = join(REPO_ROOT, "skills", "plan-implement-fully", "SKILL.md");
const CONFIG_PATH = join(REPO_ROOT, "docs", "configuration.md");
const PROTOCOL_PATH = join(REPO_ROOT, "docs", "implement-fully-protocol.md");
const IMPLEMENT_FULLY_SKILL_PATH = join(REPO_ROOT, "skills", "implement-fully", "SKILL.md");
const REFERENCE_PATH = join(REPO_ROOT, "skills", "implement-fully", "reference.md");

const BASE_VARIABLES: Omit<ChainVariables, "planningDepth" | "approvalPolicy"> =
  {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: "b59",
    featureSlug: "b59-architect-role-split",
    featureDir: "docs/roadmap/done/b59-architect-role-split",
    featureIndex: "docs/roadmap/done/b59-architect-role-split/00-index.md",
    idea: "Architect/planner role split",
    researchApprovalPolicy: "none",
    loopMode: "normal",
  };

function vars(planningDepth: "jit" | "full"): ChainVariables {
  return { ...BASE_VARIABLES, planningDepth, approvalPolicy: "none" };
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

describe("b59.3 AD6 skeleton granularity guidance", () => {
  it("prefers fewest phases in full-depth plan-skeleton prompt", () => {
    const raw = workerPrompt("plan-skeleton");
    const full = renderWorker("plan-skeleton", "full");

    expect(raw).toMatch(/When `planningDepth` is `full`/i);
    expect(raw).toMatch(/fewest realistic initial phases/i);
    expect(raw).toMatch(/oversized over routine over-split/i);
    expect(raw).toMatch(/6 × rows \+ 1/);
    expect(raw).toMatch(/safety valve/i);
    expect(raw).toMatch(/pre-split on file\/line\/neighbor counts alone/i);

    expect(full).toMatch(/fewest realistic initial phases/i);
    expect(full).toMatch(/oversized over routine over-split/i);
  });

  it("does not add AD6 bias to jit plan-skeleton branch", () => {
    const raw = workerPrompt("plan-skeleton");
    const jitBlock = raw.split(/## When `planningDepth` is `jit`/i)[1]?.split(
      /## When `planningDepth` is `full`/i
    )[0];
    expect(jitBlock).toBeDefined();
    expect(jitBlock!).not.toMatch(/oversized over routine over-split/i);
  });
});

describe("b59.3 plan-implement-fully skill AD6 and Review Gate", () => {
  it("matches skeleton bias and drops stale Review Gate root pass claim", () => {
    const body = readFileSync(PLAN_SKILL_PATH, "utf8");

    expect(body).toMatch(/fewest realistic initial phases/i);
    expect(body).toMatch(/oversized over routine over-split/i);
    expect(body).toMatch(/6 × rows \+ 1/);
    expect(body).toMatch(/safety valve/i);

    expect(body).toMatch(/## Review Gate[\s\S]*no full root `typecheck → build → full test` pass/i);
    expect(body).not.toMatch(/ends with one root compound pass/i);
  });
});

describe("b59.3 operator docs for optional architect", () => {
  it("documents deep-fast example and role semantics", () => {
    const config = readFileSync(CONFIG_PATH, "utf8");

    expect(config).toMatch(/deep-fast:/);
    expect(config).toMatch(/architect: gpt-5\.6-sol/);
    expect(config).toMatch(/planner:[\s\S]*grok-4\.5/);
    expect(config).toMatch(/implementer: composer-2\.5/);

    expect(config).toMatch(
      /\| `planner` \| yes \| Owns `plan-phase`\. Also covers `plan-skeleton` when `architect` is unset\. \|/
    );
    expect(config).toMatch(
      /\| `architect` \| optional \| Owns `plan-skeleton` only\./
    );
    expect(config).toMatch(/model_role = 'planner'` on its `plan-skeleton` row/);
    expect(config).toMatch(/optional `architect`/);
  });

  it("lists architect in protocol and implement-fully skill surfaces", () => {
    const protocol = readFileSync(PROTOCOL_PATH, "utf8");
    const skill = readFileSync(IMPLEMENT_FULLY_SKILL_PATH, "utf8");
    const reference = readFileSync(REFERENCE_PATH, "utf8");

    expect(protocol).toMatch(
      /\| `plan-skeleton` \| architect \(falls back to `planner`\) \|/
    );
    expect(skill).toMatch(/architect, gatekeeper/);
    expect(reference).toMatch(/architect\s+# optional — omit falls back to the concrete planner selection at plan-skeleton/);
  });
});
