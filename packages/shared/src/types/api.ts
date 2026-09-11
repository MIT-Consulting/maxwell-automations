import type {
  Automation,
  ChatEvent,
  ChatSession,
  ChatStatus,
  InputRequest,
  InputRequestMetadata,
  Run,
  RunEvent,
  Workspace,
} from "./entities.js";
import type { ChainConfig, ChainVariables } from "./config.js";
import type {
  ModelConfigValue,
  ModelParameterValue,
  ModelSelection,
} from "../model.js";
import type { TriggerConfig } from "./triggers.js";

export type HealthResponse = {
  ok: true;
  version: string;
};

/** Runtime status of the listening daemon (settings as applied at boot). */
export type DaemonStatus = {
  ok: true;
  version: string;
  pid: number;
  port: number;
  host: string;
  /** Addresses the daemon is listening on — loopback plus any configured bind host. */
  bindAddresses: readonly string[];
  allowedIps: readonly string[];
  /** Whether the control-token app-auth layer is active (token configured). */
  remoteAuth: boolean;
  mode: "dev" | "prod";
  startedAt: string;
  uptimeMs: number;
};

export type ListAutomationsResponse = {
  automations: Automation[];
};

export type ListRunsResponse = {
  runs: Run[];
};

export type ListWorkspacesResponse = {
  workspaces: Workspace[];
};

export type ModelParameterAllowedValue = {
  value: string;
  displayName?: string;
};

/** Catalog parameter definition (SDK-independent mirror of ModelParameterDefinition). */
export type ModelParameterDefinition = {
  id: string;
  displayName?: string;
  values: ModelParameterAllowedValue[];
};

/** Preset variant from the account catalog. */
export type ModelVariant = {
  params: ModelParameterValue[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
};

export type ModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  aliases?: string[];
  parameters?: ModelParameterDefinition[];
  variants?: ModelVariant[];
};

export type ListModelsResponse = {
  models: ModelInfo[];
  /** Effective fallback when an automation has no model override. */
  defaultModel: string;
  /** Present when the model catalog could not be fetched; models may be empty. */
  warning?: string;
};

export type WorkspaceArtifactKind = "rule" | "skill";

export type WorkspaceArtifactSource = "project" | "user";

export type WorkspaceArtifact = {
  kind: WorkspaceArtifactKind;
  source: WorkspaceArtifactSource;
  name: string;
  path: string;
  relativePath: string;
  description?: string;
  alwaysApply?: boolean;
  globs?: string[];
  keywords?: string[];
};

export type ListWorkspaceArtifactsResponse = {
  artifacts: WorkspaceArtifact[];
};

export type WorkspaceFileEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number | null; // null for dir/symlink
  mtime: string | null; // ISO 8601, null if stat fails
};

export type ListWorkspaceFilesResponse = {
  dir: string; // normalized relative dir, "" = root
  entries: WorkspaceFileEntry[]; // dirs first, then files, each A→Z
  truncated: boolean; // entry cap hit
};

export type WorkspaceFileContentResponse = {
  path: string; // normalized relative path
  size: number; // true size on disk
  mtime: string; // ISO 8601
  encoding: "utf8" | "binary";
  content: string | null; // null when binary
  truncated: boolean; // text cut at maxFileViewerBytes
};

export type GetRunResponse = {
  run: Run;
  events: RunEvent[];
  inputRequests: InputRequest[];
};

export type TriggerRunRequest = {
  automationId: string;
  /** Pipeline template variables (root kickoff). */
  variables?: ChainVariables;
  /** Concrete model-role selections for the pipeline (root kickoff). */
  roleModels?: Record<string, ModelSelection>;
  /** Max chain transitions for this pipeline (1..500); required with context. */
  maxDepth?: number;
  /** Optional legacy root model id override. */
  model?: string;
  /** Optional canonical root model override. */
  modelSelection?: ModelSelection;
};

export type TriggerRunResponse = {
  runId: string;
};

export type SetAutomationEnabledRequest = {
  enabled: boolean;
};

export type CreateWorkspaceRequest = {
  path: string;
  name?: string;
};

export type PickFolderResponse = {
  supported: boolean;
  path: string | null;
};

