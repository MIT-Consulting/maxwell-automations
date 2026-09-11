import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  KickoffError,
  assertVariablesMatchRequired,
  buildKickoffVariables,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  resolveArchitectSelection,
  resolveEntryWorkerKey,
  resolveGatekeeperSelection,
  resolveImplementFullyKickoffSchema,
  resolvePlanningControls,
  resolveResearchApprovalPolicy,
  resolveRoleModelProfileDefaults,
  resolveRoleRecipe,
  validateFeatureSlugIdea,
  type ArchitectResolutionSource,
  type GatekeeperResolutionSource,
  type ImplementFullyLoopMode,
  type ImplementFullyPlanningProfileId,
  type ImplementFullyResearchApprovalPolicy,
  type ModelSelection,
  type PipelineIntrospectionResponse,
  type PipelineModelRole,
  type ProvisionPipelineWorkersResponse,
  type ResolveImplementFullyKickoffRequest,
  type RoleModelOverride,
  type TriggerRunRequest,
} from "@lca/shared";

/** Active kickoff intent — derived from the shared resolve request union. */
export type ResolveKickoffInputKind =
  ResolveImplementFullyKickoffRequest["input"]["kind"];

/**
 * Build a strict Phase 1 resolve request from the active form intent.
 * Only the active discriminated-union member is included.
 */
export function buildResolveImplementFullyKickoffRequest(args: {
  workspaceId: string;
  kind: ResolveKickoffInputKind;
  featureId: string;
  idea: string;
}): ResolveImplementFullyKickoffRequest {
  const raw: ResolveImplementFullyKickoffRequest =
    args.kind === "feature-id"
      ? {
          workspaceId: args.workspaceId,
          input: { kind: "feature-id", featureId: args.featureId },
        }
      : {
          workspaceId: args.workspaceId,
          input: { kind: "idea", idea: args.idea },
        };
  const parsed = resolveImplementFullyKickoffSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message;
    throw new KickoffError(first ?? "Invalid resolve request.");
  }
  return parsed.data;
}

/** Pure kickoff facts for Phase 3/5 review UI — no fetch, mutate, or render. */
export type KickoffReviewFacts = {
  entryWorkerKey: string;
  rootRole: PipelineModelRole;
  researcher: ModelSelection | null;
  researchApprovalPolicy: ImplementFullyResearchApprovalPolicy;
  architect: ModelSelection;
  architectSource: ArchitectResolutionSource;
  gatekeeper: ModelSelection;
  gatekeeperSource: GatekeeperResolutionSource;
};

/** Pure research-approval control state for the kickoff modal. */
export type ResearchApprovalControlState = {
  researcherResolved: boolean;
  enabled: boolean;
  effectivePolicy: ImplementFullyResearchApprovalPolicy;
};

/**
 * Decide whether the research approval control is available and what policy
 * the kickoff payload should carry. Override wins over profile default, matching
 * `resolveRoleRecipe`'s optional-role precedence. With no researcher, the
 * effective policy is coerced to `"none"`.
 */
export function describeResearchApprovalControlState(args: {
  roleOverrides: Partial<Record<PipelineModelRole, RoleModelOverride>>;
  roleDefaults: Partial<Record<PipelineModelRole, ModelSelection>> | null;
  researchApprovalPolicy: ImplementFullyResearchApprovalPolicy;
}): ResearchApprovalControlState {
  const researcherResolved = Boolean(
    args.roleOverrides.researcher || args.roleDefaults?.researcher
  );
  return {
    researcherResolved,
    enabled: researcherResolved,
    effectivePolicy: researcherResolved
      ? args.researchApprovalPolicy
      : "none",
  };
}

/** Pure execute-mode control state for the kickoff modal. */
export type LoopModeControlState = {
  enabled: boolean;
  disabledReason: string | null;
  effectiveLoopMode: ImplementFullyLoopMode;
};

/**
 * Decide whether execute mode is available and what loop mode the kickoff
 * payload should carry. Execute requires full upfront planning (not Quick/JIT).
 */
