import { resolve as resolvePath, sep } from "node:path";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_PROFILE_IDS,
  IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES,
  KickoffError,
  PIPELINE_MODEL_ROLES,
  assertVariablesMatchRequired as sharedAssertVariablesMatchRequired,
  architectJitPlanningWarning,
  buildKickoffVariables as sharedBuildKickoffVariables,
  findActivePipelineBlocker,
  requiredRolesFromWorkers as sharedRequiredRolesFromWorkers,
  resolveArchitectSelection,
  resolveEntryWorkerKey,
  resolveImplementFullyKickoffSchema,
  resolvePlanningProfile,
  resolvePlanningControls,
  resolveResearchApprovalPolicy,
  resolveRoleModelProfileDefaults,
  resolveRoleRecipe as sharedResolveRoleRecipe,
  validateFeatureSlugIdea as sharedValidateFeatureSlugIdea,
  type ImplementFullyLoopMode,
  type ImplementFullyPlanningProfileId,
  type ImplementFullyResearchApprovalPolicy,
  type KickoffVariables,
  type ModelSelection,
  type PipelineModelRole,
  type ResolveImplementFullyKickoffRequest,
  type ProvisionPipelineWorkersResponse,
  type ResolveImplementFullyKickoffResponse,
  type ResolvedRoleRecipe,
  type RoleSource,
  type TriggerRunRequest,
  type Workspace,
} from "@lca/shared";
import {
  DaemonClient,
  DaemonError,
  ProvisionConflictError,
  resolveWorkspaceId,
} from "./client.js";

const MODEL_PARAM_SYNTAX_MARKERS = [
  ":",
  "?",
  "=",
  "&",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  ",",
] as const;

/** Cap for active-pipeline guard; runs are newest-first so older actives are theoretical. */
const GUARD_RUN_LIMIT = 500;

const THIN_USAGE =
  "Usage: lca implement-fully --feature <bN> [options]\n" +
  "       lca implement-fully --idea <text> [options]";

const VALID_FLAGS = [
  "--feature",
  "--idea",
  "--workspace",
  "--role",
  "--role-profile",
  "--profile",
  "--research-approval",
  "--dry-run",
  "--force",
  "--prune",
  "--execute",
] as const;

export type ImplementFullyInput =
  ResolveImplementFullyKickoffRequest["input"];

export type ImplementFullyArgs = {
  input: ImplementFullyInput;
  workspaceQuery?: string;
  roleOverrides: Partial<Record<PipelineModelRole, string>>;
  roleProfile?: string;
  profile: ImplementFullyPlanningProfileId;
  researchApprovalPolicy?: ImplementFullyResearchApprovalPolicy;
  dryRun: boolean;
  force: boolean;
  prune: boolean;
  execute: boolean;
};

export type { KickoffVariables, ResolvedRoleRecipe, RoleSource };

function asDaemonError(err: unknown): never {
  if (err instanceof KickoffError) {
    throw new DaemonError(err.message);
  }
  throw err;
}