export type CreateAutomationRequest = {
  workspaceId: string;
  name: string;
  trigger: TriggerConfig;
  prompt: string;
  model?: string;
  modelSelection?: ModelSelection;
  /** Optional role key for chain spawn model resolution. */
  modelRole?: string;
  enabled?: boolean;
  chain?: ChainConfig;
};

export type UpdateAutomationRequest = {
  name?: string;
  trigger?: TriggerConfig;
  prompt?: string;
  model?: string | null;
  modelSelection?: ModelSelection | null;
  /** Set a role key, or `null` to clear. */
  modelRole?: string | null;
  enabled?: boolean;
  chain?: ChainConfig | null;
};

/** Desired-state item for POST /api/generated-workers. */
export type GeneratedWorkerSpec = {
  /** Slug only. The reserved config key is `generated:${key}`. */
  key: string;
  name: string;
  prompt: string;
  trigger: TriggerConfig;
  enabled?: boolean;
  model?: ModelConfigValue | null;
  modelRole?: string | null;
  chain?: ChainConfig | null;
};

export type GeneratedWorkerAction =
  | "create"
  | "update"
  | "unchanged"
  | "revive"
  | "archive"
  | "conflict";

export type GeneratedWorkerPlanItem = {
  key: string;
  configKey: string;
  automationId: string;
  action: GeneratedWorkerAction;
  /** Changed column names for `update`; the blocking reason for `conflict`. */
  detail?: string[];
};

export type GeneratedWorkerPlan = {
  workspaceId: string;
  dryRun: boolean;
  applied: boolean;
  items: GeneratedWorkerPlanItem[];
};

/** POST /api/generated-workers — idempotent provision of generated workers. */
export type ProvisionGeneratedWorkersRequest = {
  workspaceId?: string;
  workspacePath?: string;
  workers: GeneratedWorkerSpec[];
  dryRun?: boolean;
  prune?: boolean;
};

/** Canonical pipeline id for `/implement-fully`. Use this constant — never a string literal. */
export const IMPLEMENT_FULLY_PIPELINE_ID = "implement-fully";

/**
 * Model-role keys for the implement-fully pipeline.
 * `planner` covers plan-skeleton and plan-phase; `reviewer` is the opposite smart model.
 */
export const PIPELINE_MODEL_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "docs",
  "researcher",
  "gatekeeper",
  "architect",
] as const;

export type PipelineModelRole = (typeof PIPELINE_MODEL_ROLES)[number];

/** Roles every implement-fully kickoff must resolve. */
export const PIPELINE_REQUIRED_MODEL_ROLES = [
  "planner",
  "implementer",
  "reviewer",
  "docs",
] as const satisfies readonly PipelineModelRole[];

export type PipelineRequiredModelRole =
  (typeof PIPELINE_REQUIRED_MODEL_ROLES)[number];

/** Optional roles that alter pipeline entry or terminal ownership when configured. */
export const PIPELINE_OPTIONAL_MODEL_ROLES = [
  "researcher",
  "gatekeeper",
  "architect",
] as const satisfies readonly PipelineModelRole[];

export type PipelineOptionalModelRole =
  (typeof PIPELINE_OPTIONAL_MODEL_ROLES)[number];

/** Synthetic profile id for `settings.pipelineRoleModels` in the introspection catalog. */
export const DEFAULT_ROLE_MODEL_PROFILE_ID = "default";

/** Named role-model recipe exposed on pipeline introspection. */
export type PipelineRoleModelProfile = {
  id: string;
  label: string;
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>;
};

/** Namespace prefix for provisioned pipeline worker `config_key` values. */
export const GENERATED_CONFIG_KEY_PREFIX = "generated:";

/** Entry worker for the implement-fully pipeline. Kickoff always targets this key. */
export const IMPLEMENT_FULLY_ENTRY_WORKER_KEY = "plan-skeleton";

/**
 * Retained legacy worker key — still registered and typed for in-flight pipelines
 * and the `docs` model role; unreachable from the entry worker once review owns
 * phase closeout (b57 Phase 2).
 */
export const IMPLEMENT_FULLY_LEGACY_DOCS_WORKER_KEY = "docs-commit";

