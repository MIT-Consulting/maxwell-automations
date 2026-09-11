import { z } from "zod";
import {
  modelConfigValueSchema,
  nullableModelIdSchema,
  nullableModelSelectionSchema,
  refineModelMutationFields,
} from "./model.js";

export const mcpOverlaySchema = z.object({
  extra: z.record(z.string(), z.unknown()).optional(),
  disable: z.array(z.string()).optional(),
});

// File-level lenient (z.object strips unknown keys) — soft-fail at parse time like automations.
export const workspaceChatDefaultsYamlSchema = z.object({
  model: modelConfigValueSchema.optional(),
  systemPrompt: z.string().optional(),
  mcp: mcpOverlaySchema.optional(),
});

// REST PATCH validator. Allow explicit null to clear model/systemPrompt.
export const updateWorkspaceChatDefaultsSchema = z
  .object({
    model: nullableModelIdSchema.optional(),
    modelSelection: nullableModelSelectionSchema.optional(),
    systemPrompt: z.string().nullable().optional(),
    mcp: mcpOverlaySchema.optional(),
  })
  .superRefine((value, ctx) => refineModelMutationFields(value, ctx));