/** Parse `lca implement-fully` argv (flags after the verb). */
export function parseImplementFullyArgs(args: string[]): ImplementFullyArgs {
  let featureId: string | undefined;
  let idea: string | undefined;
  let sawFeature = false;
  let sawIdea = false;
  let workspaceQuery: string | undefined;
  const roleOverrides: Partial<Record<PipelineModelRole, string>> = {};
  let roleProfile: string | undefined;
  let profile: ImplementFullyPlanningProfileId =
    DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID;
  let researchApprovalPolicy: ImplementFullyResearchApprovalPolicy | undefined;
  let dryRun = false;
  let force = false;
  let prune = false;
  let execute = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--prune") {
      prune = true;
      continue;
    }
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--feature") {
      featureId = args[++i];
      if (!featureId) {
        throw new DaemonError("--feature requires a value (e.g. b42)");
      }
      sawFeature = true;
      continue;
    }
    if (arg === "--idea") {
      idea = args[++i];
      if (idea === undefined) {
        throw new DaemonError("--idea requires a value");
      }
      sawIdea = true;
      continue;
    }
    if (arg === "--workspace") {
      workspaceQuery = args[++i];
      if (!workspaceQuery) {
        throw new DaemonError("--workspace requires an id|name|path");
      }
      continue;
    }
    if (arg === "--profile") {
      const value = args[++i];
      if (!value) {
        throw new DaemonError(
          `--profile requires a value (${IMPLEMENT_FULLY_PLANNING_PROFILE_IDS.join("|")})`
        );
      }
      if (
        !(IMPLEMENT_FULLY_PLANNING_PROFILE_IDS as readonly string[]).includes(
          value
        )
      ) {
        throw new DaemonError(
          `Unknown --profile "${value}". Valid profiles: ${IMPLEMENT_FULLY_PLANNING_PROFILE_IDS.join(", ")}`
        );
      }
      profile = value as ImplementFullyPlanningProfileId;
      continue;
    }
    if (arg === "--research-approval") {
      const value = args[++i];
      if (!value) {
        throw new DaemonError(
          `--research-approval requires a value (${IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES.join("|")})`
        );
      }
      if (
        !(
          IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES as readonly string[]
        ).includes(value)
      ) {
        throw new DaemonError(
          `Unknown --research-approval "${value}". Valid values: ${IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES.join(", ")}`
        );
      }
      // Last occurrence wins.
      researchApprovalPolicy =
        value as ImplementFullyResearchApprovalPolicy;
      continue;
    }
    if (arg === "--role-profile") {
      const value = args[++i];
      if (!value) {
        throw new DaemonError("--role-profile requires a profile id");
      }
      roleProfile = value;
      continue;
    }
    if (arg === "--role") {
      const value = args[++i];
      if (!value) {
        throw new DaemonError(
          "--role requires <role>=<modelId> (roles: " +
            PIPELINE_MODEL_ROLES.join(", ") +
            ")"
        );
      }
      parseRoleOverride(value, roleOverrides);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new DaemonError(
        `Unknown flag "${arg}". Valid flags: ${VALID_FLAGS.join(", ")}`
      );
    }
    throw new DaemonError(
      `Unexpected argument "${arg}". Valid flags: ${VALID_FLAGS.join(", ")}`
    );
  }

  if (sawFeature && sawIdea) {
    throw new DaemonError(
      `Provide exactly one of --feature <bN> or --idea <text>, not both.\n${THIN_USAGE}`
    );
  }
  if (!sawFeature && !sawIdea) {
    throw new DaemonError(
      `Exactly one of --feature <bN> or --idea <text> is required.\n${THIN_USAGE}`
    );
  }

  const input: ImplementFullyInput = sawFeature
    ? { kind: "feature-id", featureId: featureId! }
    : { kind: "idea", idea: idea! };

  if (execute && resolvePlanningControls(profile).planningDepth === "jit") {
    throw new DaemonError(
      "--execute requires full upfront planning; pass --profile deep or --profile guided."
    );
  }

  return {
    input,
    workspaceQuery,
    roleOverrides,
    roleProfile,
    profile,
    researchApprovalPolicy,
    dryRun,
    force,
    prune,
    execute,
  };
}

function parseRoleOverride(
  value: string,
  into: Partial<Record<PipelineModelRole, string>>
): void {
  const eq = value.indexOf("=");
  if (eq <= 0 || eq === value.length - 1) {
    throw new DaemonError(
      `Invalid --role "${value}". Expected <role>=<modelId> (ids only; for params use settings.pipelineRoleModels). Roles: ${PIPELINE_MODEL_ROLES.join(", ")}`
    );
  }
  const role = value.slice(0, eq);
  const modelId = value.slice(eq + 1).trim();
  if (!PIPELINE_MODEL_ROLES.includes(role as PipelineModelRole)) {
    throw new DaemonError(
      `Unknown role "${role}". Valid roles: ${PIPELINE_MODEL_ROLES.join(", ")}`
    );
  }
  if (!modelId) {
    throw new DaemonError(
      `--role ${role}= requires a non-empty model id (ids only; for params use settings.pipelineRoleModels)`
    );
  }
  if (MODEL_PARAM_SYNTAX_MARKERS.some((marker) => modelId.includes(marker))) {
    throw new DaemonError(
      `--role accepts model ids only (got "${modelId}"). Put parameter syntax in settings.pipelineRoleModels.`
    );
  }
  // Last wins for a repeated role.
  into[role as PipelineModelRole] = modelId;
}

/**
 * Build and validate a resolve request with the shared schema.
 * Only the active discriminated-union member is included.
 */
export function buildResolveKickoffRequest(
  workspaceId: string,
  input: ImplementFullyInput
): ResolveImplementFullyKickoffRequest {
  const raw: ResolveImplementFullyKickoffRequest =
    input.kind === "feature-id"
      ? {
          workspaceId,
          input: { kind: "feature-id", featureId: input.featureId },
        }
      : {
          workspaceId,
          input: { kind: "idea", idea: input.idea },
        };
  const parsed = resolveImplementFullyKickoffSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DaemonError(
      parsed.error.issues[0]?.message ?? "Invalid resolve request."
    );
  }
  return parsed.data;
}