/**
 * Loop worker keys in execution order (after the entry worker).
 * Length is the cycle divisor for step/cycle derivation only; the transition
 * budget is an independent ceiling with headroom (`IMPLEMENT_FULLY_BUDGET_FORMULA`).
 */
export const IMPLEMENT_FULLY_LOOP_WORKER_KEYS = [
  "plan-phase",
  "implement",
  "review",
] as const;

export type ImplementFullyLoopWorkerKey =
  (typeof IMPLEMENT_FULLY_LOOP_WORKER_KEYS)[number];

/**
 * Required kickoff variables for implement-fully.
 * All ten must arrive whole — `renderChainTemplate` does not compute or concatenate.
 * No phase-scoped name: chain context is immutable, so the current phase lives in the
 * feature tracker, not in variables.
 * `planningDepth` / `approvalPolicy` / `researchApprovalPolicy` are durable controls;
 * profile ids are kickoff-only.
 */
export const IMPLEMENT_FULLY_VARIABLES = [
  "pipelineId",
  "featureId",
  "featureSlug",
  "featureDir",
  "featureIndex",
  "idea",
  "planningDepth",
  "approvalPolicy",
  "researchApprovalPolicy",
  "loopMode",
] as const;

export type ImplementFullyVariable =
  (typeof IMPLEMENT_FULLY_VARIABLES)[number];

/** Kickoff presentation ids — not persisted on the chain. */
export const IMPLEMENT_FULLY_PLANNING_PROFILE_IDS = [
  "quick",
  "deep",
  "guided",
] as const;

export type ImplementFullyPlanningProfileId =
  (typeof IMPLEMENT_FULLY_PLANNING_PROFILE_IDS)[number];

/** Durable planning-depth control persisted on implement-fully chains. */
export const IMPLEMENT_FULLY_PLANNING_DEPTHS = ["jit", "full"] as const;

export type ImplementFullyPlanningDepth =
  (typeof IMPLEMENT_FULLY_PLANNING_DEPTHS)[number];

/** Durable approval-policy control persisted on implement-fully chains. */
export const IMPLEMENT_FULLY_APPROVAL_POLICIES = [
  "none",
  "before-implementation",
] as const;

export type ImplementFullyApprovalPolicy =
  (typeof IMPLEMENT_FULLY_APPROVAL_POLICIES)[number];

/** Optional operator checkpoint after durable research and before planning. */
export const IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES = [
  "none",
  "before-planning",
] as const;

export type ImplementFullyResearchApprovalPolicy =
  (typeof IMPLEMENT_FULLY_RESEARCH_APPROVAL_POLICIES)[number];

/** Durable loop-mode control persisted on implement-fully chains. */
export const IMPLEMENT_FULLY_LOOP_MODES = ["normal", "execute"] as const;

export type ImplementFullyLoopMode =
  (typeof IMPLEMENT_FULLY_LOOP_MODES)[number];

/** Canonical profile catalog entry shared by CLI, dashboard, and introspection. */
export type ImplementFullyPlanningProfile = {
  id: ImplementFullyPlanningProfileId;
  label: string;
  description: string;
  planningDepth: ImplementFullyPlanningDepth;
  approvalPolicy: ImplementFullyApprovalPolicy;
};

/**
 * Single authoritative planning-profile table.
 * Callers must not redefine labels, descriptions, or control mappings.
 */
export const IMPLEMENT_FULLY_PLANNING_PROFILES: readonly ImplementFullyPlanningProfile[] =
  [
    {
      id: "quick",
      label: "Quick/JIT",
      description:
        "Shallow skeleton now; detailed planning happens immediately before each phase.",
      planningDepth: "jit",
      approvalPolicy: "none",
    },
    {
      id: "deep",
      label: "Deep",
      description:
        "Full upfront planning for every phase, then continue into implementation automatically.",
      planningDepth: "full",
      approvalPolicy: "none",
    },
    {
      id: "guided",
      label: "Guided",
      description:
        "Full upfront planning, then pause for operator approval before implementation.",
      planningDepth: "full",
      approvalPolicy: "before-implementation",
    },
  ] as const;

