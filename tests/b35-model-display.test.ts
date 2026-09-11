import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_MODEL, type ModelInfo } from "@lca/shared";
import {
  modelChipLabel,
  modelChipShortLabel,
  selectionLabel,
} from "../packages/dashboard/src/modelControls.ts";
import { normalizeEvent } from "../packages/dashboard/src/normalizeEvent.ts";
import type { StoredEvent } from "../packages/dashboard/src/transcript-types.ts";

function ev(seq: number, eventType: string, payload: unknown): StoredEvent {
  return { seq, eventType, payload: JSON.stringify(payload) };
}

const parameterized = {
  model: "grok-4.5",
  modelSelection: {
    id: "grok-4.5",
    params: [{ id: "reasoning", value: "high" }],
  },
};

const catalog: ModelInfo[] = [
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    parameters: [
      {
        id: "reasoning",
        values: [
          { value: "low", displayName: "Low" },
          { value: "high", displayName: "High" },
        ],
      },
    ],
  },
];

describe("selection-aware transcript dividers", () => {
  it("renders parameterized and legacy-only started/resumed titles", () => {
    expect(normalizeEvent(ev(1, "run.started", parameterized)).title).toBe(
      "started (grok-4.5 (reasoning=high))"
    );
    expect(
      normalizeEvent(ev(2, "run.started", { model: "composer-2.5" })).title
    ).toBe("started (composer-2.5)");
    expect(normalizeEvent(ev(3, "run.started", {})).title).toBe("started");

    expect(normalizeEvent(ev(4, "chat.started", parameterized)).title).toBe(
      "started (grok-4.5 (reasoning=high))"
    );
    expect(normalizeEvent(ev(5, "run.resumed", parameterized)).title).toBe(
      "resumed (grok-4.5 (reasoning=high))"
    );
    expect(normalizeEvent(ev(6, "chat.resumed", parameterized)).title).toBe(
      "resumed (grok-4.5 (reasoning=high))"
    );
  });

  it("maps run.model with params and null selection", () => {
    const set = normalizeEvent(ev(1, "run.model", parameterized));
    expect(set.title).toBe("model changed");
    expect(set.body).toBe("Next turn uses grok-4.5 (reasoning=high)");

    const cleared = normalizeEvent(ev(2, "run.model", { model: null }));
    expect(cleared.title).toBe("model changed");
    expect(cleared.body).toBe("Next turn uses the automation default");
  });
});

describe("modelChipLabel", () => {
  it("uses catalog display names when available", () => {
    expect(
      modelChipLabel(
        {
          id: "grok-4.5",
          params: [{ id: "reasoning", value: "high" }],
        },
        catalog
      )
    ).toBe(selectionLabel(
      {
        id: "grok-4.5",
        params: [{ id: "reasoning", value: "high" }],
      },
      catalog
    ));
    expect(modelChipLabel({ id: "grok-4.5" }, catalog)).toBe("Grok 4.5");
  });

  it("falls back to raw id summary without a catalog", () => {
    expect(
      modelChipLabel(
        {
          id: "custom-x",
          params: [{ id: "a", value: "b" }],
        },
        []
      )
    ).toBe("custom-x (a=b)");
  });

  it("shows the global default for a null selection", () => {
    expect(modelChipLabel(null, catalog)).toBe(DEFAULT_AUTOMATION_MODEL);
  });
});

describe("modelChipShortLabel", () => {
  it("uses catalog display name without params", () => {
    expect(
      modelChipShortLabel(
        {
          id: "grok-4.5",
          params: [{ id: "reasoning", value: "high" }],
        },
        catalog
      )
    ).toBe("Grok 4.5");
  });

  it("falls back to catalog id when displayName is empty", () => {
    const noDisplay: ModelInfo[] = [{ id: "bare-model", displayName: "" }];
    expect(modelChipShortLabel({ id: "bare-model" }, noDisplay)).toBe(
      "bare-model"
    );
  });

  it("returns only the normalized id for uncatalogued parameterized selections", () => {
    const selection = {
      id: "custom-x",
      params: [{ id: "a", value: "b" }],
    };
    expect(modelChipShortLabel(selection, catalog)).toBe("custom-x");
    expect(modelChipLabel(selection, catalog)).toBe("custom-x b");
    expect(modelChipLabel(selection, [])).toBe("custom-x (a=b)");
  });

  it("shows the global default for a null selection", () => {
    expect(modelChipShortLabel(null, catalog)).toBe(DEFAULT_AUTOMATION_MODEL);
  });
});
