import { describe, expect, it } from "vitest";
import {
  baseModelOptions,
  buildSelection,
  controlsForSelection,
  isBooleanLikeParameter,
  selectionForBaseModel,
  selectionLabel,
  withParamValue,
} from "../packages/dashboard/src/modelControls.ts";
import {
  modelSelectionKey,
  type ModelInfo,
  type ModelParameterDefinition,
} from "@lca/shared";

function param(
  id: string,
  values: Array<string | { value: string; displayName?: string }>,
  displayName?: string
): ModelParameterDefinition {
  return {
    id,
    displayName,
    values: values.map((entry) =>
      typeof entry === "string" ? { value: entry } : entry
    ),
  };
}

const grok: ModelInfo = {
  id: "grok-4.5",
  displayName: "Grok 4.5",
  parameters: [
    param("reasoning", ["low", "high"], "Reasoning"),
    param("web", ["true", "false"], "Web search"),
  ],
  variants: [
    {
      displayName: "Default",
      isDefault: true,
      params: [
        { id: "reasoning", value: "low" },
        { id: "web", value: "false" },
      ],
    },
    {
      displayName: "Heavy",
      params: [{ id: "reasoning", value: "high" }],
    },
  ],
};

const composer: ModelInfo = {
  id: "composer-2.5",
  displayName: "Composer 2.5",
  parameters: [param("mode", ["fast", "max"])],
  variants: [
    {
      displayName: "Fast",
      params: [{ id: "mode", value: "fast" }],
    },
  ],
};

const bare: ModelInfo = {
  id: "bare-model",
  displayName: "Bare",
};

describe("isBooleanLikeParameter", () => {
  it("classifies true/false and on/off as switches", () => {
    expect(isBooleanLikeParameter(param("a", ["true", "false"]))).toBe(true);
    expect(isBooleanLikeParameter(param("b", ["on", "off"]))).toBe(true);
    expect(isBooleanLikeParameter(param("c", ["enabled", "disabled"]))).toBe(
      true
    );
    expect(isBooleanLikeParameter(param("d", ["yes", "no"]))).toBe(true);
  });

  it("treats multi-value and non-boolean pairs as enums", () => {
    expect(
      isBooleanLikeParameter(param("effort", ["low", "medium", "high"]))
    ).toBe(false);
    expect(isBooleanLikeParameter(param("effort", ["low", "high"]))).toBe(
      false
    );
  });

  it("ignores casing and surrounding whitespace", () => {
    expect(isBooleanLikeParameter(param("x", [" TRUE ", "False"]))).toBe(true);
    expect(isBooleanLikeParameter(param("y", [" On", "OFF "]))).toBe(true);
  });
});

describe("baseModelOptions", () => {
  const catalog = [grok, composer];

  it("preserves catalog order and labels", () => {
    expect(baseModelOptions(catalog, null)).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", isCurrentOnly: false },
      { id: "composer-2.5", label: "Composer 2.5", isCurrentOnly: false },
    ]);
  });

  it("does not duplicate a current id that is already in the catalog", () => {
    expect(baseModelOptions(catalog, { id: "grok-4.5" })).toEqual([
      { id: "grok-4.5", label: "Grok 4.5", isCurrentOnly: false },
      { id: "composer-2.5", label: "Composer 2.5", isCurrentOnly: false },
    ]);
  });

  it("prepends an unknown current id once", () => {
    expect(baseModelOptions(catalog, { id: "custom-x" })).toEqual([
      { id: "custom-x", label: "custom-x (current)", isCurrentOnly: true },
      { id: "grok-4.5", label: "Grok 4.5", isCurrentOnly: false },
      { id: "composer-2.5", label: "Composer 2.5", isCurrentOnly: false },
    ]);
  });

  it("yields only the current option when the catalog is empty", () => {
    expect(baseModelOptions([], { id: "orphan" })).toEqual([
      { id: "orphan", label: "orphan (current)", isCurrentOnly: true },
    ]);
  });
});

describe("selectionForBaseModel", () => {
  it("seeds the isDefault variant params", () => {
    const selection = selectionForBaseModel(grok);
    expect(modelSelectionKey(selection)).toBe(
      modelSelectionKey({
        id: "grok-4.5",
        params: [
          { id: "reasoning", value: "low" },
          { id: "web", value: "false" },
        ],
      })
    );
  });

  it("seeds no params when variants exist but none are default", () => {
    expect(selectionForBaseModel(composer)).toEqual({ id: "composer-2.5" });
  });

  it("seeds no params when the model has neither variants nor parameters", () => {
    expect(selectionForBaseModel(bare)).toEqual({ id: "bare-model" });
  });
});

