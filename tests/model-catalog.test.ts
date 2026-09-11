import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUTOMATION_MODEL,
  modelSelectionKey,
} from "@lca/shared";
import {
  MODEL_CATALOG_TTL_MS,
  ModelCatalog,
} from "../packages/daemon/src/models/catalog.ts";

function catalogWith(
  listModels: (apiKey: string) => Promise<unknown>,
  opts: { nowMs?: { current: number }; ttlMs?: number } = {}
) {
  const clock = opts.nowMs ?? { current: 1_000_000 };
  const onWarn = vi.fn();
  const catalog = new ModelCatalog({
    apiKey: "test-key",
    listModels,
    now: () => clock.current,
    ttlMs: opts.ttlMs ?? MODEL_CATALOG_TTL_MS,
    onWarn,
  });
  return { catalog, onWarn, clock };
}

describe("ModelCatalog mapping", () => {
  it("maps a rich catalog entry with full metadata", async () => {
    const { catalog } = catalogWith(async () => [
      {
        id: "gpt-5",
        displayName: "GPT-5",
        description: "Flagship model",
        aliases: ["gpt5", "GPT5"],
        parameters: [
          {
            id: "reasoning",
            displayName: "Reasoning",
            values: [
              { value: "low", displayName: "Low" },
              { value: "high", displayName: "High" },
            ],
          },
        ],
        variants: [
          {
            params: [{ id: "reasoning", value: "high" }],
            displayName: "GPT-5 High",
            description: "High reasoning preset",
            isDefault: true,
          },
        ],
        extraSdkField: "ignored",
      },
    ]);

    const result = await catalog.list();
    expect(result.defaultModel).toBe(DEFAULT_AUTOMATION_MODEL);
    expect(result.warning).toBeUndefined();
    expect(result.models).toEqual([
      {
        id: "gpt-5",
        displayName: "GPT-5",
        description: "Flagship model",
        aliases: ["gpt5", "GPT5"],
        parameters: [
          {
            id: "reasoning",
            displayName: "Reasoning",
            values: [
              { value: "low", displayName: "Low" },
              { value: "high", displayName: "High" },
            ],
          },
        ],
        variants: [
          {
            params: [{ id: "reasoning", value: "high" }],
            displayName: "GPT-5 High",
            description: "High reasoning preset",
            isDefault: true,
          },
        ],
      },
    ]);
  });

  it("canonicalizes variant params and distinguishes selection keys", async () => {
    const { catalog } = catalogWith(async () => [
      {
        id: "gpt-5",
        displayName: "GPT-5",
        variants: [
          {
            params: [
              { id: "z", value: "2" },
              { id: "a", value: "1" },
            ],
            displayName: "Variant A",
          },
          {
            params: [{ id: "reasoning", value: "high" }],
            displayName: "Variant B",
          },
        ],
      },
    ]);

    const result = await catalog.list();
    const model = result.models[0]!;
    expect(model.variants![0]!.params).toEqual([
      { id: "a", value: "1" },
      { id: "z", value: "2" },
    ]);
    const keyA = modelSelectionKey({
      id: model.id,
      params: model.variants![0]!.params,
    });
    const keyB = modelSelectionKey({
      id: model.id,
      params: model.variants![1]!.params,
    });
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe("gpt-5?a=1&z=2");
    expect(keyB).toBe("gpt-5?reasoning=high");
  });

  it("salvages bad optional metadata while keeping good fields", async () => {
    const { catalog } = catalogWith(async () => [
      {
        id: "claude-4",
        displayName: "Claude 4",
        description: "", // invalid — omit
        aliases: ["good-alias", "", 42, "also-good"],
        parameters: [
          {
            id: "effort",
            values: [{ value: "max" }],
          },
          {
            id: "", // bad param — drop
            values: [{ value: "x" }],
          },
          {
            id: "empty-values",
            values: [{ value: "" }], // no surviving values — drop param
          },
        ],
        variants: [
          {
            params: [{ id: "effort", value: "max" }],
            displayName: "Good variant",
          },
          {
            params: [{ id: "effort", value: "max" }],
            displayName: "", // bad — drop
          },
          {
            params: "not-an-array",
            displayName: "Broken params",
          },
          {
            params: [
              { id: "effort", value: "max" },
              { id: "", value: "invalid" },
            ],
            displayName: "Partially broken params",
          },
        ],
      },
    ]);

    const result = await catalog.list();
    expect(result.models).toHaveLength(1);
    const model = result.models[0]!;
    expect(model.description).toBeUndefined();
    expect(model.aliases).toEqual(["good-alias", "also-good"]);
    expect(model.parameters).toEqual([
      { id: "effort", values: [{ value: "max" }] },
    ]);
    expect(model.variants).toEqual([
      {
        params: [{ id: "effort", value: "max" }],
        displayName: "Good variant",
      },
    ]);
  });

  it("drops entries missing id or displayName while keeping siblings", async () => {
    const { catalog } = catalogWith(async () => [
      { id: "ok-1", displayName: "OK 1" },
      { displayName: "Missing id" },
      { id: "missing-name" },
      { id: "ok-2", displayName: "OK 2" },
    ]);

    const result = await catalog.list();
    expect(result.models.map((m) => m.id)).toEqual(["ok-1", "ok-2"]);
  });

  it("strips unknown SDK keys from the mapped payload", async () => {
    const { catalog } = catalogWith(async () => [
      {
        id: "composer-2",
        displayName: "Composer 2",
        futureField: { nested: true },
        another: 123,
      },
    ]);

    const result = await catalog.list();
    expect(result.models[0]).toEqual({
      id: "composer-2",
      displayName: "Composer 2",
    });
    expect(result.models[0]).not.toHaveProperty("futureField");
    expect(result.models[0]).not.toHaveProperty("another");
  });
});

