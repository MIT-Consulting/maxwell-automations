/**
 * SDK-independent model selection contracts.
 * Structural shape mirrors Cursor's ModelSelection but must not import @cursor/sdk.
 */

/** Model id used when an automation has no explicit `model` configured. */
export const DEFAULT_AUTOMATION_MODEL = "composer-2.5";

/** Bounds for API/YAML payloads (not catalog allowlists). */
export const MODEL_ID_MAX_LENGTH = 128;
export const MODEL_PARAM_ID_MAX_LENGTH = 128;
export const MODEL_PARAM_VALUE_MAX_LENGTH = 256;
export const MODEL_PARAMS_MAX_COUNT = 32;

export type ModelParameterValue = {
  id: string;
  value: string;
};

export type ModelSelection = {
  id: string;
  params?: ModelParameterValue[];
};

/** Scalar YAML/API id or structured selection object. */
export type ModelConfigValue = string | ModelSelection;

export class ModelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSelectionError";
  }
}

function trimNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ModelSelectionError(`${label} must be a non-empty string`);
  }
  return trimmed;
}

function assertMaxLength(value: string, max: number, label: string): void {
  if (value.length > max) {
    throw new ModelSelectionError(
      `${label} exceeds maximum length of ${max}`
    );
  }
}

/**
 * Normalize a selection: trim ids/values, reject duplicates/empties, sort params
 * by id, and omit empty param lists. Canonical ordering changes representation
 * only — never model semantics.
 */
export function normalizeModelSelection(
  selection: ModelSelection
): ModelSelection {
  const id = trimNonEmpty(selection.id, "model id");
  assertMaxLength(id, MODEL_ID_MAX_LENGTH, "model id");

  const rawParams = selection.params;
  if (rawParams === undefined || rawParams.length === 0) {
    return { id };
  }

  if (rawParams.length > MODEL_PARAMS_MAX_COUNT) {
    throw new ModelSelectionError(
      `model params exceed maximum count of ${MODEL_PARAMS_MAX_COUNT}`
    );
  }

  const seen = new Set<string>();
  const params: ModelParameterValue[] = [];
  for (const param of rawParams) {
    if (!param || typeof param !== "object") {
      throw new ModelSelectionError("model param must be an object");
    }
    if (typeof param.id !== "string" || typeof param.value !== "string") {
      throw new ModelSelectionError(
        "model param id and value must be strings"
      );
    }
    const paramId = trimNonEmpty(param.id, "model param id");
    const paramValue = trimNonEmpty(param.value, "model param value");
    assertMaxLength(paramId, MODEL_PARAM_ID_MAX_LENGTH, "model param id");
    assertMaxLength(
      paramValue,
      MODEL_PARAM_VALUE_MAX_LENGTH,
      "model param value"
    );
    if (seen.has(paramId)) {
      throw new ModelSelectionError(
        `duplicate model param id: ${paramId}`
      );
    }
    seen.add(paramId);
    params.push({ id: paramId, value: paramValue });
  }

  params.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { id, params };
}

/** Convert a legacy string model id into a canonical selection (or null). */
export function modelSelectionFromLegacy(
  model: string | null | undefined
): ModelSelection | null {
  if (model === null || model === undefined) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  return normalizeModelSelection({ id: trimmed });
}

/** Base model id from a selection (never empty string). */
export function legacyModelFromSelection(
  selection: ModelSelection | null | undefined
): string | null {
  if (!selection) return null;
  return normalizeModelSelection(selection).id;
}

/**
 * Normalize scalar string or object config/YAML model values.
 * Empty/whitespace strings become null (not persisted).
 */
export function normalizeModelConfigValue(
  value: ModelConfigValue | null | undefined
): ModelSelection | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return modelSelectionFromLegacy(value);
  }
  return normalizeModelSelection(value);
}

