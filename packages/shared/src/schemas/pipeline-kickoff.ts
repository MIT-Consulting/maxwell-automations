import { z } from "zod";
import type { ResolveImplementFullyKickoffRequest } from "../types/api.js";
import {
  DEFAULT_FEATURE_FORMAT_TEMPLATE,
  ROADMAP_FORMAT_DOC,
  ROADMAP_ID_CANDIDATE_RE,
} from "../roadmap-ids.js";
import { CHAIN_VALUE_MAX_LENGTH } from "./run.js";

const featureIdSchema = z
  .string()
  .trim()
  .regex(ROADMAP_ID_CANDIDATE_RE, {
    message: `featureId must match ${DEFAULT_FEATURE_FORMAT_TEMPLATE} (e.g. b42, b-dm58). See ${ROADMAP_FORMAT_DOC}.`,
  });

const ideaSchema = z
  .string()
  .trim()
  .min(1, { message: "idea must be non-empty after trimming" })
  .superRefine((value, ctx) => {
    const byteLength = new TextEncoder().encode(value).length;
    if (byteLength > CHAIN_VALUE_MAX_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: `idea is ${byteLength} bytes; max is ${CHAIN_VALUE_MAX_LENGTH}`,
      });
    }
  });

/**
 * POST /api/pipelines/implement-fully/resolve — strict two-intent body.
 * UTF-8 byte limit on idea; no truncation.
 */
export const resolveImplementFullyKickoffSchema = z.strictObject({
  workspaceId: z.string().trim().min(1, { message: "workspaceId is required" }),
  input: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("feature-id"),
      featureId: featureIdSchema,
    }),
    z.strictObject({
      kind: z.literal("idea"),
      idea: ideaSchema,
    }),
  ]),
});

type InferredResolveRequest = z.infer<typeof resolveImplementFullyKickoffSchema>;

const _resolveRequestAligns: ResolveImplementFullyKickoffRequest =
  null as unknown as InferredResolveRequest;
const _resolveRequestAlignsReverse: InferredResolveRequest =
  null as unknown as ResolveImplementFullyKickoffRequest;
void _resolveRequestAligns;
void _resolveRequestAlignsReverse;
