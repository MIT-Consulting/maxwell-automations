import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { CommandTriggerConfig } from "@lca/shared";
import type { EnabledAutomation } from "./store.js";

const DEFAULT_INTERVAL_MS = 60_000;

export type CommandScheduler = {
  refresh: (
    automations: EnabledAutomation[],
    onFire: (id: string, promptOverride: string) => void
  ) => void;
  stop: () => void;
};

function runCommand(
  command: string,
  cwd: string
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
    });

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c) => chunks.push(c));
    child.stderr?.on("data", (c) => chunks.push(c));

    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8").trim(),
      });
    });

    child.on("error", (err) => {
      resolvePromise({
        exitCode: 1,
        output: err.message,
      });
    });
  });
}

export function createCommandScheduler(
  onLog?: (msg: string) => void
): CommandScheduler {
  const intervals = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<string>();
  // Last observed exit code per automation. Used to fire only on the transition
  // into failure (edge-triggered) so a persistently failing command does not
  // re-fire every poll. `undefined` means "no prior observation" (counts as
  // healthy, so the first failure fires).
  const lastExitCode = new Map<string, number>();

  const stop = () => {
    for (const timer of intervals.values()) {
      clearInterval(timer);
    }
    intervals.clear();
    inFlight.clear();
    lastExitCode.clear();
  };

  const runOnce = async (
    auto: EnabledAutomation,
    onFire: (id: string, promptOverride: string) => void
  ) => {
    if (inFlight.has(auto.id)) {
      return;
    }
    inFlight.add(auto.id);

    try {
      const cfg = auto.trigger as CommandTriggerConfig;
      const cwd = resolve(cfg.cwd ?? auto.workspacePath);
      const { exitCode, output } = await runCommand(cfg.command, cwd);

      const prev = lastExitCode.get(auto.id);
      lastExitCode.set(auto.id, exitCode);

      if (exitCode === 0) {
        return;
      }

      // Edge-triggered: only fire when transitioning from healthy (exit 0 or no
      // prior observation) into failure. A still-failing command waits until it
      // recovers and fails again.
      const wasHealthy = prev === undefined || prev === 0;
      if (!wasHealthy) {
        return;
      }

      const promptOverride = `${auto.prompt}

--- command trigger: non-zero exit ---
Command: ${cfg.command}
Exit code: ${exitCode}
Output:
${output || "(no output)"}`;

      onLog?.(
        `Command trigger fired: ${auto.name} (exit ${exitCode})`
      );
      onFire(auto.id, promptOverride);
    } finally {
      inFlight.delete(auto.id);
    }
  };

  const refresh = (
    automations: EnabledAutomation[],
    onFire: (id: string, promptOverride: string) => void
  ) => {
    stop();

    for (const auto of automations) {
      if (auto.trigger.type !== "command") {
        continue;
      }

      void runOnce(auto, onFire);

      const timer = setInterval(() => {
        void runOnce(auto, onFire);
      }, DEFAULT_INTERVAL_MS);
      intervals.set(auto.id, timer);
      onLog?.(`Command trigger armed: ${auto.name} (poll ${DEFAULT_INTERVAL_MS}ms)`);
    }
  };

  return { refresh, stop };
}
