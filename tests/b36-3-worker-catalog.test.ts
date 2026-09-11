import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_VARIABLES,
  PIPELINE_MODEL_ROLES,
  PIPELINE_OPTIONAL_MODEL_ROLES,
  PIPELINE_REQUIRED_MODEL_ROLES,
} from "../packages/shared/src/types/api.ts";
import type { ChainVariables } from "../packages/shared/src/types/config.ts";
import { CHAIN_RENDERED_PROMPT_MAX_BYTES } from "../packages/shared/src/schemas/run.ts";
import { generatedWorkerSpecSchema } from "../packages/shared/src/schemas/config.ts";
import { parsePromptReferences } from "../packages/shared/src/prompt-references.ts";
import { renderChainTemplate } from "../packages/daemon/src/runs/chain-template.ts";
import { GENERATED_CONFIG_KEY_PREFIX } from "../packages/daemon/src/config/generated-workers.ts";
import {
  IMPLEMENT_FULLY_BUDGET_FORMULA_STRING,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_REQUIRED_SKILLS,
  IMPLEMENT_FULLY_WORKERS,
  computeImplementFullyBudget,
  getPipelineDefinition,
} from "../packages/daemon/src/pipelines/implement-fully.ts";

const SAMPLE_VARIABLES: ChainVariables = {
  pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
  featureId: "b99",
  featureSlug: "sample-feature",
  featureDir: "docs/roadmap/b99-sample-feature",
  featureIndex: "docs/roadmap/b99-sample-feature/00-index.md",
  idea: "Add a sample feature for catalog rendering tests",
  planningDepth: "jit",
  approvalPolicy: "none",
  researchApprovalPolicy: "none",
  loopMode: "normal",
};

