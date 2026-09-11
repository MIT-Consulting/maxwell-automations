import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_FULLY_BUDGET_FORMULA,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_VARIABLES,
  PIPELINE_MODEL_ROLES,
  PIPELINE_OPTIONAL_MODEL_ROLES,
  PIPELINE_REQUIRED_MODEL_ROLES,
} from "../packages/shared/src/types/api.ts";
import { provisionPipelineWorkersSchema } from "../packages/shared/src/schemas/config.ts";
import {
  chainKeySchema,
  chainVariablesSchema,
} from "../packages/shared/src/schemas/run.ts";

const PROTOCOL_PATH = resolve(
  import.meta.dirname,
  "../docs/implement-fully-protocol.md"
);

describe("b36.03a pipeline model roles", () => {
  it("every role parses under chainKeySchema and the tuple has no duplicates", () => {
    expect(PIPELINE_MODEL_ROLES).toHaveLength(7);
    expect(new Set(PIPELINE_MODEL_ROLES).size).toBe(PIPELINE_MODEL_ROLES.length);
    expect(
      new Set([
        ...PIPELINE_REQUIRED_MODEL_ROLES,
        ...PIPELINE_OPTIONAL_MODEL_ROLES,
      ])
    ).toEqual(new Set(PIPELINE_MODEL_ROLES));
    expect(
      PIPELINE_REQUIRED_MODEL_ROLES.some((role) =>
        (PIPELINE_OPTIONAL_MODEL_ROLES as readonly string[]).includes(role)
      )
    ).toBe(false);
    for (const role of PIPELINE_MODEL_ROLES) {
      expect(chainKeySchema.parse(role)).toBe(role);
    }
  });
});

describe("b36.03a implement-fully variables", () => {
  it("has exactly ten entries that parse as chainVariablesSchema keys", () => {
    expect(IMPLEMENT_FULLY_VARIABLES).toHaveLength(10);
    const variables = Object.fromEntries(
      IMPLEMENT_FULLY_VARIABLES.map((key) => [key, `value-for-${key}`])
    );
    expect(chainVariablesSchema.parse(variables)).toEqual(variables);
  });

  it("contains no phase-scoped name", () => {
    // Chain context is immutable after insert; a {{phase.*}} variable would be
    // the same for every run and cannot name the phase that changes each loop.
    for (const key of IMPLEMENT_FULLY_VARIABLES) {
      expect(key.startsWith("phase")).toBe(false);
    }
  });
});

describe("b36.03a provisionPipelineWorkersSchema", () => {
  it("accepts workspaceId-only and workspacePath-only", () => {
    expect(
      provisionPipelineWorkersSchema.parse({ workspaceId: "ws-1" })
    ).toEqual({
      workspaceId: "ws-1",
      dryRun: false,
      prune: false,
    });
    expect(
      provisionPipelineWorkersSchema.parse({
        workspacePath: "C:/tmp/project",
      })
    ).toEqual({
      workspacePath: "C:/tmp/project",
      dryRun: false,
      prune: false,
    });
  });

  it("defaults dryRun and prune to false when omitted", () => {
    const parsed = provisionPipelineWorkersSchema.parse({
      workspaceId: "ws",
    });
    expect(parsed.dryRun).toBe(false);
    expect(parsed.prune).toBe(false);
  });

  it("rejects both, neither, unknown keys, and non-boolean dryRun", () => {
    expect(() =>
      provisionPipelineWorkersSchema.parse({
        workspaceId: "ws",
        workspacePath: "C:/tmp",
      })
    ).toThrow();
    expect(() => provisionPipelineWorkersSchema.parse({})).toThrow();
    expect(() =>
      provisionPipelineWorkersSchema.parse({
        workspaceId: "ws",
        workers: [],
      })
    ).toThrow();
    expect(() =>
      provisionPipelineWorkersSchema.parse({
        workspaceId: "ws",
        dryRun: "yes",
      })
    ).toThrow();
  });
});

describe("b36.03a pipeline id and budget formula constants", () => {
  it("exports the stable pipeline id and budget formula", () => {
    expect(IMPLEMENT_FULLY_PIPELINE_ID).toBe("implement-fully");
    expect(IMPLEMENT_FULLY_BUDGET_FORMULA).toBe("6 × phaseCount + 1");
  });
});

describe("b36.03a protocol verification ownership", () => {
  it("keeps split gate ownership in the canonical protocol", () => {
    const text = readFileSync(PROTOCOL_PATH, "utf8");
    expect(text).toContain("## Per-worker responsibilities");
    expect(text).toContain("## Verification ownership");
    expect(text).toContain("Implementation Checks");
    expect(text).toContain("Review Gate");
    expect(text).toContain("Legacy fallback");
    expect(text).toMatch(/never blindly retried/i);
  });
});

describe("b46 protocol handoff contract", () => {
  it("documents v1 packet extraction for implement-fully successors", () => {
    const text = readFileSync(PROTOCOL_PATH, "utf8");
    expect(text).toContain("## The handoff block");
    expect(text).toContain("version: 1");
    expect(text).toContain("downstream-effects:");
    expect(text).toMatch(/daemon extracts \*\*only\*\* this validated packet/i);
    expect(text).toMatch(/≤ 4 KiB UTF-8/i);
    expect(text).not.toMatch(/daemon never parses it/i);
  });
});
