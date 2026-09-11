import type { ChainConfig, ChainRunContext } from "./config.js";
import type { ModelSelection } from "../model.js";
import type { RunPipelineSummary } from "../pipeline-run.js";
import type {
  RunPipelineTrackSummary,
  RunPipelineWaveSummary,
} from "../pipeline-wave.js";
import type { TriggerConfig } from "./triggers.js";

export type Workspace = {
  id: string;
  path: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AutomationStatus = "backlog" | "enabled";

export type AutomationOrigin = "config" | "dashboard" | "generated";

export type Automation = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  status: AutomationStatus;
  origin: AutomationOrigin;
  trigger: TriggerConfig;
  prompt: string;
  model: string | null;
  /** Canonical structured selection; null until persisted (Phase 2). */
  modelSelection: ModelSelection | null;
  /** Optional role key resolved against pipeline `roleModels` at chain spawn. */
  modelRole?: string;
  chain: ChainConfig | null;
  configPath: string;
  configKey: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Next scheduled fire time (ISO) for an enabled cron automation, computed by
   * the daemon. Absent for non-cron triggers, disabled automations, or invalid
   * expressions.
   */
  nextRunAt?: string | null;
};

export type RunStatus =
  | "queued"
  | "running"
  | "needs_input"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type Run = {
  id: string;
  automationId: string;
  workspaceId: string;
  status: RunStatus;
  agentId: string | null;
  sdkRunId: string | null;
  triggerKind: string | null;
  parentRunId: string | null;
  /** Agent-generated short title; null until post-settlement naming succeeds. */
  title: string | null;
  /** Agent-generated outcome summary; null until post-settlement naming succeeds. */
  summary: string | null;
  /** Per-run model override; null = use automation model. */
  model: string | null;
  /** Canonical structured selection; null until persisted (Phase 2). */
  modelSelection: ModelSelection | null;
  /** Root run id for a context-aware pipeline; null for legacy chains. */
  chainRootRunId?: string | null;
  /** Transition depth from root (root = 0); null for legacy chains. */
  chainDepth?: number | null;
  /** Max transitions for this pipeline; null for legacy chains. */
  chainMaxDepth?: number | null;
  /**
   * Immutable pipeline context snapshot. Omitted from the list/board read surface
   * permanently (idea + roleModels are too large for the poll payload); available on
   * the per-run detail snapshot.
   */
  chainContext?: ChainRunContext | null;
  /**
   * Board-safe pipeline identity parsed from chain context.
   * `{ pipelineId, featureId, featureSlug }` — never includes idea or roleModels.
   */
  pipeline?: RunPipelineSummary | null;
  /** When set, this run will not enqueue a chain successor. */
  chainStopRequestedAt?: string | null;
  /** Operator/agent reason recorded with the stop decision. */
  chainStopReason?: string | null;
  /** Replaces `chainMaxDepth` for this run and its descendants when set. */
  chainMaxDepthOverride?: number | null;
  /** Claim timestamp for the one-shot chain transition; null until claimed. */
  chainHandledAt?: string | null;
  /**
   * Board-safe wave summary when this run belongs to a parallel wave.
   * Null/absent for sequential pipelines. Never includes branch, base/head
   * commit, or worktree path.
   */
  pipelineWave?: RunPipelineWaveSummary | null;
  /**
   * Board-safe track summary when this run belongs to a parallel track.
   * Null/absent for sequential pipelines and main-checkout integration runs.
   */
  pipelineTrack?: RunPipelineTrackSummary | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RunEvent = {
  id: number;
  runId: string;
  seq: number;
  eventType: string;
  payload: string;
  createdAt: string;
};

export type InputRequestStatus = "pending" | "answered" | "cancelled";

/** Named choice for a structured input request (answer is the choice `id`). */
export type InputChoice = {
  id: string;
  label: string;
  description?: string;
};

/** Workspace-relative artifact link for an input request. */
export type InputArtifact = {
  label: string;
  /** Forward-slash workspace-relative path (never absolute or traversal). */
  path: string;
};

/**
 * Input Hub metadata `kind` for daemon-authored halt-discovery briefing cards.
 * Kept as a shared constant so daemon and dashboard agree without specializing
 * the generic `InputRequestMetadata` schema.
 */
export const HALT_DISCOVERY_INPUT_KIND = "halt-discovery-briefing" as const;

/**
 * Input Hub metadata `kind` for Guided plan-phase approval gates (b45 / b53).
 * Shared so daemon notify wiring and dashboard Other affordance agree.
 */
export const PLAN_APPROVAL_INPUT_KIND = "approval" as const;

/**
 * Optional reusable metadata on an input request. Guided planning is one caller;
 * the shape stays generic for any structured ask.
 */
export type InputRequestMetadata = {
  kind: string;
  choices?: InputChoice[];
  recommendedChoiceId?: string;
  artifacts?: InputArtifact[];
};

export type InputRequest = {
  id: string;
  runId: string;
  question: string;
  answer: string | null;
  status: InputRequestStatus;
  createdAt: string;
  answeredAt: string | null;
  /** Absent/null when the request is free-form or historical. */
  metadata?: InputRequestMetadata | null;
};

export type ChatStatus = "idle" | "running" | "needs_input" | "error";

export type ChatTitleSource = "auto" | "user";

export type ChatSession = {
  id: string;
  workspaceId: string;
  title: string | null;
  titleSource: ChatTitleSource | null;
  status: ChatStatus;
  agentId: string | null;
  sdkRunId: string | null;
  model: string | null;
  /** Canonical structured selection; null until persisted (Phase 2). */
  modelSelection: ModelSelection | null;
  systemPrompt: string | null;
  originRunId: string | null;
  /** Live run bound for soft-steer; null when detached. */
  attachedRunId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

export type ChatEvent = {
  id: number;
  chatId: string;
  seq: number;
  eventType: string;
  payload: string;
  createdAt: string;
};