function extractPlaceholders(prompt: string): string[] {
  const names = new Set<string>();
  for (const match of prompt.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

describe("b36.03b worker catalog schema", () => {
  it("has eight unique slug-valid specs including integrate-wave, final-gate, and research", () => {
    expect(IMPLEMENT_FULLY_WORKERS).toHaveLength(8);
    const keys = IMPLEMENT_FULLY_WORKERS.map((w) => w.key);
    expect(new Set(keys).size).toBe(8);
    expect(keys).toContain(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY);
    expect(keys).toContain(IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY);
    for (const spec of IMPLEMENT_FULLY_WORKERS) {
      expect(generatedWorkerSpecSchema.parse(spec)).toEqual(spec);
    }
  });
});

describe("b36.03b wiring", () => {
  it("forms one sequential cycle from the entry worker; integrate-wave and final-gate are off-cycle", () => {
    const byKey = new Map(IMPLEMENT_FULLY_WORKERS.map((w) => [w.key, w]));
    expect(byKey.has(IMPLEMENT_FULLY_ENTRY_WORKER_KEY)).toBe(true);

    for (const worker of IMPLEMENT_FULLY_WORKERS) {
      if (worker.key === IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY) {
        expect(worker.chain).toBeNull();
        continue;
      }
      expect(worker.chain).toEqual({
        next: expect.stringMatching(/^generated:/),
        when: "completed",
        passResult: true,
      });
      const nextKey = worker.chain!.next.slice(GENERATED_CONFIG_KEY_PREFIX.length);
      expect(byKey.has(nextKey)).toBe(true);
    }

    // Reachability from entry through the three loop workers (docs-commit retained but unreachable)
    const reachable = new Set<string>();
    let cursor: string | undefined = IMPLEMENT_FULLY_ENTRY_WORKER_KEY;
    while (cursor && !reachable.has(cursor)) {
      reachable.add(cursor);
      if (cursor === IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY) break;
      cursor = byKey
        .get(cursor)!
        .chain!.next.slice(GENERATED_CONFIG_KEY_PREFIX.length);
    }
    expect(reachable.size).toBe(4);
    expect(reachable.has("docs-commit")).toBe(false);
    expect(reachable.has(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY)).toBe(false);
    expect(reachable.has(IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY)).toBe(false);

    // Loop keys match the first three workers after entry
    expect(
      IMPLEMENT_FULLY_WORKERS.slice(1, 1 + IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length).map(
        (w) => w.key
      )
    ).toEqual([...IMPLEMENT_FULLY_LOOP_WORKER_KEYS]);

    const review = byKey.get("review")!;
    expect(review.chain!.next).toBe(
      GENERATED_CONFIG_KEY_PREFIX + "plan-phase"
    );

    const docsCommit = byKey.get("docs-commit")!;
    expect(docsCommit.modelRole).toBe("docs");
    expect(docsCommit.chain!.next).toBe(
      GENERATED_CONFIG_KEY_PREFIX + "plan-phase"
    );

    const integrateWave = byKey.get(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY)!;
    expect(integrateWave.modelRole).toBe("reviewer");
    expect(integrateWave.chain!.next).toBe(
      GENERATED_CONFIG_KEY_PREFIX + "plan-phase"
    );

    const finalGate = byKey.get(IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY)!;
    expect(finalGate.modelRole).toBe("gatekeeper");
    expect(finalGate.chain).toBeNull();
  });
});

describe("b36.03b roles and models", () => {
  it("covers required roles plus optional researcher, architect, and gatekeeper workers", () => {
    const used = new Set(
      IMPLEMENT_FULLY_WORKERS.map((w) => w.modelRole).filter(
        (r): r is string => typeof r === "string"
      )
    );
    for (const role of used) {
      expect(PIPELINE_MODEL_ROLES).toContain(role);
    }
    for (const role of PIPELINE_REQUIRED_MODEL_ROLES) {
      expect(used.has(role)).toBe(true);
    }
    const optionalWorkers = IMPLEMENT_FULLY_WORKERS.filter((w) =>
      (PIPELINE_OPTIONAL_MODEL_ROLES as readonly string[]).includes(
        w.modelRole ?? ""
      )
    );
    expect(optionalWorkers).toHaveLength(3);
    const byKey = new Map(optionalWorkers.map((w) => [w.key, w]));
    expect(byKey.get("research")?.modelRole).toBe("researcher");
    expect(byKey.get("plan-skeleton")?.modelRole).toBe("architect");
    expect(byKey.get("final-gate")?.modelRole).toBe("gatekeeper");
    const gatekeeperOwners = IMPLEMENT_FULLY_WORKERS.filter(
      (w) => w.modelRole === "gatekeeper"
    );
    expect(gatekeeperOwners).toHaveLength(1);
    expect(gatekeeperOwners[0]!.key).toBe("final-gate");
  });

  it("bakes no model onto any spec", () => {
    for (const worker of IMPLEMENT_FULLY_WORKERS) {
      expect(worker.model).toBeUndefined();
    }
  });
});

describe("b36.03b placeholders and rendering", () => {
  it("uses only IMPLEMENT_FULLY_VARIABLES and covers every one", () => {
    const allowed = new Set<string>(IMPLEMENT_FULLY_VARIABLES);
    const seen = new Set<string>();
    for (const worker of IMPLEMENT_FULLY_WORKERS) {
      for (const name of extractPlaceholders(worker.prompt)) {
        expect(allowed.has(name)).toBe(true);
        seen.add(name);
      }
    }
    for (const name of IMPLEMENT_FULLY_VARIABLES) {
      expect(seen.has(name)).toBe(true);
    }
  });

  it("renders every prompt under the byte cap", () => {
    for (const worker of IMPLEMENT_FULLY_WORKERS) {
      const rendered = renderChainTemplate(worker.prompt, SAMPLE_VARIABLES);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) continue;
      const bytes = Buffer.byteLength(rendered.text, "utf8");
      expect(bytes).toBeLessThan(CHAIN_RENDERED_PROMPT_MAX_BYTES);
      // Soft guard: prompts should stay far below the ceiling
      expect(bytes).toBeLessThan(16 * 1024);
    }
  });
});

describe("b36.03b prompt references", () => {
  it("matches declared skills and emits zero rule references", () => {
    for (const worker of IMPLEMENT_FULLY_WORKERS) {
      const rendered = renderChainTemplate(worker.prompt, SAMPLE_VARIABLES);
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) continue;

      const refs = parsePromptReferences(rendered.text);
      const skillNames = [
        ...new Set(
          refs.filter((r) => r.kind === "skill").map((r) => r.name)
        ),
      ].sort();
      const ruleNames = refs.filter((r) => r.kind === "rule").map((r) => r.name);
      const expected = [
        ...(IMPLEMENT_FULLY_REQUIRED_SKILLS[
          worker.key as keyof typeof IMPLEMENT_FULLY_REQUIRED_SKILLS
        ] ?? []),
      ].sort();

      expect(skillNames).toEqual(expected);
      expect(ruleNames).toEqual([]);
    }
  });
});

