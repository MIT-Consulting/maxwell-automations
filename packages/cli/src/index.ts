#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, watch } from "node:fs";
import type {
  Automation,
  ChatStatus,
  DaemonStatus,
  InputRequest,
  Run,
  RunEscalationAction,
  WsServerMessage,
} from "@lca/shared";
import { RUN_ESCALATION_ACTIONS } from "@lca/shared";
import {
  DaemonClient,
  DaemonError,
  resolveWorkspaceId,
  type RunSnapshot,
} from "./client.js";
import { cmdImplementFully } from "./implement-fully.js";
import { cmdQueue } from "./queue.js";
import { formatInputRequest } from "./input-request.js";
import {
  formatWaveOperatorResponse,
  parseWaveArgs,
} from "./pipeline-wave.js";
import {
  buildPipelineLineage,
  CHAT_DOCTOR_KEY_EVENTS,
  collectPipelineDoctorFacts,
  diagnoseChat,
  diagnoseRun,
  DOCTOR_KEY_EVENTS,
  formatLineageBlockLines,
  formatPipelineBlockLines,
  formatPipelineHealthLines,
  formatFeatureQueueLines,
  resolveDoctorTarget,
  summarizeDiscoveryEvent,
  summarizeEvent,
  summarizeFeatureQueue,
  summarizePipelineHealth,
  summarizeRecoveryEvent,
} from "./doctor.js";
import {
  clearDevPid,
  DEV_LOG_PATH,
  findPortListenerPid,
  killPortOwner,
  killTree,
  portListening,
  readDevPid,
  spawnDevRig,
  waitForDashboardReady,
  type InstanceMode,
  VITE_PORT,
} from "./lifecycle.js";
import { parseListArgs, selectListEntries } from "./list.js";
import { initRoadmap } from "./roadmap.js";
import {
  addAllowedIps,
  ALL_INTERFACES_HOST,
  clearAllowedIps,
  configPath,
  disableRemote,
  enableRemote,
  ensureControlToken,
  isRemoteEnabled,
  isValidIp,
  readControlToken,
  readNetworkConfig,
  removeAllowedIps,
  resolveDenyTargets,
  tailscaleAddresses,
  tailscaleIp,
  type NetworkConfig,
} from "./remote.js";

const LCA_HOME = join(homedir(), ".cursor-local-automations");
const ENV_PATH = join(LCA_HOME, ".env");
const DAEMON_ERR_LOG = join(LCA_HOME, "daemon.err.log");

const DAEMON_LOG_TS_RE = /^\[lca-daemon ([^\]]+Z)\]\s/;

const ACTIVE_RUN_STATUSES: ReadonlyArray<Run["status"]> = [
  "queued",
  "running",
  "needs_input",
  "paused",
];

const TERMINAL: ReadonlyArray<Run["status"]> = [
  "completed",
  "failed",
  "cancelled",
];

function statusDot(status: Run["status"] | ChatStatus): string {
  switch (status) {
    case "running":
      return "▶";
    case "paused":
      return "⏸";
    case "needs_input":
      return "?";
    case "completed":
      return "✓";
    case "failed":
    case "error":
      return "✗";
    case "cancelled":
      return "⊘";
    case "queued":
      return "·";
    case "idle":
      return "✓";
    default:
      return "•";
  }
}

