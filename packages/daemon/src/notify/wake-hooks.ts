import { hostname } from "node:os";
import type {
  ResolvedWakeHookConfig,
  WakeHookDeliveryRecord,
  WakeHookEvent,
} from "@lca/shared";
import { ChatMessageError } from "../chats/engine.js";
import type { ParsedChainContext, RunRow } from "../runs/store.js";
import { classifyRootPipelineOutcome } from "../runs/pipeline-steering.js";
import type { RunStore } from "../runs/store.js";

const MAX_RING = 20;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;
const BACKOFF_MS = [1000, 2000] as const;
const HOUR_MS = 3_600_000;

/** D5 actor-stamped kinds (excluding run.message — queried separately). */
const WAKE_HOOK_ACTOR_LIFECYCLE_KINDS = [
  "run.pipeline-escalated",
  "run.pipeline-directive",
  "run.pipeline-stop-requested",
  "input.delivered",
  "run.cancelled",
] as const;

export type WakeHookPayload = {
  source: "max";
  kind: string;
  correlation_id: string;
  workspace: string;
  feature: string;
  rootRunId: string;
  host: string;
  outcome: string;
  cursor: number;
  next: string;
  suppressed?: number;
};

export type WakeHookDispatcherDeps = {
  getRun: (runId: string) => RunRow | undefined;
  parseChainContext: (row: RunRow) => ParsedChainContext | null;
  getMaxGlobalEventId: () => number;
  classifyOutcome: (rootRunId: string) => string;
  findNewestActorEvent?: (
    rootRunId: string,
    actorId: string
  ) => { id: number; actorId: string } | null;
  onLog?: (message: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type RunWakeContext = {
  workspaceId: string;
  featureId: string;
  rootRunId: string;
  outcome: string;
};

type QueueWakeContext = {
  workspaceId: string;
};

type CoalesceBucket = {
  suppressed: number;
  timer?: ReturnType<typeof setTimeout>;
  lastDeliveredAt: number;
  lastPayload: WakeHookPayload;
  lastEvent: WakeHookEvent;
  lastWorkspaceId: string;
  lastFeatureId: string;
};

type HourlyBucket = {
  deliveryTimes: number[];
  dropped: number;
};

type LastSuccessMeta = {
  cursor: number;
  rootRunId: string;
  kind: string;
};

export type WakeHookDoctorContext = {
  actorId?: string;
  noActorActivitySince?: boolean;
};

function coalesceKey(
  hookId: string,
  workspaceId: string,
  kind: WakeHookEvent
): string {
  return `${hookId}:${workspaceId}:${kind}`;
}

function cursorKey(hookId: string, rootRunId: string): string {
  return `${hookId}:${rootRunId}`;
}

function kindForEvent(event: WakeHookEvent): string {
  switch (event) {
    case "needs_input":
      return "pipeline.needs_input";
    case "halted":
      return "pipeline.halted";
    case "blocked":
      return "pipeline.blocked";
    case "green":
      return "pipeline.green";
    case "queue_batch_complete":
      return "queue.batch_complete";
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function outcomeForEvent(event: WakeHookEvent, runOutcome: string): string {
  if (event === "queue_batch_complete") {
    return "drained";
  }
  if (event === "needs_input") {
    return "needs_input";
  }
  return runOutcome;
}

function matchesFilter(
  hook: ResolvedWakeHookConfig,
  workspaceId: string,
  featureId: string
): boolean {
  if (
    hook.workspaceIds != null &&
    hook.workspaceIds.length > 0 &&
    !hook.workspaceIds.includes(workspaceId)
  ) {
    return false;
  }
  if (
    hook.featureIds != null &&
    hook.featureIds.length > 0 &&
    !hook.featureIds.includes(featureId)
  ) {
    return false;
  }
  return true;
}

function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") {
        parts.push(code);
      }
      current = current.cause;
      continue;
    }
    break;
  }
  return parts.join(" ").toLowerCase();
}

function classifyFetchError(err: unknown): string {
  if (!(err instanceof Error)) {
    return "request";
  }
  const name = err.name;
  const text = collectErrorText(err);
  if (name === "AbortError" || text.includes("timeout") || text.includes("aborted")) {
    return "timeout";
  }
  if (
    text.includes("certificate") ||
    text.includes("cert_") ||
    /\bssl\b/.test(text) ||
    /\btls\b/.test(text) ||
    text.includes("unable to verify")
  ) {
    return "certificate";
  }
  return "request";
}

