/**
 * Pure kickoff validation and derivation shared by the CLI and dashboard.
 * No fetch, fs, process, or DaemonError — callers render structured failures.
 */

import { CHAIN_VALUE_MAX_LENGTH } from "./schemas/run.js";
import type { ModelSelection } from "./model.js";
import type { ChainVariables } from "./types/config.js";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  IMPLEMENT_FULLY_APPROVAL_POLICIES,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_PLANNING_DEPTHS,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  IMPLEMENT_FULLY_LOOP_MODES,
  IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES,
  PIPELINE_MODEL_ROLES,
  PIPELINE_OPTIONAL_MODEL_ROLES,
  type ImplementFullyApprovalPolicy,
  type ImplementFullyLoopMode,
  type ImplementFullyPlanningDepth,
  type ImplementFullyPlanningProfile,
  type ImplementFullyPlanningProfileId,
  type ImplementFullyResearchApprovalPolicy,
  type PipelineIntrospectionResponse,
  type PipelineModelRole,
} from "./types/api.js";

const FEATURE_RE = /^b\d+$/;
const SLUG_RE = /^b\d+-[a-z0-9]+(-[a-z0-9]+)*$/;

const ACTIVE_PIPELINE_STATUSES = new Set([
  "queued",
  "running",
  "needs_input",
  "paused",
]);

const PLANNING_DEPTH_SET = new Set<string>(IMPLEMENT_FULLY_PLANNING_DEPTHS);
const APPROVAL_POLICY_SET = new Set<string>(IMPLEMENT_FULLY_APPROVAL_POLICIES);
const RESEARCH_APPROVAL_POLICY_SET = new Set<string>(
  IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES
);
const LOOP_MODE_SET = new Set<string>(IMPLEMENT_FULLY_LOOP_MODES);

export class KickoffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KickoffError";
  }
}

export type RoleSource = "override" | "default";

export type ResolvedRoleRecipe = {
  roleModels: Record<string, ModelSelection>;
  sources: Record<string, RoleSource>;
};

export type KickoffVariables = {
  pipelineId: string;
  featureId: string;
  featureSlug: string;
  featureDir: string;
  featureIndex: string;
  idea: string;
  planningDepth: ImplementFullyPlanningDepth;
  approvalPolicy: ImplementFullyApprovalPolicy;
  researchApprovalPolicy: ImplementFullyResearchApprovalPolicy;
  loopMode: ImplementFullyLoopMode;
};

export type ActivePipelineBlocker = {
  id: string;
  automationId: string;
  status: string;
};

export type ResolvedPlanningControls = {
  planningDepth: ImplementFullyPlanningDepth;
  approvalPolicy: ImplementFullyApprovalPolicy;
};

/** Look up a catalog profile; throws KickoffError for unknown ids. */
export function resolvePlanningProfile(
  profileId: string = DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID
): ImplementFullyPlanningProfile {
  const profile = IMPLEMENT_FULLY_PLANNING_PROFILES.find(
    (entry) => entry.id === profileId
  );
  if (!profile) {
    throw new KickoffError(
      `Unknown planning profile "${profileId}". Valid profiles: ${IMPLEMENT_FULLY_PLANNING_PROFILES.map((p) => p.id).join(", ")}`
    );
  }
  return profile;
}

/** Map a profile id to durable controls (default Quick/JIT). */
export function resolvePlanningControls(
  profileId: string = DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID
): ResolvedPlanningControls {
  const profile = resolvePlanningProfile(profileId);
  return {
    planningDepth: profile.planningDepth,
    approvalPolicy: profile.approvalPolicy,
  };
}

