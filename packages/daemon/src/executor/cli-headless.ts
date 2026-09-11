import type { ActiveRun, Executor, ResumeParams, SpawnParams } from "./types.js";

export class CliHeadlessExecutor implements Executor {
  readonly kind = "cli-headless" as const;

  private notImplemented(): never {
    throw new Error(
      "CliHeadlessExecutor is not implemented yet (cursor-agent --headless fallback)."
    );
  }

  spawn(_params: SpawnParams): Promise<ActiveRun> {
    this.notImplemented();
  }

  resume(_params: ResumeParams): Promise<ActiveRun> {
    this.notImplemented();
  }
}
