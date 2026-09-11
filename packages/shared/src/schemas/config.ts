import { z } from "zod";
import {
  modelConfigValueSchema,
  modelIdSchema,
  modelSelectionObjectSchema,
  nullableModelIdSchema,
  nullableModelSelectionSchema,
  refineModelMutationFields,
} from "./model.js";
import { chainKeySchema } from "./run.js";
import {
  PIPELINE_MODEL_ROLES,
  type PipelineModelRole,
} from "../types/api.js";
import {
  ALERT_NOTIFY_EVENTS,
  NTFY_NOTIFY_EVENTS,
} from "../types/config.js";

const nonEmptyString = z.string().trim().min(1);
export const triggerConfigSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("cron"),
    expression: nonEmptyString,
  }),
  z.strictObject({
    type: z.literal("git"),
    events: z
      .array(z.enum(["post-commit", "pre-push", "post-merge"]))
      .min(1),
  }),
  z.strictObject({
    type: z.literal("file-watch"),
    globs: z.array(nonEmptyString).min(1),
    debounceMs: z.number().int().positive().optional(),
  }),
  z.strictObject({
    type: z.literal("command"),
    command: nonEmptyString,
    cwd: nonEmptyString.optional(),
  }),
  z.strictObject({
    type: z.literal("manual"),
  }),
]);

export const chainConfigSchema = z.strictObject({
  next: nonEmptyString,
  when: z.enum(["completed", "failed", "always"]).optional(),
  passResult: z.boolean().optional(),
});

export const automationYamlEntrySchema = z.strictObject({
  id: nonEmptyString.optional(),
  name: nonEmptyString,
  enabled: z.boolean().optional(),
  trigger: triggerConfigSchema,
  prompt: nonEmptyString,
  model: modelConfigValueSchema.optional(),
  modelRole: chainKeySchema.optional(),
  chain: chainConfigSchema.optional(),
});
export const workspaceCreateSchema = z.strictObject({
  path: nonEmptyString,
  name: nonEmptyString.optional(),
});

export const automationCreateSchema = z.strictObject({
  workspaceId: nonEmptyString,
  name: nonEmptyString,
  trigger: triggerConfigSchema,
  prompt: nonEmptyString,
  model: modelIdSchema.optional(),
  modelSelection: modelSelectionObjectSchema.optional(),
  modelRole: chainKeySchema.optional(),
  enabled: z.boolean().optional(),
  chain: chainConfigSchema.optional(),
}).superRefine((value, ctx) => refineModelMutationFields(value, ctx));

export const automationUpdateSchema = z
  .strictObject({
    name: nonEmptyString.optional(),
    trigger: triggerConfigSchema.optional(),
    prompt: nonEmptyString.optional(),
    model: nullableModelIdSchema.optional(),
    modelSelection: nullableModelSelectionSchema.optional(),
    modelRole: chainKeySchema.nullable().optional(),
    enabled: z.boolean().optional(),
    chain: chainConfigSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => refineModelMutationFields(value, ctx));

/** Slug for a generated worker; daemon owns the `generated:` namespace prefix. */
export const generatedWorkerKeySchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "key must be a slug (a-z0-9, hyphens; 1–64 chars)"
  );

export const generatedWorkerSpecSchema = z.strictObject({
  key: generatedWorkerKeySchema,
  name: nonEmptyString,
  prompt: nonEmptyString,
  trigger: triggerConfigSchema,
  enabled: z.boolean().optional(),
  model: modelConfigValueSchema.nullable().optional(),
  modelRole: chainKeySchema.nullable().optional(),
  chain: chainConfigSchema.nullable().optional(),
});