/** Validate feature / slug / idea shape (pure). */
export function validateFeatureSlugIdea(
  feature: string,
  slug: string,
  idea: string
): void {
  try {
    sharedValidateFeatureSlugIdea(feature, slug, idea);
  } catch (err) {
    asDaemonError(err);
  }
}

/** Build the ten kickoff variables (forward slashes always). */
export function buildKickoffVariables(
  feature: string,
  slug: string,
  idea: string,
  profileId: ImplementFullyPlanningProfileId | string = DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  researchApprovalPolicy: ImplementFullyResearchApprovalPolicy = "none",
  loopMode: ImplementFullyLoopMode = "normal"
): KickoffVariables {
  try {
    return sharedBuildKickoffVariables(
      feature,
      slug,
      idea,
      profileId,
      researchApprovalPolicy,
      loopMode
    );
  } catch (err) {
    asDaemonError(err);
  }
}

/**
 * Assert built keys equal introspection's requiredVariables exactly
 * (order-independent set equality).
 */
export function assertVariablesMatchRequired(
  variables: KickoffVariables,
  requiredVariables: readonly string[]
): void {
  try {
    sharedAssertVariablesMatchRequired(variables, requiredVariables);
  } catch (err) {
    asDaemonError(err);
  }
}

/** Resolve roleModels from overrides → roleDefaults → error. */
export function resolveRoleRecipe(
  requiredRoles: readonly string[],
  overrides: Parameters<typeof sharedResolveRoleRecipe>[1],
  roleDefaults: Partial<Record<PipelineModelRole, ModelSelection>>
): ResolvedRoleRecipe {
  try {
    return sharedResolveRoleRecipe(requiredRoles, overrides, roleDefaults);
  } catch (err) {
    asDaemonError(err);
  }
}

/** Distinct modelRole values from introspection workers, stable order. */
export function requiredRolesFromWorkers(
  workers: Parameters<typeof sharedRequiredRolesFromWorkers>[0]
): string[] {
  return sharedRequiredRolesFromWorkers(workers);
}