describe("ModelCatalog cache and failure", () => {
  it("caches an empty successful list without a warning", async () => {
    let calls = 0;
    const { catalog } = catalogWith(async () => {
      calls += 1;
      return [];
    });

    const first = await catalog.list();
    const second = await catalog.list();
    expect(first).toEqual({
      models: [],
      defaultModel: DEFAULT_AUTOMATION_MODEL,
    });
    expect(first.warning).toBeUndefined();
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it("invokes the source once inside the TTL", async () => {
    let calls = 0;
    const { catalog, clock } = catalogWith(async () => {
      calls += 1;
      return [{ id: "a", displayName: "A" }];
    });

    await catalog.list();
    clock.current += MODEL_CATALOG_TTL_MS - 1;
    await catalog.list();
    expect(calls).toBe(1);
  });

  it("refetches after the TTL expires", async () => {
    let calls = 0;
    const { catalog, clock } = catalogWith(async () => {
      calls += 1;
      return [{ id: `m-${calls}`, displayName: `M${calls}` }];
    });

    const first = await catalog.list();
    clock.current += MODEL_CATALOG_TTL_MS;
    const second = await catalog.list();
    expect(calls).toBe(2);
    expect(first.models[0]!.id).toBe("m-1");
    expect(second.models[0]!.id).toBe("m-2");
  });

  it("does not cache failures and retries on the next call", async () => {
    let calls = 0;
    const { catalog, onWarn } = catalogWith(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return [{ id: "recovered", displayName: "Recovered" }];
    });

    const failed = await catalog.list();
    expect(failed.models).toEqual([]);
    expect(failed.warning).toBe("network down");
    expect(failed.defaultModel).toBe(DEFAULT_AUTOMATION_MODEL);
    expect(onWarn).toHaveBeenCalledWith(
      "[lca-daemon] Cursor.models.list failed: network down"
    );

    const ok = await catalog.list();
    expect(ok.models).toEqual([{ id: "recovered", displayName: "Recovered" }]);
    expect(ok.warning).toBeUndefined();
    expect(ok.defaultModel).toBe(DEFAULT_AUTOMATION_MODEL);
    expect(calls).toBe(2);
  });

  it("takes the failure path for a non-array payload", async () => {
    const { catalog, onWarn } = catalogWith(async () => ({ not: "an array" }));

    const result = await catalog.list();
    expect(result.models).toEqual([]);
    expect(result.warning).toBeTruthy();
    expect(result.defaultModel).toBe(DEFAULT_AUTOMATION_MODEL);
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("uses DEFAULT_AUTOMATION_MODEL on every path", async () => {
    const success = await catalogWith(async () => [
      { id: "x", displayName: "X" },
    ]).catalog.list();
    const empty = await catalogWith(async () => []).catalog.list();
    const failed = await catalogWith(async () => {
      throw new Error("boom");
    }).catalog.list();

    expect(success.defaultModel).toBe(DEFAULT_AUTOMATION_MODEL);
    expect(empty.defaultModel).toBe(DEFAULT_AUTOMATION_MODEL);
    expect(failed.defaultModel).toBe(DEFAULT_AUTOMATION_MODEL);
  });
});
