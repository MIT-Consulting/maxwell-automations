import chokidar from "chokidar";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LcaDatabase } from "../db/index.js";
import { GLOBAL_CONFIG_PATH, LCA_HOME } from "../paths.js";
import { listWatchedPaths, reconcileConfig } from "./reconcile.js";

export type ConfigWatcher = {
  close: () => Promise<void>;
};

export function startConfigWatcher(
  db: LcaDatabase,
  onReconcile?: (count: number) => void,
  onLog?: (message: string) => void
): ConfigWatcher {
  mkdirSync(LCA_HOME, { recursive: true });
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });

  let paths: string[];
  try {
    paths = listWatchedPaths();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onLog?.(`Config watcher using global file only: ${message}`);
    paths = [GLOBAL_CONFIG_PATH];
  }

  // Watch the parent dir of the global config (not just the file) so the daemon
  // detects first-time creation of `automations.yaml`. Files in LCA_HOME other
  // than the global config (state.sqlite, .env, …) are ignored below.
  const globalDir = dirname(GLOBAL_CONFIG_PATH);
  const watchPaths = paths.map((p) =>
    p === GLOBAL_CONFIG_PATH ? globalDir : p
  );

  const homeNorm = LCA_HOME.replace(/\\/g, "/");
  const globalConfigNorm = GLOBAL_CONFIG_PATH.replace(/\\/g, "/");

  const watcher = chokidar.watch(watchPaths, {
    ignored: (watchPath) => {
      const p = String(watchPath).replace(/\\/g, "/");
      if (p.includes("/.cursor/automations")) {
        return !/\.ya?ml$/i.test(p);
      }
      if (/\/\.cursor$/.test(p) || /\/\.cursor\/chat\.yaml$/i.test(p)) {
        return false;
      }
      if (p.includes("/.cursor/") && !p.includes("/.cursor/automations")) {
        return true;
      }
      if (p === homeNorm) {
        return false;
      }
      if (p.startsWith(`${homeNorm}/`)) {
        return p !== globalConfigNorm;
      }
      return false;
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    persistent: true,
  });

  const runReconcile = () => {
    try {
      const count = reconcileConfig(db, { onLog });
      onReconcile?.(count);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLog?.(`Config reconcile failed: ${message}`);
    }
  };

  watcher.on("add", runReconcile);
  watcher.on("change", runReconcile);
  watcher.on("unlink", runReconcile);

  return {
    close: () => watcher.close(),
  };
}
