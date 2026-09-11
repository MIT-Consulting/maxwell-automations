import { Cursor } from "@cursor/sdk";
import {
  DEFAULT_AUTOMATION_MODEL,
  MODEL_CATALOG_MAX_ALIASES,
  MODEL_CATALOG_MAX_MODELS,
  MODEL_CATALOG_MAX_PARAMETER_VALUES,
  MODEL_CATALOG_MAX_PARAMETERS,
  MODEL_CATALOG_MAX_VARIANTS,
  catalogParameterValueSchema,
  catalogTextSchema,
  modelIdSchema,
  modelParameterAllowedValueSchema,
  modelVariantSchema,
  normalizeModelSelection,
  type ListModelsResponse,
  type ModelInfo,
  type ModelParameterAllowedValue,
  type ModelParameterDefinition,
  type ModelVariant,
} from "@lca/shared";

export const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

export type ModelCatalogSource = (apiKey: string) => Promise<unknown>;

export type ModelCatalogDeps = {
  apiKey: string;
  /** Injected in tests; defaults to `Cursor.models.list({ apiKey })`. */
  listModels?: ModelCatalogSource;
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `MODEL_CATALOG_TTL_MS`. */
  ttlMs?: number;
  /** Defaults to `console.warn`. */
  onWarn?: (message: string) => void;
};

const paramIdSchema = catalogParameterValueSchema.shape.id;

function mapAllowedValue(raw: unknown): ModelParameterAllowedValue | null {
  const parsed = modelParameterAllowedValueSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function mapParameter(raw: unknown): ModelParameterDefinition | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const idParsed = paramIdSchema.safeParse(obj.id);
  if (!idParsed.success) return null;

  if (!Array.isArray(obj.values)) return null;

  const values: ModelParameterAllowedValue[] = [];
  for (const entry of obj.values.slice(0, MODEL_CATALOG_MAX_PARAMETER_VALUES)) {
    const value = mapAllowedValue(entry);
    if (value) values.push(value);
  }
  if (values.length === 0) return null;

  const result: ModelParameterDefinition = {
    id: idParsed.data,
    values,
  };

  const displayNameParsed = catalogTextSchema.safeParse(obj.displayName);
  if (displayNameParsed.success) {
    result.displayName = displayNameParsed.data;
  }

  return result;
}

function mapVariant(raw: unknown, modelId: string): ModelVariant | null {
  const parsed = modelVariantSchema.safeParse(raw);
  if (!parsed.success) return null;

  let canonicalParams;
  try {
    canonicalParams =
      normalizeModelSelection({
        id: modelId,
        params: parsed.data.params,
      }).params ?? [];
  } catch {
    return null;
  }

  const result: ModelVariant = {
    params: canonicalParams,
    displayName: parsed.data.displayName,
  };

  if (parsed.data.description !== undefined) {
    result.description = parsed.data.description;
  }

  if (parsed.data.isDefault !== undefined) {
    result.isDefault = parsed.data.isDefault;
  }

  return result;
}

/** Map one untrusted SDK entry to ModelInfo; null means drop the entry. */
function mapModelEntry(raw: unknown): ModelInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const idParsed = modelIdSchema.safeParse(obj.id);
  const displayNameParsed = catalogTextSchema.safeParse(obj.displayName);
  if (!idParsed.success || !displayNameParsed.success) return null;

  const model: ModelInfo = {
    id: idParsed.data,
    displayName: displayNameParsed.data,
  };

  const descriptionParsed = catalogTextSchema.safeParse(obj.description);
  if (descriptionParsed.success) {
    model.description = descriptionParsed.data;
  }

  if (Array.isArray(obj.aliases)) {
    const aliases: string[] = [];
    for (const entry of obj.aliases.slice(0, MODEL_CATALOG_MAX_ALIASES)) {
      const parsed = catalogTextSchema.safeParse(entry);
      if (parsed.success) aliases.push(parsed.data);
    }
    if (aliases.length > 0) {
      model.aliases = aliases;
    }
  }

  if (Array.isArray(obj.parameters)) {
    const parameters: ModelParameterDefinition[] = [];
    for (const entry of obj.parameters.slice(0, MODEL_CATALOG_MAX_PARAMETERS)) {
      const param = mapParameter(entry);
      if (param) parameters.push(param);
    }
    if (parameters.length > 0) {
      model.parameters = parameters;
    }
  }

  if (Array.isArray(obj.variants)) {
    const variants: ModelVariant[] = [];
    for (const entry of obj.variants.slice(0, MODEL_CATALOG_MAX_VARIANTS)) {
      const variant = mapVariant(entry, model.id);
      if (variant) variants.push(variant);
    }
    if (variants.length > 0) {
      model.variants = variants;
    }
  }

  return model;
}

function mapModels(payload: unknown[]): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const entry of payload.slice(0, MODEL_CATALOG_MAX_MODELS)) {
    const mapped = mapModelEntry(entry);
    if (mapped) models.push(mapped);
  }
  return models;
}

/**
 * Cached, injectable wrapper around Cursor.models.list with per-field salvage
 * of untrusted catalog metadata.
 */
export class ModelCatalog {
  private cache: { at: number; models: ModelInfo[] } | null = null;
  private readonly apiKey: string;
  private readonly listModels: ModelCatalogSource;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly onWarn: (message: string) => void;

  constructor(deps: ModelCatalogDeps) {
    this.apiKey = deps.apiKey;
    this.listModels =
      deps.listModels ??
      ((apiKey: string) => Cursor.models.list({ apiKey }));
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? MODEL_CATALOG_TTL_MS;
    this.onWarn = deps.onWarn ?? ((message: string) => console.warn(message));
  }

  async list(): Promise<ListModelsResponse> {
    const at = this.now();
    if (this.cache && at - this.cache.at < this.ttlMs) {
      return {
        models: this.cache.models,
        defaultModel: DEFAULT_AUTOMATION_MODEL,
      };
    }

    try {
      const payload = await this.listModels(this.apiKey);
      if (!Array.isArray(payload)) {
        throw new Error("expected an array of models");
      }
      const models: ModelInfo[] = mapModels(payload);
      this.cache = { at, models };
      return { models, defaultModel: DEFAULT_AUTOMATION_MODEL };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onWarn(`[lca-daemon] Cursor.models.list failed: ${message}`);
      return {
        models: [],
        defaultModel: DEFAULT_AUTOMATION_MODEL,
        warning: message,
      };
    }
  }
}
