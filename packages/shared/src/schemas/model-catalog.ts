import { z } from "zod";
import {
  MODEL_ID_MAX_LENGTH,
  MODEL_PARAM_ID_MAX_LENGTH,
  MODEL_PARAM_VALUE_MAX_LENGTH,
} from "../model.js";

/** Ceiling on models returned from a single catalog fetch. */
export const MODEL_CATALOG_MAX_MODELS = 200;
/** Max length for free-text catalog fields (displayName, description, aliases). */
export const MODEL_CATALOG_TEXT_MAX_LENGTH = 1024;
export const MODEL_CATALOG_MAX_ALIASES = 32;
export const MODEL_CATALOG_MAX_PARAMETERS = 32;
export const MODEL_CATALOG_MAX_PARAMETER_VALUES = 64;
export const MODEL_CATALOG_MAX_VARIANTS = 64;

/** Trimmed non-empty free-text catalog field. */
export const catalogTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(MODEL_CATALOG_TEXT_MAX_LENGTH);

/** Lenient param value for catalog metadata (unknown keys stripped, not rejected). */
export const catalogParameterValueSchema = z.object({
  id: z.string().trim().min(1).max(MODEL_PARAM_ID_MAX_LENGTH),
  value: z.string().trim().min(1).max(MODEL_PARAM_VALUE_MAX_LENGTH),
});

export const modelParameterAllowedValueSchema = z.object({
  value: z.string().trim().min(1).max(MODEL_PARAM_VALUE_MAX_LENGTH),
  displayName: catalogTextSchema.optional(),
});

export const modelParameterDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(MODEL_PARAM_ID_MAX_LENGTH),
  displayName: catalogTextSchema.optional(),
  values: z
    .array(modelParameterAllowedValueSchema)
    .max(MODEL_CATALOG_MAX_PARAMETER_VALUES),
});

export const modelVariantSchema = z.object({
  params: z.array(catalogParameterValueSchema).max(MODEL_CATALOG_MAX_PARAMETERS),
  displayName: catalogTextSchema,
  description: catalogTextSchema.optional(),
  isDefault: z.boolean().optional(),
});

export const modelInfoSchema = z.object({
  id: z.string().trim().min(1).max(MODEL_ID_MAX_LENGTH),
  displayName: catalogTextSchema,
  description: catalogTextSchema.optional(),
  aliases: z.array(catalogTextSchema).max(MODEL_CATALOG_MAX_ALIASES).optional(),
  parameters: z
    .array(modelParameterDefinitionSchema)
    .max(MODEL_CATALOG_MAX_PARAMETERS)
    .optional(),
  variants: z.array(modelVariantSchema).max(MODEL_CATALOG_MAX_VARIANTS).optional(),
});