/** Effective model for display and agent spawn (matches daemon `buildContext`). */
export function resolveAutomationModel(
  model: string | null | undefined
): string {
  const trimmed = model?.trim();
  return trimmed ? trimmed : DEFAULT_AUTOMATION_MODEL;
}

/** Stable equality after canonicalization. */
export function modelSelectionsEqual(
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  try {
    return modelSelectionKey(a) === modelSelectionKey(b);
  } catch {
    return false;
  }
}

/**
 * Stable key for store/UI option values (id + sorted params).
 * Variants sharing one base id must not collide.
 */
export function modelSelectionKey(selection: ModelSelection): string {
  const normalized = normalizeModelSelection(selection);
  if (!normalized.params?.length) return normalized.id;
  const paramKey = normalized.params
    .map((p) => `${encodeURIComponent(p.id)}=${encodeURIComponent(p.value)}`)
    .join("&");
  return `${normalized.id}?${paramKey}`;
}

/** Concise chip/divider summary; id when params are absent. */
export function modelSelectionSummary(
  selection: ModelSelection | null | undefined
): string {
  if (!selection) return "";
  const normalized = normalizeModelSelection(selection);
  if (!normalized.params?.length) return normalized.id;
  const parts = normalized.params.map((p) => `${p.id}=${p.value}`);
  return `${normalized.id} (${parts.join(", ")})`;
}

/**
 * True when legacy `model` and canonical `modelSelection` disagree.
 * Compatible same-id dual writes (string id + parameterized selection) are allowed.
 * One clear + one set is a conflict. Both null/clear is fine.
 */
export function modelFieldsConflict(
  model: string | null | undefined,
  modelSelection: ModelSelection | null | undefined
): boolean {
  if (model === undefined || modelSelection === undefined) return false;
  if (model === null && modelSelection === null) return false;
  if (model === null || modelSelection === null) return true;
  const legacy = model.trim();
  if (!legacy) return true;
  try {
    return legacy !== normalizeModelSelection(modelSelection).id;
  } catch {
    return true;
  }
}

/**
 * Resolve mutation input preferring canonical `modelSelection`, falling back to
 * legacy `model`. Returns undefined when both omitted (unchanged).
 */
export function resolveModelMutationInput(input: {
  model?: string | null;
  modelSelection?: ModelSelection | null;
}): ModelSelection | null | undefined {
  const { model, modelSelection } = input;
  if (model === undefined && modelSelection === undefined) return undefined;
  if (modelFieldsConflict(model, modelSelection)) {
    throw new ModelSelectionError(
      "conflicting model and modelSelection values"
    );
  }
  if (modelSelection !== undefined) {
    if (modelSelection === null) return null;
    return normalizeModelSelection(modelSelection);
  }
  // model is defined (possibly null)
  return modelSelectionFromLegacy(model);
}

export function modelFromRunStartedPayload(
  payload: unknown
): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as {
    modelSelection?: unknown;
    model?: unknown;
  };
  if (
    record.modelSelection &&
    typeof record.modelSelection === "object" &&
    record.modelSelection !== null &&
    "id" in record.modelSelection &&
    typeof (record.modelSelection as { id: unknown }).id === "string"
  ) {
    try {
      return normalizeModelSelection(
        record.modelSelection as ModelSelection
      ).id;
    } catch {
      // fall through to legacy
    }
  }
  const model = record.model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

/** Prefer canonical selection from lifecycle payloads; fall back to legacy model. */
export function modelSelectionFromLifecyclePayload(
  payload: unknown
): ModelSelection | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as {
    modelSelection?: unknown;
    model?: unknown;
  };
  if (
    record.modelSelection &&
    typeof record.modelSelection === "object" &&
    record.modelSelection !== null
  ) {
    try {
      return normalizeModelSelection(record.modelSelection as ModelSelection);
    } catch {
      // fall through
    }
  }
  if (typeof record.model === "string") {
    const fromLegacy = modelSelectionFromLegacy(record.model);
    return fromLegacy ?? undefined;
  }
  return undefined;
}
