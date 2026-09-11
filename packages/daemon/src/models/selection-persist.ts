import {
  legacyModelFromSelection,
  modelSelectionFromLegacy,
  normalizeModelSelection,
  type ModelParameterValue,
  type ModelSelection,
} from "@lca/shared";

export type StoredModelColumns = {
  model: string | null;
  modelParamsJson: string | null;
};

/**
 * Corrupt rows are re-read on every projection, so warn once per distinct
 * payload instead of on every list/GET.
 */
const reportedCorruptParams = new Set<string>();

function reportCorruptParams(model: string, detail: string): void {
  const key = `${model}\u0000${detail}`;
  if (reportedCorruptParams.has(key)) {
    return;
  }
  reportedCorruptParams.add(key);
  const ts = new Date().toISOString();
  console.error(
    `[lca-daemon ${ts}] model "${model}": ${detail} — falling back to id-only selection`
  );
}

/**
 * Split a canonical selection into DB columns.
 * ID-only selections store `model_params_json = NULL`.
 */
export function splitSelectionForDb(
  selection: ModelSelection | null | undefined
): StoredModelColumns {
  if (!selection) {
    return { model: null, modelParamsJson: null };
  }
  const normalized = normalizeModelSelection(selection);
  if (!normalized.params?.length) {
    return { model: normalized.id, modelParamsJson: null };
  }
  return {
    model: normalized.id,
    modelParamsJson: JSON.stringify(normalized.params),
  };
}

/**
 * Reconstruct a selection from stored columns. Corrupt/invalid JSON degrades to
 * ID-only (never throws) so daemon startup and projections stay healthy, and is
 * reported to `onCorrupt` — or to the daemon log when no handler is supplied.
 */
export function selectionFromStored(
  model: string | null | undefined,
  paramsJson: string | null | undefined,
  onCorrupt?: (detail: string) => void
): ModelSelection | null {
  const base = modelSelectionFromLegacy(model);
  if (!base) {
    return null;
  }
  if (paramsJson == null || paramsJson.trim() === "") {
    return base;
  }
  const warn =
    onCorrupt ?? ((detail: string) => reportCorruptParams(base.id, detail));

  let parsed: unknown;
  try {
    parsed = JSON.parse(paramsJson);
  } catch {
    warn(`invalid model_params_json (not JSON): ${paramsJson.slice(0, 120)}`);
    return base;
  }

  if (!Array.isArray(parsed)) {
    warn("invalid model_params_json (expected array)");
    return base;
  }

  const params: ModelParameterValue[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      warn("invalid model_params_json entry (not object)");
      return base;
    }
    const row = item as { id?: unknown; value?: unknown };
    if (typeof row.id !== "string" || typeof row.value !== "string") {
      warn("invalid model_params_json entry (id/value must be strings)");
      return base;
    }
    params.push({ id: row.id, value: row.value });
  }

  try {
    return normalizeModelSelection({ id: base.id, params });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`invalid model_params_json (${message})`);
    return base;
  }
}

/** YAML/API config form: scalar id when params absent, object otherwise. */
export function modelConfigForYaml(
  selection: ModelSelection | null | undefined
): string | ModelSelection | null | undefined {
  if (selection === undefined) return undefined;
  if (selection === null) return null;
  const normalized = normalizeModelSelection(selection);
  if (!normalized.params?.length) return normalized.id;
  return { id: normalized.id, params: normalized.params };
}

/** Convenience: id string for callers that still need legacy-only display. */
export function storedModelId(selection: ModelSelection | null | undefined): string | null {
  return legacyModelFromSelection(selection);
}