export const provisionGeneratedWorkersSchema = z
  .strictObject({
    workspaceId: nonEmptyString.optional(),
    workspacePath: nonEmptyString.optional(),
    workers: z.array(generatedWorkerSpecSchema).max(64),
    dryRun: z.boolean().optional().default(false),
    prune: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    const hasId = value.workspaceId !== undefined;
    const hasPath = value.workspacePath !== undefined;
    if (hasId === hasPath) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of workspaceId or workspacePath is required",
        path: hasId ? ["workspaceId"] : ["workspaceId"],
      });
    }
    const seen = new Set<string>();
    for (let i = 0; i < value.workers.length; i++) {
      const key = value.workers[i]!.key;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate worker key: ${key}`,
          path: ["workers", i, "key"],
        });
      }
      seen.add(key);
    }
  });

/**
 * POST /api/pipelines/:id/workers — workspace xor path, no worker list.
 * The daemon supplies the catalog for the known pipeline id.
 */
export const provisionPipelineWorkersSchema = z
  .strictObject({
    workspaceId: nonEmptyString.optional(),
    workspacePath: nonEmptyString.optional(),
    dryRun: z.boolean().optional().default(false),
    prune: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    const hasId = value.workspaceId !== undefined;
    const hasPath = value.workspacePath !== undefined;
    if (hasId === hasPath) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of workspaceId or workspacePath is required",
        path: hasId ? ["workspaceId"] : ["workspaceId"],
      });
    }
  });

// File-level shapes are intentionally lenient: unknown top-level keys (user
// metadata, comments-as-keys, future fields) are ignored rather than rejecting
// the whole file. Per-entry strictness lives in `automationYamlEntrySchema`.
export const workspaceAutomationsYamlSchema = z.union([
  z.array(z.unknown()),
  z.object({
    automations: z.array(z.unknown()).optional(),
  }),
]);

/** Strict role→model map for operator `settings.pipelineRoleModels`. */
export const pipelineRoleModelsSchema = z.strictObject(
  Object.fromEntries(
    PIPELINE_MODEL_ROLES.map((role) => [
      role,
      modelConfigValueSchema.optional(),
    ])
  ) as Record<PipelineModelRole, z.ZodOptional<typeof modelConfigValueSchema>>
);

const pipelineRoleModelProfileIdPattern = /^[a-z][a-z0-9-]*$/;

/** Named role-model recipes keyed by operator-chosen profile id (b55). */
export const pipelineRoleModelProfilesSchema = z
  .record(z.string(), pipelineRoleModelsSchema)
  .superRefine((profiles, ctx) => {
    for (const profileId of Object.keys(profiles)) {
      if (!pipelineRoleModelProfileIdPattern.test(profileId)) {
        ctx.addIssue({
          code: "custom",
          message: "profile id must match ^[a-z][a-z0-9-]*$",
          path: [profileId],
        });
      } else if (profileId === "default") {
        ctx.addIssue({
          code: "custom",
          message: 'profile id "default" is reserved',
          path: [profileId],
        });
      }
    }
  });

/** Canonical YAML event ids for optional ntfy phone notifications (b48). */
export const ntfyNotifyEventSchema = z.enum(NTFY_NOTIFY_EVENTS);

/** Full operator alert catalog ids (b51). */
export const alertNotifyEventSchema = z.enum(ALERT_NOTIFY_EVENTS);

const notifyEventChannelPrefsSchema = z.strictObject({
  toast: z.boolean(),
  ntfy: z.boolean(),
});

function refineNotifyEventPrefKeys(
  val: Record<string, unknown> | undefined,
  ctx: z.RefinementCtx
): void {
  if (val == null) {
    return;
  }
  for (const key of Object.keys(val)) {
    if (!(ALERT_NOTIFY_EVENTS as readonly string[]).includes(key)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown notify event id: ${key}`,
        path: [key],
      });
    }
  }
}

const notifyEventPrefsMapSchema = z
  .record(z.string(), notifyEventChannelPrefsSchema)
  .optional()
  .superRefine((val, ctx) => refineNotifyEventPrefKeys(val, ctx));

/** PATCH body events map (replaces YAML `settings.notify.events`). */
export const notifyEventPrefsPatchMapSchema = z
  .record(z.string(), notifyEventChannelPrefsSchema)
  .superRefine((val, ctx) => refineNotifyEventPrefKeys(val, ctx));