/** Default when kickoff omits `--profile` / selector — preserves legacy Quick/JIT. */
export const DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID: ImplementFullyPlanningProfileId =
  "quick";

/** Human-readable transition-budget formula: `6 × phaseCount + 1`. */
export const IMPLEMENT_FULLY_BUDGET_FORMULA = "6 × phaseCount + 1";

/** Execute-mode transition-budget formula: `3 × phaseCount + 2`. */
export const IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA = "3 × phaseCount + 2";

/**
 * Integration worker for parallel waves. Not part of
 * `IMPLEMENT_FULLY_LOOP_WORKER_KEYS` — sequential cycle arithmetic stays
 * backward compatible.
 */
export const IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY = "integrate-wave";

/**
 * Feature-end gate worker. Terminal (no chain edge) and outside
 * `IMPLEMENT_FULLY_LOOP_WORKER_KEYS`, so sequential cycle arithmetic is unchanged.
 */
export const IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY = "final-gate";

/**
 * Conditional root worker for optional researcher-led prelude. Off-cycle and
 * outside `IMPLEMENT_FULLY_LOOP_WORKER_KEYS`. Does not change
 * `IMPLEMENT_FULLY_ENTRY_WORKER_KEY` (still `plan-skeleton`); kickoff selects
 * this key only when a researcher model is present.
 */
export const IMPLEMENT_FULLY_RESEARCH_WORKER_KEY = "research";

/** Wave lifecycle statuses (durable `pipeline_waves.status`). */
export const PIPELINE_WAVE_STATUSES = [
  "provisioning",
  "running",
  "integrating",
  "blocked",
  "completed",
  "aborted",
] as const;

export type PipelineWaveStatus = (typeof PIPELINE_WAVE_STATUSES)[number];

/** Track lifecycle statuses (durable `pipeline_tracks.status`). */
export const PIPELINE_TRACK_STATUSES = [
  "provisioning",
  "running",
  "completed",
  "integrated",
  "blocked",
  "aborted",
] as const;

export type PipelineTrackStatus = (typeof PIPELINE_TRACK_STATUSES)[number];

/** Bounded fan-out candidate submitted by a coordinator plan-phase. */
export type PipelineWaveCandidate = {
  /** Trimmed phase ref (tracker phase number / id), ≤ 64 chars. */
  phaseRef: string;
  /** Forward-slash relative markdown path under `featureDir`. */
  phaseFile: string;
};

/** Run-token-gated wave control actions (POST /api/runs/:id/pipeline-wave). */
export type PipelineWaveControlRequest =
  | { action: "fan-out"; candidates: PipelineWaveCandidate[] }
  | { action: "finalize" }
  | { action: "block"; reason: string };

/** Stable reason codes for fan-out sequential fallback or refusal. */
export type PipelineWaveFanOutReason =
  | "parallel"
  | "insufficient-candidates"
  | "max-concurrent-one"
  | "dirty-checkout"
  | "detached-head"
  | "unborn-head"
  | "missing-git"
  | "invalid-worktree-state"
  | "preflight-failed"
  | "not-coordinator"
  | "not-pipeline"
  | "terminal"
  | "already-tracked"
  | "forbidden"
  | "not-found";

/** Response from a fan-out attempt — IDs only; never paths/branches/idea. */
export type PipelineWaveFanOutResponse = {
  outcome: "parallel" | "sequential-fallback";
  reason: PipelineWaveFanOutReason;
  waveId: string | null;
  accepted: PipelineWaveCandidate[];
  deferred: PipelineWaveCandidate[];
};

/** Response from finalize / block actions. */
export type PipelineWaveControlResponse =
  | PipelineWaveFanOutResponse
  | {
      action: "finalize" | "block";
      waveId: string;
      status: PipelineWaveStatus;
    };

/** Operator actions on a blocked wave (POST /api/pipeline-waves/:id/actions). */
export const PIPELINE_WAVE_OPERATOR_ACTIONS = [
  "retry-integration",
  "abort",
] as const;

export type PipelineWaveOperatorAction =
  (typeof PIPELINE_WAVE_OPERATOR_ACTIONS)[number];

export type PipelineWaveOperatorRequest = {
  action: PipelineWaveOperatorAction;
  reason?: string;
};

