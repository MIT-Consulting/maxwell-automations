import {
  exitCodeForWatchUntilReason,
  isRoadmapIdCandidate,
  PIPELINE_WATCH_UNTIL_REASON_SET,
  type PipelineFeedEvent,
  type PipelineFeedResponse,
  type PipelineSnapshot,
  type PipelineWatchUntilReason,
  watchUntilReasonFromFeedEvent,
  watchUntilReasonFromSnapshot,
} from "@lca/shared";
import { DaemonClient } from "./client.js";
import { resolveRunId } from "./run-resolve.js";
import { resolveFeaturePipeline } from "./operator-target.js";
/** Matches daemon default long-poll wait (25 s). */
const SERVER_WAIT_SEC = 25;
/** Client abort must exceed each server long-poll wait. */
const FETCH_BUFFER_MS = 5_000;

export type ParsedWatchArgs =
  | {
      ok: true;
      target: string;
      workspaceQuery?: string;
      feature?: string;
      until: ReadonlySet<PipelineWatchUntilReason> | null;
      timeoutMs: number | null;
      since: number | null;
      json: boolean;
    }
  | { ok: false; message: string };

export type WatchJsonEnvelope = {
  rootRunId: string;
  snapshot: PipelineSnapshot;
  cursor: number;
  reason: PipelineWatchUntilReason | "timeout" | null;
  events?: PipelineFeedEvent[];
};

function parseDurationMs(raw: string): number | "invalid" {
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) return "invalid";
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return "invalid";
  const unit = match[2] ?? "s";
  switch (unit) {
    case "ms":
      return Math.floor(amount);
    case "s":
      return Math.floor(amount * 1000);
    case "m":
      return Math.floor(amount * 60_000);
    case "h":
      return Math.floor(amount * 3_600_000);
    default:
      return "invalid";
  }
}