/** Validate feature / slug / idea shape (pure). */
export function validateFeatureSlugIdea(
  feature: string,
  slug: string,
  idea: string
): void {
  if (!FEATURE_RE.test(feature)) {
    throw new KickoffError(
      `Invalid --feature "${feature}". Expected ^b\\d+$ (e.g. b42).`
    );
  }
  if (!SLUG_RE.test(slug)) {
    throw new KickoffError(
      `Invalid --slug "${slug}". Expected ^b\\d+-[a-z0-9]+(-[a-z0-9]+)*$ (e.g. b42-my-feature).`
    );
  }
  if (!slug.startsWith(`${feature}-`)) {
    throw new KickoffError(
      `Slug "${slug}" must start with "${feature}-" (feature=${feature}).`
    );
  }
  const trimmed = idea.trim();
  if (!trimmed) {
    throw new KickoffError("--idea must be non-empty after trimming");
  }
  const byteLength = new TextEncoder().encode(trimmed).length;
  if (byteLength > CHAIN_VALUE_MAX_LENGTH) {
    throw new KickoffError(
      `--idea is ${byteLength} bytes; max is ${CHAIN_VALUE_MAX_LENGTH} (CHAIN_VALUE_MAX_LENGTH). Refuse to truncate.`
    );
  }
}

/**
 * Build the ten kickoff variables (forward slashes always).
 * Optional profile id defaults to Quick/JIT; the profile id itself is not persisted.
 * Optional research-approval policy defaults to `"none"`.
 * Optional loop mode defaults to `"normal"`.
 */
export function buildKickoffVariables(
  feature: string,
  slug: string,
  idea: string,
  profileId: ImplementFullyPlanningProfileId | string = DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  researchApprovalPolicy: ImplementFullyResearchApprovalPolicy = "none",
  loopMode: ImplementFullyLoopMode = "normal"
): KickoffVariables {
  const controls = resolvePlanningControls(profileId);
  const featureDir = `docs/roadmap/${slug}`;
  return {
    pipelineId: IMPLEMENT_FULLY_PIPELINE_ID,
    featureId: feature,
    featureSlug: slug,
    featureDir,
    featureIndex: `${featureDir}/00-index.md`,
    idea,
    planningDepth: controls.planningDepth,
    approvalPolicy: controls.approvalPolicy,
    researchApprovalPolicy,
    loopMode,
  };
}

/**
 * Normalize / validate chain variables for render and persistence.
 * Non-implement-fully contexts are returned unchanged (same object reference).
 * Implement-fully fills missing controls with Quick/JIT defaults, rejects invalid
 * enum values, and rejects unsupported `jit` + `before-implementation`.
 * Never mutates the input object.
 */
