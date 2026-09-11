import { describe, expect, it } from "vitest";
import {
  automationCreateSchema,
  automationUpdateSchema,
  automationYamlEntrySchema,
  createChatSchema,
  modelConfigValueSchema,
  modelSelectionFromLegacy,
  modelSelectionKey,
  modelSelectionObjectSchema,
  modelSelectionsEqual,
  modelSelectionSummary,
  normalizeModelConfigValue,
  normalizeModelSelection,
  resolveModelMutationInput,
  updateChatSchema,
  updateRunSchema,
  updateWorkspaceChatDefaultsSchema,
  workspaceChatDefaultsYamlSchema,
} from "@lca/shared";

describe("normalizeModelSelection", () => {
  it("trims ids and sorts params by id", () => {
    expect(
      normalizeModelSelection({
        id: "  claude-sonnet-5-thinking-high  ",
        params: [
          { id: "z", value: "2" },
          { id: "a", value: "1" },
        ],
      })
    ).toEqual({
      id: "claude-sonnet-5-thinking-high",
      params: [
        { id: "a", value: "1" },
        { id: "z", value: "2" },
      ],
    });
  });

  it("omits empty param lists", () => {
    expect(normalizeModelSelection({ id: "gpt-5", params: [] })).toEqual({
      id: "gpt-5",
    });
  });

  it("rejects duplicate param ids", () => {
    expect(() =>
      normalizeModelSelection({
        id: "gpt-5",
        params: [
          { id: "reasoning", value: "high" },
          { id: "reasoning", value: "low" },
        ],
      })
    ).toThrow(/duplicate model param id/);
  });

  it("rejects empty strings", () => {
    expect(() => normalizeModelSelection({ id: "  " })).toThrow(
      /must be a non-empty string/
    );
  });
});

describe("modelSelection helpers", () => {
  it("builds stable keys that distinguish variants", () => {
    const base = { id: "gpt-5" };
    const variant = {
      id: "gpt-5",
      params: [{ id: "reasoning", value: "high" }],
    };
    expect(modelSelectionKey(base)).toBe("gpt-5");
    expect(modelSelectionKey(variant)).toBe("gpt-5?reasoning=high");
    expect(modelSelectionsEqual(base, { id: "gpt-5" })).toBe(true);
    expect(modelSelectionsEqual(base, variant)).toBe(false);
  });

  it("summarizes parameterized selections", () => {
    expect(
      modelSelectionSummary({
        id: "gpt-5",
        params: [{ id: "reasoning", value: "high" }],
      })
    ).toBe("gpt-5 (reasoning=high)");
  });

  it("converts legacy strings and clears empties", () => {
    expect(modelSelectionFromLegacy(" composer-2.5 ")).toEqual({
      id: "composer-2.5",
    });
    expect(modelSelectionFromLegacy("")).toBeNull();
    expect(modelSelectionFromLegacy(null)).toBeNull();
  });

  it("resolves mutation input with conflict detection", () => {
    expect(resolveModelMutationInput({ model: "gpt-5" })).toEqual({
      id: "gpt-5",
    });
    expect(resolveModelMutationInput({ modelSelection: null })).toBeNull();
    expect(resolveModelMutationInput({})).toBeUndefined();
    expect(() =>
      resolveModelMutationInput({ model: "gpt-5", modelSelection: null })
    ).toThrow(/conflicting/);
    expect(() =>
      resolveModelMutationInput({
        model: "gpt-5",
        modelSelection: { id: "claude-opus-5" },
      })
    ).toThrow(/conflicting/);
    expect(
      resolveModelMutationInput({
        model: "gpt-5",
        modelSelection: {
          id: "gpt-5",
          params: [{ id: "reasoning", value: "high" }],
        },
      })
    ).toEqual({
      id: "gpt-5",
      params: [{ id: "reasoning", value: "high" }],
    });
  });
});

describe("modelConfigValueSchema", () => {
  it("accepts scalar or structured YAML values", () => {
    expect(modelConfigValueSchema.parse("composer-2.5")).toBe("composer-2.5");
    expect(
      modelConfigValueSchema.parse({
        id: "gpt-5",
        params: [{ id: "reasoning", value: "high" }],
      })
    ).toEqual({
      id: "gpt-5",
      params: [{ id: "reasoning", value: "high" }],
    });
  });

  it("normalizes structured selections on parse", () => {
    expect(
      modelSelectionObjectSchema.parse({
        id: "gpt-5",
        params: [
          { id: "b", value: "2" },
          { id: "a", value: "1" },
        ],
      })
    ).toEqual({
      id: "gpt-5",
      params: [
        { id: "a", value: "1" },
        { id: "b", value: "2" },
      ],
    });
  });
});