function readPayloadActorId(payloadJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (
      typeof parsed === "object" &&
      parsed != null &&
      "actorId" in parsed &&
      typeof (parsed as { actorId: unknown }).actorId === "string"
    ) {
      const actorId = (parsed as { actorId: string }).actorId.trim();
      return actorId.length > 0 ? actorId : null;
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}

/** Newest actor-stamped D5 event on a lineage for a given actor label. */
export function findNewestActorStampedEvent(
  store: RunStore,
  rootRunId: string,
  actorId: string
): { id: number; actorId: string } | null {
  const lifecycle = store.listLifecycleEventsForLineage(
    rootRunId,
    WAKE_HOOK_ACTOR_LIFECYCLE_KINDS,
    { since: 0, limit: 500 }
  );
  const messages = store.listRunMessageEventsForLineage(rootRunId, {
    since: 0,
    limit: 500,
  });
  const merged = [...lifecycle, ...messages].sort((a, b) => b.id - a.id);
  for (const row of merged) {
    const rowActorId = readPayloadActorId(row.payload);
    if (rowActorId === actorId) {
      return { id: row.id, actorId: rowActorId };
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WakeHookDispatcher {
  private hooks: ResolvedWakeHookConfig[] = [];
  private readonly rings = new Map<string, WakeHookDeliveryRecord[]>();
  private readonly fetchImpl: typeof fetch;
  private readonly hostName: string;
  private readonly now: () => number;
  private sendChatMessage?: (chatId: string, text: string) => Promise<void>;
  private readonly coalesce = new Map<string, CoalesceBucket>();
  private readonly hourly = new Map<string, HourlyBucket>();
  private readonly lastSuccess = new Map<string, LastSuccessMeta>();
  private readonly lastCursor = new Map<string, number>();

  constructor(private readonly deps: WakeHookDispatcherDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.hostName = hostname();
    this.now = deps.now ?? (() => Date.now());
  }

  setSendChatMessage(
    fn: ((chatId: string, text: string) => Promise<void>) | undefined
  ): void {
    this.sendChatMessage = fn;
  }

  reconfigure(hooks: ResolvedWakeHookConfig[]): void {
    this.hooks = hooks;
  }

  getDeliveryRings(): Map<string, WakeHookDeliveryRecord[]> {
    return this.rings;
  }

  getLastDeliveredCursor(hookId: string, rootRunId: string): number | undefined {
    return this.lastCursor.get(cursorKey(hookId, rootRunId));
  }

  getDoctorContext(hook: ResolvedWakeHookConfig): WakeHookDoctorContext {
    const ctx: WakeHookDoctorContext = {};
    if (hook.actorId != null) {
      ctx.actorId = hook.actorId;
    }
    const last = this.rings.get(hook.id)?.at(-1);
    const meta = this.lastSuccess.get(hook.id);
    if (
      hook.actorId != null &&
      last?.status === "success" &&
      meta != null &&
      meta.kind !== kindForEvent("queue_batch_complete") &&
      meta.rootRunId.length > 0 &&
      this.deps.findNewestActorEvent != null
    ) {
      const newest = this.deps.findNewestActorEvent(meta.rootRunId, hook.actorId);
      if (newest == null || newest.id <= meta.cursor) {
        ctx.noActorActivitySince = true;
      }
    }
    return ctx;
  }

  private resolveRunContext(runId: string): RunWakeContext | null {
    const row = this.deps.getRun(runId);
    if (!row) {
      return null;
    }
    const rootRunId = row.chain_root_run_id ?? row.id;
    const parsed = this.deps.parseChainContext(row);
    const featureId =
      parsed?.ok === true &&
      typeof parsed.context.variables.featureId === "string"
        ? parsed.context.variables.featureId
        : "";
    const outcome = this.deps.classifyOutcome(rootRunId);
    return {
      workspaceId: row.workspace_id,
      featureId,
      rootRunId,
      outcome,
    };
  }

  private buildRunPayload(
    event: WakeHookEvent,
    ctx: RunWakeContext,
    suppressed?: number
  ): WakeHookPayload {
    const cursor = this.deps.getMaxGlobalEventId();
    const kind = kindForEvent(event);
    const outcome = outcomeForEvent(event, ctx.outcome);
    const next =
      ctx.featureId.length > 0
        ? `max watch ${ctx.featureId} -w ${ctx.workspaceId} --since ${cursor} --json`
        : `max watch -w ${ctx.workspaceId} --since ${cursor} --json`;
    return {
      source: "max",
      kind,
      correlation_id: `${ctx.rootRunId}:${cursor}`,
      workspace: ctx.workspaceId,
      feature: ctx.featureId,
      rootRunId: ctx.rootRunId,
      host: this.hostName,
      outcome,
      cursor,
      next,
      ...(suppressed != null && suppressed > 0 ? { suppressed } : {}),
    };
  }

  private buildQueuePayload(
    ctx: QueueWakeContext,
    suppressed?: number
  ): WakeHookPayload {
    const cursor = this.deps.getMaxGlobalEventId();
    return {
      source: "max",
      kind: kindForEvent("queue_batch_complete"),
      correlation_id: `${ctx.workspaceId}:${cursor}`,
      workspace: ctx.workspaceId,
      feature: "",
      rootRunId: "",
      host: this.hostName,
      outcome: "drained",
      cursor,
      next: `max queue list -w ${ctx.workspaceId}`,
      ...(suppressed != null && suppressed > 0 ? { suppressed } : {}),
    };
  }

  private recordDelivery(
    hookId: string,
    kind: string,
    status: "success" | "failure",
    attempt: number,
    error?: string
  ): void {
    const ring = this.rings.get(hookId) ?? [];
    ring.push({
      at: new Date(this.now()).toISOString(),
      kind,
      status,
      attempt,
      ...(error !== undefined ? { error } : {}),
    });
    while (ring.length > MAX_RING) {
      ring.shift();
    }
    this.rings.set(hookId, ring);
  }

  private pruneHourly(bucket: HourlyBucket): void {
    const cutoff = this.now() - HOUR_MS;
    bucket.deliveryTimes = bucket.deliveryTimes.filter((t) => t > cutoff);
  }

  private isHourlyCapReached(
    hook: ResolvedWakeHookConfig,
    bucket: HourlyBucket
  ): boolean {
    this.pruneHourly(bucket);
    return bucket.deliveryTimes.length >= hook.maxPerHour;
  }

  private noteHourlyDelivery(hookId: string): void {
    const bucket = this.hourly.get(hookId) ?? { deliveryTimes: [], dropped: 0 };
    bucket.deliveryTimes.push(this.now());
    this.hourly.set(hookId, bucket);
  }

  private shouldSuppressActor(
    hook: ResolvedWakeHookConfig,
    event: WakeHookEvent,
    rootRunId: string,
    payloadKind: string
  ): boolean {
    if (
      event === "queue_batch_complete" ||
      rootRunId.length === 0 ||
      hook.actorId == null ||
      this.deps.findNewestActorEvent == null
    ) {
      return false;
    }
    const lastCursor = this.lastCursor.get(cursorKey(hook.id, rootRunId));
    // No prior wake for this hook+root — the first doorbell must still ring
    // even when kickoff / earlier actor stamps already exist on the lineage.
    if (lastCursor == null) {
      return false;
    }
    const newest = this.deps.findNewestActorEvent(rootRunId, hook.actorId);
    if (newest != null && newest.id > lastCursor) {
      this.recordDelivery(hook.id, payloadKind, "failure", 1, "suppressed-actor");
      return true;
    }
    return false;
  }

  private scheduleCoalesceSummary(
    hook: ResolvedWakeHookConfig,
    bucket: CoalesceBucket
  ): void {
    if (bucket.timer != null) {
      clearTimeout(bucket.timer);
    }
    if (hook.coalesceMs <= 0) {
      return;
    }
    bucket.timer = setTimeout(() => {
      bucket.timer = undefined;
      const suppressed = bucket.suppressed;
      bucket.suppressed = 0;
      if (suppressed <= 0) {
        return;
      }
      const summaryPayload: WakeHookPayload = {
        ...bucket.lastPayload,
        suppressed,
      };
      void this.deliverWake(
        hook,
        bucket.lastEvent,
        summaryPayload,
        bucket.lastWorkspaceId,
        bucket.lastFeatureId
      ).catch(() => {});
    }, hook.coalesceMs);
  }

  private isCoalesceWindowActive(
    hook: ResolvedWakeHookConfig,
    bucket: CoalesceBucket | undefined
  ): boolean {
    if (hook.coalesceMs <= 0 || bucket == null) {
      return false;
    }
    return this.now() - bucket.lastDeliveredAt < hook.coalesceMs;
  }

  private async deliverWake(
    hook: ResolvedWakeHookConfig,
    event: WakeHookEvent,
    payload: WakeHookPayload,
    workspaceId: string,
    featureId: string
  ): Promise<void> {
    const hourlyBucket = this.hourly.get(hook.id) ?? {
      deliveryTimes: [],
      dropped: 0,
    };
    if (this.isHourlyCapReached(hook, hourlyBucket)) {
      hourlyBucket.dropped++;
      this.hourly.set(hook.id, hourlyBucket);
      return;
    }

    const dropped = hourlyBucket.dropped;
    if (dropped > 0) {
      payload = { ...payload, suppressed: (payload.suppressed ?? 0) + dropped };
      hourlyBucket.dropped = 0;
      this.hourly.set(hook.id, hourlyBucket);
    }

    const success =
      hook.sink === "chat"
        ? await this.sendChat(hook, payload)
        : await this.sendHttp(hook, payload);

    if (!success) {
      return;
    }

    this.noteHourlyDelivery(hook.id);
    if (payload.rootRunId.length > 0) {
      this.lastCursor.set(
        cursorKey(hook.id, payload.rootRunId),
        payload.cursor
      );
    }
    this.lastSuccess.set(hook.id, {
      cursor: payload.cursor,
      rootRunId: payload.rootRunId,
      kind: payload.kind,
    });

    const key = coalesceKey(hook.id, workspaceId, event);
    const bucket: CoalesceBucket = {
      suppressed: 0,
      lastDeliveredAt: this.now(),
      lastPayload: payload,
      lastEvent: event,
      lastWorkspaceId: workspaceId,
      lastFeatureId: featureId,
    };
    const existing = this.coalesce.get(key);
    if (existing?.timer != null) {
      clearTimeout(existing.timer);
    }
    this.coalesce.set(key, bucket);
    this.scheduleCoalesceSummary(hook, bucket);
  }

  private enqueueWake(
    hook: ResolvedWakeHookConfig,
    event: WakeHookEvent,
    payload: WakeHookPayload,
    workspaceId: string,
    featureId: string,
    rootRunId: string
  ): void {
    if (this.shouldSuppressActor(hook, event, rootRunId, payload.kind)) {
      return;
    }

    const key = coalesceKey(hook.id, workspaceId, event);
    const bucket = this.coalesce.get(key);
    if (this.isCoalesceWindowActive(hook, bucket)) {
      if (bucket != null) {
        bucket.suppressed++;
      }
      return;
    }

    void this.deliverWake(hook, event, payload, workspaceId, featureId).catch(
      () => {}
    );
  }

  private async sendHttp(
    hook: ResolvedWakeHookConfig,
    payload: WakeHookPayload
  ): Promise<boolean> {
    if (hook.sink !== "http" || hook.url == null || hook.tokenEnv == null) {
      return false;
    }

    const token = process.env[hook.tokenEnv];
    if (token == null || token.length === 0) {
      this.recordDelivery(hook.id, payload.kind, "failure", 1, "token");
      this.deps.onLog?.(
        `Wake hook ${hook.id}: token env ${hook.tokenEnv} missing`
      );
      return false;
    }

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(hook.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) {
          this.recordDelivery(hook.id, payload.kind, "success", attempt);
          this.deps.onLog?.(
            `Wake hook ${hook.id}: ${payload.kind} delivered (attempt ${attempt})`
          );
          return true;
        }
        lastError = `http ${res.status}`;
        this.deps.onLog?.(
          `Wake hook ${hook.id}: ${payload.kind} HTTP ${res.status} (attempt ${attempt})`
        );
      } catch (err) {
        lastError = classifyFetchError(err);
        this.deps.onLog?.(
          `Wake hook ${hook.id}: ${payload.kind} ${lastError} (attempt ${attempt})`
        );
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[1]);
      }
    }
    this.recordDelivery(
      hook.id,
      payload.kind,
      "failure",
      MAX_ATTEMPTS,
      lastError
    );
    return false;
  }

  private async sendChat(
    hook: ResolvedWakeHookConfig,
    payload: WakeHookPayload
  ): Promise<boolean> {
    if (hook.sink !== "chat" || hook.chatId == null) {
      this.recordDelivery(hook.id, payload.kind, "failure", 1, "request");
      return false;
    }
    if (this.sendChatMessage == null) {
      this.recordDelivery(hook.id, payload.kind, "failure", 1, "request");
      return false;
    }
    const text = `Max wake\n${JSON.stringify(payload, null, 2)}`;
    try {
      await this.sendChatMessage(hook.chatId, text);
      this.recordDelivery(hook.id, payload.kind, "success", 1);
      this.deps.onLog?.(`Wake hook ${hook.id}: ${payload.kind} chat delivered`);
      return true;
    } catch (err) {
      if (
        err instanceof ChatMessageError &&
        (err.code === "busy" || err.code === "needs_input")
      ) {
        this.recordDelivery(hook.id, payload.kind, "failure", 1, "chat busy");
        return false;
      }
      this.recordDelivery(hook.id, payload.kind, "failure", 1, "request");
      return false;
    }
  }

  private dispatchPayload(
    event: WakeHookEvent,
    payload: WakeHookPayload,
    workspaceId: string,
    featureId: string
  ): void {
    for (const hook of this.hooks) {
      if (!hook.events.includes(event)) {
        continue;
      }
      if (!matchesFilter(hook, workspaceId, featureId)) {
        continue;
      }
      this.enqueueWake(
        hook,
        event,
        payload,
        workspaceId,
        featureId,
        payload.rootRunId
      );
    }
  }

  /** Fire run-scoped wake hooks; never throws. */
  dispatchRunEvent(runId: string, event: WakeHookEvent): void {
    try {
      const ctx = this.resolveRunContext(runId);
      if (!ctx) {
        return;
      }
      const payload = this.buildRunPayload(event, ctx);
      this.dispatchPayload(event, payload, ctx.workspaceId, ctx.featureId);
    } catch {
      // Never let wake hooks interfere with notify/run lifecycle.
    }
  }

  /** Fire queue drain wake hooks; never throws. */
  dispatchQueueEvent(facts: { workspaceId: string }): void {
    try {
      const payload = this.buildQueuePayload({ workspaceId: facts.workspaceId });
      this.dispatchPayload(
        "queue_batch_complete",
        payload,
        facts.workspaceId,
        ""
      );
    } catch {
      // Never let wake hooks interfere with notify/run lifecycle.
    }
  }

  /**
   * Synthetic test doorbell for Settings. Ignores event filter, coalesce, and
   * actor suppression; still counts against maxPerHour.
   */
  async dispatchTest(
    hookId: string
  ): Promise<{ ok: true } | { ok: false; error: string } | null> {
    const hook = this.hooks.find((h) => h.id === hookId);
    if (hook == null) {
      return null;
    }
    const payload: WakeHookPayload = {
      source: "max",
      kind: "wake.test",
      correlation_id: `test:${this.now()}`,
      workspace: "",
      feature: "",
      rootRunId: "",
      host: this.hostName,
      outcome: "test",
      cursor: 0,
      next: "max doctor",
    };
    const ringBefore = this.rings.get(hook.id)?.length ?? 0;
    await this.deliverImmediate(hook, payload);
    const ring = this.rings.get(hook.id) ?? [];
    if (ring.length === ringBefore) {
      return { ok: false, error: "request" };
    }
    const last = ring.at(-1);
    if (last?.status === "success") {
      return { ok: true };
    }
    const error = last?.error ?? "request";
    return { ok: false, error };
  }

  /** Deliver without coalesce bookkeeping (test sends). */
  private async deliverImmediate(
    hook: ResolvedWakeHookConfig,
    payload: WakeHookPayload
  ): Promise<void> {
    const hourlyBucket = this.hourly.get(hook.id) ?? {
      deliveryTimes: [],
      dropped: 0,
    };
    if (this.isHourlyCapReached(hook, hourlyBucket)) {
      hourlyBucket.dropped++;
      this.hourly.set(hook.id, hourlyBucket);
      return;
    }

    let deliverPayload = payload;
    const dropped = hourlyBucket.dropped;
    if (dropped > 0) {
      deliverPayload = {
        ...payload,
        suppressed: (payload.suppressed ?? 0) + dropped,
      };
      hourlyBucket.dropped = 0;
      this.hourly.set(hook.id, hourlyBucket);
    }

    const success =
      hook.sink === "chat"
        ? await this.sendChat(hook, deliverPayload)
        : await this.sendHttp(hook, deliverPayload);

    if (!success) {
      return;
    }

    this.noteHourlyDelivery(hook.id);
  }
}

/** Factory helper wired from daemon startup. */
export function createWakeHookDispatcher(
  store: RunStore,
  onLog?: (message: string) => void,
  fetchImpl?: typeof fetch,
  now?: () => number
): WakeHookDispatcher {
  return new WakeHookDispatcher({
    getRun: (id) => store.getRun(id),
    parseChainContext: (row) => store.parseChainContext(row),
    getMaxGlobalEventId: () => store.getMaxGlobalEventId(),
    classifyOutcome: (rootRunId) =>
      classifyRootPipelineOutcome(store, rootRunId),
    findNewestActorEvent: (rootRunId, actorId) =>
      findNewestActorStampedEvent(store, rootRunId, actorId),
    onLog,
    fetchImpl,
    ...(now != null ? { now } : {}),
  });
}
