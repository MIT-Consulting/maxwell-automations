import { resolve } from "node:path";
import type { GitTriggerConfig } from "@lca/shared";
import type { LcaDatabase } from "../db/index.js";
import type { RunEngine } from "../runs/engine.js";
import { createCommandScheduler } from "./command.js";
import { createCronScheduler } from "./cron.js";
import { createFileWatchScheduler } from "./file-watch.js";
import { installGitHooksForWorkspaces } from "./git-install.js";
import { TriggerStore } from "./store.js";

export type TriggerManagerOptions = {
  port: number;
  onLog?: (message: string) => void;
};

export type GitTriggerPayload = {
  workspace: string;
  event: "post-commit" | "pre-push" | "post-merge";
  sha: string;
};

export class TriggerManager {
  private readonly store: TriggerStore;
  private readonly cron = createCronScheduler((m) => this.log(m));
  private readonly fileWatch = createFileWatchScheduler((m) => this.log(m));
  private readonly command = createCommandScheduler((m) => this.log(m));

  constructor(
    db: LcaDatabase,
    private readonly engine: RunEngine,
    private readonly options: TriggerManagerOptions
  ) {
    this.store = new TriggerStore(db);
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  start(): void {
    this.refresh();
  }

  async stop(): Promise<void> {
    this.cron.stop();
    this.command.stop();
    await this.fileWatch.stop();
  }

  refresh(): void {
    const automations = this.store.listEnabledWorkspaceAutomations();
    const workspacePaths = [
      ...new Set(automations.map((a) => resolve(a.workspacePath))),
    ];

    const hooksInstalled = installGitHooksForWorkspaces(
      workspacePaths,
      this.options.port
    );
    if (hooksInstalled > 0) {
      this.log(`Git hooks updated (${hooksInstalled} hook file(s))`);
    }

    this.cron.refresh(automations, (id) => {
      void this.fire(id, "cron");
    });

    this.fileWatch.refresh(automations, (id) => {
      void this.fire(id, "file-watch");
    });

    this.command.refresh(automations, (id, promptOverride) => {
      void this.fire(id, "command", { promptOverride });
    });

    this.log(
      `Triggers refreshed (${automations.length} enabled workspace automation(s))`
    );
  }

  async handleGitEvent(payload: GitTriggerPayload): Promise<string[]> {
    const workspace = resolve(payload.workspace);
    const automations = this.store.listEnabledWorkspaceAutomations();
    const fired: string[] = [];

    for (const auto of automations) {
      if (auto.trigger.type !== "git") {
        continue;
      }
      const cfg = auto.trigger as GitTriggerConfig;
      if (!cfg.events.includes(payload.event)) {
        continue;
      }
      if (resolve(auto.workspacePath) !== workspace) {
        continue;
      }

      const promptOverride = `${auto.prompt}

--- git trigger: ${payload.event} ---
SHA: ${payload.sha}`;

      const runId = await this.fire(auto.id, `git:${payload.event}`, {
        promptOverride,
      });
      if (runId) {
        fired.push(runId);
      }
    }

    return fired;
  }

  async fire(
    automationId: string,
    triggerKind: string,
    opts?: { promptOverride?: string }
  ): Promise<string | undefined> {
    if (!this.store.isAutomationEnabled(automationId)) {
      return undefined;
    }

    try {
      const runId = await this.engine.triggerRun(
        automationId,
        triggerKind,
        opts?.promptOverride
          ? { promptOverride: opts.promptOverride }
          : undefined
      );
      this.log(`Triggered ${automationId} (${triggerKind}) → run ${runId}`);
      return runId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Trigger failed for ${automationId}: ${message}`);
      return undefined;
    }
  }
}