export type PipelineWaveOperatorRefusal =
  | "not-found"
  | "not-blocked"
  | "tracks-incomplete"
  | "dirty-checkout"
  | "integration-active"
  | "already-aborted"
  | "not-eligible";

export type PipelineWaveOperatorResponse = {
  action: PipelineWaveOperatorAction;
  waveId: string;
  status: PipelineWaveStatus;
  /** New integration run for retry; null for abort. */
  integrationRunId: string | null;
  /** Retained worktree/branch resources after abort (diagnostic only). */
  retained?: Array<{ branch: string; worktreePath: string; reason: string }>;
};


/** Per-worker summary for GET /api/pipelines/:id — no prompt text. */
export type PipelineWorkerSummary = {
  key: string;
  name: string;
  modelRole: PipelineModelRole;
  /** Null for terminal workers (no successor), e.g. `final-gate`. */
  chain: ChainConfig | null;
};

/** Workspace filesystem checks for dashboard kickoff (optional query). */
export type PipelineWorkspacePreconditions = {
  workspaceId: string;
  gitRepo: boolean;
  roadmapIndex: boolean;
};

/**
 * POST /api/pipelines/implement-fully/resolve — resolve kickoff inputs from
 * roadmap metadata. Does not provision workers or create runs.
 */
export type ResolveImplementFullyKickoffRequest = {
  workspaceId: string;
  input:
    | { kind: "feature-id"; featureId: string }
    | { kind: "idea"; idea: string };
};

/** Canonical triple returned by implement-fully input resolution. */
export type ResolveImplementFullyKickoffResponse = {
  featureId: string;
  featureSlug: string;
  idea: string;
};

/** GET /api/pipelines/:id — pipeline shape without shipping prompts. */
export type PipelineIntrospectionResponse = {
  pipelineId: string;
  entryWorkerKey: string;
  /** Reserved config key for the entry worker (`generated:` + entryWorkerKey). */
  entryWorkerConfigKey: string;
  roleContract: {
    required: readonly PipelineModelRole[];
    optional: readonly PipelineModelRole[];
    /** Optional role whose presence selects a different entry worker. */
    conditionalEntryRole: PipelineModelRole;
    /** Entry worker used when conditionalEntryRole resolves. */
    conditionalEntryWorkerKey: string;
    /** Optional role that falls back to another role at runtime. */
    fallbackRole: PipelineModelRole;
    fallbackToRole: PipelineModelRole;
    /** Optional role that owns plan-skeleton when set; falls back at spawn. */
    skeletonFallbackRole: PipelineModelRole;
    skeletonFallbackToRole: PipelineModelRole;
  };
  requiredVariables: readonly ImplementFullyVariable[];
  requiredSkills: string[];
  budgetFormula: string;
  /** Execute-mode budget formula when `loopMode` is `execute`. */
  executeBudgetFormula: string;
  workers: PipelineWorkerSummary[];
  /**
   * Active default role recipe for kickoff — the `roleModels` map for
   * `defaultRoleModelProfileId`. Synthetic id `default` mirrors
   * `settings.pipelineRoleModels`; named entries come from
   * `settings.pipelineRoleModelProfiles`. Always present; `{}` when the active
   * profile defines no roles. Kickoff still must send the roles it wants — an
   * absent role here is the caller's problem to fill before POSTing `/api/runs`.
   */
  roleDefaults: Partial<Record<PipelineModelRole, ModelSelection>>;
  /**
   * Named role-model profiles (always includes synthetic `default`) plus any
   * entries from `settings.pipelineRoleModelProfiles`. Fresh JSON-safe copies.
   */
  roleModelProfiles: readonly PipelineRoleModelProfile[];
  /** Default profile id when kickoff omits `--role-profile` / dashboard selection. */
  defaultRoleModelProfileId: string;
  /**
   * Supported planning profiles from the shared catalog (no prompt text).
   * Fresh JSON-safe copies — callers must not mutate daemon state through these.
   */
  planningProfiles: readonly ImplementFullyPlanningProfile[];
  /** Canonical default profile id when kickoff omits a selection. */
  defaultPlanningProfileId: ImplementFullyPlanningProfileId;
  /**
   * Present only when `?workspaceId=` is supplied and resolves. Omitted when
   * the query param is absent so existing callers see a byte-identical body.
   */
  preconditions?: PipelineWorkspacePreconditions;
};