export function parseWatchArgs(argv: readonly string[]): ParsedWatchArgs {
  let target: string | undefined;
  let feature: string | undefined;
  let workspaceQuery: string | undefined;
  let untilRaw: string | undefined;
  let timeoutRaw: string | undefined;
  let sinceRaw: string | undefined;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "-w" || arg === "--workspace") {
      workspaceQuery = argv[++i];
      if (!workspaceQuery?.trim()) {
        return { ok: false, message: "--workspace requires a value" };
      }
      continue;
    }
    if (arg === "--feature") {
      feature = argv[++i];
      if (!feature?.trim()) {
        return { ok: false, message: "--feature requires a value" };
      }
      feature = feature.trim();
      continue;
    }
    if (arg === "--until") {
      untilRaw = argv[++i];
      if (!untilRaw?.trim()) {
        return { ok: false, message: "--until requires a comma-separated list" };
      }
      continue;
    }
    if (arg === "--timeout") {
      timeoutRaw = argv[++i];
      if (!timeoutRaw?.trim()) {
        return { ok: false, message: "--timeout requires a duration" };
      }
      continue;
    }
    if (arg === "--since") {
      sinceRaw = argv[++i];
      if (!sinceRaw?.trim()) {
        return { ok: false, message: "--since requires a cursor id" };
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Unknown watch flag: ${arg}` };
    }
    if (target != null) {
      return { ok: false, message: "Only one watch target is allowed" };
    }
    target = arg;
  }

  if (target && feature) {
    return {
      ok: false,
      message: "Cannot combine a positional run/feature target with --feature",
    };
  }

  const effectiveTarget = target?.trim() ?? feature;
  if (!effectiveTarget) {
    return {
      ok: false,
      message:
        "Usage: max watch <feature-id|runId> [--feature <feature-id>] [-w <workspace>] [--until <csv>] [--timeout <dur>] [--since <cursor>] [--json]",
    };
  }

  let until: ReadonlySet<PipelineWatchUntilReason> | null = null;
  if (untilRaw != null) {
    const parts = untilRaw.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) {
      return { ok: false, message: "--until requires at least one reason" };
    }
    const set = new Set<PipelineWatchUntilReason>();
    for (const part of parts) {
      if (!PIPELINE_WATCH_UNTIL_REASON_SET.has(part)) {
        return { ok: false, message: `Unknown --until reason: ${part}` };
      }
      set.add(part as PipelineWatchUntilReason);
    }
    until = set;
  }

  let timeoutMs: number | null = null;
  if (timeoutRaw != null) {
    const parsed = parseDurationMs(timeoutRaw);
    if (parsed === "invalid") {
      return { ok: false, message: `Invalid --timeout duration: ${timeoutRaw}` };
    }
    timeoutMs = parsed;
  }

  let since: number | null = null;
  if (sinceRaw != null) {
    const n = Number(sinceRaw);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, message: `Invalid --since cursor: ${sinceRaw}` };
    }
    since = n;
  }

  return {
    ok: true,
    target: effectiveTarget,
    workspaceQuery: workspaceQuery?.trim(),
    feature,
    until,
    timeoutMs,
    since,
    json,
  };
}

function formatWatchLine(event: PipelineFeedEvent): string {
  const payloadKeys = Object.keys(event.payload);
  const payloadHint =
    payloadKeys.length > 0
      ? ` ${JSON.stringify(event.payload)}`
      : "";
  return `[${event.id}] ${event.kind} run=${event.runId.slice(0, 8)}${payloadHint}`;
}

function terminalOutcome(outcome: PipelineSnapshot["outcome"]): boolean {
  return outcome !== "running";
}

function pickMatchedUntilReason(
  snapshot: PipelineSnapshot,
  event: PipelineFeedEvent | null,
  until: ReadonlySet<PipelineWatchUntilReason>
): PipelineWatchUntilReason | null {
  if (event) {
    const fromEvent = watchUntilReasonFromFeedEvent(event);
    if (fromEvent != null && until.has(fromEvent)) {
      return fromEvent;
    }
  }
  const fromSnapshot = watchUntilReasonFromSnapshot(snapshot);
  if (fromSnapshot != null && until.has(fromSnapshot)) {
    return fromSnapshot;
  }
  return null;
}

async function resolveWatchRootRunId(
  client: DaemonClient,
  parsed: Extract<ParsedWatchArgs, { ok: true }>
): Promise<string> {
  if (isRoadmapIdCandidate(parsed.target)) {
    const resolved = await resolveFeaturePipeline(
      client,
      parsed.target,
      parsed.workspaceQuery
    );
    if (!parsed.json) {
      console.error(`rootRunId: ${resolved.rootRunId}`);
    }
    return resolved.rootRunId;
  }
  const rootRunId = await resolveRunId(client, parsed.target);
  if (!parsed.json) {
    console.error(`rootRunId: ${rootRunId}`);
  }
  return rootRunId;
}

export async function cmdWatch(
  client: DaemonClient,
  argv: readonly string[]
): Promise<number> {
  const parsed = parseWatchArgs(argv);
  if (!parsed.ok) {
    console.error(`Error: ${parsed.message}`);
    return 2;
  }

  const rootRunId = await resolveWatchRootRunId(client, parsed);
  let cursor = parsed.since ?? 0;
  const collectedEvents: PipelineFeedEvent[] = [];
  let lastResponse: PipelineFeedResponse | null = null;
  let exitReason: PipelineWatchUntilReason | "timeout" | null = null;
  const deadline =
    parsed.timeoutMs != null ? Date.now() + parsed.timeoutMs : null;
  let firstPoll = true;

  while (true) {
    if (deadline != null && Date.now() >= deadline) {
      exitReason = "timeout";
      break;
    }

    const remainingMs =
      deadline != null ? Math.max(0, deadline - Date.now()) : null;
    let serverWaitSec = firstPoll
      ? 0
      : remainingMs != null
        ? Math.min(SERVER_WAIT_SEC, Math.ceil(remainingMs / 1000))
        : SERVER_WAIT_SEC;
    firstPoll = false;

    const abortController = new AbortController();
    const fetchTimeoutMs = serverWaitSec * 1000 + FETCH_BUFFER_MS;
    let abortReason: "deadline" | "fetch" | null = null;
    const fetchTimer = setTimeout(() => {
      abortReason = "fetch";
      abortController.abort();
    }, fetchTimeoutMs);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    if (remainingMs != null) {
      deadlineTimer = setTimeout(() => {
        abortReason = "deadline";
        abortController.abort();
      }, remainingMs);
    }
    try {
      lastResponse = await client.pollPipelineFeed(
        rootRunId,
        cursor,
        serverWaitSec,
        abortController.signal
      );
    } catch (err) {
      if (
        abortReason === "deadline" ||
        (deadline != null && Date.now() >= deadline)
      ) {
        exitReason = "timeout";
        break;
      }
      throw err;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      clearTimeout(fetchTimer);
    }

    cursor = lastResponse.cursor;
    for (const event of lastResponse.events) {
      collectedEvents.push(event);
      if (!parsed.json) {
        console.log(formatWatchLine(event));
      }
      if (parsed.until) {
        const matched = pickMatchedUntilReason(
          lastResponse.snapshot,
          event,
          parsed.until
        );
        if (matched != null) {
          exitReason = matched;
          break;
        }
      }
    }
    if (exitReason != null) {
      break;
    }

    if (parsed.until) {
      const matched = pickMatchedUntilReason(
        lastResponse.snapshot,
        null,
        parsed.until
      );
      if (matched != null) {
        exitReason = matched;
        break;
      }
    } else if (terminalOutcome(lastResponse.snapshot.outcome)) {
      exitReason = watchUntilReasonFromSnapshot(lastResponse.snapshot);
      break;
    }
  }

  if (parsed.json) {
    const envelope: WatchJsonEnvelope = {
      rootRunId,
      snapshot: lastResponse?.snapshot ?? (await client.getPipelineSnapshot(rootRunId)),
      cursor,
      reason: exitReason,
      events: collectedEvents.length > 0 ? collectedEvents : undefined,
    };
    console.log(JSON.stringify(envelope));
  }

  return exitCodeForWatchUntilReason(exitReason);
}
