import {
  classifyFeatureQueueOutcome,
  featureQueueFailureDetail,
  findActivePipelineBlocker,
} from "@lca/shared";
import type { DaemonEventBus } from "../events.js";
import {
  IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY,
  pipelineWorkerAutomationIds,
} from "../pipelines/implement-fully.js";
import type { Notifier } from "../notify/notifier.js";
import type { RunEngine } from "./engine.js";
import {
  FeatureQueueStore,
  parseFeatureQueueKickoff,
  type FeatureQueueEntryRow,
} from "./feature-queue-store.js";
import type { RunStore } from "./store.js";

export type FeatureQueueRunnerOptions = {
  store: RunStore;
  queueStore: FeatureQueueStore;
  engine: RunEngine;
  events: DaemonEventBus;
  onLog: (message: string) => void;
  notifier?: Pick<Notifier, "queueBatchComplete">;
  getWorkspaceLabel?: (workspaceId: string) => string;
};

export class FeatureQueueRunner {
  private readonly store: RunStore;
  private readonly queueStore: FeatureQueueStore;
  private readonly engine: RunEngine;
  private readonly events: DaemonEventBus;
  private readonly onLog: (message: string) => void;
  private readonly notifier?: Pick<Notifier, "queueBatchComplete">;
  private readonly getWorkspaceLabel: (workspaceId: string) => string;
  private unsubscribe: (() => void) | null = null;

  constructor(options: FeatureQueueRunnerOptions) {
    this.store = options.store;
    this.queueStore = options.queueStore;
    this.engine = options.engine;
    this.events = options.events;
    this.onLog = options.onLog;
    this.notifier = options.notifier;
    this.getWorkspaceLabel =
      options.getWorkspaceLabel ?? ((workspaceId) => workspaceId);
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.events.subscribe((message) => {
      if (message.type !== "run_status") {
        return;
      }
      if (
        message.status !== "completed" &&
        message.status !== "failed" &&
        message.status !== "cancelled"
      ) {
        return;
      }
      queueMicrotask(() => {
        void this.handleSettle(message.runId).catch((err) => {
          const text = err instanceof Error ? err.message : String(err);
          this.onLog(`Feature queue runner error for run ${message.runId}: ${text}`);
        });
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async startNextIfIdle(workspaceId: string): Promise<void> {
    await this.tryStartNext(workspaceId);
  }

  async resumeQueue(): Promise<void> {
    const workspaceIds = this.queueStore.listWorkspaceIdsWithActiveQueue();
    let resumed = 0;
    for (const workspaceId of workspaceIds) {
      await this.classifyRunningEntry(workspaceId);
      const started = await this.tryStartNext(workspaceId);
      if (started) {
        resumed += 1;
      }
    }
    if (workspaceIds.length > 0) {
      this.onLog(
        `Feature queue resume: ${workspaceIds.length} workspace(s), ${resumed} start(s)`
      );
    }
  }

  private async handleSettle(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) {
      return;
    }
    const workspaceId = run.workspace_id;
    if (!this.queueStore.hasQueueActivity(workspaceId)) {
      return;
    }
    if (this.hasPipelineBlocker(workspaceId)) {
      return;
    }
    await this.classifyRunningEntry(workspaceId);
    const started = await this.tryStartNext(workspaceId);
    if (!started) {
      this.maybeEmitBatchDigest(workspaceId);
    }
  }

  private maybeEmitBatchDigest(workspaceId: string): void {
    if (!this.notifier) {
      return;
    }
    if (this.queueStore.hasRunningOrQueued(workspaceId)) {
      return;
    }
    const facts = this.queueStore.collectUndigestedBatchDigest(workspaceId);
    if (!facts) {
      return;
    }
    try {
      this.notifier.queueBatchComplete({
        workspaceLabel: this.getWorkspaceLabel(workspaceId),
        ...facts,
      });
      this.queueStore.markBatchDigested(workspaceId);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.onLog(`Feature queue digest notify failed for ${workspaceId}: ${text}`);
    }
  }

  private async classifyRunningEntry(workspaceId: string): Promise<void> {
    const running = this.queueStore.getRunningEntry(workspaceId);
    if (!running?.run_id) {
      return;
    }
    const lineage = this.store.listChainLineageRuns(running.run_id);
    const outcome = classifyFeatureQueueOutcome(
      lineage,
      IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY
    );
    const detail =
      outcome === "failed"
        ? featureQueueFailureDetail(lineage, IMPLEMENT_FULLY_TERMINAL_CONFIG_KEY)
        : null;
    const settled = this.queueStore.settleEntry(running.id, outcome, detail);
    if (settled && outcome === "failed") {
      this.queueStore.parkDependents(running.feature_id, workspaceId);
    }
  }

  private hasPipelineBlocker(workspaceId: string): boolean {
    const runs = this.store.listActiveRunsForWorkspace(workspaceId);
    const pipelineAutomationIds = pipelineWorkerAutomationIds(workspaceId);
    return (
      findActivePipelineBlocker(
        runs.map((row) => ({
          id: row.id,
          automationId: row.automation_id,
          status: row.status,
        })),
        pipelineAutomationIds
      ) != null
    );
  }

  private isEntryEligible(
    entry: FeatureQueueEntryRow,
    workspaceId: string
  ): boolean {
    let after: string[] = [];
    try {
      const parsed = JSON.parse(entry.after_json) as unknown;
      if (Array.isArray(parsed)) {
        after = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      after = [];
    }
    for (const depId of after) {
      const dep = this.queueStore.getNewestEntryByFeatureId(workspaceId, depId);
      if (!dep) {
        return false;
      }
      if (dep.state === "done") {
        continue;
      }
      if (
        dep.state === "failed" ||
        dep.state === "blocked" ||
        dep.state === "cancelled"
      ) {
        this.queueStore.blockEntry(
          entry.id,
          `blocked by ${dep.state} dependency ${depId}`
        );
        return false;
      }
      return false;
    }
    return true;
  }

  private async tryStartNext(workspaceId: string): Promise<boolean> {
    if (this.hasPipelineBlocker(workspaceId)) {
      return false;
    }
    const queued = this.queueStore.listQueuedEntries(workspaceId);
    const attemptLimit = queued.length;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
      const candidates = this.queueStore.listQueuedEntries(workspaceId);
      const entry = candidates.find((row) =>
        this.isEntryEligible(row, workspaceId)
      );
      if (!entry) {
        return false;
      }
      if (!this.queueStore.claimEntry(entry.id)) {
        continue;
      }
      const kickoff = parseFeatureQueueKickoff(entry);
      try {
        const runId = await this.engine.triggerRun(
          kickoff.automationId,
          "manual",
          {
            chainContext: {
              variables: kickoff.variables ?? {},
              roleModels: kickoff.roleModels ?? {},
            },
            chainMaxDepth: kickoff.maxDepth ?? 1,
            modelSelectionOverride: kickoff.modelSelection ?? null,
          }
        );
        this.queueStore.recordStart(entry.id, runId);
        this.onLog(
          `Feature queue started ${entry.feature_id} (entry ${entry.id}, run ${runId})`
        );
        return true;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        this.queueStore.settleEntry(entry.id, "failed", text);
        this.queueStore.parkDependents(entry.feature_id, workspaceId);
        this.onLog(
          `Feature queue start failed for ${entry.feature_id}: ${text}`
        );
      }
    }
    return false;
  }
}
