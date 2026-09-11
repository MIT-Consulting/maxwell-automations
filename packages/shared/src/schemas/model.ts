import { z } from "zod";
import {
  MODEL_ID_MAX_LENGTH,
  MODEL_PARAM_ID_MAX_LENGTH,
  MODEL_PARAM_VALUE_MAX_LENGTH,
  MODEL_PARAMS_MAX_COUNT,
  modelFieldsConflict,
  normalizeModelSelection,
  type ModelSelection,
} from "../model.js";

export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MODEL_ID_MAX_LENGTH);

export const modelParameterValueSchema = z.strictObject({
  id: z.string().trim().min(1).max(MODEL_PARAM_ID_MAX_LENGTH),
  value: z.string().trim().min(1).max(MODEL_PARAM_VALUE_MAX_LENGTH),
});

export const modelSelectionObjectSchema = z
  .strictObject({
    id: modelIdSchema,
    params: z.array(modelParameterValueSchema).max(MODEL_PARAMS_MAX_COUNT).optional(),
  })
  .superRefine((value, ctx) => {
    try {
      normalizeModelSelection(value);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : "invalid model selection",
      });
    }
  })
  .transform((value): ModelSelection => normalizeModelSelection(value));

/** Scalar id or structured selection (YAML / config). */
export const modelConfigValueSchema = z.union([
  modelIdSchema,
  modelSelectionObjectSchema,
]);

/** Nullable clearable model field (REST). */
export const nullableModelIdSchema = modelIdSchema.nullable();

/** Nullable clearable selection (REST). */
export const nullableModelSelectionSchema = modelSelectionObjectSchema.nullable();

type ModelMutationFields = {
  model?: string | null;
  modelSelection?: ModelSelection | null;
};

/** Reject conflicting dual representations; allow compatible same-id pairs. */
export function refineModelMutationFields(
  value: ModelMutationFields,
  ctx: z.RefinementCtx,
  options: { requireOne?: boolean } = {}
): void {
  if (options.requireOne) {
    if (value.model === undefined && value.modelSelection === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "model or modelSelection is required",
        path: ["model"],
      });
      return;
    }
  }
  // Field-level validation/normalization belongs to modelSelectionObjectSchema;
  // re-checking here would emit the same issue twice.
  if (modelFieldsConflict(value.model, value.modelSelection)) {
    ctx.addIssue({
      code: "custom",
      message: "conflicting model and modelSelection values",
      path: ["modelSelection"],
    });
  }
}