export function normalizeImplementFullyChainVariables(
  variables: ChainVariables
): ChainVariables {
  if (variables.pipelineId !== IMPLEMENT_FULLY_PIPELINE_ID) {
    return variables;
  }

  const planningDepthRaw = variables.planningDepth;
  const approvalPolicyRaw = variables.approvalPolicy;
  const researchApprovalPolicyRaw = variables.researchApprovalPolicy;
  const loopModeRaw = variables.loopMode;

  let planningDepth: ImplementFullyPlanningDepth;
  if (planningDepthRaw === undefined) {
    planningDepth = "jit";
  } else if (typeof planningDepthRaw !== "string") {
    throw new KickoffError(
      `Invalid planningDepth: expected string enum (${IMPLEMENT_FULLY_PLANNING_DEPTHS.join(", ")}), got ${typeof planningDepthRaw}`
    );
  } else if (!PLANNING_DEPTH_SET.has(planningDepthRaw)) {
    throw new KickoffError(
      `Invalid planningDepth "${planningDepthRaw}". Valid values: ${IMPLEMENT_FULLY_PLANNING_DEPTHS.join(", ")}`
    );
  } else {
    planningDepth = planningDepthRaw as ImplementFullyPlanningDepth;
  }

  let approvalPolicy: ImplementFullyApprovalPolicy;
  if (approvalPolicyRaw === undefined) {
    approvalPolicy = "none";
  } else if (typeof approvalPolicyRaw !== "string") {
    throw new KickoffError(
      `Invalid approvalPolicy: expected string enum (${IMPLEMENT_FULLY_APPROVAL_POLICIES.join(", ")}), got ${typeof approvalPolicyRaw}`
    );
  } else if (!APPROVAL_POLICY_SET.has(approvalPolicyRaw)) {
    throw new KickoffError(
      `Invalid approvalPolicy "${approvalPolicyRaw}". Valid values: ${IMPLEMENT_FULLY_APPROVAL_POLICIES.join(", ")}`
    );
  } else {
    approvalPolicy = approvalPolicyRaw as ImplementFullyApprovalPolicy;
  }

  if (planningDepth === "jit" && approvalPolicy === "before-implementation") {
    throw new KickoffError(
      'Unsupported combination: planningDepth "jit" with approvalPolicy "before-implementation"'
    );
  }

  let loopMode: ImplementFullyLoopMode;
  if (loopModeRaw === undefined) {
    loopMode = "normal";
  } else if (typeof loopModeRaw !== "string") {
    throw new KickoffError(
      `Invalid loopMode: expected string enum (${IMPLEMENT_FULLY_LOOP_MODES.join(", ")}), got ${typeof loopModeRaw}`
    );
  } else if (!LOOP_MODE_SET.has(loopModeRaw)) {
    throw new KickoffError(
      `Invalid loopMode "${loopModeRaw}". Valid values: ${IMPLEMENT_FULLY_LOOP_MODES.join(", ")}`
    );
  } else {
    loopMode = loopModeRaw as ImplementFullyLoopMode;
  }

  if (loopMode === "execute" && planningDepth === "jit") {
    throw new KickoffError(
      'Unsupported combination: loopMode "execute" with planningDepth "jit". ' +
        "Execute mode needs full upfront contracts — use profile deep or guided."
    );
  }

  let researchApprovalPolicy: ImplementFullyResearchApprovalPolicy;
  if (researchApprovalPolicyRaw === undefined) {
    researchApprovalPolicy = "none";
  } else if (typeof researchApprovalPolicyRaw !== "string") {
    throw new KickoffError(
      `Invalid researchApprovalPolicy: expected string enum (${IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES.join(", ")}), got ${typeof researchApprovalPolicyRaw}`
    );
  } else if (!RESEARCH_APPROVAL_POLICY_SET.has(researchApprovalPolicyRaw)) {
    throw new KickoffError(
      `Invalid researchApprovalPolicy "${researchApprovalPolicyRaw}". Valid values: ${IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES.join(", ")}`
    );
  } else {
    researchApprovalPolicy =
      researchApprovalPolicyRaw as ImplementFullyResearchApprovalPolicy;
  }

  return {
    ...variables,
    planningDepth,
    approvalPolicy,
    researchApprovalPolicy,
    loopMode,
  };
}

/**
 * Assert built keys equal introspection's requiredVariables exactly
 * (order-independent set equality).
 */
export function assertVariablesMatchRequired(
  variables: KickoffVariables,
  requiredVariables: readonly string[]
): void {
  const built = new Set(Object.keys(variables));
  const required = new Set(requiredVariables);
  if (built.size !== required.size) {
    throw new KickoffError(
      `Variable key mismatch: built [${[...built].sort().join(", ")}] vs required [${[...required].sort().join(", ")}]`
    );
  }
  for (const key of required) {
    if (!built.has(key)) {
      throw new KickoffError(
        `Variable key mismatch: built [${[...built].sort().join(", ")}] vs required [${[...required].sort().join(", ")}]`
      );
    }
  }
}

function copyRoleModels(
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>
): Partial<Record<PipelineModelRole, ModelSelection>> {
  const out: Partial<Record<PipelineModelRole, ModelSelection>> = {};
  for (const role of PIPELINE_MODEL_ROLES) {
    const selection = roleModels[role];
    if (!selection) continue;
    out[role] = {
      id: selection.id,
      ...(selection.params
        ? { params: selection.params.map((p) => ({ id: p.id, value: p.value })) }
        : {}),
    };
  }
  return out;
}

/** Look up a role-model profile id; throws KickoffError for unknown ids. */
export function resolveRoleModelProfileDefaults(
  profileId: string | undefined,
  introspection: Pick<
    PipelineIntrospectionResponse,
    "roleModelProfiles" | "roleDefaults" | "defaultRoleModelProfileId"
  >
): Partial<Record<PipelineModelRole, ModelSelection>> {
  const effectiveId =
    profileId != null && profileId.trim() !== ""
      ? profileId.trim()
      : introspection.defaultRoleModelProfileId;

  const profile = introspection.roleModelProfiles.find(
    (entry) => entry.id === effectiveId
  );
  if (!profile) {
    const validIds = introspection.roleModelProfiles.map((entry) => entry.id);
    throw new KickoffError(
      `Unknown role model profile "${effectiveId}". Valid profiles: ${validIds.join(", ")}`
    );
  }

  return copyRoleModels(profile.roleModels);
}

