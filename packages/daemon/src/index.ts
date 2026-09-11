import { mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { HALT_DISCOVERY_INPUT_KIND } from "@lca/shared";
import { openDatabase } from "./db/index.js";
import { reconcileConfig } from "./config/reconcile.js";
import { loadSettings, loadNotifySettings } from "./config/settings.js";
import { buildNotifySettingsPublic } from "./config/notify-public.js";
import { writeNotifySettings } from "./config/write.js";
import { startConfigWatcher } from "./config/watch.js";
import { loadEnv, getApiKey } from "./env.js";
import { createExecutor } from "./executor/index.js";
import { DaemonEventBus } from "./events.js";
import { DashboardStore } from "./http/dashboard-store.js";
import { startHttpServer } from "./http/server.js";
import { InputHub } from "./input/hub.js";
import {
  InputStore,
  parseInputMetadataJson,
  rowToInputRequest,
} from "./input/store.js";
import {
  notifyHaltDiscoveryBriefingIfApplicable,
  subscribeHaltDiscoveryNotifications,
} from "./notify/halt-discovery-notifications.js";
import { notifyPlanApprovalIfApplicable } from "./notify/plan-approval-notifications.js";
import { buildNtfyDashboardUrl, Notifier } from "./notify/notifier.js";
import { notifyOnRunCompleted } from "./notify/run-completed.js";
import { provisionGeneratedWorkers } from "./config/generated-workers.js";
import { ChainRunner } from "./runs/chain-runner.js";
import { RunEngine } from "./runs/engine.js";
import {
  orchestrateHaltDiscoveryAdvisory,
  reconcileHaltDiscoveryAdvisoryTerminal,
} from "./runs/halt-discovery-orchestrator.js";
import { presentCompletedHaltDiscoveryAdvisory } from "./runs/halt-discovery-presentation.js";
import { PipelineWaveCoordinator } from "./runs/pipeline-wave-coordinator.js";
import { PipelineWaveStore } from "./runs/pipeline-wave-store.js";
import { FeatureQueueStore } from "./runs/feature-queue-store.js";
import { FeatureQueueRunner } from "./runs/feature-queue-runner.js";
import { ChatEngine, createChatDefaultsResolver } from "./chats/engine.js";
import { ChatStore } from "./chats/store.js";
import { TriggerManager } from "./triggers/manager.js";
import { RunStore } from "./runs/store.js";
import { assertTransition } from "./runs/state-machine.js";
import { AttachmentStore } from "./attachments/store.js";
import { startAttachmentSweepScheduler } from "./attachments/sweep.js";
import { LCA_HOME, GLOBAL_CONFIG_PATH } from "./paths.js";

function log(message: string): void {
  const ts = new Date().toISOString();
  console.error(`[lca-daemon ${ts}] ${message}`);
}

/**
 * Recognize the Cursor/connectRPC "not logged in" auth failure. The SDK surfaces
 * it as a `ConnectError` with code `unauthenticated` (16) carrying an
 * `ERROR_NOT_LOGGED_IN` detail, and — critically — it can reject on a *detached*
 * stream promise deep inside connectRPC (no `await` of ours owns it). That makes
 * it land as an unhandled rejection, which is why resuming a stale agent session
 * used to take the whole daemon down.
 */
function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  const text = `${(err as { message?: unknown }).message ?? ""} ${JSON.stringify(
    (err as { details?: unknown }).details ?? ""
  )}`;
  return (
    code === 16 ||
    code === "unauthenticated" ||
    /unauthenticated|ERROR_NOT_LOGGED_IN|not logged in/i.test(text)
  );
}

/**
 * A long-lived local daemon must never be killed by a single failed agent
 * stream. The Cursor SDK can reject on detached promises (connectRPC async
 * iterables) that no local `try/catch` can reach — most notably an expired
 * login when resuming a completed run. Without these handlers Node 22 prints the
 * rejection and exits, dropping every other automation/run with it. We log
 * loudly and stay up; stalled runs are reaped by the engine watchdog and cleared
 * as stale on the next restart.
 */
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    if (isAuthError(reason)) {
      log(
        "Unhandled rejection: Cursor auth expired (ERROR_NOT_LOGGED_IN). " +
          "A run could not resume its agent session. Re-authenticate the SDK " +
          "(refresh CURSOR_API_KEY in ~/.cursor-local-automations/.env, or run " +
          "`cursor-agent login`). Daemon staying up."
      );
    } else {
      const detail =
        reason instanceof Error ? reason.stack ?? reason.message : String(reason);
      log(`Unhandled rejection (kept daemon alive): ${detail}`);
    }
  });

  process.on("uncaughtException", (err) => {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    log(`Uncaught exception (kept daemon alive): ${detail}`);
  });
}