function normalizeFsPath(p: string): string {
  const normalized = resolvePath(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInsideOrEqual(cwd: string, workspacePath: string): boolean {
  const cwdNorm = normalizeFsPath(cwd);
  const wsNorm = normalizeFsPath(workspacePath);
  if (cwdNorm === wsNorm) return true;
  // resolvePath normalizes separators; compare with platform sep.
  return cwdNorm.startsWith(wsNorm + sep.toLowerCase());
}

/**
 * Pick the registered workspace whose path is the longest prefix of `cwd`
 * (nested wins over parent). Never selects `__global__`.
 */
export function resolveWorkspaceFromCwd(
  workspaces: Workspace[],
  cwd: string
): Workspace {
  let best: Workspace | undefined;
  let bestLen = -1;

  for (const w of workspaces) {
    if (w.id === "__global__") continue;
    if (!pathIsInsideOrEqual(cwd, w.path)) continue;
    const wsNorm = normalizeFsPath(w.path);
    if (wsNorm.length > bestLen) {
      best = w;
      bestLen = wsNorm.length;
    }
  }

  if (!best) {
    throw new DaemonError(
      `Current directory "${cwd}" is not inside a registered workspace. ` +
        `Register it in the Max dashboard (or via the daemon API) first.`
    );
  }
  return best;
}

function formatRoleRecipe(
  roleModels: Record<string, ModelSelection>,
  sources: Record<string, RoleSource>
): string {
  return Object.keys(roleModels)
    .sort()
    .map((role) => {
      const sel = roleModels[role]!;
      const src = sources[role] ?? "default";
      const params =
        sel.params && sel.params.length > 0
          ? ` +${sel.params.length} param(s)`
          : "";
      return `  ${role}: ${sel.id}${params} (${src})`;
    })
    .join("\n");
}

export type ImplementFullyKickoffBuild = {
  workspace: Workspace;
  resolved: ResolveImplementFullyKickoffResponse;
  dryProvision: ProvisionPipelineWorkersResponse;
  kickoff: TriggerRunRequest;
  summaryLines: string[];
  architectJitWarning: string | null;
  pipelineAutomationIds: Set<string>;
};

export type BuildImplementFullyKickoffOptions = {
  researchApprovalPolicy?: ImplementFullyResearchApprovalPolicy;
};

/**
 * Shared prefix for implement-fully and queue add: resolve, validate, dry-run
 * provision, and assemble the kickoff payload. Does not apply the active-pipeline
 * guard, real provision, or trigger a run.
 */
export async function buildImplementFullyKickoff(
  client: DaemonClient,
  parsed: ImplementFullyArgs,
  options?: BuildImplementFullyKickoffOptions
): Promise<ImplementFullyKickoffBuild> {
  const workspaces = await client.listWorkspaces();
  let workspace: Workspace;
  if (parsed.workspaceQuery) {
    const id = await resolveWorkspaceId(client, parsed.workspaceQuery);
    const found = workspaces.find((w) => w.id === id);
    if (!found) {
      throw new DaemonError(`No workspace matches "${parsed.workspaceQuery}".`);
    }
    if (found.id === "__global__") {
      throw new DaemonError(
        "Cannot kick off /implement-fully in the global workspace."
      );
    }
    workspace = found;
  } else {
    workspace = resolveWorkspaceFromCwd(workspaces, process.cwd());
  }

  const resolveRequest = buildResolveKickoffRequest(
    workspace.id,
    parsed.input
  );
  const resolved: ResolveImplementFullyKickoffResponse =
    await client.resolveImplementFullyKickoff(resolveRequest);

  validateFeatureSlugIdea(
    resolved.featureId,
    resolved.featureSlug,
    resolved.idea
  );
  const profile = resolvePlanningProfile(parsed.profile);
  const kickoffResearchApprovalPolicy =
    parsed.researchApprovalPolicy ??
    options?.researchApprovalPolicy ??
    "none";
  const variables = buildKickoffVariables(
    resolved.featureId,
    resolved.featureSlug,
    resolved.idea,
    parsed.profile,
    kickoffResearchApprovalPolicy,
    parsed.execute ? "execute" : "normal"
  );

  const introspection = await client.getPipeline(IMPLEMENT_FULLY_PIPELINE_ID);
  assertVariablesMatchRequired(variables, introspection.requiredVariables);

  const requiredRoles = introspection.roleContract.required;
  let baseRoleDefaults;
  try {
    baseRoleDefaults = resolveRoleModelProfileDefaults(
      parsed.roleProfile,
      introspection
    );
  } catch (err) {
    asDaemonError(err);
  }
  const recipe = resolveRoleRecipe(
    requiredRoles,
    parsed.roleOverrides,
    baseRoleDefaults
  );

  const { entryWorkerKey, rootRole } = resolveEntryWorkerKey(
    recipe.roleModels,
    introspection.roleContract,
    introspection.entryWorkerKey
  );

  const entryWorker = introspection.workers.find((w) => w.key === entryWorkerKey);
  if (!entryWorker) {
    throw new DaemonError(
      `Introspection entry worker "${entryWorkerKey}" missing from workers list.`
    );
  }

  let researchApprovalPolicy;
  try {
    researchApprovalPolicy = resolveResearchApprovalPolicy(
      variables.researchApprovalPolicy,
      recipe.roleModels
    );
  } catch (err) {
    if (
      err instanceof KickoffError &&
      parsed.researchApprovalPolicy !== undefined
    ) {
      throw new DaemonError(
        `${err.message} Pass --role researcher=<modelId> when using --research-approval.`
      );
    }
    asDaemonError(err);
  }

  // Dry-run provision after recipe/policy checks so an armed policy without a
  // researcher fails before any provision or trigger call.
  const dryProvision = await client.provisionPipelineWorkers(
    IMPLEMENT_FULLY_PIPELINE_ID,
    {
      workspaceId: workspace.id,
      dryRun: true,
      prune: parsed.prune,
    }
  );

  const entryPlanItem = dryProvision.plan.items.find(
    (i) => i.key === entryWorkerKey
  );
  if (!entryPlanItem) {
    throw new DaemonError(
      `Dry-run plan missing entry worker "${entryWorkerKey}".`
    );
  }

  const pipelineAutomationIds = new Set(
    dryProvision.plan.items.map((i) => i.automationId)
  );

  const modelSelection =
    entryWorkerKey === IMPLEMENT_FULLY_ENTRY_WORKER_KEY
      ? resolveArchitectSelection(
          recipe.roleModels,
          introspection.roleContract
        ).selection
      : recipe.roleModels[rootRole];
  if (!modelSelection) {
    throw new DaemonError(
      `No resolved selection for entry worker role "${rootRole}".`
    );
  }

  const architectResolved = resolveArchitectSelection(
    recipe.roleModels,
    introspection.roleContract
  );
  const architectSourceLabel =
    architectResolved.source === "explicit"
      ? "explicit"
      : "planner fallback";

  const kickoff: TriggerRunRequest = {
    automationId: entryPlanItem.automationId,
    variables,
    roleModels: recipe.roleModels,
    maxDepth: 1,
    modelSelection,
  };

  const researcherSelection = recipe.roleModels.researcher;
  const architectJitWarning = architectJitPlanningWarning(
    variables.planningDepth,
    recipe.roleModels
  );
  const summaryLines = [
    `Workspace: ${workspace.path}`,
    `Feature:   ${resolved.featureId} (${resolved.featureSlug})`,
    `Idea:      ${resolved.idea}`,
    `Profile:   ${profile.label} (${profile.id})`,
    `Planning:  depth=${variables.planningDepth} approval=${variables.approvalPolicy}`,
    `Loop mode: ${variables.loopMode}`,
    `Entry:     ${entryWorkerKey} (${rootRole})`,
    researcherSelection
      ? `Research:  ${researcherSelection.id} (approval=${researchApprovalPolicy})`
      : "Research:  disabled",
    `Architect: ${architectResolved.selection.id} (${architectSourceLabel})`,
    `Roles:`,
    formatRoleRecipe(recipe.roleModels, recipe.sources),
  ];

  return {
    workspace,
    resolved,
    dryProvision,
    kickoff,
    summaryLines,
    architectJitWarning,
    pipelineAutomationIds,
  };
}

/**
 * Kick off an `/implement-fully` pipeline: resolve thin input, provision,
 * introspect, validate, guard, POST /api/runs at maxDepth 1.
 *
 * CLI `--research-approval` wins over `options.researchApprovalPolicy`
 * (composition/tests); either defaults to `"none"`.
 */
export async function cmdImplementFully(
  client: DaemonClient,
  args: string[],
  options?: BuildImplementFullyKickoffOptions
): Promise<void> {
  const parsed = parseImplementFullyArgs(args);
  const built = await buildImplementFullyKickoff(client, parsed, options);

  if (!parsed.force) {
    // Newest-first; GUARD_RUN_LIMIT means a non-terminal older than that window
    // is not detected (theoretical for normal use).
    const runs = await client.listRuns(GUARD_RUN_LIMIT);
    const blocker = findActivePipelineBlocker(
      runs,
      built.pipelineAutomationIds
    );
    if (blocker) {
      throw new DaemonError(
        `Active pipeline run ${blocker.id} on automation ${blocker.automationId} ` +
          `(status=${blocker.status}). Wait for it to finish, or pass --force.`
      );
    }
  }

  const {
    workspace,
    dryProvision,
    kickoff,
    summaryLines,
    architectJitWarning,
  } = built;

  if (parsed.dryRun) {
    console.log("Dry run — nothing written.");
    console.log(summaryLines.join("\n"));
    if (architectJitWarning) {
      console.warn(architectJitWarning);
    }
    if (dryProvision.missingSkills.length > 0) {
      console.log(
        `Warning: missing skills (non-blocking): ${dryProvision.missingSkills.join(", ")}`
      );
    }
    console.log("Kickoff payload:");
    console.log(JSON.stringify(kickoff, null, 2));
    return;
  }

  let applied: ProvisionPipelineWorkersResponse;
  try {
    applied = await client.provisionPipelineWorkers(
      IMPLEMENT_FULLY_PIPELINE_ID,
      {
        workspaceId: workspace.id,
        dryRun: false,
        prune: parsed.prune,
      }
    );
  } catch (err) {
    if (err instanceof ProvisionConflictError) {
      const keys = err.response.plan.items
        .filter((i) => i.action === "conflict")
        .map((i) => i.key);
      throw new DaemonError(
        `Provisioning conflict for worker(s): ${keys.join(", ")}. ` +
          `A non-generated automation already owns that id. No run created.`
      );
    }
    throw err;
  }

  const runId = await client.triggerRunWithContext(kickoff);

  console.log(`Started run ${runId}`);
  console.log(summaryLines.join("\n"));
  if (architectJitWarning) {
    console.warn(architectJitWarning);
  }
  if (applied.missingSkills.length > 0) {
    console.log(
      `Warning: missing skills (non-blocking): ${applied.missingSkills.join(", ")}`
    );
  }
  console.log(`Watch: ${client.base}  |  lca logs ${runId}`);
}