/**
 * Per-role kickoff override. CLI passes bare model ids; the dashboard passes
 * full ModelSelection (id + params like thinking/fast) from ModelSelect.
 */
export type RoleModelOverride = string | ModelSelection;

function coerceRoleOverride(override: RoleModelOverride): ModelSelection {
  if (typeof override === "string") {
    return { id: override };
  }
  return {
    id: override.id,
    ...(override.params
      ? { params: override.params.map((p) => ({ id: p.id, value: p.value })) }
      : {}),
  };
}

/** Resolve required roles strictly and optional roles when configured. */
export function resolveRoleRecipe(
  requiredRoles: readonly string[],
  overrides: Partial<Record<PipelineModelRole, RoleModelOverride>>,
  roleDefaults: Partial<Record<PipelineModelRole, ModelSelection>>
): ResolvedRoleRecipe {
  const roleModels: Record<string, ModelSelection> = {};
  const sources: Record<string, RoleSource> = {};
  const unresolved: string[] = [];

  for (const role of requiredRoles) {
    const override = overrides[role as PipelineModelRole];
    if (override) {
      roleModels[role] = coerceRoleOverride(override);
      sources[role] = "override";
      continue;
    }
    const def = roleDefaults[role as PipelineModelRole];
    if (def) {
      roleModels[role] = def;
      sources[role] = "default";
      continue;
    }
    unresolved.push(role);
  }

  if (unresolved.length > 0) {
    throw new KickoffError(
      `Unresolved pipeline role(s): ${unresolved.join(", ")}. ` +
        `Provide --role <role>=<modelId>, select --role-profile <id>, or set ` +
        `settings.pipelineRoleModels / settings.pipelineRoleModelProfiles.`
    );
  }

  for (const role of PIPELINE_OPTIONAL_MODEL_ROLES) {
    const override = overrides[role];
    if (override) {
      roleModels[role] = coerceRoleOverride(override);
      sources[role] = "override";
      continue;
    }
    const def = roleDefaults[role];
    if (def) {
      roleModels[role] = def;
      sources[role] = "default";
    }
  }

  return { roleModels, sources };
}

/** Select the configured research entry, otherwise preserve the planner entry. */
export function resolveEntryWorkerKey(
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>,
  contract: PipelineIntrospectionResponse["roleContract"],
  defaultEntryWorkerKey: string
): { entryWorkerKey: string; rootRole: PipelineModelRole } {
  if (roleModels[contract.conditionalEntryRole]) {
    return {
      entryWorkerKey: contract.conditionalEntryWorkerKey,
      rootRole: contract.conditionalEntryRole,
    };
  }
  return { entryWorkerKey: defaultEntryWorkerKey, rootRole: "planner" };
}

export type RoleFallbackResolutionSource =
  | "explicit"
  | "reviewer-fallback"
  | "planner-fallback";

export type GatekeeperResolutionSource = Extract<
  RoleFallbackResolutionSource,
  "explicit" | "reviewer-fallback"
>;

export type ArchitectResolutionSource = Extract<
  RoleFallbackResolutionSource,
  "explicit" | "planner-fallback"
>;

/** Terminal final-gate owner; missing selection falls back to reviewer. */
export const PIPELINE_TERMINAL_ROLE = "gatekeeper" as const;
/** Concrete fallback when the terminal role is unset in roleModels. */
export const PIPELINE_TERMINAL_FALLBACK_ROLE = "reviewer" as const;

/** Optional skeleton owner; missing selection falls back to planner at spawn. */
export const PIPELINE_SKELETON_ROLE = "architect" as const;
export const PIPELINE_SKELETON_FALLBACK_ROLE = "planner" as const;

/**
 * Non-throwing role-then-fallback lookup. Returns null when neither role is
 * present. Preserves stored params on both branches.
 */
