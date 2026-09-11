import { z } from "zod";
import {
  modelIdSchema,
  modelSelectionObjectSchema,
  nullableModelIdSchema,
  nullableModelSelectionSchema,
  refineModelMutationFields,
} from "./model.js";

export const createChatSchema = z
  .strictObject({
    title: z.string().trim().min(1).optional(),
    model: modelIdSchema.optional(),
    modelSelection: modelSelectionObjectSchema.optional(),
  })
  .superRefine((value, ctx) => refineModelMutationFields(value, ctx));

export const sendChatMessageSchema = z.strictObject({
  message: z.string().trim().min(1),
});

export const queueChatMessageSchema = sendChatMessageSchema;
export const interruptChatSchema = sendChatMessageSchema;

export const steerChatSchema = z.strictObject({
  message: z.string().trim().min(1),
  runId: z.string().min(1).optional(),
});

export const answerChatSchema = z.strictObject({
  answer: z.string().trim().min(1),
});

export const updateChatSchema = z
  .strictObject({
    title: z.string().trim().min(1).optional(),
    archived: z.boolean().optional(),
    model: nullableModelIdSchema.optional(),
    modelSelection: nullableModelSelectionSchema.optional(),
    attachedRunId: z.string().min(1).nullable().optional(),
  })
  .superRefine((value, ctx) => refineModelMutationFields(value, ctx))
  .refine(
    (v) =>
      v.title !== undefined ||
      v.archived !== undefined ||
      v.model !== undefined ||
      v.modelSelection !== undefined ||
      v.attachedRunId !== undefined,
    {
      message:
        "at least one of title, archived, model, modelSelection, or attachedRunId is required",
    }
  );