/**
 * Spawn a fresh copy of this daemon, mirroring how the CLI launches prod: on
 * Windows via `Start-Process -WindowStyle Hidden` (so the daemon and every
 * `cursor-agent`/shell it spawns inherit one hidden console instead of popping
 * windows), on POSIX via a detached session writing to the log files. Called
 * during a restart *after* the HTTP listener and DB are closed, so the fresh
 * process binds the freed port immediately.
 *
 * Resolves once the hand-off is complete. Critically, on Windows we *await* the
 * short-lived launcher instead of detaching it: a child of the dying daemon is
 * torn down with us, so it must finish running `Start-Process` (which breaks the
 * new daemon away into its own hidden console, independent of both us and the
 * launcher) before we exit. An earlier version had the launcher wait for our PID
 * first — it never survived long enough to relaunch anything.
 */
function relaunchDaemon(): Promise<void> {
  const entry = process.argv[1];
  if (!entry) {
    return Promise.reject(
      new Error("cannot determine daemon entry (process.argv[1] is empty)")
    );
  }
  const outPath = join(LCA_HOME, "daemon.out.log");
  const errPath = join(LCA_HOME, "daemon.err.log");

  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      // -ArgumentList does not auto-quote elements; quote the entry path.
      "$argLine = '\"' + $env:LCA_DAEMON_ENTRY + '\"'",
      "Start-Process -FilePath $env:LCA_NODE_EXE -ArgumentList $argLine -WindowStyle Hidden -RedirectStandardOutput $env:LCA_DAEMON_OUT -RedirectStandardError $env:LCA_DAEMON_ERR | Out-Null",
    ].join("; ");
    return new Promise<void>((resolve, reject) => {
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
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };
      // Never hang teardown if the launcher misbehaves; Start-Process returns
      // almost immediately, so this only fires on a genuine stall.
      const timer = setTimeout(() => finish(), 10_000);
      timer.unref?.();
      child.once("error", (err) => finish(err));
      child.once("close", () => finish());
    });
  }

  const out = openSync(outPath, "a");
  const err = openSync(errPath, "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();
  return Promise.resolve();
}

