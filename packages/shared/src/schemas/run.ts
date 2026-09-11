import { z } from "zod";
import type { ChainRunContext, ChainVariables } from "../types/config.js";
import {
  PIPELINE_WAVE_OPERATOR_ACTIONS,
  RUN_ESCALATION_ACTIONS,
} from "../types/api.js";
import {
  isValidPipelinePhaseFile,
  normalizePipelinePhaseRef,
  PIPELINE_WAVE_CANDIDATE_MAX,
  PIPELINE_WAVE_CANDIDATE_MIN,
  PIPELINE_WAVE_PHASE_REF_MAX,
} from "../pipeline-wave.js";
import type { ModelSelection } from "../model.js";
import {
  modelIdSchema,
  modelSelectionObjectSchema,
  nullableModelIdSchema,
  nullableModelSelectionSchema,
  refineModelMutationFields,
} from "./model.js";

/** Bounds for durable pipeline context (b36). */
export const CHAIN_VAR_MAX_TOP_LEVEL = 32;
export const CHAIN_VAR_MAX_NESTED = 16;
export const CHAIN_KEY_MAX_LENGTH = 64;
export const CHAIN_VALUE_MAX_LENGTH = 2048;
export const CHAIN_CONTEXT_MAX_BYTES = 64 * 1024;
export const CHAIN_RENDERED_PROMPT_MAX_BYTES = 256 * 1024;
export const CHAIN_MAX_DEPTH_MIN = 1;
export const CHAIN_MAX_DEPTH_MAX = 500;

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isDangerousChainKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

/** Shared key rules for `roleModels` map keys and automation `modelRole`. */
export const chainKeySchema = z
  .string()
  .min(1)
  .max(CHAIN_KEY_MAX_LENGTH)
  .refine((key) => key.trim().length > 0, {
    message: "empty object key rejected",
  })
  .refine((key) => !isDangerousChainKey(key), {
    message: "dangerous object key rejected",
  });

const chainStringValueSchema = z.string().min(1).max(CHAIN_VALUE_MAX_LENGTH);

const chainNestedMapSchema = z
  .record(chainKeySchema, chainStringValueSchema)
  .superRefine((value, ctx) => {
    const entries = Object.keys(value);
    if (entries.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "nested map must contain at least one entry",
      });
    }
    if (entries.length > CHAIN_VAR_MAX_NESTED) {
      ctx.addIssue({
        code: "custom",
        message: `nested map exceeds ${CHAIN_VAR_MAX_NESTED} entries`,
      });
    }
  });

const chainTemplateValueSchema = z.union([
  chainStringValueSchema,
  chainNestedMapSchema,
]);

export const chainVariablesSchema = z
  .record(chainKeySchema, chainTemplateValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > CHAIN_VAR_MAX_TOP_LEVEL) {
      ctx.addIssue({
        code: "custom",
        message: `variables exceed ${CHAIN_VAR_MAX_TOP_LEVEL} top-level entries`,
      });
    }
  });

export const chainRoleModelsSchema = z
  .record(chainKeySchema, modelSelectionObjectSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > CHAIN_VAR_MAX_TOP_LEVEL) {
      ctx.addIssue({
        code: "custom",
        message: `roleModels exceed ${CHAIN_VAR_MAX_TOP_LEVEL} entries`,
      });
    }
  });

export const chainRunContextSchema = z
  .strictObject({
    variables: chainVariablesSchema,
    roleModels: chainRoleModelsSchema,
  })
  .superRefine((value, ctx) => {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).length > CHAIN_CONTEXT_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `chain context exceeds ${CHAIN_CONTEXT_MAX_BYTES} bytes`,
      });
    }
  });

export const chainMaxDepthSchema = z
  .number()
  .int()
  .min(CHAIN_MAX_DEPTH_MIN)
  .max(CHAIN_MAX_DEPTH_MAX);

const CHAIN_STOP_REASON_MAX_LENGTH = 256;

/**
 * POST /api/runs/:id/chain-control — at least one of `stop` / `rebudget` /
 * `extendBudget`. Absolute rebudget and additive extension are mutually
 * exclusive. Empty body is rejected (never a silent no-op).
 */