export function describeLoopModeControlState(args: {
  profileId: ImplementFullyPlanningProfileId | string;
  execute: boolean;
}): LoopModeControlState {
  const { planningDepth } = resolvePlanningControls(args.profileId);
  if (planningDepth === "jit") {
    return {
      enabled: false,
      disabledReason:
        "Execute mode requires full upfront planning — choose Deep or Guided.",
      effectiveLoopMode: "normal",
    };
  }
  return {
    enabled: true,
    disabledReason: null,
    effectiveLoopMode: args.execute ? "execute" : "normal",
  };
}

/** Derive effective entry, research, and gatekeeper facts for review surfaces. */
export function describeKickoffReviewFacts(args: {
  introspection: PipelineIntrospectionResponse;
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>;
  researchApprovalPolicy?: ImplementFullyResearchApprovalPolicy;
}): KickoffReviewFacts {
  const { entryWorkerKey, rootRole } = resolveEntryWorkerKey(
    args.roleModels,
    args.introspection.roleContract,
    args.introspection.entryWorkerKey
  );
  const researchApprovalPolicy = resolveResearchApprovalPolicy(
    args.researchApprovalPolicy,
    args.roleModels
  );
  const gate = resolveGatekeeperSelection(
    args.roleModels,
    args.introspection.roleContract
  );
  const architect = resolveArchitectSelection(
    args.roleModels,
    args.introspection.roleContract
  );
  return {
    entryWorkerKey,
    rootRole,
    researcher: args.roleModels.researcher ?? null,
    researchApprovalPolicy,
    architect: architect.selection,
    architectSource: architect.source,
    gatekeeper: gate.selection,
    gatekeeperSource: gate.source,
  };
}

/** Assemble the kickoff payload the same way the modal does (for tests + UI). */
export function assembleKickoffPayload(args: {
  introspection: PipelineIntrospectionResponse;
  plan: ProvisionPipelineWorkersResponse;
  feature: string;
  slug: string;
  idea: string;
  roleOverrides: Partial<Record<PipelineModelRole, RoleModelOverride>>;
  profileId?: ImplementFullyPlanningProfileId | string;
  roleProfileId?: string;
  researchApprovalPolicy?: ImplementFullyResearchApprovalPolicy;
  loopMode?: ImplementFullyLoopMode;
}): TriggerRunRequest {
  validateFeatureSlugIdea(args.feature, args.slug, args.idea);
  const variables = buildKickoffVariables(
    args.feature,
    args.slug,
    args.idea.trim(),
    args.profileId ?? DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
    args.researchApprovalPolicy ?? "none",
    args.loopMode ?? "normal"
  );
  assertVariablesMatchRequired(
    variables,
    args.introspection.requiredVariables
  );
  const requiredRoles = args.introspection.roleContract.required;
  const base = resolveRoleModelProfileDefaults(
    args.roleProfileId,
    args.introspection
  );
  const recipe = resolveRoleRecipe(requiredRoles, args.roleOverrides, base);
  const { entryWorkerKey, rootRole } = resolveEntryWorkerKey(
    recipe.roleModels,
    args.introspection.roleContract,
    args.introspection.entryWorkerKey
  );
  const entryWorker = args.introspection.workers.find(
    (w) => w.key === entryWorkerKey
  );
  if (!entryWorker) {
    throw new KickoffError(`Entry worker "${entryWorkerKey}" missing.`);
  }
  const entryPlanItem = args.plan.plan.items.find(
    (i) => i.key === entryWorkerKey
  );
  if (!entryPlanItem) {
    throw new KickoffError(`Plan missing entry worker "${entryWorkerKey}".`);
  }
  resolveResearchApprovalPolicy(
    args.researchApprovalPolicy ?? variables.researchApprovalPolicy,
    recipe.roleModels
  );
  const modelSelection =
    entryWorkerKey === IMPLEMENT_FULLY_ENTRY_WORKER_KEY
      ? resolveArchitectSelection(
          recipe.roleModels,
          args.introspection.roleContract
        ).selection
      : recipe.roleModels[rootRole];
  if (!modelSelection) {
    throw new KickoffError(
      `No resolved selection for entry role "${rootRole}".`
    );
  }
  return {
    automationId: entryPlanItem.automationId,
    variables,
    roleModels: recipe.roleModels,
    maxDepth: 1,
    modelSelection,
  };
}