const httpOrHttpsUrl = nonEmptyString.refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "server must be an HTTP(S) URL" }
);

const updateNotifyNtfySchema = z.union([
  z.null(),
  z.strictObject({
    topic: nonEmptyString,
    server: z.union([httpOrHttpsUrl, z.literal(""), z.null()]).optional(),
    token: z.union([nonEmptyString, z.literal(""), z.null()]).optional(),
  }),
]);

/** PATCH /api/settings/notify body validator. */
export const updateNotifySettingsSchema = z
  .object({
    events: notifyEventPrefsPatchMapSchema.optional(),
    ntfy: updateNotifyNtfySchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.events === undefined && val.ntfy === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "at least one of events or ntfy is required",
        path: [],
      });
    }
  });

export type UpdateNotifySettingsInput = z.infer<
  typeof updateNotifySettingsSchema
>;

/** Optional ntfy sink under `settings.notify.ntfy`. */
export const ntfyNotifySettingsSchema = z.strictObject({
  topic: nonEmptyString,
  server: httpOrHttpsUrl.optional(),
  token: nonEmptyString.optional(),
  /** Legacy allowlist (b48); migrated to `notify.events` on load. */
  events: z.array(ntfyNotifyEventSchema).optional(),
});

export const notifySettingsSchema = z.strictObject({
  events: notifyEventPrefsMapSchema,
  ntfy: ntfyNotifySettingsSchema.optional(),
});

// Daemon-wide runtime knobs. All optional with daemon-side defaults; values are
// coerced/clamped by `loadSettings` so a stale or aggressive config never wedges
// the daemon. `strictObject` rejects typos (e.g. `maxConcurrency`) with a clear
// error instead of silently ignoring them.
export const settingsSchema = z.strictObject({
  maxConcurrentRuns: z.number().int().positive().optional(),
  eventRetentionPerRun: z.number().int().positive().optional(),
  maxEventPayloadBytes: z.number().int().positive().optional(),
  spawnTimeoutMs: z.number().int().positive().optional(),
  runStallTimeoutMs: z.number().int().positive().optional(),
  maxSpawnAttempts: z.number().int().positive().optional(),
  retryBackoffMs: z.number().int().nonnegative().optional(),
  retainedSessionTtlMs: z.number().int().nonnegative().optional(),
  sessionRevive: z.boolean().optional(),
  host: z.string().min(1).optional(),
  allowedIps: z.array(z.string().min(1)).optional(),
  controlToken: z.string().min(1).optional(),
  pipelineRoleModels: pipelineRoleModelsSchema.optional(),
  pipelineRoleModelProfiles: pipelineRoleModelProfilesSchema.optional(),
  defaultPipelineRoleModelProfile: nonEmptyString.optional(),
  pipelineResumeLookbackMs: z.number().int().nonnegative().optional(),
  /** Post-terminal safe-halt auto-escalation (b43). Default enabled in resolver. */
  pipelineAutoEscalate: z.boolean().optional(),
  /** Max daemon escalations per pipeline lineage. Default 2 in resolver. */
  pipelineAutoEscalateMaxPerPipeline: z.number().int().positive().optional(),
  /** Post-unrecovered halt discovery advisory (b44). Default enabled in resolver. */
  pipelineHaltDiscovery: z.boolean().optional(),
  maxAttachmentBytes: z.number().int().positive().optional(),
  maxAttachmentsPerMessage: z.number().int().positive().optional(),
  allowedAttachmentMimeTypes: z.array(z.string().min(1)).optional(),
  maxFileViewerBytes: z.number().int().positive().optional(),
  maxFileViewerEntries: z.number().int().positive().optional(),
  /** Optional phone-notify sinks (b48). Absent means disabled. */
  notify: notifySettingsSchema.optional(),
});

export const globalConfigYamlSchema = z.object({
  workspaces: z.array(nonEmptyString).optional(),
  automations: z.array(z.unknown()).optional(),
  settings: settingsSchema.optional(),
});