export const chainControlSchema = z
  .strictObject({
    stop: z
      .strictObject({
        reason: z
          .string()
          .trim()
          .min(1)
          .max(CHAIN_STOP_REASON_MAX_LENGTH),
      })
      .optional(),
    rebudget: z
      .strictObject({
        maxDepth: chainMaxDepthSchema,
      })
      .optional(),
    extendBudget: z
      .strictObject({
        transitions: z
          .number()
          .int()
          .min(1)
          .max(CHAIN_MAX_DEPTH_MAX),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.stop === undefined &&
      value.rebudget === undefined &&
      value.extendBudget === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "at least one of stop, rebudget, or extendBudget is required",
      });
    }
    if (value.rebudget !== undefined && value.extendBudget !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "rebudget and extendBudget are mutually exclusive",
      });
    }
  });

/**
 * POST /api/runs/:id/escalate — operator retry / skip / abort on a halted
 * pipeline run. Optional reason shares the chain-control stop-reason bound.
 */
export const runEscalationSchema = z.strictObject({
  action: z.enum(RUN_ESCALATION_ACTIONS),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(CHAIN_STOP_REASON_MAX_LENGTH)
    .optional(),
});

export const pipelineWaveCandidateSchema = z
  .strictObject({
    phaseRef: z.string().min(1).max(PIPELINE_WAVE_PHASE_REF_MAX),
    phaseFile: z.string().min(1).max(CHAIN_VALUE_MAX_LENGTH),
  })
  .superRefine((value, ctx) => {
    if (normalizePipelinePhaseRef(value.phaseRef) == null) {
      ctx.addIssue({
        code: "custom",
        message: "phaseRef must be trimmed, non-empty, and ≤ 64 characters",
        path: ["phaseRef"],
      });
    }
    if (!isValidPipelinePhaseFile(value.phaseFile)) {
      ctx.addIssue({
        code: "custom",
        message:
          "phaseFile must be a forward-slash relative .md path without . or ..",
        path: ["phaseFile"],
      });
    }
  });

/**
 * POST /api/runs/:id/pipeline-wave — discriminated run-token control.
 * Fan-out requires 2–64 unique candidates.
 */