/**
 * POST /api/pipelines/:id/workers — provision a known pipeline's workers.
 * No `workers` field: the daemon owns the catalog.
 */
export type ProvisionPipelineWorkersRequest = {
  workspaceId?: string;
  workspacePath?: string;
  dryRun?: boolean;
  prune?: boolean;
};

/** Response from POST /api/pipelines/:id/workers. */
export type ProvisionPipelineWorkersResponse = {
  pipelineId: string;
  plan: GeneratedWorkerPlan;
  missingSkills: string[];
};

/** Evidence for a monotonic additive budget extension. */
export type ChainBudgetExtensionEvidence = {
  previousEffectiveMaxDepth: number;
  requestedTransitions: number;
  appliedTransitions: number;
  clamped: boolean;
};

/**
 * POST /api/runs/:id/chain-control — stop and/or re-budget a non-terminal run.
 * Absolute `rebudget` and additive `extendBudget` are mutually exclusive.
 */
export type ChainControlRequest = {
  stop?: { reason: string };
  rebudget?: { maxDepth: number };
  /** Monotonic growth by N transitions from the current effective ceiling. */
  extendBudget?: { transitions: number };
};

/** Post-state after a successful chain-control decision. */
export type ChainControlResponse = {
  runId: string;
  depth: number | null;
  /** Budget descendants of this run will inherit: override when set, else the original. */
  effectiveMaxDepth: number | null;
  maxDepth: number | null;
  maxDepthOverride: number | null;
  stopRequested: boolean;
  stopReason: string | null;
  /** Present when the request included `extendBudget` (including identical no-ops). */
  budgetExtension?: ChainBudgetExtensionEvidence;
};

/** Operator escalation actions for a halted pipeline run. */
export const RUN_ESCALATION_ACTIONS = ["retry", "skip", "abort"] as const;

export type RunEscalationAction = (typeof RUN_ESCALATION_ACTIONS)[number];

/** Machine-readable refusals from POST /api/runs/:id/escalate. */
export type RunEscalationRefusal =
  | "not-found"
  | "not-pipeline"
  | "not-halted"
  | "already-chained"
  | "root-run"
  | "no-successor"
  | "budget-exhausted";

/**
 * Auto-recovery actions for a post-terminal pipeline halt (b43).
 * Includes `none` for declines; does not widen `RunEscalationAction`.
 */
export const PIPELINE_HALT_RECOVERY_ACTIONS = ["retry", "skip", "none"] as const;

export type PipelineHaltRecoveryAction =
  (typeof PIPELINE_HALT_RECOVERY_ACTIONS)[number];

/** Native decline codes owned by halt recovery (not operator escalation refusals). */
export const PIPELINE_HALT_RECOVERY_NATIVE_DECLINE_CODES = [
  "disabled",
  "not-safe-class",
  "wave-scoped",
  "budget-spent",
  "ladder-exhausted",
] as const;

export type PipelineHaltRecoveryNativeDeclineCode =
  (typeof PIPELINE_HALT_RECOVERY_NATIVE_DECLINE_CODES)[number];

/** No-action codes: native declines plus existing escalation refusals. */
export type PipelineHaltRecoveryDeclineCode =
  | PipelineHaltRecoveryNativeDeclineCode
  | RunEscalationRefusal;

/**
 * Discriminated decision from the pure halt-recovery classifier.
 * `retry`/`skip` only pair with `safe-class`; `none` only pairs with a decline.
 */
export type PipelineHaltRecoveryDecision =
  | {
      action: "retry" | "skip";
      code: "safe-class";
      detail: string;
    }
  | {
      action: "none";
      code: PipelineHaltRecoveryDeclineCode;
      detail: string;
      /**
       * Observed halt or failure reason when `code` is `not-safe-class`.
       * Diagnostic only — not part of the safe-reason allowlist.
       */
      observedReason?: string;
    };

