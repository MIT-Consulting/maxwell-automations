import type { TriggerRunRequest } from "./api.js";

export const FEATURE_QUEUE_ENTRY_STATES = [
  "queued",
  "running",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const;

export type FeatureQueueEntryState = (typeof FEATURE_QUEUE_ENTRY_STATES)[number];

export const FEATURE_QUEUE_ENTRY_ORIGINS = ["queue", "direct"] as const;

export type FeatureQueueEntryOrigin =
  (typeof FEATURE_QUEUE_ENTRY_ORIGINS)[number];

export type FeatureQueueEntryDetail = {
  featureDocPath: string | null;
  roleModelProfileId: string | null;
  roleModels: { role: string; modelId: string }[] | null;
  planningDepth: string | null;
  approvalPolicy: string | null;
  researchApprovalPolicy: string | null;
  loopMode: string | null;
  then: string | null;
};

export function emptyQueueEntryDetail(): FeatureQueueEntryDetail {
  return {
    featureDocPath: null,
    roleModelProfileId: null,
    roleModels: null,
    planningDepth: null,
    approvalPolicy: null,
    researchApprovalPolicy: null,
    loopMode: null,
    then: null,
  };
}

export type FeatureQueueEntry = {
  id: string;
  workspaceId: string;
  featureId: string;
  position: number;
  after: string[];
  origin: FeatureQueueEntryOrigin;
  state: FeatureQueueEntryState;
  runId: string | null;
  detail: string | null;
  featureSlug?: string | null;
  summary?: string | null;
  entryDetail: FeatureQueueEntryDetail;
  createdAt: string;
  startedAt: string | null;
  settledAt: string | null;
  updatedAt: string;
};

export type EnqueueFeatureRequest = {
  workspaceId: string;
  featureId: string;
  after?: string[];
  kickoff: TriggerRunRequest;
};

export type MoveFeatureQueueRequest =
  | { before: string }
  | { after: string }
  | { top: true };