export const pipelineWaveControlSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("fan-out"),
      candidates: z
        .array(pipelineWaveCandidateSchema)
        .min(PIPELINE_WAVE_CANDIDATE_MIN)
        .max(PIPELINE_WAVE_CANDIDATE_MAX),
    })
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      for (let i = 0; i < value.candidates.length; i++) {
        const ref = normalizePipelinePhaseRef(value.candidates[i]!.phaseRef);
        if (ref == null) continue;
        if (seen.has(ref)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate phaseRef "${ref}"`,
            path: ["candidates", i, "phaseRef"],
          });
        }
        seen.add(ref);
      }
    }),
  z.strictObject({
    action: z.literal("finalize"),
  }),
  z.strictObject({
    action: z.literal("block"),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(CHAIN_STOP_REASON_MAX_LENGTH),
  }),
]);

/**
 * POST /api/pipeline-waves/:id/actions — operator retry-integration / abort.
 */
export const pipelineWaveOperatorSchema = z.strictObject({
  action: z.enum(PIPELINE_WAVE_OPERATOR_ACTIONS),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(CHAIN_STOP_REASON_MAX_LENGTH)
    .optional(),
});

/**
 * POST /api/runs — legacy `{ automationId }` remains valid.
 * Context kickoff requires `maxDepth` when any context field is present.
 */
export const triggerRunSchema = z
  .strictObject({
    automationId: z.string().trim().min(1),
    variables: chainVariablesSchema.optional(),
    roleModels: chainRoleModelsSchema.optional(),
    maxDepth: chainMaxDepthSchema.optional(),
    model: modelIdSchema.optional(),
    modelSelection: modelSelectionObjectSchema.optional(),
  })
  .superRefine((value, ctx) => {
    refineModelMutationFields(value, ctx);
    const hasContextFields =
      value.variables !== undefined ||
      value.roleModels !== undefined ||
      value.maxDepth !== undefined;
    if (hasContextFields && value.maxDepth === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "maxDepth is required when variables or roleModels are provided",
        path: ["maxDepth"],
      });
    }
    if (hasContextFields) {
      const context: ChainRunContext = {
        variables: (value.variables ?? {}) as ChainVariables,
        roleModels: (value.roleModels ?? {}) as Record<string, ModelSelection>,
      };
      const check = chainRunContextSchema.safeParse(context);
      if (!check.success) {
        for (const issue of check.error.issues) {
          ctx.addIssue({
            code: "custom",
            message: issue.message,
            path: issue.path,
          });
        }
      }
    }
  });

/** PATCH /api/runs/:id — require `model` or `modelSelection` (legacy or canonical). */
export const updateRunSchema = z
  .strictObject({
    model: nullableModelIdSchema.optional(),
    modelSelection: nullableModelSelectionSchema.optional(),
  })
  .superRefine((value, ctx) =>
    refineModelMutationFields(value, ctx, { requireOne: true })
  );

/** Bounds for structured input-request metadata (b45). */
export const INPUT_KIND_MAX_LENGTH = 64;
export const INPUT_CHOICE_ID_MAX_LENGTH = 64;
export const INPUT_CHOICE_LABEL_MAX_LENGTH = 128;
export const INPUT_CHOICE_DESCRIPTION_MAX_LENGTH = 256;
export const INPUT_CHOICES_MAX = 16;
export const INPUT_ARTIFACT_LABEL_MAX_LENGTH = 128;
export const INPUT_ARTIFACT_PATH_MAX_LENGTH = 512;
export const INPUT_ARTIFACTS_MAX = 32;
export const INPUT_METADATA_MAX_BYTES = 16 * 1024;
export const INPUT_QUESTION_MAX_LENGTH = 8 * 1024;
export const INPUT_ANSWER_MAX_LENGTH = 8 * 1024;

/**
 * Validate a workspace-relative artifact path.
 * Rejects absolute paths, backslashes, empty/`.`/`..` segments, and NUL.
 * Extension-agnostic — callers supply Markdown or other workspace files.
 */
export function isValidInputArtifactPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.includes("\0")) return false;
  if (path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

const inputChoiceSchema = z.strictObject({
  id: z.string().trim().min(1).max(INPUT_CHOICE_ID_MAX_LENGTH),
  label: z.string().trim().min(1).max(INPUT_CHOICE_LABEL_MAX_LENGTH),
  description: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_CHOICE_DESCRIPTION_MAX_LENGTH)
    .optional(),
});

const inputArtifactSchema = z
  .strictObject({
    label: z.string().trim().min(1).max(INPUT_ARTIFACT_LABEL_MAX_LENGTH),
    path: z.string().trim().min(1).max(INPUT_ARTIFACT_PATH_MAX_LENGTH),
  })
  .superRefine((value, ctx) => {
    if (!isValidInputArtifactPath(value.path)) {
      ctx.addIssue({
        code: "custom",
        message:
          "artifact path must be a forward-slash workspace-relative path without . or ..",
        path: ["path"],
      });
    }
  });

export const inputRequestMetadataSchema = z
  .strictObject({
    kind: z.string().trim().min(1).max(INPUT_KIND_MAX_LENGTH),
    choices: z.array(inputChoiceSchema).min(1).max(INPUT_CHOICES_MAX).optional(),
    recommendedChoiceId: z
      .string()
      .trim()
      .min(1)
      .max(INPUT_CHOICE_ID_MAX_LENGTH)
      .optional(),
    artifacts: z
      .array(inputArtifactSchema)
      .min(1)
      .max(INPUT_ARTIFACTS_MAX)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.choices) {
      const seen = new Set<string>();
      for (let i = 0; i < value.choices.length; i++) {
        const id = value.choices[i]!.id;
        if (seen.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate choice id "${id}"`,
            path: ["choices", i, "id"],
          });
        }
        seen.add(id);
      }
      if (
        value.recommendedChoiceId !== undefined &&
        !seen.has(value.recommendedChoiceId)
      ) {
        ctx.addIssue({
          code: "custom",
          message: "recommendedChoiceId must identify one supplied choice",
          path: ["recommendedChoiceId"],
        });
      }
    } else if (value.recommendedChoiceId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "recommendedChoiceId requires choices",
        path: ["recommendedChoiceId"],
      });
    }

    const serialized = JSON.stringify(value);
    if (
      new TextEncoder().encode(serialized).length > INPUT_METADATA_MAX_BYTES
    ) {
      ctx.addIssue({
        code: "custom",
        message: `metadata exceeds ${INPUT_METADATA_MAX_BYTES} bytes`,
      });
    }
  });

/**
 * POST /api/runs/:id/ask — question required; metadata optional.
 * Unknown keys are rejected.
 */
export const askRunInputSchema = z.strictObject({
  question: z.string().trim().min(1).max(INPUT_QUESTION_MAX_LENGTH),
  metadata: inputRequestMetadataSchema.optional(),
});

/** Trimmed operator answer body (shared by HTTP and Input Hub bounds). */
export const inputAnswerSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_ANSWER_MAX_LENGTH);

/**
 * POST /api/runs/:id/answer — answer required.
 * Unknown keys are rejected.
 */
export const answerRunInputSchema = z.strictObject({
  answer: inputAnswerSchema,
});
