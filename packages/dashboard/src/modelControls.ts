import {
  ModelSelectionError,
  modelSelectionSummary,
  normalizeModelSelection,
  resolveAutomationModel,
  type ModelInfo,
  type ModelParameterAllowedValue,
  type ModelParameterDefinition,
  type ModelParameterValue,
  type ModelSelection,
} from "@lca/shared";

export type ModelControlKind = "switch" | "enum";

export type ModelControl = {
  paramId: string;
  /** Catalog displayName when present, else the raw param id. */
  label: string;
  kind: ModelControlKind;
  values: ModelParameterAllowedValue[];
  /** Current value for this param in the selection, or null when unset. */
  current: string | null;
  /** Only for kind "switch": the value meaning on / off. */
  onValue?: string;
  offValue?: string;
};

export type BaseModelOption = {
  id: string;
  label: string;
  /** True when the model is absent from the catalog and is listed only to preserve the current value. */
  isCurrentOnly: boolean;
};

export type BuildSelectionResult =
  | { ok: true; selection: ModelSelection }
  | { ok: false; error: string };

/** Lowercased truthy members of recognized boolean pairs. */
const TRUTHY_BOOLEAN_VALUES = new Set(["true", "on", "enabled", "yes"]);

/** Recognized boolean pairs as sorted "a|b" keys of lowercased values. */
const BOOLEAN_PAIR_KEYS = new Set([
  "false|true",
  "off|on",
  "disabled|enabled",
  "no|yes",
]);

function normalizeAllowedToken(value: string): string {
  return value.trim().toLowerCase();
}

export function isBooleanLikeParameter(param: ModelParameterDefinition): boolean {
  if (param.values.length !== 2) return false;
  const a = normalizeAllowedToken(param.values[0]!.value);
  const b = normalizeAllowedToken(param.values[1]!.value);
  if (!a || !b || a === b) return false;
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  return BOOLEAN_PAIR_KEYS.has(key);
}

function switchSides(
  values: ModelParameterAllowedValue[]
): { onValue: string; offValue: string } {
  const first = values[0]!;
  const second = values[1]!;
  if (TRUTHY_BOOLEAN_VALUES.has(normalizeAllowedToken(first.value))) {
    return { onValue: first.value, offValue: second.value };
  }
  return { onValue: second.value, offValue: first.value };
}

export function baseModelOptions(
  models: ModelInfo[],
  current: ModelSelection | null
): BaseModelOption[] {
  const options: BaseModelOption[] = models.map((model) => ({
    id: model.id,
    label: model.displayName || model.id,
    isCurrentOnly: false,
  }));

  if (current && !models.some((model) => model.id === current.id)) {
    options.unshift({
      id: current.id,
      label: `${current.id} (current)`,
      isCurrentOnly: true,
    });
  }

  return options;
}

export function selectionForBaseModel(model: ModelInfo): ModelSelection {
  const defaultVariant = model.variants?.find((variant) => variant.isDefault === true);
  if (defaultVariant) {
    return normalizeModelSelection({
      id: model.id,
      params: defaultVariant.params,
    });
  }
  return normalizeModelSelection({ id: model.id });
}

function currentParamValue(
  selection: ModelSelection | null,
  paramId: string
): string | null {
  if (!selection?.params) return null;
  const match = selection.params.find((param) => param.id === paramId);
  return match ? match.value : null;
}

export function controlsForSelection(
  model: ModelInfo | undefined,
  selection: ModelSelection | null
): ModelControl[] {
  if (!model?.parameters) return [];

  return model.parameters.map((param) => {
    const current = currentParamValue(selection, param.id);
    if (isBooleanLikeParameter(param)) {
      const { onValue, offValue } = switchSides(param.values);
      return {
        paramId: param.id,
        label: param.displayName || param.id,
        kind: "switch" as const,
        values: param.values,
        current,
        onValue,
        offValue,
      };
    }
    return {
      paramId: param.id,
      label: param.displayName || param.id,
      kind: "enum" as const,
      values: param.values,
      current,
    };
  });
}

export function withParamValue(
  selection: ModelSelection,
  paramId: string,
  value: string | null
): ModelSelection {
  const existing = selection.params ?? [];
  const without = existing.filter((param) => param.id !== paramId);
  if (value === null) {
    return normalizeModelSelection({
      id: selection.id,
      params: without.length > 0 ? without : undefined,
    });
  }
  return normalizeModelSelection({
    id: selection.id,
    params: [...without, { id: paramId, value }],
  });
}

export function buildSelection(
  id: string,
  params: ModelParameterValue[]
): BuildSelectionResult {
  try {
    return {
      ok: true,
      selection: normalizeModelSelection({ id, params }),
    };
  } catch (err) {
    if (err instanceof ModelSelectionError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

function paramValueLabel(
  model: ModelInfo | undefined,
  paramId: string,
  value: string
): string {
  const def = model?.parameters?.find((param) => param.id === paramId);
  const allowed = def?.values.find((entry) => entry.value === value);
  return allowed?.displayName || value;
}

/**
 * Cursor-style display: model name plus muted suffixes derived from params
 * (e.g. name "Grok 4.5", suffixes ["High", "Fast"]).
 */
export function selectionDisplayParts(
  selection: ModelSelection | null,
  models: ModelInfo[]
): { name: string; suffixes: string[] } {
  if (!selection) return { name: "", suffixes: [] };
  const normalized = normalizeModelSelection(selection);
  const model = models.find((entry) => entry.id === normalized.id);
  const name = model?.displayName || normalized.id;
  const suffixes: string[] = [];
  for (const param of normalized.params ?? []) {
    const def = model?.parameters?.find((entry) => entry.id === param.id);
    if (def && isBooleanLikeParameter(def)) {
      const { onValue } = switchSides(def.values);
      if (param.value === onValue) {
        suffixes.push(def.displayName || param.id);
      }
      continue;
    }
    suffixes.push(paramValueLabel(model, param.id, param.value));
  }
  return { name, suffixes };
}

/** Trigger / list label: "Grok 4.5 High Fast". */
export function selectionLabel(
  selection: ModelSelection | null,
  models: ModelInfo[]
): string {
  const { name, suffixes } = selectionDisplayParts(selection, models);
  if (!name) return "";
  return suffixes.length > 0 ? `${name} ${suffixes.join(" ")}` : name;
}

/** Suffixes to show for a catalog model row (current selection or defaults). */
export function modelRowSuffixes(
  model: ModelInfo,
  current: ModelSelection | null
): string[] {
  const selection =
    current?.id === model.id ? current : selectionForBaseModel(model);
  return selectionDisplayParts(selection, [model]).suffixes;
}

/** Board chip label: catalog-aware when models are loaded, else raw summary / global default. */
export function modelChipLabel(
  selection: ModelSelection | null,
  models: ModelInfo[]
): string {
  if (!selection) return resolveAutomationModel(null);
  if (models.length > 0) return selectionLabel(selection, models);
  return modelSelectionSummary(selection);
}

/** Compact board chip: base model only (no params), for tight Kanban metadata. */
export function modelChipShortLabel(
  selection: ModelSelection | null,
  models: ModelInfo[]
): string {
  if (!selection) return resolveAutomationModel(null);
  const normalized = normalizeModelSelection(selection);
  const model = models.find((entry) => entry.id === normalized.id);
  if (model) return model.displayName || model.id;
  return normalized.id;
}