/**
 * Halt-discovery lifecycle events (b44). Append-only on the halted source run.
 * Phase 1 emits requested/skipped; failed is a stable envelope for later phases.
 */
export const PIPELINE_HALT_DISCOVERY_EVENT_TYPES = [
  "run.pipeline-halt-discovery-requested",
  "run.pipeline-halt-discovery-skipped",
  "run.pipeline-halt-discovery-failed",
  "run.pipeline-halt-discovery-action-result",
  "run.pipeline-halt-discovery-promoted",
] as const;

export type PipelineHaltDiscoveryEventType =
  (typeof PIPELINE_HALT_DISCOVERY_EVENT_TYPES)[number];

/** Reason-coded skip outcomes for the discovery trigger. */
export const PIPELINE_HALT_DISCOVERY_SKIP_CODES = [
  "disabled",
  "wave-scoped",
  "source-resolved",
  "ineligible-source",
  "invalid-trigger",
] as const;

export type PipelineHaltDiscoverySkipCode =
  (typeof PIPELINE_HALT_DISCOVERY_SKIP_CODES)[number];

/** Failure stages for discovery worker / briefing (later phases). */
export const PIPELINE_HALT_DISCOVERY_FAILURE_STAGES = [
  "spawn",
  "diagnosis",
  "briefing",
] as const;

export type PipelineHaltDiscoveryFailureStage =
  (typeof PIPELINE_HALT_DISCOVERY_FAILURE_STAGES)[number];

/** Outbox payload when discovery is requested for an unrecovered halt. */
export type PipelineHaltDiscoveryRequestedPayload = {
  code: "unrecovered-halt";
  recoveryCode: PipelineHaltRecoveryDeclineCode;
  recoveryDetail: string;
  observedReason?: string;
};

/** Durable skip payload; operator-safe detail. */
export type PipelineHaltDiscoverySkippedPayload = {
  code: PipelineHaltDiscoverySkipCode;
  detail: string;
};

/**
 * Durable failure envelope. Stage-specific `code` literals are owned by later
 * phases; keep `code` open as string here.
 */
export type PipelineHaltDiscoveryFailedPayload = {
  stage: PipelineHaltDiscoveryFailureStage;
  code: string;
  detail: string;
  advisoryRunId?: string;
};

/** Outcomes for an operator answer mapped to source escalation (b44.12). */
export const PIPELINE_HALT_DISCOVERY_ACTION_OUTCOMES = [
  "acted",
  "refused",
  "internal-failure",
] as const;

export type PipelineHaltDiscoveryActionOutcome =
  (typeof PIPELINE_HALT_DISCOVERY_ACTION_OUTCOMES)[number];

/**
 * Durable advisory-side result after the operator answers a halt-discovery
 * briefing. Source claim/escalation remains authoritative; this event is
 * advisory visibility only.
 */
export type PipelineHaltDiscoveryActionResultPayload = {
  sourceRunId: string;
  advisoryRunId: string;
  action: RunEscalationAction;
  outcome: PipelineHaltDiscoveryActionOutcome;
  /** Refusal or stable internal-failure code when unsuccessful. */
  code?: string;
  /** Child run from a successful retry/skip; omitted otherwise. */
  childRunId?: string;
  /** Optional operator-safe detail; never stack traces or packet text. */
  detail?: string;
};

/**
 * Durable advisory-side record after promoting a halt-discovery briefing into
 * a workspace chat. Separate from escalation action results.
 */
export type PipelineHaltDiscoveryPromotedPayload = {
  sourceRunId: string;
  advisoryRunId: string;
  chatId: string;
};

/** Payload for `chat.promoted_from_run`; halt-discovery may set sourceRunId. */
export type ChatPromotedFromRunPayload = {
  originRunId: string;
  /** Halted source run when promoting a halt-discovery advisory. */
  sourceRunId?: string;
};

/** POST /api/runs/:id/escalate — operator retry / skip / abort. */
export type RunEscalationRequest = {
  action: RunEscalationAction;
  reason?: string;
};

/** Post-state after a successful escalation. */
export type RunEscalationResponse = {
  action: RunEscalationAction;
  runId: string;
  /** New run created by retry or skip; null for abort. */
  childRunId: string | null;
  /** Recorded stop reason; non-null only for abort. */
  stopReason: string | null;
};

