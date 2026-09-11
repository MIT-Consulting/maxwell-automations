import chokidar, { type FSWatcher } from "chokidar";
import { resolve } from "node:path";
import picomatch from "picomatch";
import type { FileWatchTriggerConfig } from "@lca/shared";
import type { EnabledAutomation } from "./store.js";

export type FileWatchScheduler = {
  refresh: (automations: EnabledAutomation[], onFire: (id: string) => void) => void;
  stop: () => Promise<void>;
};

type CompiledGlob = {
  isMatch: (rel: string) => boolean;
};

/**
 * Resolve a changed absolute path to a workspace-relative, forward-slashed path
 * for glob matching. Returns "" when the path is outside the workspace. Exported
 * for unit tests (chokidar watches a base dir, we filter with picomatch).
 */
export function relativeForMatch(
  workspacePath: string,
  changedPath: string
): string {
  const base = resolve(workspacePath);
  const normalized = resolve(changedPath);
  if (!normalized.toLowerCase().startsWith(base.toLowerCase())) {
    return "";
  }
  return normalized
    .slice(base.length)
    .replace(/^[/\\]/, "")
    .replace(/\\/g, "/");
}

/** Compile workspace globs into picomatch matchers (forward-slashed, dotfiles on). */
export function compileGlobs(globs: string[]): CompiledGlob[] {
  return globs.map((rawGlob) => {
    const glob = rawGlob.replace(/\\/g, "/");
    return { isMatch: picomatch(glob, { dot: true }) };
  });
}

/**
 * Pure predicate: does `changedPath` (absolute) match any of `globs` relative to
 * `workspacePath`? Mirrors the scheduler's matching so trigger regressions are
 * caught without a live watcher.
 */
export function matchesGlobs(
  workspacePath: string,
  globs: string[],
  changedPath: string
): boolean {
  const rel = relativeForMatch(workspacePath, changedPath);
  if (!rel) {
    return false;
  }
  return compileGlobs(globs).some((g) => g.isMatch(rel));
}

export function createFileWatchScheduler(
  onLog?: (msg: string) => void
): FileWatchScheduler {
  let watcher: FSWatcher | undefined;
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const automationByKey = new Map<string, EnabledAutomation>();

  const stop = async () => {
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    debounceTimers.clear();
    automationByKey.clear();
    if (watcher) {
      await watcher.close();
      watcher = undefined;
    }
  };

  const refresh = (
    automations: EnabledAutomation[],
    onFire: (id: string) => void
  ) => {
    void stop().then(() => {
      const fileWatchAutos = automations.filter(
        (a) => a.trigger.type === "file-watch"
      );
      if (fileWatchAutos.length === 0) {
        return;
      }

      // chokidar 4 dropped glob support, so we watch the longest static base dir
      // of each glob and filter `all` events with a real matcher (picomatch).
      const baseDirs = new Set<string>();
      const compiledByAutomation = new Map<string, CompiledGlob[]>();

      for (const auto of fileWatchAutos) {
        const cfg = auto.trigger as FileWatchTriggerConfig;
        const ws = resolve(auto.workspacePath);

        for (const rawGlob of cfg.globs) {
          const glob = rawGlob.replace(/\\/g, "/");
          const { base } = picomatch.scan(glob);
          const baseAbs = base ? resolve(ws, base) : ws;
          baseDirs.add(baseAbs);
        }

        compiledByAutomation.set(auto.id, compileGlobs(cfg.globs));
        automationByKey.set(auto.id, auto);
      }

      watcher = chokidar.watch([...baseDirs], {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
        persistent: true,
      });

      const scheduleFire = (auto: EnabledAutomation) => {
        const cfg = auto.trigger as FileWatchTriggerConfig;
        const debounceMs = cfg.debounceMs ?? 500;
        const existing = debounceTimers.get(auto.id);
        if (existing) {
          clearTimeout(existing);
        }
        debounceTimers.set(
          auto.id,
          setTimeout(() => {
            debounceTimers.delete(auto.id);
            onFire(auto.id);
          }, debounceMs)
        );
      };

      const matchesAutomation = (
        auto: EnabledAutomation,
        changedPath: string
      ): boolean => {
        const rel = relativeForMatch(auto.workspacePath, changedPath);
        if (!rel) {
          return false;
        }
        const compiled = compiledByAutomation.get(auto.id) ?? [];
        return compiled.some((g) => g.isMatch(rel));
      };

      watcher.on("all", (_event, filePath) => {
        for (const auto of fileWatchAutos) {
          if (matchesAutomation(auto, filePath)) {
            scheduleFire(auto);
          }
        }
      });

      onLog?.(
        `File-watch armed: ${fileWatchAutos.length} automation(s), ${baseDirs.size} base dir(s)`
      );
    });
  };

  return { refresh, stop };
}