describe("b36.03b budget", () => {
  it("computes 6P+1, clamps at 500, and rejects invalid counts", () => {
    expect(computeImplementFullyBudget(1)).toBe(7);
    expect(computeImplementFullyBudget(2)).toBe(13);
    expect(computeImplementFullyBudget(10)).toBe(61);
    expect(computeImplementFullyBudget(200)).toBe(500);
    expect(() => computeImplementFullyBudget(0)).toThrow();
    expect(() => computeImplementFullyBudget(-1)).toThrow();
    expect(() => computeImplementFullyBudget(1.5)).toThrow();
  });

  it("embeds the formula string in plan-skeleton", () => {
    const skeleton = IMPLEMENT_FULLY_WORKERS.find(
      (w) => w.key === "plan-skeleton"
    )!;
    expect(skeleton.prompt).toContain(IMPLEMENT_FULLY_BUDGET_FORMULA_STRING);
  });
});

describe("b36.03b registry", () => {
  it("resolves the known pipeline and rejects unknowns", () => {
    const known = getPipelineDefinition(IMPLEMENT_FULLY_PIPELINE_ID);
    expect(known).toBeDefined();
    expect(known!.entryWorkerKey).toBe(IMPLEMENT_FULLY_ENTRY_WORKER_KEY);
    expect(known!.workers).toHaveLength(8);
    expect(getPipelineDefinition("no-such-pipeline")).toBeUndefined();
  });
});

describe("b36.03b lane guards", () => {
  it("names each worker and keeps stopped paths out of success handoffs", () => {
    for (const worker of IMPLEMENT_FULLY_WORKERS) {
      expect(worker.prompt).toContain(worker.key);
      expect(worker.prompt).toContain("lca-handoff");
      expect(worker.prompt).toContain("version: 1");
      expect(worker.prompt).toContain("downstream-effects:");
      expect(worker.prompt).toMatch(/≤ 4 KiB UTF-8/);
    }

    const byKey = new Map(IMPLEMENT_FULLY_WORKERS.map((worker) => [worker.key, worker]));
    expect(byKey.get("plan-phase")!.prompt).toContain(
      "A stopped terminal path emits no success handoff"
    );
    expect(byKey.get("plan-phase")!.prompt).toContain("pipeline_wave");
    expect(byKey.get("plan-phase")!.prompt).toContain("lca-track-context");
    expect(byKey.get("implement")!.prompt).toContain("lca-track-context");
    expect(byKey.get("implement")!.prompt).toContain(
      "do not emit a success handoff"
    );
    expect(byKey.get("review")!.prompt).toContain(
      "On the successful closeout path only"
    );
    expect(byKey.get("review")!.prompt).toContain("Deliverable moved");
    expect(byKey.get("review")!.prompt).toContain("Phase added");
    expect(byKey.get("review")!.prompt).toContain("Phase dropped");
    expect(byKey.get("review")!.prompt).not.toContain("fifth drift kind");
    expect(byKey.get("docs-commit")!.prompt).toContain(
      "Invent any other drift kind"
    );
    expect(byKey.get("docs-commit")!.prompt).not.toContain("fifth drift kind");
    expect(byKey.get(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY)!.prompt).toContain(
      "pipeline_wave"
    );
    expect(byKey.get(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY)!.prompt).toContain(
      "lca-integration-context"
    );
  });
});