export function resolveRoleSelectionWithFallback(
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>,
  role: PipelineModelRole,
  fallbackRole: PipelineModelRole
): { selection: ModelSelection; source: RoleFallbackResolutionSource } | null {
  const explicit = roleModels[role];
  if (explicit) {
    return { selection: explicit, source: "explicit" };
  }
  const fallback = roleModels[fallbackRole];
  if (fallback) {
    return {
      selection: fallback,
      source: `${fallbackRole}-fallback` as RoleFallbackResolutionSource,
    };
  }
  return null;
}

/** Resolve terminal ownership without persisting the reviewer fallback as gatekeeper. */
export function resolveGatekeeperSelection(
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>,
  contract: PipelineIntrospectionResponse["roleContract"]
): { selection: ModelSelection; source: GatekeeperResolutionSource } {
  const resolved = resolveRoleSelectionWithFallback(
    roleModels,
    contract.fallbackRole,
    contract.fallbackToRole
  );
  if (!resolved) {
    throw new KickoffError(
      `Cannot resolve optional role "${contract.fallbackRole}": fallback role "${contract.fallbackToRole}" is missing.`
    );
  }
  return resolved as {
    selection: ModelSelection;
    source: GatekeeperResolutionSource;
  };
}

export function resolveArchitectSelection(
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>,
  contract: PipelineIntrospectionResponse["roleContract"]
): { selection: ModelSelection; source: ArchitectResolutionSource } {
  const resolved = resolveRoleSelectionWithFallback(
    roleModels,
    contract.skeletonFallbackRole,
    contract.skeletonFallbackToRole
  );
  if (!resolved) {
    throw new KickoffError(
      `Cannot resolve optional role "${contract.skeletonFallbackRole}": fallback role "${contract.skeletonFallbackToRole}" is missing.`
    );
  }
  return resolved as { selection: ModelSelection; source: ArchitectResolutionSource };
}

/** Warn when explicit architect is paired with JIT planning (non-blocking). */
export function architectJitPlanningWarning(
  planningDepth: ImplementFullyPlanningDepth,
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>
): string | null {
  if (planningDepth !== "jit" || !roleModels[PIPELINE_SKELETON_ROLE]) {
    return null;
  }
  return (
    'Warning: explicit "architect" role with planningDepth "jit" — the architect ' +
    "writes a full-depth skeleton once while later admit/repair passes stay on the " +
    "fast model; this is allowed but may be redundant."
  );
}

/** Validate the research checkpoint against the resolved optional researcher role. */
export function resolveResearchApprovalPolicy(
  policy: ImplementFullyResearchApprovalPolicy | undefined,
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>
): ImplementFullyResearchApprovalPolicy {
  const resolved = policy ?? "none";
  if (!RESEARCH_APPROVAL_POLICY_SET.has(resolved)) {
    throw new KickoffError(
      `Invalid researchApprovalPolicy "${resolved}". Valid values: ${IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES.join(", ")}`
    );
  }
  if (resolved === "before-planning" && !roleModels.researcher) {
    throw new KickoffError(
      'researchApprovalPolicy "before-planning" requires a resolved "researcher" role.'
    );
  }
  return resolved;
}

/** Distinct modelRole values from introspection workers, stable order. */
export function requiredRolesFromWorkers(
  workers: PipelineIntrospectionResponse["workers"]
): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const w of workers) {
    if (!seen.has(w.modelRole)) {
      seen.add(w.modelRole);
      roles.push(w.modelRole);
    }
  }
  return roles;
}

/**
 * First non-terminal run on a provisioned pipeline automation, or null.
 * Callers that want to force past the guard ignore a non-null result.
 */
export function findActivePipelineBlocker(
  runs: ReadonlyArray<{
    id: string;
    automationId: string;
    status: string;
  }>,
  pipelineAutomationIds: ReadonlySet<string>
): ActivePipelineBlocker | null {
  for (const run of runs) {
    if (
      ACTIVE_PIPELINE_STATUSES.has(run.status) &&
      pipelineAutomationIds.has(run.automationId)
    ) {
      return {
        id: run.id,
        automationId: run.automationId,
        status: run.status,
      };
    }
  }
  return null;
}
