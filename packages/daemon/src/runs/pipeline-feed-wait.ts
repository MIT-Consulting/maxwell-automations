import type { WsServerMessage } from "@lca/shared";
import type { DaemonEventBus } from "../events.js";
import type { RunStore } from "./store.js";

/** Per-root waiters for pipeline feed long-poll (one bus subscription). */
export class PipelineFeedWaitRegistry {
  private readonly waiters = new Map<string, Set<() => void>>();
  private unsub?: () => void;

  constructor(
    private readonly events: DaemonEventBus,
    private readonly runStore: RunStore
  ) {}

  private ensureSubscribed(): void {
    if (this.unsub) return;
    this.unsub = this.events.subscribe((msg) => this.onMessage(msg));
  }

  private onMessage(msg: WsServerMessage): void {
    if (msg.type !== "run_event" && msg.type !== "run_status") {
      return;
    }
    const row = this.runStore.getRun(msg.runId);
    if (!row) return;
    const rootRunId = row.chain_root_run_id ?? row.id;
    this.wake(rootRunId);
  }

  private wake(rootRunId: string): void {
    const set = this.waiters.get(rootRunId);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      fn();
    }
  }

  /** Visible for tests — pending finish callbacks across all roots. */
  get pendingWaiterCount(): number {
    let n = 0;
    for (const set of this.waiters.values()) {
      n += set.size;
    }
    return n;
  }

  /**
   * Block until a lineage change or timeout. Registers the waiter first, then
   * runs `afterSubscribe` so a wake during the second query is not lost.
   */
  async waitForChange(
    rootRunId: string,
    waitMs: number,
    options?: {
      signal?: AbortSignal;
      afterSubscribe?: () => boolean;
    }
  ): Promise<void> {
    await this.wait(rootRunId, waitMs, options?.signal, options?.afterSubscribe);
  }

  /** Block until a lineage change or timeout; cleans up on resolve/abort. */
  wait(
    rootRunId: string,
    waitMs: number,
    signal?: AbortSignal,
    afterSubscribe?: () => boolean
  ): Promise<void> {
    if (waitMs <= 0) {
      return Promise.resolve();
    }
    this.ensureSubscribed();
    return new Promise((resolve) => {
      let waiterSet = this.waiters.get(rootRunId);
      if (!waiterSet) {
        waiterSet = new Set();
        this.waiters.set(rootRunId, waiterSet);
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        waiterSet.delete(finish);
        if (waiterSet.size === 0) {
          this.waiters.delete(rootRunId);
        }
        resolve();
      };

      waiterSet.add(finish);
      if (afterSubscribe?.()) {
        finish();
        return;
      }

      timer = setTimeout(finish, waitMs);
      timer.unref?.();
      onAbort = (): void => finish();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    this.unsub?.();
    this.unsub = undefined;
    for (const set of this.waiters.values()) {
      for (const fn of [...set]) {
        fn();
      }
    }
    this.waiters.clear();
  }
}
