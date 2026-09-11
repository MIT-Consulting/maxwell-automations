import cron, { type ScheduledTask } from "node-cron";
import type { CronTriggerConfig } from "@lca/shared";
import type { EnabledAutomation } from "./store.js";

export type CronScheduler = {
  refresh: (automations: EnabledAutomation[], onFire: (id: string) => void) => void;
  stop: () => void;
};

/**
 * Next fire time for a cron expression in the daemon's local timezone (matching
 * how {@link createCronScheduler} arms tasks). Returns null for invalid
 * expressions. `getNextRun()` only reports once a task is running, so this
 * briefly schedules a no-op task, reads its schedule, then tears it down (the
 * no-op makes an accidental boundary fire harmless).
 */
export function nextCronRun(expression: string): string | null {
  if (!cron.validate(expression)) {
    return null;
  }
  let task: ScheduledTask | undefined;
  try {
    task = cron.schedule(expression, () => {});
    const next = task.getNextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  } finally {
    if (task) {
      void task.stop();
      void task.destroy();
    }
  }
}

export function createCronScheduler(onLog?: (msg: string) => void): CronScheduler {
  const tasks = new Map<string, ScheduledTask>();

  const stop = () => {
    for (const task of tasks.values()) {
      task.stop();
    }
    tasks.clear();
  };

  const refresh = (
    automations: EnabledAutomation[],
    onFire: (id: string) => void
  ) => {
    stop();

    for (const auto of automations) {
      if (auto.trigger.type !== "cron") {
        continue;
      }
      const cfg = auto.trigger as CronTriggerConfig;
      if (!cron.validate(cfg.expression)) {
        onLog?.(
          `Cron trigger skipped for ${auto.name}: invalid expression "${cfg.expression}"`
        );
        continue;
      }

      const task = cron.schedule(cfg.expression, () => {
        onFire(auto.id);
      });
      tasks.set(auto.id, task);
      onLog?.(`Cron armed: ${auto.name} (${cfg.expression})`);
    }
  };

  return { refresh, stop };
}
