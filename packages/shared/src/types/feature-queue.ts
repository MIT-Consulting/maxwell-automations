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