describe("controlsForSelection", () => {
  it("builds one control per catalog parameter in order", () => {
    const selection = {
      id: "grok-4.5",
      params: [{ id: "web", value: "true" }],
    };
    const controls = controlsForSelection(grok, selection);
    expect(controls).toHaveLength(2);
    expect(controls[0]).toMatchObject({
      paramId: "reasoning",
      label: "Reasoning",
      kind: "enum",
      current: null,
    });
    expect(controls[1]).toMatchObject({
      paramId: "web",
      label: "Web search",
      kind: "switch",
      current: "true",
      onValue: "true",
      offValue: "false",
    });
  });

  it("returns [] for an unknown model", () => {
    expect(controlsForSelection(undefined, { id: "missing" })).toEqual([]);
  });

  it("does not invent controls for selection-only params, and withParamValue preserves them", () => {
    const selection = {
      id: "grok-4.5",
      params: [
        { id: "reasoning", value: "high" },
        { id: "custom", value: "keep-me" },
      ],
    };
    const controls = controlsForSelection(grok, selection);
    expect(controls.map((c) => c.paramId)).toEqual(["reasoning", "web"]);
    expect(controls.every((c) => c.paramId !== "custom")).toBe(true);

    const next = withParamValue(selection, "web", "true");
    expect(modelSelectionKey(next)).toBe(
      modelSelectionKey({
        id: "grok-4.5",
        params: [
          { id: "custom", value: "keep-me" },
          { id: "reasoning", value: "high" },
          { id: "web", value: "true" },
        ],
      })
    );
  });
});

describe("withParamValue", () => {
  it("sets, overwrites, and removes without mutating the input", () => {
    const original = {
      id: "grok-4.5",
      params: [
        { id: "custom", value: "x" },
        { id: "reasoning", value: "low" },
      ],
    };
    const frozen = structuredClone(original);

    const set = withParamValue(original, "web", "true");
    expect(modelSelectionKey(set)).toBe(
      modelSelectionKey({
        id: "grok-4.5",
        params: [
          { id: "custom", value: "x" },
          { id: "reasoning", value: "low" },
          { id: "web", value: "true" },
        ],
      })
    );

    const overwrite = withParamValue(set, "reasoning", "high");
    expect(modelSelectionKey(overwrite)).toBe(
      modelSelectionKey({
        id: "grok-4.5",
        params: [
          { id: "custom", value: "x" },
          { id: "reasoning", value: "high" },
          { id: "web", value: "true" },
        ],
      })
    );

    const removed = withParamValue(overwrite, "web", null);
    expect(modelSelectionKey(removed)).toBe(
      modelSelectionKey({
        id: "grok-4.5",
        params: [
          { id: "custom", value: "x" },
          { id: "reasoning", value: "high" },
        ],
      })
    );

    expect(original).toEqual(frozen);
  });
});

describe("buildSelection", () => {
  it("returns a normalized selection for valid input", () => {
    const result = buildSelection("grok-4.5", [
      { id: "web", value: "true" },
      { id: "reasoning", value: "low" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(modelSelectionKey(result.selection)).toBe(
      modelSelectionKey({
        id: "grok-4.5",
        params: [
          { id: "reasoning", value: "low" },
          { id: "web", value: "true" },
        ],
      })
    );
  });

  it("returns ok:false for duplicate param ids without throwing", () => {
    const result = buildSelection("grok-4.5", [
      { id: "web", value: "true" },
      { id: "web", value: "false" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("returns ok:false for an empty or whitespace-only id", () => {
    expect(buildSelection("", []).ok).toBe(false);
    expect(buildSelection("   ", []).ok).toBe(false);
  });
});

describe("selectionLabel", () => {
  const catalog = [grok, composer];

  it("returns empty string for null", () => {
    expect(selectionLabel(null, catalog)).toBe("");
  });

  it("uses the catalog display name for a bare id", () => {
    expect(selectionLabel({ id: "grok-4.5" }, catalog)).toBe("Grok 4.5");
  });

  it("appends params in normalized order, preferring value displayNames", () => {
    const model: ModelInfo = {
      ...grok,
      parameters: [
        param("reasoning", [
          { value: "low", displayName: "Low" },
          { value: "high", displayName: "High" },
        ]),
        param("web", ["true", "false"]),
      ],
    };
    expect(
      selectionLabel(
        {
          id: "grok-4.5",
          params: [
            { id: "web", value: "true" },
            { id: "reasoning", value: "high" },
          ],
        },
        [model]
      )
    ).toBe("Grok 4.5 High web");
  });

  it("falls back to the raw id when the model is unknown", () => {
    expect(selectionLabel({ id: "custom-x" }, catalog)).toBe("custom-x");
  });
});