describe("normalizeModelConfigValue", () => {
  it("round-trips multi-parameter selections", () => {
    const input = {
      id: "claude-sonnet-5-thinking-high",
      params: [
        { id: "thinking", value: "high" },
        { id: "mode", value: "agent" },
      ],
    };
    const normalized = normalizeModelConfigValue(input);
    expect(normalized).toEqual(
      normalizeModelSelection({
        id: "claude-sonnet-5-thinking-high",
        params: [
          { id: "mode", value: "agent" },
          { id: "thinking", value: "high" },
        ],
      })
    );
  });
});

describe("REST/YAML schema compatibility", () => {
  it("keeps legacy automation YAML strings valid", () => {
    expect(
      automationYamlEntrySchema.safeParse({
        name: "nightly",
        trigger: { type: "manual" },
        prompt: "go",
        model: "composer-2.5",
      }).success
    ).toBe(true);
  });

  it("accepts structured automation YAML model objects", () => {
    expect(
      automationYamlEntrySchema.safeParse({
        name: "nightly",
        trigger: { type: "manual" },
        prompt: "go",
        model: {
          id: "gpt-5",
          params: [{ id: "reasoning", value: "high" }],
        },
      }).success
    ).toBe(true);
  });

  it("preserves existing run/chat schema behavior", () => {
    expect(updateRunSchema.safeParse({ model: "gpt-5" }).success).toBe(true);
    expect(updateRunSchema.safeParse({ model: null }).success).toBe(true);
    expect(updateRunSchema.safeParse({}).success).toBe(false);
    expect(updateRunSchema.safeParse({ model: "" }).success).toBe(false);
    expect(
      updateRunSchema.safeParse({
        modelSelection: {
          id: "gpt-5",
          params: [{ id: "reasoning", value: "high" }],
        },
      }).success
    ).toBe(true);

    expect(createChatSchema.safeParse({}).success).toBe(true);
    expect(createChatSchema.safeParse({ model: "composer-2.5" }).success).toBe(
      true
    );
    expect(createChatSchema.safeParse({ model: "" }).success).toBe(false);

    expect(updateChatSchema.safeParse({ model: "gpt-5" }).success).toBe(true);
    expect(updateChatSchema.safeParse({ model: null }).success).toBe(true);
    expect(updateChatSchema.safeParse({}).success).toBe(false);
  });

  it("rejects conflicting dual fields on automation create", () => {
    const conflict = automationCreateSchema.safeParse({
      workspaceId: "ws",
      name: "x",
      trigger: { type: "manual" },
      prompt: "p",
      model: "gpt-5",
      modelSelection: { id: "claude-opus-5" },
    });
    expect(conflict.success).toBe(false);
    expect(conflict.error?.issues[0]?.message).toMatch(/conflicting/);

    // Create has no "clear" semantics, so a null selection is a type error.
    expect(
      automationCreateSchema.safeParse({
        workspaceId: "ws",
        name: "x",
        trigger: { type: "manual" },
        prompt: "p",
        model: "gpt-5",
        modelSelection: null,
      }).success
    ).toBe(false);
  });

  it("reports invalid selections once", () => {
    const result = updateChatSchema.safeParse({
      modelSelection: {
        id: "gpt-5",
        params: [
          { id: "reasoning", value: "high" },
          { id: "reasoning", value: "low" },
        ],
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toMatch(/duplicate model param id/);
  });

  it("accepts workspace chat defaults YAML scalar or object", () => {
    expect(
      workspaceChatDefaultsYamlSchema.safeParse({ model: "composer-2.5" })
        .success
    ).toBe(true);
    expect(
      workspaceChatDefaultsYamlSchema.safeParse({
        model: { id: "gpt-5", params: [{ id: "reasoning", value: "high" }] },
      }).success
    ).toBe(true);
    expect(
      updateWorkspaceChatDefaultsSchema.safeParse({ model: null }).success
    ).toBe(true);
    expect(
      automationUpdateSchema.safeParse({
        modelSelection: {
          id: "gpt-5",
          params: [{ id: "reasoning", value: "high" }],
        },
      }).success
    ).toBe(true);
  });
});
