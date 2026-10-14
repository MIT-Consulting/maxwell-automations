import { z } from "zod";
import {
  IMPLEMENT_FULLY_APPROVAL_POLICIES,
  IMPLEMENT_FULLY_PLANNING_DEPTHS,
  IMPLEMENT_FULLY_PLANNING_PROFILE_IDS,
  PIPELINE_MODEL_ROLES,
} from "../types/api.js";
import { FEATURE_QUEUE_ENTRY_STATES } from "../types/feature-queue.js";
import { modelSelectionObjectSchema } from "./model.js";

const nonEmptyString = z.string().trim().min(1);

const versionIdentitySchema = z.strictObject({
  version: nonEmptyString,
  channel: z.enum(["factory", "public", "unknown", "test"]),
  commit: z.string().nullable().optional(),
  dirty: z.boolean().optional(),
  describe: z.string().nullable().optional(),
  base: z.string().nullable().optional(),
  testId: z.string().nullable().optional(),
});

const capabilitySurfaceEffectSchema = z.enum([
  "read",
  "steer",
  "start",
  "destructive",
]);

const capabilityAvailabilitySchema = z.strictObject({
  status: z.enum(["available", "blocked"]),
  reason: nonEmptyString,
});

const capabilitySurfaceSchema = z.strictObject({
  id: nonEmptyString,
  verb: nonEmptyString,
  bestFor: nonEmptyString,
  notFor: nonEmptyString,
  needs: z.array(nonEmptyString),
  produces: z.array(nonEmptyString),
  effect: capabilitySurfaceEffectSchema,
  availability: capabilityAvailabilitySchema.optional(),
});

const roleModelsSchema = z.strictObject(
  Object.fromEntries(
    PIPELINE_MODEL_ROLES.map((role) => [
      role,
      modelSelectionObjectSchema.optional(),
    ])
  ) as Record<
    (typeof PIPELINE_MODEL_ROLES)[number],
    z.ZodOptional<typeof modelSelectionObjectSchema>
  >
);

const capabilityProfileSchema = z.strictObject({
  id: nonEmptyString,
  label: nonEmptyString,
  roleModels: roleModelsSchema,
  bestFor: nonEmptyString.optional(),
});

const capabilityPlanningEntrySchema = z.strictObject({
  id: z.enum(IMPLEMENT_FULLY_PLANNING_PROFILE_IDS),
  label: nonEmptyString,
  description: nonEmptyString,
  planningDepth: z.enum(IMPLEMENT_FULLY_PLANNING_DEPTHS),
  approvalPolicy: z.enum(IMPLEMENT_FULLY_APPROVAL_POLICIES),
  budgetFormula: nonEmptyString,
  executeBudgetFormula: nonEmptyString,
});

const capabilityStatusDomainSchema = z.enum([
  "run",
  "pipeline",
  "queue",
  "input",
  "halt",
]);

const capabilityStatusEntrySchema = z.strictObject({
  domain: capabilityStatusDomainSchema,
  id: nonEmptyString,
  terminal: z.boolean(),
  meaning: nonEmptyString,
  verb: nonEmptyString,
});

const capabilityPlaybookSchema = z.strictObject({
  id: nonEmptyString,
  when: nonEmptyString,
  steps: z.array(nonEmptyString).min(1),
  doneSignal: nonEmptyString,
  dontStopEarlyBecause: nonEmptyString,
  availability: capabilityAvailabilitySchema.optional(),
});

const roadmapReadinessStateSchema = z.enum(["ready", "empty", "adoptable"]);

const roadmapReadinessImpactCountsSchema = z.strictObject({
  "blocks-all": z.number().int().nonnegative(),
  "blocks-some": z.number().int().nonnegative(),
  "idea-only": z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
});

const capabilitiesReadinessBlockerSchema = z.strictObject({
  code: nonEmptyString,
  message: nonEmptyString,
});

const capabilitiesReadinessSummarySchema = z.strictObject({
  state: roadmapReadinessStateSchema,
  counts: roadmapReadinessImpactCountsSchema,
  blockers: z.array(capabilitiesReadinessBlockerSchema),
});

const capabilitiesActivePipelineSummarySchema = z.strictObject({
  active: z.boolean(),
  rootRunId: z.string().nullable(),
  featureId: z.string().nullable(),
  outcome: z
    .enum(["running", "green", "blocked", "deadlock", "aborted", "failed"])
    .nullable(),
  waiting: z.boolean(),
  halt: z.boolean(),
});

const featureQueueCountsSchema = z.strictObject(
  Object.fromEntries(
    FEATURE_QUEUE_ENTRY_STATES.map((state) => [state, z.number().int().nonnegative()])
  ) as Record<
    (typeof FEATURE_QUEUE_ENTRY_STATES)[number],
    z.ZodNumber
  >
);

const capabilitiesQueueSummarySchema = z.strictObject({
  counts: featureQueueCountsSchema,
  running: z
    .strictObject({
      featureId: nonEmptyString,
      runId: z.string(),
    })
    .nullable(),
  failedFeatureIds: z.array(nonEmptyString),
  blockedFeatureIds: z.array(nonEmptyString),
  nextEligibleFeatureId: z.string().nullable(),
  isEmpty: z.boolean(),
});

const capabilitiesWorkspaceContextSchema = z.strictObject({
  id: nonEmptyString,
  name: nonEmptyString,
  readiness: capabilitiesReadinessSummarySchema,
  pipeline: capabilitiesActivePipelineSummarySchema,
  queue: capabilitiesQueueSummarySchema,
});

const capabilityPointerSchema = z.strictObject({
  id: nonEmptyString,
  path: nonEmptyString,
  note: nonEmptyString,
});

const capabilitiesVersionSchema = z.strictObject({
  daemon: versionIdentitySchema,
  cli: versionIdentitySchema.optional(),
  skills: z.enum(["in-sync", "drift", "unavailable"]).optional(),
});

export const capabilitiesDocumentSchema = z.strictObject({
  version: capabilitiesVersionSchema,
  surfaces: z.array(capabilitySurfaceSchema).min(1),
  profiles: z.array(capabilityProfileSchema),
  planning: z.array(capabilityPlanningEntrySchema).min(1),
  statuses: z.array(capabilityStatusEntrySchema).min(1),
  playbooks: z.array(capabilityPlaybookSchema).min(1),
  antiPatterns: z.array(nonEmptyString).min(1),
  pointers: z.array(capabilityPointerSchema).min(1),
  workspace: capabilitiesWorkspaceContextSchema.optional(),
});

export type CapabilitiesDocumentInput = z.infer<typeof capabilitiesDocumentSchema>;