export type WorkspaceMutationResponse = {
  workspace: Workspace;
};

export type AutomationMutationResponse = {
  automation: Automation;
};

export type DeleteAutomationResponse = {
  ok: true;
};

export type AnswerInputRequest = {
  answer: string;
};

export type AnswerInputResponse = {
  ok: true;
};

/** POST /api/runs/:id/ask — agent-created blocking question. */
export type AskInputRequest = {
  question: string;
  metadata?: InputRequestMetadata;
};

export type AskInputResponse = {
  answer: string;
};

export type AttachmentOwnerKind = "run" | "chat";
export type AttachmentKind = "image" | "file";

export type Attachment = {
  id: string;
  ownerKind: AttachmentOwnerKind;
  ownerId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  kind: AttachmentKind;
  createdAt: string;
};

/** Lightweight ref for message payloads and transcript chips. */
export type AttachmentRef = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: AttachmentKind;
};

export type UploadAttachmentRequest = {
  filename: string;
  mimeType: string;
  contentBase64: string;
};

export type UploadAttachmentResponse = {
  ok: true;
  attachment: Attachment;
};

export type SendRunMessageRequest = {
  message: string;
  attachments?: AttachmentRef[];
};
export type SendRunMessageResponse = { ok: true };

export type QueueRunMessageRequest = {
  message: string;
  attachments?: AttachmentRef[];
};
export type QueueRunMessageResponse = { ok: true; queuedMessageId?: string };
export type InterruptRunRequest = {
  message: string;
  attachments?: AttachmentRef[];
};
export type InterruptRunResponse = { ok: true };

export type PauseRunResponse = { ok: true };
export type ResumeRunRequest = { note?: string };
export type ResumeRunResponse = { ok: true };

export type DeleteRunsRequest = {
  runIds: string[];
};

export type DeleteRunsResponse = {
  deleted: number;
  runIds: string[];
};

export type ChatSnapshot = {
  session: ChatSession;
  events: ChatEvent[];
};

export type ListChatsResponse = { chats: ChatSession[] };
export type CreateChatRequest = {
  title?: string;
  model?: string;
  modelSelection?: ModelSelection;
};
export type ChatMutationResponse = { chat: ChatSession };

export type SendChatMessageRequest = {
  message: string;
  attachments?: AttachmentRef[];
};
export type SendChatMessageResponse = { ok: true };
export type QueueChatMessageRequest = {
  message: string;
  attachments?: AttachmentRef[];
};
export type QueueChatMessageResponse = { ok: true; queuedMessageId?: string };
export type InterruptChatRequest = {
  message: string;
  attachments?: AttachmentRef[];
};
export type InterruptChatResponse = { ok: true };
export type AnswerChatRequest = { answer: string };
export type AnswerChatResponse = { ok: true };
export type SteerChatRequest = {
  message: string;
  runId?: string;
};
export type SteerChatResponse = {
  ok: true;
  runId: string;
  queuedMessageId?: string;
};
export type UpdateChatRequest = {
  title?: string;
  archived?: boolean;
  model?: string | null;
  modelSelection?: ModelSelection | null;
  attachedRunId?: string | null;
};
export type DeleteChatResponse = { ok: true };

export type UpdateRunRequest = {
  model?: string | null;
  modelSelection?: ModelSelection | null;
};
export type UpdateRunResponse = { run: Run };

export type WsServerMessage =
  | { type: "run_event"; runId: string; event: RunEvent }
  | { type: "run_status"; runId: string; status: Run["status"] }
  | { type: "input_request"; runId: string; request: InputRequest }
  | {
      type: "automation_event";
      action: "created" | "updated" | "deleted";
      id: string;
      automation?: Automation;
    }
  | { type: "runs_deleted"; runIds: string[] }
  | { type: "chat_event"; chatId: string; event: ChatEvent }
  | { type: "chat_status"; chatId: string; status: ChatStatus }
  | { type: "chat_input_request"; chatId: string; request: InputRequest }
  | { type: "chat_session"; chatId: string; session: ChatSession }
  | { type: "chats_deleted"; chatIds: string[] };
