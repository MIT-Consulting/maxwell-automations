import type { Executor, ExecutorKind } from "./types.js";
import { CliHeadlessExecutor } from "./cli-headless.js";
import { SdkLocalExecutor } from "./sdk-local.js";

export function createExecutor(kind: ExecutorKind = "sdk-local"): Executor {
  switch (kind) {
    case "sdk-local":
      return new SdkLocalExecutor();
    case "cli-headless":
      return new CliHeadlessExecutor();
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export * from "./types.js";