function parseDbTimestamp(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDaemonLogTimestamp(line: string): Date | null {
  const m = line.match(DAEMON_LOG_TS_RE);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function resolveDaemonLogPath(client: DaemonClient): Promise<string> {
  const live = await readLiveStatus(client);
  return live?.mode === "dev" ? DEV_LOG_PATH : DAEMON_ERR_LOG;
}

function readCorrelatedLogLines(
  logPath: string,
  windowStart: Date,
  windowEnd: Date,
  runId: string
): { lines: string[]; note?: string } {
  if (!existsSync(logPath)) {
    return { lines: [], note: `No log file at ${logPath}` };
  }
  try {
    const content = readFileSync(logPath, "utf8");
    const padMs = 5000;
    const from = windowStart.getTime() - padMs;
    const to = windowEnd.getTime() + padMs;
    const lines: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      if (line.includes(runId)) {
        lines.push(line);
        continue;
      }
      const ts = parseDaemonLogTimestamp(line);
      if (ts && ts.getTime() >= from && ts.getTime() <= to) {
        lines.push(line);
      }
    }
    return { lines };
  } catch {
    return { lines: [], note: `Could not read ${logPath}` };
  }
}

function readCursorApiKeyInfo(): string {
  if (!existsSync(ENV_PATH)) return "MISSING";
  try {
    const content = readFileSync(ENV_PATH, "utf8");
    const line = content
      .split(/\r?\n/)
      .find(
        (l) =>
          l.startsWith("CURSOR_API_KEY=") &&
          l.trim().length > "CURSOR_API_KEY=".length
      );
    if (!line) return "MISSING";
    const raw = line.slice("CURSOR_API_KEY=".length).trim();
    const value = raw.replace(/^["']|["']$/g, "");
    if (!value) return "MISSING";
    const prefix = value.slice(0, Math.min(6, value.length)) + "…";
    return `set (${prefix}, ${value.length} chars)`;
  } catch {
    return "MISSING";
  }
}

/**
 * Match an automation by (in order) exact internal id, the YAML-declared id
 * (`configKey`, e.g. "sample-hello"), exact name, or a unique id prefix.
 */
function resolveAutomation(automations: Automation[], query: string): Automation {
  const byId = automations.find((a) => a.id === query);
  if (byId) return byId;

  const lower = query.toLowerCase();
  const byConfigKey = automations.filter(
    (a) => a.configKey.toLowerCase() === lower
  );
  if (byConfigKey.length === 1) return byConfigKey[0];
  if (byConfigKey.length > 1) {
    throw new DaemonError(
      `"${query}" matches automations in multiple workspaces. Use the full id.`
    );
  }

  const byName = automations.filter((a) => a.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new DaemonError(`Multiple automations named "${query}". Use the id.`);
  }

  if (query.length >= 4) {
    const byPrefix = automations.filter((a) => a.id.startsWith(query));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) {
      throw new DaemonError(`Ambiguous id prefix "${query}". Be more specific.`);
    }
  }

  throw new DaemonError(`No automation matches "${query}".`);
}

async function resolveRunId(client: DaemonClient, query: string): Promise<string> {
  // Fast path: exact id is accepted directly by the daemon.
  try {
    const snap = await client.getRun(query);
    return snap.run.id;
  } catch {
    /* fall through to prefix match */
  }
  const runs = await client.listRuns();
  const matches = runs.filter((r) => r.id.startsWith(query));
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new DaemonError(`Ambiguous run id prefix "${query}".`);
  }
  throw new DaemonError(`No run matches "${query}".`);
}

async function cmdList(client: DaemonClient, args: string[]): Promise<void> {
  const { workspaceQuery } = parseListArgs(args);

  const workspaceId = workspaceQuery
    ? await resolveWorkspaceId(client, workspaceQuery)
    : undefined;

  const [allAutomations, allRuns, workspaces] = await Promise.all([
    client.listAutomations(),
    client.listRuns(50),
    client.listWorkspaces(),
  ]);

  const { automations, runs } = selectListEntries(
    allAutomations,
    allRuns,
    workspaceId
  );

  const wsName = new Map(workspaces.map((w) => [w.id, w.name ?? w.path]));

  console.log("Automations");
  if (automations.length === 0) {
    console.log("  (none configured)");
  }
  for (const a of automations) {
    const state = a.enabled ? "enabled" : "backlog";
    const ws = wsName.get(a.workspaceId) ?? a.workspaceId.slice(0, 8);
    console.log(
      `  ${statusDot(a.enabled ? "running" : "queued")} ${a.name}  [${state}]  ` +
        `${a.trigger.type}  ${ws}  (${a.configKey})`
    );
  }

  console.log("\nRecent runs");
  if (runs.length === 0) {
    console.log("  (none yet)");
  }
  const autoName = new Map(automations.map((a) => [a.id, a.name]));
  for (const r of runs) {
    const name = autoName.get(r.automationId) ?? r.automationId.slice(0, 8);
    console.log(
      `  ${statusDot(r.status)} ${r.status.padEnd(12)} ${name}  ` +
        `(${r.id.slice(0, 8)})  ${r.startedAt ?? r.createdAt}`
    );
  }
}

async function cmdEnable(
  client: DaemonClient,
  query: string,
  enabled: boolean
): Promise<void> {
  const automations = await client.listAutomations();
  const automation = resolveAutomation(automations, query);
  const updated = await client.setEnabled(automation.id, enabled);
  console.log(
    `${enabled ? "Enabled" : "Disabled"} "${updated.name}" → ${updated.status}`
  );
}

/**
 * Connect the live stream, run `start()` to obtain the runId, then stream that
 * run's events until it reaches a terminal state. The socket opens *before*
 * `start()` so events from a fast run are buffered, not missed. When
 * `options.prompt` is set, `needs_input` triggers an inline terminal prompt
 * whose answer funnels back through the Input Hub (the same path as dashboard).
 */
async function followRun(
  client: DaemonClient,
  start: () => Promise<string>,
  options: { prompt: boolean }
): Promise<Run["status"]> {
  const answered = new Set<string>();
  /** In-flight prompts; cleared whether answer succeeds or fails (D24). */
  const promptingIds = new Set<string>();
  let runId: string | null = null;
  const preconnect: WsServerMessage[] = [];
  let prompting = false;
  const buffered: string[] = [];

  const emit = (line: string): void => {
    if (prompting) buffered.push(line);
    else console.log(line);
  };
  const flush = (): void => {
    for (const line of buffered.splice(0)) console.log(line);
  };

  return new Promise<Run["status"]>((resolve, reject) => {
    const promptAnswer = async (request: InputRequest): Promise<void> => {
      if (!runId) return;
      prompting = true;
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const choices = request.metadata?.choices;
        const structured = Boolean(choices && choices.length > 0);
        const formatted = formatInputRequest(request);
        console.log(structured ? `\n${formatted}` : `\n? ${formatted}`);
        const reply = await rl.question("> ");
        const trimmed = reply.trim();
        if (structured && !trimmed) {
          console.log(
            `  Answer with one of: ${choices!.map((c) => c.id).join(", ")}`
          );
          return;
        }
        await client.answer(
          runId,
          structured ? trimmed : trimmed || "(no answer)"
        );
        answered.add(request.id);
        console.log("  (answer sent)\n");
      } catch (err) {
        console.error(
          `  Failed to send answer: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        rl.close();
        prompting = false;
        flush();
      }
    };

    const handle = (msg: WsServerMessage): void => {
      if (msg.type === "automation_event" || msg.type === "runs_deleted") return;
      if (!("runId" in msg) || msg.runId !== runId) return;
      if (msg.type === "run_event") {
        emit(
          `  ${msg.event.seq}  ${summarizeEvent(msg.event.eventType, msg.event.payload)}`
        );
      } else if (msg.type === "run_status") {
        emit(`  ${statusDot(msg.status)} status → ${msg.status}`);
        if (TERMINAL.includes(msg.status)) {
          socket.close();
          resolve(msg.status);
        }
      } else if (msg.type === "input_request" && options.prompt) {
        if (
          answered.has(msg.request.id) ||
          promptingIds.has(msg.request.id)
        ) {
          return;
        }
        promptingIds.add(msg.request.id);
        void promptAnswer(msg.request).finally(() => {
          promptingIds.delete(msg.request.id);
        });
      }
    };

    const onMessage = (msg: WsServerMessage): void => {
      if (runId === null) {
        preconnect.push(msg);
        return;
      }
      handle(msg);
    };

    const { socket, opened } = client.connect(onMessage);
    opened
      .then(() => start())
      .then((id) => {
        runId = id;
        // Replay anything that arrived between connect and trigger.
        for (const msg of preconnect.splice(0)) handle(msg);
      })
      .catch(reject);
  });
}

async function cmdRun(client: DaemonClient, query: string): Promise<void> {
  const automations = await client.listAutomations();
  const automation = resolveAutomation(automations, query);

  let announced = false;
  const finalStatus = await followRun(
    client,
    async () => {
      const runId = await client.triggerRun(automation.id);
      if (!announced) {
        announced = true;
        console.log(`Triggered "${automation.name}" → run ${runId.slice(0, 8)}\n`);
      }
      return runId;
    },
    { prompt: true }
  );
  console.log(`\nRun finished: ${finalStatus}`);
  process.exitCode = finalStatus === "completed" ? 0 : 1;
}

async function cmdDaemonLogs(follow: boolean): Promise<void> {
  const client = new DaemonClient();
  const live = await readLiveStatus(client);
  const logPath = live?.mode === "dev" ? DEV_LOG_PATH : DAEMON_ERR_LOG;
  if (!existsSync(logPath)) {
    console.error(`No log file at ${logPath}`);
    process.exitCode = 1;
    return;
  }
  if (!follow) {
    const { readFileSync } = await import("node:fs");
    process.stdout.write(readFileSync(logPath, "utf8"));
    return;
  }
  console.error(`Following ${logPath} (Ctrl+C to stop)…`);
  let offset = 0;
  const { statSync } = await import("node:fs");
  const pump = (): void => {
    try {
      const st = statSync(logPath);
      if (st.size > offset) {
        const stream = createReadStream(logPath, { start: offset, end: st.size });
        stream.pipe(process.stdout, { end: false });
        offset = st.size;
      }
    } catch {
      /* rotated or missing */
    }
  };
  pump();
  watch(logPath, () => pump());
  await new Promise<void>(() => {});
}

async function cmdLogs(
  client: DaemonClient,
  query: string,
  follow: boolean
): Promise<void> {
  const runId = await resolveRunId(client, query);
  const snapshot: RunSnapshot = await client.getRun(runId);

  console.log(`Run ${runId.slice(0, 8)} — status: ${snapshot.run.status}`);
  for (const ev of snapshot.events) {
    console.log(`  ${ev.seq}  ${summarizeEvent(ev.event_type, ev.payload)}`);
  }

  if (!follow || TERMINAL.includes(snapshot.run.status)) {
    return;
  }

  console.log("  … following (Ctrl+C to stop)");
  const lastSeq = snapshot.events.at(-1)?.seq ?? 0;
  await new Promise<void>((resolve, reject) => {
    const onMessage = (msg: WsServerMessage): void => {
      if (msg.type === "automation_event" || msg.type === "runs_deleted") return;
      if (!("runId" in msg) || msg.runId !== runId) return;
      if (msg.type === "run_event" && msg.event.seq > lastSeq) {
        console.log(
          `  ${msg.event.seq}  ${summarizeEvent(
            msg.event.eventType,
            msg.event.payload
          )}`
        );
      } else if (msg.type === "run_status") {
        console.log(`  ${statusDot(msg.status)} status → ${msg.status}`);
        if (TERMINAL.includes(msg.status)) {
          socket.close();
          resolve();
        }
      }
    };
    const { socket, opened } = client.connect(onMessage);
    opened.catch(reject);
  });
}

function printCorrelatedLogs(
  logPath: string,
  lines: string[],
  note?: string
): void {
  console.log(`\nCorrelated daemon log (${logPath}):`);
  if (note) {
    console.log(`  (${note})`);
  } else if (lines.length === 0) {
    console.log("  (no lines in window)");
  } else {
    for (const line of lines) console.log(`  ${line}`);
  }
}

async function cmdDoctorRun(
  client: DaemonClient,
  snapshot: RunSnapshot
): Promise<void> {
  const run = snapshot.run;
  const runId = run.id;

  const automations = await client.listAutomations();
  const automation = automations.find((a) => a.id === run.automation_id);
  const autoName = automation?.name ?? run.automation_id.slice(0, 8);

  console.log(`Run ${runId}`);
  console.log(`  status:     ${statusDot(run.status)} ${run.status}`);
  console.log(`  automation: ${autoName}`);
  console.log(`  trigger:    ${run.trigger_kind ?? "(unknown)"}`);
  console.log(`  started:    ${run.started_at ?? "(not started)"}`);
  console.log(`  ended:      ${run.ended_at ?? "(still active)"}`);

  const pipelineFacts = collectPipelineDoctorFacts(snapshot, automation);
  if (pipelineFacts) {
    console.log(`\nPipeline`);
    for (const line of formatPipelineBlockLines(pipelineFacts)) {
      console.log(line);
    }

    const listed = await client.listRuns(200);
    const autoById = new Map(automations.map((a) => [a.id, a]));
    const lineage = buildPipelineLineage(
      runId,
      pipelineFacts.rootRunId,
      listed,
      autoById
    );
    console.log(`\nLineage`);
    for (const line of formatLineageBlockLines(lineage)) {
      console.log(line);
    }
  }

  const otherEvents = snapshot.events.filter(
    (e) => !DOCTOR_KEY_EVENTS.has(e.event_type)
  );
  const tailNonKeySeqs = new Set(otherEvents.slice(-20).map((e) => e.seq));

  console.log(`\nEvents (${snapshot.events.length} total):`);
  let omitted = 0;
  let omissionPrinted = false;
  for (const ev of snapshot.events) {
    if (DOCTOR_KEY_EVENTS.has(ev.event_type)) {
      if (!omissionPrinted && omitted > 0) {
        console.log(`  … ${omitted} event(s) omitted`);
        omissionPrinted = true;
      }
      const keySummary =
        summarizeRecoveryEvent(ev.event_type, ev.payload) ??
        summarizeDiscoveryEvent(ev.event_type, ev.payload);
      if (keySummary !== undefined) {
        console.log(`  ${ev.seq}  ${keySummary}`);
      } else {
        console.log(`  ${ev.seq}  ${ev.event_type}`);
        console.log(`    ${ev.payload}`);
      }
    } else if (tailNonKeySeqs.has(ev.seq)) {
      if (!omissionPrinted && omitted > 0) {
        console.log(`  … ${omitted} event(s) omitted`);
        omissionPrinted = true;
      }
      console.log(`  ${ev.seq}  ${summarizeEvent(ev.event_type, ev.payload)}`);
    } else {
      omitted++;
    }
  }

  const logPath = await resolveDaemonLogPath(client);
  const start =
    parseDbTimestamp(run.started_at ?? run.created_at) ?? new Date();
  const end = parseDbTimestamp(run.ended_at) ?? new Date();
  const { lines, note } = readCorrelatedLogLines(logPath, start, end, runId);
  printCorrelatedLogs(logPath, lines, note);
  console.log(`\nVerdict: ${diagnoseRun(snapshot, lines)}`);
}

async function cmdDoctorChat(
  client: DaemonClient,
  snapshot: Awaited<ReturnType<DaemonClient["getChat"]>>
): Promise<void> {
  const { session, events } = snapshot;
  const chatId = session.id;
  const archived = session.archivedAt != null;

  console.log(`Chat ${chatId}`);
  console.log(`  title:      ${session.title ?? "(untitled)"}`);
  console.log(`  workspace:  ${session.workspaceId}`);
  console.log(`  status:     ${statusDot(session.status)} ${session.status}`);
  console.log(`  archived:   ${archived ? `yes (${session.archivedAt})` : "no"}`);
  console.log(`  created:    ${session.createdAt}`);
  console.log(`  updated:    ${session.updatedAt}`);
  if (session.lastMessageAt) {
    console.log(`  last msg:   ${session.lastMessageAt}`);
  }

  const otherEvents = events.filter(
    (e) => !CHAT_DOCTOR_KEY_EVENTS.has(e.eventType)
  );
  const tailNonKeySeqs = new Set(otherEvents.slice(-20).map((e) => e.seq));

  console.log(`\nEvents (${events.length} total):`);
  let omitted = 0;
  let omissionPrinted = false;
  for (const ev of events) {
    if (CHAT_DOCTOR_KEY_EVENTS.has(ev.eventType)) {
      if (!omissionPrinted && omitted > 0) {
        console.log(`  … ${omitted} event(s) omitted`);
        omissionPrinted = true;
      }
      console.log(`  ${ev.seq}  ${ev.eventType}`);
      console.log(`    ${ev.payload}`);
    } else if (tailNonKeySeqs.has(ev.seq)) {
      if (!omissionPrinted && omitted > 0) {
        console.log(`  … ${omitted} event(s) omitted`);
        omissionPrinted = true;
      }
      console.log(`  ${ev.seq}  ${summarizeEvent(ev.eventType, ev.payload)}`);
    } else {
      omitted++;
    }
  }

  const firstTs = events[0]?.createdAt;
  const lastTs = events.at(-1)?.createdAt;
  const start =
    parseDbTimestamp(firstTs ?? session.createdAt) ?? new Date();
  const end = parseDbTimestamp(lastTs ?? session.updatedAt) ?? new Date();
  const logPath = await resolveDaemonLogPath(client);
  const { lines, note } = readCorrelatedLogLines(logPath, start, end, chatId);
  printCorrelatedLogs(logPath, lines, note);
  console.log(`\nVerdict: ${diagnoseChat(snapshot, lines)}`);
}

async function cmdDoctorHealth(client: DaemonClient): Promise<void> {
  const live = await readLiveStatus(client);

  console.log("Daemon health");
  if (!live) {
    const devPid = readDevPid();
    if (devPid) {
      console.log(`  not responding (dev rig pid ${devPid} may be starting)`);
      console.log(`  logs: ${DEV_LOG_PATH}`);
    } else {
      console.log(`  not running at ${client.base}`);
      console.log(`  log:  ${DAEMON_ERR_LOG}`);
    }
  } else {
    console.log(`  running (${live.mode.toUpperCase()} mode)`);
    console.log(`  uptime: ${formatUptime(live.uptimeMs)} (since ${live.startedAt})`);
    const logPath = live.mode === "dev" ? DEV_LOG_PATH : DAEMON_ERR_LOG;
    console.log(`  log:    ${logPath}`);
  }

  console.log(`\nCURSOR_API_KEY: ${readCursorApiKeyInfo()}`);

  const logPath = await resolveDaemonLogPath(client);
  let logContent: string | null = null;
  if (existsSync(logPath)) {
    try {
      logContent = readFileSync(logPath, "utf8");
    } catch {
      /* degrade */
    }
  }

  const correlateFromContent = (
    run: Run,
    content: string | null
  ): string[] => {
    if (!content) return [];
    const start =
      parseDbTimestamp(run.startedAt ?? run.createdAt) ?? new Date();
    const end = parseDbTimestamp(run.endedAt) ?? new Date();
    const padMs = 5000;
    const from = start.getTime() - padMs;
    const to = end.getTime() + padMs;
    const lines: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line) continue;
      if (line.includes(run.id)) {
        lines.push(line);
        continue;
      }
      const ts = parseDaemonLogTimestamp(line);
      if (ts && ts.getTime() >= from && ts.getTime() <= to) {
        lines.push(line);
      }
    }
    return lines;
  };

  const runs = await client.listRuns(100);

  console.log("\nPipelines");
  for (const line of formatPipelineHealthLines(summarizePipelineHealth(runs))) {
    console.log(line);
  }

  console.log("\nQueue");
  try {
    const queueEntries = await client.listFeatureQueue();
    for (const line of formatFeatureQueueLines(
      summarizeFeatureQueue(queueEntries)
    )) {
      console.log(line);
    }
  } catch {
    console.log("  (queue status unavailable — daemon may need restart)");
  }

  const failed = runs.filter((r) => r.status === "failed").slice(0, 5);

  console.log("\nRecent failures");
  if (failed.length === 0) {
    console.log("  (no recent failures)");
    return;
  }

  const autoName = new Map(
    (await client.listAutomations()).map((a) => [a.id, a.name])
  );

  for (const r of failed) {
    const snap = await client.getRun(r.id);
    const correlated = correlateFromContent(r, logContent);
    const cause = diagnoseRun(snap, correlated);
    const name = autoName.get(r.automationId) ?? r.automationId.slice(0, 8);
    console.log(
      `  ${statusDot("failed")} ${r.id.slice(0, 8)}  ${name}  ${r.startedAt ?? r.createdAt}`
    );
    console.log(`    ${cause}`);
  }
}

async function cmdDoctor(
  client: DaemonClient,
  query: string | undefined
): Promise<void> {
  if (query) {
    const target = await resolveDoctorTarget(client, query);
    if (target.kind === "run") {
      await cmdDoctorRun(client, target.snapshot);
    } else {
      await cmdDoctorChat(client, target.snapshot);
    }
  } else {
    await cmdDoctorHealth(client);
  }
}

async function cmdAnswer(
  client: DaemonClient,
  query: string,
  inlineAnswer: string | undefined
): Promise<void> {
  const runId = await resolveRunId(client, query);

  let answer = inlineAnswer;
  if (!answer) {
    const snapshot = await client.getRun(runId);
    const pending = snapshot.inputRequests.find((r) => r.status === "pending");
    if (pending) {
      const formatted = formatInputRequest({
        ...pending,
        status: pending.status as InputRequest["status"],
      });
      const structured = Boolean(pending.metadata?.choices?.length);
      console.log(structured ? formatted : `? ${formatted}`);
    }
    const rl = createInterface({ input: stdin, output: stdout });
    answer = await rl.question("> ");
    rl.close();
  }

  await client.answer(runId, (answer ?? "").trim());
  console.log(`Answer sent to run ${runId.slice(0, 8)}.`);
}

async function promptForText(): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  const text = await rl.question("> ");
  rl.close();
  return text.trim();
}

async function cmdCancel(client: DaemonClient, query: string): Promise<void> {
  const runId = await resolveRunId(client, query);
  await client.cancel(runId);
  console.log(`Cancelled run ${runId.slice(0, 8)}.`);
}

async function cmdPause(client: DaemonClient, query: string): Promise<void> {
  const runId = await resolveRunId(client, query);
  await client.pause(runId);
  console.log(`Paused run ${runId.slice(0, 8)} (status: paused).`);
}

async function cmdResume(
  client: DaemonClient,
  query: string,
  inlineNote: string | undefined
): Promise<void> {
  const runId = await resolveRunId(client, query);
  const note = inlineNote?.trim() || undefined;
  await client.resume(runId, note);
  console.log(`Resumed run ${runId.slice(0, 8)} (status: running).`);
}

function parseEscalateArgs(args: string[]): {
  runQuery: string;
  action: RunEscalationAction;
  reason?: string;
} {
  const positional: string[] = [];
  let reason: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--reason") {
      const value = args[++i];
      if (!value || value.startsWith("-")) {
        throw new DaemonError("Usage: lca escalate <runId> retry|skip|abort [--reason <text>]");
      }
      reason = value;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new DaemonError(
        `Unknown flag "${arg}". Usage: lca escalate <runId> retry|skip|abort [--reason <text>]`
      );
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new DaemonError(
      "Usage: lca escalate <runId> retry|skip|abort [--reason <text>]"
    );
  }
  const [runQuery, actionRaw] = positional;
  if (
    !(RUN_ESCALATION_ACTIONS as readonly string[]).includes(actionRaw!)
  ) {
    throw new DaemonError(
      `Invalid action "${actionRaw}". Valid: ${RUN_ESCALATION_ACTIONS.join(", ")}`
    );
  }
  return {
    runQuery: runQuery!,
    action: actionRaw as RunEscalationAction,
    ...(reason !== undefined ? { reason } : {}),
  };
}

async function cmdEscalate(
  client: DaemonClient,
  args: string[]
): Promise<void> {
  const { runQuery, action, reason } = parseEscalateArgs(args);
  const target = await resolveDoctorTarget(client, runQuery);
  if (target.kind !== "run") {
    throw new DaemonError(
      `Escalate requires a run id; "${runQuery}" matched a chat.`
    );
  }
  const runId = target.snapshot.run.id;
  const response = await client.escalate(runId, {
    action,
    ...(reason !== undefined ? { reason } : {}),
  });
  if (response.childRunId) {
    console.log(
      `Escalated ${action} on run ${runId.slice(0, 8)} → new run ${response.childRunId.slice(0, 8)}`
    );
  } else if (response.stopReason) {
    console.log(
      `Escalated abort on run ${runId.slice(0, 8)}: ${response.stopReason}`
    );
  } else {
    console.log(`Escalated ${action} on run ${runId.slice(0, 8)}.`);
  }
}

async function cmdWave(client: DaemonClient, args: string[]): Promise<void> {
  const { waveId, action, reason } = parseWaveArgs(args);
  const response = await client.waveAction(waveId, {
    action,
    ...(reason !== undefined ? { reason } : {}),
  });
  console.log(formatWaveOperatorResponse(response));
}

async function cmdMessage(
  client: DaemonClient,
  query: string,
  inlineText: string | undefined
): Promise<void> {
  const runId = await resolveRunId(client, query);
  const { status } = (await client.getRun(runId)).run;

  if (status === "needs_input") {
    throw new DaemonError(
      "Run is waiting for input. Use: lca answer <runId> [text…]"
    );
  }
  if (status === "queued") {
    throw new DaemonError(
      "Run has not started yet (status: queued). Wait for it to begin running."
    );
  }

  let message = inlineText?.trim();
  if (!message) {
    message = await promptForText();
  }
  if (!message) {
    throw new DaemonError("Message is required.");
  }

  if (status === "running") {
    await client.queueMessage(runId, message);
    console.log(`Message queued for run ${runId.slice(0, 8)}.`);
    return;
  }

  if (TERMINAL.includes(status)) {
    await client.sendMessage(runId, message);
    console.log(`Follow-up sent to run ${runId.slice(0, 8)}.`);
    return;
  }

  throw new DaemonError(`Cannot send message while run status is "${status}".`);
}

async function cmdInterrupt(
  client: DaemonClient,
  query: string,
  inlineText: string | undefined
): Promise<void> {
  const runId = await resolveRunId(client, query);
  const { status } = (await client.getRun(runId)).run;

  if (status === "needs_input") {
    throw new DaemonError(
      "Run is waiting for input. Use: lca answer <runId> [text…]"
    );
  }

  let message = inlineText?.trim();
  if (!message) {
    message = await promptForText();
  }
  if (!message) {
    throw new DaemonError("Message is required.");
  }

  await client.interrupt(runId, message);
  console.log(`Interrupt sent to run ${runId.slice(0, 8)}.`);
}

async function cmdExport(client: DaemonClient, args: string[]): Promise<void> {
  let format: "json" | "csv" = "json";
  let outFile: string | undefined;
  let workspaceQuery: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--format" || arg === "-f") {
      const value = args[++i];
      if (value !== "json" && value !== "csv") {
        throw new DaemonError("--format must be 'json' or 'csv'");
      }
      format = value;
    } else if (arg === "--out" || arg === "-o") {
      outFile = args[++i];
      if (!outFile) throw new DaemonError("--out requires a file path");
    } else if (arg === "--workspace" || arg === "-w") {
      workspaceQuery = args[++i];
      if (!workspaceQuery) throw new DaemonError("--workspace requires an id|name");
    } else {
      throw new DaemonError(`Unknown export option: ${arg}`);
    }
  }

  const workspaceId = workspaceQuery
    ? await resolveWorkspaceId(client, workspaceQuery)
    : undefined;
  const data = await client.exportRuns(format, workspaceId);

  if (outFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outFile, data, "utf8");
    console.error(`Wrote ${format} run history to ${outFile}`);
  } else {
    process.stdout.write(data.endsWith("\n") ? data : `${data}\n`);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** True if the daemon answers its health check. */
async function daemonReachable(client: DaemonClient): Promise<boolean> {
  try {
    const health = await client.health();
    return health.ok === true;
  } catch {
    return false;
  }
}

/**
 * Poll `/health` until the daemon reaches the desired liveness (`up` or `down`)
 * or the timeout elapses. Returns whether the target state was observed.
 */
async function waitForDaemon(
  client: DaemonClient,
  target: "up" | "down",
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await daemonReachable(client);
    if ((target === "up" && up) || (target === "down" && !up)) return true;
    await sleep(250);
  }
  return false;
}

function parseModeFlag(arg: string | undefined): InstanceMode | undefined {
  if (arg === "dev") return "dev";
  if (arg === "prod") return "prod";
  return undefined;
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Bracket IPv6 literals so they're valid in a URL authority. */
function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

/**
 * The host to print in a reachable URL: prefer an explicitly configured specific
 * (non-loopback, non-wildcard) bind host; otherwise the first detected Tailscale
 * candidate. Returns undefined when nothing usable is known.
 */
function reachableUrlHost(host: string, candidates: string[]): string | undefined {
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  const wildcard = host === ALL_INTERFACES_HOST || host === "::";
  if (host && !loopback && !wildcard) return host;
  return candidates[0];
}

function dashboardUrls(status: DaemonStatus): void {
  const port = String(status.port);
  console.log(`  dashboard:  http://127.0.0.1:${port}/`);
  if (isRemoteEnabled({ host: status.host, allowedIps: [...status.allowedIps] })) {
    const host = reachableUrlHost(status.host, tailscaleAddresses());
    if (host) {
      console.log(`  phone:      http://${formatUrlHost(host)}:${port}/`);
    }
  }
}

async function readLiveStatus(
  client: DaemonClient
): Promise<DaemonStatus | null> {
  try {
    return await client.status();
  } catch {
    return null;
  }
}

async function currentMode(client: DaemonClient): Promise<InstanceMode | null> {
  const live = await readLiveStatus(client);
  if (live) return live.mode;
  if (readDevPid()) return "dev";
  // A daemon that answers /health but not /api/status is an older build with no
  // status endpoint. Treat it as a running prod instance so restart tears it
  // down — otherwise cmdRestart sees "no mode", skips teardown, and cmdUp loops
  // back into cmdRestart forever (reachable=prod vs currentMode=null mismatch).
  if (await daemonReachable(client)) return "prod";
  return null;
}

async function cancelActiveRuns(client: DaemonClient): Promise<number> {
  const runs = await client.listRuns(500);
  let n = 0;
  for (const run of runs) {
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) continue;
    try {
      await client.cancel(run.id);
      console.log(`  cancel ${run.id.slice(0, 8)} (${run.status})`);
      n++;
    } catch (err) {
      console.warn(
        `  cancel failed ${run.id.slice(0, 8)}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  return n;
}

function hardKillPortListener(port: number): boolean {
  const pid = findPortListenerPid(port);
  if (!pid) return true;
  try {
    const name = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: "utf8",
    });
    if (!name.toLowerCase().includes("node")) {
      console.warn(
        `Port ${port} held by PID ${pid} (not node). Refusing to kill.`
      );
      return false;
    }
  } catch {
    /* tasklist failed — proceed cautiously */
  }
  if (process.platform === "win32") {
    killTree(pid);
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  return true;
}

async function cmdStatus(client: DaemonClient): Promise<void> {
  const live = await readLiveStatus(client);

  if (!live) {
    const devPid = readDevPid();
    if (devPid) {
      console.log(`Daemon: not responding (dev rig pid ${devPid} may be starting)`);
      console.log(`  logs: ${DEV_LOG_PATH}`);
    } else {
      console.log(`Daemon: not running at ${client.base}`);
    }
    return;
  }

  console.log(`Daemon: running (${live.mode.toUpperCase()} mode)`);
  console.log(`  pid:        ${live.pid}`);
  console.log(`  url:        ${client.base}`);
  console.log(`  uptime:     ${formatUptime(live.uptimeMs)} (since ${live.startedAt})`);
  console.log(`  version:    ${live.version}`);

  const remoteOn = isRemoteEnabled({
    host: live.host,
    allowedIps: [...live.allowedIps],
  });
  console.log(`  remote:     ${remoteOn ? "ON" : "OFF (loopback-only)"}`);
  console.log(`  host:       ${live.host}`);
  console.log(
    `  allowedIps: ${
      live.allowedIps.length > 0
        ? live.allowedIps.join(", ")
        : remoteOn
          ? "(none — any reachable device)"
          : "(n/a)"
    }`
  );
  dashboardUrls(live);
  if (live.mode === "dev") {
    console.log(`  dev logs:   ${DEV_LOG_PATH}`);
    console.log(`              tail: lca logs --daemon -f`);
  } else {
    console.log(`  daemon log: ${DAEMON_ERR_LOG}`);
  }

  const [automations, runs, workspaces] = await Promise.all([
    client.listAutomations(),
    client.listRuns(500),
    client.listWorkspaces(),
  ]);
  const enabled = automations.filter((a) => a.enabled).length;
  const byStatus = new Map<string, number>();
  for (const r of runs) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }
  console.log(`\nAutomations: ${automations.length} (${enabled} enabled)`);
  console.log(`Workspaces:  ${workspaces.length}`);
  if (byStatus.size === 0) {
    console.log("Runs:        (none)");
  } else {
    const parts = [...byStatus.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, n]) => `${s}=${n}`);
    console.log(`Runs:        ${parts.join(", ")}`);
  }
}

/**
 * Locate the built daemon entrypoint. The CLI ships next to the daemon in the
 * monorepo, so resolve `packages/cli/dist → packages/daemon/dist/index.js`.
 */
function resolveDaemonEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "..", "..", "daemon", "dist", "index.js");
  if (existsSync(candidate)) return candidate;
  throw new DaemonError(
    `Could not find the daemon at ${candidate}. Build it first: npm run build`
  );
}

/**
 * POSIX: detach into a new session so the daemon outlives this CLI process, and
 * pipe stdout/stderr to log files since nothing reads them once we exit.
 */
function spawnDaemonPosix(
  entry: string,
  outPath: string,
  errPath: string
): number | undefined {
  const out = openSync(outPath, "a");
  const err = openSync(errPath, "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();
  return child.pid;
}

/**
 * Windows: launch via `Start-Process -WindowStyle Hidden` instead of Node's
 * `detached`.
 *
 * Node's `detached: true` sets the DETACHED_PROCESS flag, which leaves the
 * daemon with NO console. Every console process the daemon transitively spawns
 * (the SDK's `cursor-agent`, and every shell it runs per tool call) is then
 * forced to allocate its own new console *window*, so a command window pops up
 * for each one. `windowsHide` only suppresses the daemon's own window, not its
 * descendants'. But dropping `detached` makes the daemon die when the CLI's job
 * object closes.
 *
 * `Start-Process -WindowStyle Hidden` threads the needle: it creates a process
 * that (a) gets its own hidden console the entire descendant tree inherits — so
 * no popups — and (b) breaks away from the CLI's kill-on-close job object, so
 * the daemon survives the CLI exiting.
 *
 * The PowerShell launcher itself is spawned with `windowsHide: true` (NOT
 * `detached`): `windowsHide` maps to CREATE_NO_WINDOW, which gives PowerShell a
 * hidden-but-present console. `Start-Process` needs that console — under
 * `detached` (DETACHED_PROCESS) PowerShell has no console at all and
 * `Start-Process` silently fails to launch anything. `stdio: "ignore"` keeps the
 * daemon off the CLI's console pipe (otherwise the terminal blocks on the shared
 * handle), and `unref()` lets the CLI exit as soon as /health is reachable. The
 * daemon's own stdout/stderr are redirected to the log files by `Start-Process`,
 * so no PID is returned here (see the logs / health endpoint).
 */
function spawnDaemonWindows(
  entry: string,
  outPath: string,
  errPath: string
): number | undefined {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Quote the entry arg explicitly; -ArgumentList does not auto-quote elements.
    "$argLine = '\"' + $env:LCA_DAEMON_ENTRY + '\"'",
    "Start-Process -FilePath $env:LCA_NODE_EXE -ArgumentList $argLine -WindowStyle Hidden -RedirectStandardOutput $env:LCA_DAEMON_OUT -RedirectStandardError $env:LCA_DAEMON_ERR | Out-Null",
  ].join("; ");

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        LCA_NODE_EXE: process.execPath,
        LCA_DAEMON_ENTRY: entry,
        LCA_DAEMON_OUT: outPath,
        LCA_DAEMON_ERR: errPath,
      },
    }
  );
  child.unref();
  return undefined;
}

type UpOptions = {
  /** Target mode when starting or switching. */
  mode: InstanceMode;
  /** User passed `dev` or `prod` explicitly (not bare `up`). */
  explicit: boolean;
};

async function cmdUpProd(client: DaemonClient): Promise<void> {
  const entry = resolveDaemonEntry();
  mkdirSync(LCA_HOME, { recursive: true });
  const outLogPath = join(LCA_HOME, "daemon.out.log");
  const errLogPath = join(LCA_HOME, "daemon.err.log");

  const pid =
    process.platform === "win32"
      ? spawnDaemonWindows(entry, outLogPath, errLogPath)
      : spawnDaemonPosix(entry, outLogPath, errLogPath);

  console.log("Starting daemon (prod)…");
  if (await waitForDaemon(client, "up", 45_000)) {
    const live = await readLiveStatus(client);
    console.log(
      `Daemon ready at ${client.base}${pid ? ` (pid ${pid})` : ""}; logs: ${errLogPath}`
    );
    if (live) dashboardUrls(live);
  } else {
    console.error(
      `Daemon did not become ready in time. Check logs: ${errLogPath}`
    );
    process.exitCode = 1;
  }
}

async function cmdUpDev(client: DaemonClient): Promise<void> {
  console.log("Starting dev stack (tsc watch + daemon + Vite)…");
  spawnDevRig();
  if (await waitForDashboardReady(client.base, 120_000)) {
    const live = await readLiveStatus(client);
    console.log(`Dev ready at ${client.base}`);
    if (live) dashboardUrls(live);
    console.log(`  logs: lca logs --daemon -f  (${DEV_LOG_PATH})`);
  } else {
    console.error(
      `Dev stack did not become ready in time. Check ${DEV_LOG_PATH}`
    );
    process.exitCode = 1;
  }
}

async function cmdUp(client: DaemonClient, options: UpOptions): Promise<void> {
  const { mode: requested, explicit } = options;
  const reachable = await daemonReachable(client);
  const live = reachable ? await readLiveStatus(client) : null;
  const running = live?.mode ?? (reachable ? "prod" : null);

  if (running) {
    if (explicit && running !== requested) {
      await cmdRestart(client, requested);
      return;
    }
    if (explicit && running === requested) {
      console.log(`Already up in ${running} mode.\n`);
      await cmdStatus(client);
      const other = running === "dev" ? "prod" : "dev";
      console.log(`\nSwitch mode: lca up ${other}`);
      return;
    }
    // Bare `up` while running — status + suggest opposite mode, never tear down.
    await cmdStatus(client);
    const other = running === "dev" ? "prod" : "dev";
    const hint =
      running === "prod"
        ? "For hot reload while editing: lca up dev"
        : "For a prod-build preview: lca up prod";
    console.log(`\n${hint}  (or: lca restart ${other})`);
    return;
  }

  if (requested === "dev") {
    await cmdUpDev(client);
  } else {
    await cmdUpProd(client);
  }
}

async function cmdDownDev(client: DaemonClient): Promise<void> {
  const pid = readDevPid();
  if (pid) {
    console.log(`Stopping dev rig (pid ${pid})…`);
    killTree(pid);
    clearDevPid();
  } else {
    console.log("No dev.pid — stopping port listeners…");
  }
  await waitForDaemon(client, "down", 20_000);
  await killPortOwner(VITE_PORT);
  if (await portListening(Number(daemonPort(client)))) {
    const port = Number(daemonPort(client));
    if (!hardKillPortListener(port)) {
      process.exitCode = 1;
      return;
    }
    await sleep(500);
  }
  console.log("Dev stack stopped.");
}

async function cmdDownProd(
  client: DaemonClient,
  options: { forRestart?: boolean } = {}
): Promise<void> {
  if (!(await daemonReachable(client))) {
    const port = Number(daemonPort(client));
    if (hardKillPortListener(port)) {
      console.log("Daemon port cleared.");
    } else {
      console.log(`Daemon is not running at ${client.base}.`);
    }
    return;
  }

  console.log("Cancelling active runs…");
  const n = await cancelActiveRuns(client);
  console.log(`Cancelled ${n} active run(s).`);
  if (n > 0 && !options.forRestart) {
    console.warn(
      "lca down stops the daemon. To restart after a build, use lca restart (not down then up)."
    );
  }

  try {
    await client.shutdown();
  } catch (err) {
    if (!(err instanceof DaemonError)) throw err;
  }

  if (await waitForDaemon(client, "down", 15_000)) {
    console.log("Daemon stopped.");
    return;
  }

  console.warn("Graceful shutdown timed out — hard kill…");
  const port = Number(daemonPort(client));
  if (hardKillPortListener(port)) {
    await waitForDaemon(client, "down", 10_000);
    console.log("Daemon stopped (forced).");
  } else {
    console.error("Daemon did not stop in time.");
    process.exitCode = 1;
  }
}

async function cmdDown(
  client: DaemonClient,
  options: { forRestart?: boolean } = {}
): Promise<void> {
  const mode = (await currentMode(client)) ?? (readDevPid() ? "dev" : null);
  if (!mode && !(await daemonReachable(client))) {
    console.log(`Daemon is not running at ${client.base}.`);
    return;
  }
  if (mode === "dev") {
    await cmdDownDev(client);
  } else {
    await cmdDownProd(client, options);
  }
}

async function cmdRestart(
  client: DaemonClient,
  target?: InstanceMode
): Promise<void> {
  const current = await currentMode(client);
  const mode = target ?? current ?? "prod";
  if (current) {
    console.log(`Restarting (${current} → ${mode})…`);
    await cmdDown(client, { forRestart: true });
    await sleep(500);
  }
  await cmdUp(client, { mode, explicit: true });
}

function daemonPort(client: DaemonClient): string {
  try {
    return new URL(client.base).port || "3747";
  } catch {
    return "3747";
  }
}

function printNetworkConfig(client: DaemonClient, cfg: NetworkConfig): void {
  const on = isRemoteEnabled(cfg);
  console.log(`Remote access: ${on ? "ON" : "OFF (loopback-only)"}`);
  console.log(`  app-auth:   ${readControlToken() !== undefined ? "ON" : "OFF"}`);
  console.log(`  host:       ${cfg.host}`);
  console.log(
    `  allowedIps: ${
      cfg.allowedIps.length > 0
        ? `${cfg.allowedIps.length} device(s) — lca remote allowed`
        : "(none — any reachable device may connect)"
    }`
  );
  console.log(`  config:     ${configPath()}`);
  if (on) {
    const host = reachableUrlHost(cfg.host, tailscaleAddresses());
    if (host) {
      console.log(
        `  open on an allowed device: http://${formatUrlHost(host)}:${daemonPort(client)}`
      );
    }
    if (cfg.allowedIps.length === 0) {
      console.log(
        "  WARNING: no allowlist set — restrict to a device with: lca remote allow <ip>"
      );
    }
  }
}

function assertIps(ips: string[]): void {
  for (const ip of ips) {
    if (!isValidIp(ip)) {
      throw new DaemonError(`"${ip}" is not a valid IP address.`);
    }
  }
}

function printAllowedList(allowedIps: string[]): void {
  if (allowedIps.length === 0) {
    console.log("Device allowlist: (empty)");
    console.log("  Add a device: lca remote allow <ip>");
    return;
  }
  console.log("Device allowlist:");
  for (let i = 0; i < allowedIps.length; i++) {
    console.log(`  ${i + 1}. ${allowedIps[i]}`);
  }
  console.log("  Remove: lca remote deny <n>  or  lca remote deny <ip>");
  console.log("  Clear all: lca remote deny --all");
}

/**
 * Network settings are read once at daemon startup, so a change only takes
 * effect after a restart. Restart automatically when the daemon is live (unless
 * `--no-restart`); otherwise the change applies on the next `lca up`.
 */
async function applyNetworkChange(
  client: DaemonClient,
  restart: boolean
): Promise<void> {
  if (!(await daemonReachable(client))) {
    console.log("Daemon not running — change applies on next `lca up`.");
    return;
  }
  if (!restart) {
    console.log("Daemon is running — restart to apply: lca restart");
    return;
  }
  console.log("Restarting daemon to apply…");
  await cmdRestart(client);
}

async function cmdRemote(client: DaemonClient, rawArgs: string[]): Promise<void> {
  const restart = !rawArgs.includes("--no-restart");
  const insecureAny = rawArgs.includes("--insecure-any");
  const args = rawArgs.filter(
    (arg) => arg !== "--no-restart" && arg !== "--insecure-any"
  );
  const [sub, ...rest] = args;

  switch (sub ?? "status") {
    case "status":
    case undefined:
      printNetworkConfig(client, readNetworkConfig());
      return;
    case "on": {
      if (rest.length === 0 && !insecureAny) {
        throw new DaemonError(
          "Usage: lca remote on <ip…>  (or lca remote on --insecure-any to bind all interfaces with no device allowlist)"
        );
      }
      assertIps(rest);
      // The bind target is THIS machine's address peers connect to (auto-detected),
      // not the device allowlist in `rest`. `--insecure-any` keeps the broad bind.
      let bindHost: string;
      if (insecureAny) {
        bindHost = ALL_INTERFACES_HOST;
      } else {
        const detected = tailscaleIp();
        if (!detected) {
          throw new DaemonError(
            "Could not detect a Tailscale address to bind to. Re-run with " +
              "`lca remote on <ip…> --insecure-any` to bind all interfaces (0.0.0.0)."
          );
        }
        bindHost = detected;
      }
      const next = enableRemote(bindHost, rest);
      console.log("Remote access enabled.");
      const { token, created } = ensureControlToken();
      if (created) {
        console.log("");
        console.log("Control token (app-auth) — SAVE THIS, it won't be shown again:");
        console.log(`  ${token}`);
        console.log(
          "  Send it as the X-LCA-Control-Token header (or /ws?token=) from remote devices."
        );
        console.log("");
      } else {
        console.log("App-auth already provisioned (token unchanged, not reprinted).");
      }
      printNetworkConfig(client, next);
      await applyNetworkChange(client, restart);
      return;
    }
    case "off": {
      const next = disableRemote();
      console.log("Remote access disabled (loopback-only).");
      printNetworkConfig(client, next);
      await applyNetworkChange(client, restart);
      return;
    }
    case "allow": {
      if (rest.length === 0) {
        throw new DaemonError("Usage: lca remote allow <ip…>");
      }
      assertIps(rest);
      const next = addAllowedIps(rest);
      console.log(`Allowed: ${rest.join(", ")}`);
      printNetworkConfig(client, next);
      await applyNetworkChange(client, restart);
      return;
    }
    case "allowed": {
      printAllowedList(readNetworkConfig().allowedIps);
      return;
    }
    case "deny": {
      if (rest.length === 0) {
        throw new DaemonError(
          "Usage: lca remote deny <n…|ip…>  |  lca remote deny --all  (list: lca remote allowed)"
        );
      }
      const cfg = readNetworkConfig();
      let resolved: ReturnType<typeof resolveDenyTargets>;
      try {
        resolved = resolveDenyTargets(cfg.allowedIps, rest);
      } catch (err) {
        throw new DaemonError(err instanceof Error ? err.message : String(err));
      }
      if (resolved.clearAll) {
        if (cfg.allowedIps.length === 0) {
          console.log("Allowlist is already empty.");
          return;
        }
        const n = cfg.allowedIps.length;
        const next = clearAllowedIps();
        console.log(`Cleared allowlist (${n} device(s) removed).`);
        printNetworkConfig(client, next);
        await applyNetworkChange(client, restart);
        return;
      }
      for (const arg of rest) {
        if (!/^\d+$/.test(arg)) {
          assertIps([arg]);
        }
      }
      const missing = resolved.ips.filter((ip) => !cfg.allowedIps.includes(ip));
      if (missing.length > 0) {
        throw new DaemonError(
          `Not on allowlist: ${missing.join(", ")} (run \`lca remote allowed\`)`
        );
      }
      const next = removeAllowedIps(resolved.ips);
      console.log(`Denied: ${resolved.ips.join(", ")}`);
      printNetworkConfig(client, next);
      await applyNetworkChange(client, restart);
      return;
    }
    case "detect": {
      // Read-only: list candidate reachable addresses without touching config.
      const candidates = tailscaleAddresses();
      if (candidates.length === 0) {
        console.log(
          "No reachable Tailscale address detected (IPv4 CGNAT 100.64.0.0/10 or IPv6 fd7a::/16)."
        );
        return;
      }
      const port = daemonPort(client);
      console.log("Candidate reachable URLs:");
      for (const addr of candidates) {
        console.log(`  http://${formatUrlHost(addr)}:${port}`);
      }
      return;
    }
    default:
      throw new DaemonError(
        `Unknown remote subcommand "${sub}". Try: status | on | off | allowed | allow | deny | detect`
      );
  }
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function cmdSkillsInstall(args: string[]): void {
  const script = join(repoRoot(), "scripts", "install-skill.mjs");
  if (!existsSync(script)) {
    throw new DaemonError(`Skill installer not found at ${script}`);
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
  });
  if (result.status) process.exitCode = result.status ?? 1;
}

function cmdRoadmap(args: string[]): void {
  const [sub, maybeDir] = args;
  if (sub !== "init") {
    throw new DaemonError("Usage: max roadmap init [dir]");
  }
  const target = maybeDir ?? process.cwd();
  const written = initRoadmap(target);
  console.log(`Wrote ${written}`);
}

function printHelp(): void {
  console.log(
    `max — control Max, your local agent factory
(\`lca\` is a permanent alias)

Usage:
  max up [prod]                  Start prod daemon (detached); bare up = ensure up
  max up dev                     Start dev stack (HMR, single port) or switch from prod
  max down                       Stop daemon or dev stack (mode-aware)
  max restart [dev|prod]         Restart; bare restart keeps current mode
  max status                     Instance health, mode, remote, counts
  max logs --daemon [-f]         Tail daemon or dev rig log (-f to follow)
  max list [--workspace, -w <id|name|path>]
                                 Show automations and recent run states
  max enable <id|name>           Arm an automation
  max disable <id|name>          Disarm an automation
  max run <id|name>              Trigger a run; prompts inline if it asks for input
  max logs <runId> [--no-follow] Tail (and follow) a run's events
  max doctor [runId|chatId]      Diagnose a run or chat (events + correlated daemon log), or daemon health
  max answer <runId> [text…]     Answer a run waiting on input
  max cancel <runId>             Stop one active run (not the daemon; see down)
  max pause <runId>              Park a running automation for steering chat
  max resume <runId> [note…]     Resume a paused run (optional operator note)
  max escalate <runId> <action>  Retry/skip/abort a halted pipeline run (needs daemon)
  max wave <waveId> <action>     Retry integration or abort a blocked wave (needs daemon)
  max message <runId> [text…]    Queue while running, or follow-up after terminal
  max interrupt <runId> [text…]  Stop current stream and send message immediately
  max export [opts]              Export run history (JSON/CSV)
  max implement-fully --feature <bN>
                                 Kick off documented work (needs daemon)
  max implement-fully --idea <text>
                                 Kick off new work (needs daemon)
                                 [--research-approval <none|before-planning>]
  max queue [list]               List serial implement-fully queue entries
  max queue add --feature <bN>   Enqueue documented work for overnight chaining
  max queue add --idea <text>    Enqueue new work (same options as implement-fully)
  max queue rm <id>              Cancel a waiting queue entry
  max queue clear                Cancel all queued and blocked entries
  max skills install             Copy in-repo skills into ~/.cursor/skills
  max roadmap init [dir]         Scaffold docs/roadmap/00-index.md
  max remote [status]            Show remote-access (host + device allowlist)
  max remote on <ip…>            Expose to other devices; allow given device IP(s)
  max remote on --insecure-any   Bind all interfaces with no device allowlist (unsafe)
  max remote off                 Restrict to loopback-only (this machine)
  max remote allowed             List allowlisted devices (numbered)
  max remote allow <ip…>         Add device IP(s) to the allowlist
  max remote deny <n…|ip…>       Remove by list index or IP (see allowed)
  max remote deny --all          Clear the entire device allowlist
  max remote detect              List candidate reachable URLs (IPv4 + IPv6 tailnet)
  max help                       Show this help

List options:
  --workspace, -w <id|name|path> Limit to one workspace (CLI-side filter)

Export options:
  --format, -f <json|csv>        Output format (default json)
  --workspace, -w <id|name>      Limit to one workspace
  --out, -o <file>               Write to a file instead of stdout

Implement-fully options:
  --feature <bN>                 Existing documented work (exactly one of --feature/--idea)
  --idea <text>                  New work idea (exactly one of --feature/--idea)
  --workspace <id|name|path>     Target workspace (default: current directory)
  --profile <quick|deep|guided>  Planning profile (default quick = Quick/JIT)
  --role-profile <id>            Named role-model recipe (not planning --profile)
  --role <role>=<modelId>        Override a pipeline role (repeatable); roles:
                                 planner, implementer, reviewer, docs, plus
                                 optional researcher, gatekeeper, and architect
  --research-approval <none|before-planning>
                                 Research gate after durable research.md
                                 (default none)
  --execute                      Skip per-phase plan/review; implement+commit
                                 per phase, one review at end (requires deep
                                 or guided profile)
  --dry-run                      Validate and print payload; write nothing
  --force                        Allow kickoff despite an active pipeline
  --prune                        Archive workers this pipeline no longer defines

Queue add options (same as implement-fully, plus):
  --after <bN>[,<bN>…]          Dependency feature ids (repeatable)

Remote options:
  --no-restart                   Edit config only; don't restart the daemon
  --insecure-any                 Broad bind (0.0.0.0) with empty allowlist; explicit opt-in

Environment:
  LCA_DAEMON_URL   Daemon base URL (default http://127.0.0.1:3747)
  LCA_PORT         Daemon port when LCA_DAEMON_URL is unset (default 3747)`
  );
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  const client = new DaemonClient();

  switch (verb) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    case "up":
    case "start": {
      const modeArg = parseModeFlag(rest[0]);
      const explicit = modeArg !== undefined;
      await cmdUp(client, {
        mode: modeArg ?? "prod",
        explicit,
      });
      return;
    }
    case "down":
    case "stop":
      await cmdDown(client);
      return;
    case "restart": {
      const modeArg = parseModeFlag(rest[0]);
      if (rest[0] && modeArg === undefined) {
        throw new DaemonError("Usage: lca restart [dev|prod]");
      }
      await cmdRestart(client, modeArg);
      return;
    }
    case "status":
    case "st":
      await cmdStatus(client);
      return;
    case "list":
    case "ls":
      await cmdList(client, rest);
      return;
    case "enable":
      if (!rest[0]) throw new DaemonError("Usage: lca enable <id|name>");
      await cmdEnable(client, rest[0], true);
      return;
    case "disable":
      if (!rest[0]) throw new DaemonError("Usage: lca disable <id|name>");
      await cmdEnable(client, rest[0], false);
      return;
    case "run":
      if (!rest[0]) throw new DaemonError("Usage: lca run <id|name>");
      await cmdRun(client, rest[0]);
      return;
    case "logs": {
      if (rest.includes("--daemon")) {
        const follow = rest.includes("-f") || rest.includes("--follow");
        await cmdDaemonLogs(follow);
        return;
      }
      const runQuery = rest.find((a) => !a.startsWith("-"));
      if (!runQuery) {
        throw new DaemonError("Usage: lca logs <runId> [--no-follow]  |  lca logs --daemon [-f]");
      }
      await cmdLogs(client, runQuery, !rest.includes("--no-follow"));
      return;
    }
    case "answer": {
      if (!rest[0]) throw new DaemonError("Usage: lca answer <runId> [text…]");
      const inline = rest.slice(1).join(" ").trim();
      await cmdAnswer(client, rest[0], inline || undefined);
      return;
    }
    case "cancel": {
      if (!rest[0]) throw new DaemonError("Usage: lca cancel <runId>");
      await cmdCancel(client, rest[0]);
      return;
    }
    case "pause": {
      if (!rest[0]) throw new DaemonError("Usage: lca pause <runId>");
      await cmdPause(client, rest[0]);
      return;
    }
    case "resume": {
      if (!rest[0]) throw new DaemonError("Usage: lca resume <runId> [note…]");
      const inline = rest.slice(1).join(" ").trim();
      await cmdResume(client, rest[0], inline || undefined);
      return;
    }
    case "escalate": {
      await cmdEscalate(client, rest);
      return;
    }
    case "wave": {
      await cmdWave(client, rest);
      return;
    }
    case "message": {
      if (!rest[0]) throw new DaemonError("Usage: lca message <runId> [text…]");
      const inline = rest.slice(1).join(" ").trim();
      await cmdMessage(client, rest[0], inline || undefined);
      return;
    }
    case "interrupt": {
      if (!rest[0]) throw new DaemonError("Usage: lca interrupt <runId> [text…]");
      const inline = rest.slice(1).join(" ").trim();
      await cmdInterrupt(client, rest[0], inline || undefined);
      return;
    }
    case "export":
      await cmdExport(client, rest);
      return;
    case "implement-fully":
      await cmdImplementFully(client, rest);
      return;
    case "queue":
      await cmdQueue(client, rest);
      return;
    case "remote":
      await cmdRemote(client, rest);
      return;
    case "skills":
      if (rest[0] !== "install") {
        throw new DaemonError("Usage: max skills install [--check|--dry-run]");
      }
      cmdSkillsInstall(rest.slice(1));
      return;
    case "roadmap":
      cmdRoadmap(rest);
      return;
    case "doctor":
      await cmdDoctor(client, rest.find((a) => !a.startsWith("-")));
      return;
    default:
      console.error(`Unknown command: ${verb}\n`);
      printHelp();
      process.exitCode = 2;
  }
}

main().catch((err) => {
  if (err instanceof DaemonError) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