async function main(): Promise<void> {
  installProcessGuards();
  mkdirSync(LCA_HOME, { recursive: true });
  loadEnv();

  const db = openDatabase();
  log("Database opened and schema applied");

  try {
    const count = reconcileConfig(db, { onLog: log });
    log(`Config reconciled (${count} automation(s))`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Config reconcile failed at startup: ${message}`);
  }

  const apiKey = getApiKey();
  const port = Number(process.env.LCA_PORT ?? 3747);
  const settings = loadSettings({ onLog: log });
  log(
    `Settings: maxConcurrentRuns=${settings.maxConcurrentRuns}, ` +
      `eventRetentionPerRun=${settings.eventRetentionPerRun}, ` +
      `maxEventPayloadBytes=${settings.maxEventPayloadBytes}, ` +
      `host=${settings.host}, ` +
      `allowedIps=${settings.allowedIps.length > 0 ? settings.allowedIps.join(",") : "(none)"}, ` +
      `remoteAuth=${settings.controlToken ? "on" : "off"}`
  );
  log(
    `Reliability: spawnTimeoutMs=${settings.spawnTimeoutMs}, ` +
      `runStallTimeoutMs=${settings.runStallTimeoutMs}, ` +
      `maxSpawnAttempts=${settings.maxSpawnAttempts}, ` +
      `retryBackoffMs=${settings.retryBackoffMs}, ` +
      `retainedSessionTtlMs=${settings.retainedSessionTtlMs}, ` +
      `sessionRevive=${settings.sessionRevive}`
  );
  const events = new DaemonEventBus();
  const runStore = new RunStore(db, events);
  const inputStore = new InputStore(db);
  const dashboardStore = new DashboardStore(db);
  const notifier = new Notifier({
    dashboardUrl: `http://127.0.0.1:${port}`,
    ntfyDashboardUrl: buildNtfyDashboardUrl(settings.host, port),
    eventPrefs: settings.notify.events,
    ntfy: settings.notify.ntfy,
    disabled: process.env.LCA_NO_TOAST === "1",
    onLog: log,
  });
  let currentNotify = settings.notify;

  const reloadAndApplyNotify = (): typeof currentNotify => {
    currentNotify = loadNotifySettings({ onLog: log });
    notifier.reconfigureNotify({
      eventPrefs: currentNotify.events,
      ntfy: currentNotify.ntfy,
    });
    return currentNotify;
  };

  // Single Input Hub for engine ask_user waits and halt-discovery passive cards.
  const inputHub = new InputHub(inputStore, {
    onNeedsInput: (runId, request) => {
      const row = runStore.getRun(runId);
      if (row?.status === "running") {
        assertTransition(row.status, "needs_input");
        runStore.setStatus(runId, "needs_input");
        log(`Run ${runId}: running → needs_input`);
      }
      events.emitInputRequest(runId, rowToInputRequest(request));
    },
    onAnswered: (runId, request) => {
      const meta = parseInputMetadataJson(request.metadata_json);
      const haltDiscoveryBriefing = meta?.kind === HALT_DISCOVERY_INPUT_KIND;
      const row = runStore.getRun(runId);
      // Parked briefing cards close to completed after source escalation; do not
      // resume the diagnosis agent via the generic needs_input → running flip.
      if (row?.status === "needs_input" && !haltDiscoveryBriefing) {
        assertTransition(row.status, "running");
        runStore.setStatus(runId, "running");
        log(`Run ${runId}: needs_input → running`);
      }
      events.emitInputRequest(runId, rowToInputRequest(request));
    },
    onNotify: (runId, question) => {
      // Terminal sink (daemon log) + OS toast sink. The dashboard sink fires
      // via the WS input_request event; all answers reconverge in the Input Hub.
      // Halt-discovery briefings get a dedicated recommendation-ready toast.
      const discoveryNotified = notifyHaltDiscoveryBriefingIfApplicable({
        runId,
        question,
        getPending: (id) => inputHub.getPendingQuestion(id),
        getParentRunId: (id) => runStore.getRun(id)?.parent_run_id,
        notifier,
        onLog: log,
      });
      if (discoveryNotified) {
        return;
      }
      const planApprovalNotified = notifyPlanApprovalIfApplicable({
        runId,
        question,
        getPending: (id) => inputHub.getPendingQuestion(id),
        notifier,
        onLog: log,
      });
      if (!planApprovalNotified) {
        log(`Run ${runId} needs input: ${question.slice(0, 120)}`);
        notifier.needsInput(runId, question);
      }
    },
  });

  const unsubscribeHaltDiscoveryNotifications =
    subscribeHaltDiscoveryNotifications({
      events,
      notifier,
      onLog: log,
    });

  const engine = new RunEngine(db, {
    apiKey,
    executor: createExecutor("sdk-local"),
    events,
    maxConcurrentRuns: settings.maxConcurrentRuns,
    eventRetentionPerRun: settings.eventRetentionPerRun,
    maxEventPayloadBytes: settings.maxEventPayloadBytes,
    spawnTimeoutMs: settings.spawnTimeoutMs,
    runStallTimeoutMs: settings.runStallTimeoutMs,
    maxSpawnAttempts: settings.maxSpawnAttempts,
    retryBackoffMs: settings.retryBackoffMs,
    retainedSessionTtlMs: settings.retainedSessionTtlMs,
    sessionRevive: settings.sessionRevive,
    onRunFailed: (runId, reason) => {
      log(`Run ${runId} failed: ${reason}`);
      notifier.runFailed(runId, reason);
    },
    onRunCompleted: (runId) => {
      notifyOnRunCompleted(runId, {
        getRun: (id) => runStore.getRun(id),
        getAutomation: (id) => runStore.getAutomationByIdIncludingArchived(id),
        parseChainContext: (row) => runStore.parseChainContext(row),
        notifier,
      });
    },
    onImplementFullyPhaseCompleted: (runId, details) => {
      notifier.phaseCompleted(runId, details);
    },
    onAuthExpired: (kind, id, message) => {
      log(`${kind} ${id}: Cursor auth expired — ${message}`);
      notifier.authExpired(id, message);
    },
    inputHub,
    onLog: log,
  });

  await engine.resumeInterruptedRuns();
  engine.startWatchdog();

  const waveStore = new PipelineWaveStore(db);
  engine.setPipelineWaveStore(waveStore);
  const featureQueueStore = new FeatureQueueStore(db);
  const waveCoordinator = new PipelineWaveCoordinator({
    store: runStore,
    waveStore,
    engine,
    onLog: log,
    maxConcurrentRuns: settings.maxConcurrentRuns,
    pipelineResumeLookbackMs: settings.pipelineResumeLookbackMs,
  });
  engine.setPipelineWaveCoordinator(waveCoordinator);

  const chatStore = new ChatStore(db, events, {
    maxEventPayloadBytes: settings.maxEventPayloadBytes,
  });

  const chatEngine = new ChatEngine(db, {
    apiKey,
    executor: createExecutor("sdk-local"),
    events,
    store: chatStore,
    resolveDefaults: createChatDefaultsResolver(chatStore),
    maxEventPayloadBytes: settings.maxEventPayloadBytes,
    sessionRevive: settings.sessionRevive,
    onChatNeedsInput: (chatId, request) => {
      log(`Chat ${chatId} needs input: ${request.question.slice(0, 120)}`);
      notifier.needsInput(chatId, request.question);
    },
    onAuthExpired: (kind, id, message) => {
      log(`${kind} ${id}: Cursor auth expired — ${message}`);
      notifier.authExpired(id, message);
    },
    onLog: log,
    lookupRun: (runId) => {
      const row = runStore.getRun(runId);
      if (!row) return undefined;
      return { workspaceId: row.workspace_id, status: row.status };
    },
  });
  await chatEngine.resumeInterruptedChats();

  const attachmentStore = new AttachmentStore(db);
  const attachmentSweep = startAttachmentSweepScheduler({
    store: attachmentStore,
    log,
  });

  const triggers = new TriggerManager(db, engine, { port, onLog: log });

  const chainRunner = new ChainRunner({
    store: runStore,
    engine,
    events,
    onLog: log,
    pipelineResumeLookbackMs: settings.pipelineResumeLookbackMs,
    pipelineAutoEscalate: settings.pipelineAutoEscalate,
    pipelineAutoEscalateMaxPerPipeline:
      settings.pipelineAutoEscalateMaxPerPipeline,
    pipelineHaltDiscovery: settings.pipelineHaltDiscovery,
    waveCoordinator,
    onHaltRecoveryDecision: (runId, result) => {
      try {
        if (result.kind === "acted") {
          notifier.pipelineHaltRecovered(
            runId,
            result.action,
            result.childRunId
          );
        } else if (result.kind === "declined") {
          notifier.pipelineHaltUnrecovered(runId, result.code, result.detail);
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        log(`Halt recovery notification failed for run ${runId}: ${text}`);
      }
    },
    orchestrateHaltDiscoveryAdvisory: (sourceRunId) =>
      orchestrateHaltDiscoveryAdvisory({
        store: runStore,
        engine,
        provisionWorkers: (workspaceId, workers) =>
          provisionGeneratedWorkers(db, workspaceId, [...workers], {
            prune: false,
          }),
        onLog: log,
        sourceRunId,
      }),
    reconcileHaltDiscoveryAdvisoryTerminal: (advisoryRunId, status) =>
      reconcileHaltDiscoveryAdvisoryTerminal({
        store: runStore,
        onLog: log,
        advisoryRunId,
        status,
      }),
    presentCompletedHaltDiscoveryAdvisory: (advisoryRunId) =>
      presentCompletedHaltDiscoveryAdvisory({
        store: runStore,
        inputHub,
        onLog: log,
        advisoryRunId,
      }),
  });

  const featureQueueRunner = new FeatureQueueRunner({
    store: runStore,
    queueStore: featureQueueStore,
    engine,
    events,
    onLog: log,
    notifier,
    getWorkspaceLabel: (workspaceId) => {
      const path = runStore.getWorkspacePath(workspaceId);
      if (!path) {
        return workspaceId;
      }
      const parts = path.split(/[/\\]/);
      return parts[parts.length - 1] || workspaceId;
    },
  });

  // Holder lets the HTTP shutdown/restart endpoints reach the real teardown,
  // which is defined below (it depends on `http` and `watcher`, created after
  // the server).
  const lifecycle: {
    shutdown: (reason: string) => Promise<void>;
    restart: (reason: string) => Promise<void>;
  } = {
    shutdown: async () => {},
    restart: async () => {},
  };

  const http = await startHttpServer({
    engine,
    chatEngine,
    store: dashboardStore,
    db,
    events,
    apiKey,
    settings,
    triggers,
    port,
    host: settings.host,
    allowedIps: settings.allowedIps,
    controlToken: settings.controlToken,
    onShutdown: (reason) => lifecycle.shutdown(reason),
    onRestart: (reason) => lifecycle.restart(reason),
    // Dev serves the UI via Vite + `node --watch`, which already hot-restarts the
    // daemon; a self-relaunch there would fight the watch rig, so disable it.
    restartSupported: !process.env.LCA_DEV_VITE,
    onLog: log,
    waveCoordinator,
    featureQueue: featureQueueStore,
    featureQueueRunner,
    notify: {
      getPublic: () => buildNotifySettingsPublic(currentNotify),
      patch: (body) => {
        writeNotifySettings(GLOBAL_CONFIG_PATH, body);
        return buildNotifySettingsPublic(reloadAndApplyNotify());
      },
      testSend: () => notifier.testNtfy(),
    },
  });
  log(
    `HTTP API listening on ${http.bindAddresses
      .map((addr) => `http://${addr}:${http.port}`)
      .join(", ")}`
  );

  triggers.start();
  chainRunner.start();
  featureQueueRunner.start();
  // Wave → transitions → failed-halt recovery → halt-discovery requests → advisories → queue.
  void waveCoordinator
    .resumeWaves()
    .then(() => chainRunner.resumeMissedTransitions())
    .then(() => chainRunner.resumeFailedHaltRecovery())
    .then(() => chainRunner.resumeHaltDiscovery())
    .then(() => chainRunner.resumeHaltDiscoveryAdvisories())
    .then(() => featureQueueRunner.resumeQueue())
    .catch((err) => {
      const text = err instanceof Error ? err.message : String(err);
      log(`Pipeline wave/chain resume sweep failed: ${text}`);
    });
  log("Trigger subsystem active (cron, git, file-watch, command, manual)");
  log("Automation chaining active");
  log("Feature queue active");

  const watcher = startConfigWatcher(
    db,
    (n) => {
      log(`Config changed — reconciled (${n} automation(s))`);
      triggers.refresh();
      try {
        reloadAndApplyNotify();
        log("Notify settings reloaded");
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        log(`Notify settings reload failed: ${text}`);
      }
    },
    log
  );
  log("Watching YAML config for changes");

  let shuttingDown = false;
  // Tear everything down in dependency order. `relaunch` decides whether a fresh
  // daemon is spawned before this process exits.
  const teardown = async (relaunch: boolean) => {
    await watcher.close();
    chainRunner.stop();
    featureQueueRunner.stop();
    unsubscribeHaltDiscoveryNotifications();
    await triggers.stop();
    await http.close(); // frees the listening port before any relaunch re-binds
    attachmentSweep.stop();
    await engine.shutdown();
    await chatEngine.shutdown();
    db.close();
    if (relaunch) {
      try {
        await relaunchDaemon();
        log("Handed off to fresh daemon; exiting previous process");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`Relaunch failed (daemon will stay down): ${message}`);
      }
    }
    process.exit(0);
  };

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down`);
    await teardown(false);
  };
  lifecycle.shutdown = shutdown;

  const restart = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Restart requested (${reason}) — relaunching daemon`);
    await teardown(true);
  };
  lifecycle.restart = restart;

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  log("Daemon ready");
}

main().catch((err) => {
  console.error("[lca-daemon] Fatal error:", err);
  process.exit(1);
});
