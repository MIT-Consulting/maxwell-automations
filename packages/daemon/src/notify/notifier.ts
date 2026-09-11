import { spawn } from "node:child_process";
import type {
  AlertNotifyEvent,
  NtfyNotifySettings,
  ResolvedNotifyEventPrefs,
} from "@lca/shared";
import notifier from "node-notifier";
import { NtfyTransport } from "./ntfy-transport.js";

export type NotifierOptions = {
  /** Base dashboard URL (no trailing slash), e.g. http://127.0.0.1:3747 */
  dashboardUrl: string;
  onLog?: (message: string) => void;
  /** Disable OS toasts (terminal/dashboard sinks still fire). */
  disabled?: boolean;
  /** Materialized per-event toast/ntfy prefs from `settings.notify.events`. */
  eventPrefs: ResolvedNotifyEventPrefs;
  /** Validated optional ntfy connection from `settings.notify.ntfy`. */
  ntfy?: NtfyNotifySettings;
  /**
   * Phone-reachable dashboard base for ntfy click links. Falls back to
   * `dashboardUrl` when omitted.
   */
  ntfyDashboardUrl?: string;
};

/**
 * Deep link that opens the dashboard focused on a specific run. The dashboard
 * reads the `run` query param on load and opens that run's logs view.
 */
export function buildRunDeepLink(dashboardUrl: string, runId: string): string {
  const base = dashboardUrl.replace(/\/+$/, "");
  return `${base}/?run=${encodeURIComponent(runId)}`;
}

/**
 * Derive the ntfy click base URL from the daemon bind host/port.
 * Specific non-loopback hosts are used as-is (IPv6 bracketed); loopback and
 * wildcard binds fall back to 127.0.0.1 so the click target stays valid.
 */
export function buildNtfyDashboardUrl(host: string, port: number): string {
  const normalized = host.trim();
  const loopbackOrWildcard =
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized.toLowerCase() === "localhost";
  if (loopbackOrWildcard) {
    return `http://127.0.0.1:${port}`;
  }
  const authority =
    normalized.includes(":") && !normalized.startsWith("[")
      ? `[${normalized}]`
      : normalized;
  return `http://${authority}:${port}`;
}

/** Open a URL in the operator's default browser, cross-platform. */
function openUrl(url: string, onLog?: (m: string) => void): void {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the window-title arg so URLs
      // with `&` are not mis-parsed.
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onLog?.(`Failed to open deep link ${url}: ${message}`);
  }
}

function truncateMessage(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Enriched implement-fully phase-completed toast — mirrors the kanban card. */
export type PhaseCompletionDetails = {
  /** Backlog id, e.g. "b60". */
  featureId: string;
  /** Raw worker key, e.g. "plan-phase", "implement", "review", "final-gate". */
  workerKey: string;
  /** Same outcome description shown on the run's kanban card. */
  description: string;
  /** Wall-clock duration for this phase run, in ms; null when unavailable. */
  elapsedMs: number | null;
};

/** "plan-phase" → "Plan Phase"; "final-gate" → "Final Gate". */
function formatWorkerKeyLabel(workerKey: string): string {
  return workerKey
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Compact duration for a toast timer, e.g. "1h 3m", "4m 12s", "58s". */
function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Multi-sink notification helper. The OS toast is one of three sinks for the
 * single "needs input" event (dashboard canonical + terminal being the others);
 * all answers converge back through the Input Hub regardless of which sink the
 * operator reacts to. Clicking the toast deep-links into the dashboard run view.
 * Optional ntfy is a fourth sink composed here; toast disablement never gates it.
 */
export class Notifier {
  private readonly ntfy: NtfyTransport;
  private eventPrefs: ResolvedNotifyEventPrefs;
  private ntfySettings?: NtfyNotifySettings;

  constructor(private readonly options: NotifierOptions) {
    this.eventPrefs = options.eventPrefs;
    this.ntfySettings = options.ntfy;
    this.ntfy = new NtfyTransport({
      settings: options.ntfy,
      onLog: options.onLog,
    });
  }

  /** Hot-swap event prefs and ntfy connection without reconstructing sinks. */
  reconfigureNotify(settings: {
    eventPrefs: ResolvedNotifyEventPrefs;
    ntfy?: NtfyNotifySettings;
  }): void {
    this.eventPrefs = settings.eventPrefs;
    this.ntfySettings = settings.ntfy;
    this.ntfy.setSettings(settings.ntfy);
  }

  /** Operator test send — bypasses per-event prefs; respects LCA_NO_NTFY. */
  async testNtfy(): Promise<
    { ok: true } | { ok: false; error: string }
  > {
    if (process.env.LCA_NO_NTFY === "1") {
      return { ok: false, error: "ntfy disabled by LCA_NO_NTFY" };
    }
    if (this.ntfySettings == null) {
      return { ok: false, error: "ntfy not configured" };
    }
    return this.ntfy.publishAwait({
      title: "Max",
      message: "Test notification from Max",
    });
  }

  private shouldToast(event: AlertNotifyEvent): boolean {
    if (this.options.disabled) {
      return false;
    }
    return this.eventPrefs[event].toast;
  }

  private shouldNtfy(event: AlertNotifyEvent): boolean {
    return this.eventPrefs[event].ntfy && this.ntfySettings != null;
  }

  private notifyToast(
    event: AlertNotifyEvent,
    id: string,
    title: string,
    message: string,
    deepLink: string
  ): void {
    if (!this.shouldToast(event)) {
      return;
    }

    try {
      notifier.notify(
        {
          title,
          message,
          // `wait: true` keeps the toast interactive so the click callback fires.
          wait: true,
          timeout: 60,
          // Some notifiers (e.g. macOS Notification Center) open this URL on click.
          open: deepLink,
        },
        (err, response) => {
          if (err) {
            this.options.onLog?.(
              `Toast for ${id} failed: ${err.message ?? String(err)}`
            );
            return;
          }
          // Windows SnoreToast / macOS report "activate" when the body is clicked.
          if (typeof response === "string" && /activate|click/i.test(response)) {
            openUrl(deepLink, this.options.onLog);
          }
        }
      );
    } catch (err) {
      // Never let a notification failure interfere with the run lifecycle.
      const m = err instanceof Error ? err.message : String(err);
      this.options.onLog?.(`Notifier error for ${id}: ${m}`);
    }
  }

  /**
   * Per-event ntfy publish. Independent of toast disablement.
   */
  private publishNtfy(
    event: AlertNotifyEvent,
    title: string,
    message: string,
    runId: string
  ): void {
    if (!this.shouldNtfy(event)) {
      return;
    }
    const base = this.options.ntfyDashboardUrl ?? this.options.dashboardUrl;
    this.publishNtfyWithClick(
      event,
      title,
      message,
      buildRunDeepLink(base, runId)
    );
  }

  private publishNtfyWithClick(
    event: AlertNotifyEvent,
    title: string,
    message: string,
    click: string
  ): void {
    if (!this.shouldNtfy(event)) {
      return;
    }
    this.ntfy.publish({
      title,
      message,
      click,
    });
  }

  needsInput(runId: string, question: string): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    const title = "Max needs your input";
    const message = truncateMessage(question, 220);
    this.notifyToast("needs_input", `run ${runId}`, title, message, deepLink);
    this.publishNtfy("needs_input", title, message, runId);
  }

  runFailed(runId: string, reason: string): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    const title = "Max run failed";
    const message = `Reason: ${reason}`;
    this.notifyToast("run_failed", `run ${runId}`, title, message, deepLink);
    this.publishNtfy("run_failed", title, message, runId);
  }

  /** Success notification — toast and ntfy per event prefs. */
  runCompleted(runId: string, label?: string): void {
    const shortId = runId.slice(0, 8);
    const trimmedLabel = label?.trim();
    const title = "Max run completed";
    const message = truncateMessage(
      trimmedLabel && trimmedLabel.length > 0
        ? `${trimmedLabel} completed (${shortId})`
        : `Run ${shortId} completed`,
      220
    );
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    this.notifyToast(
      "run_completed",
      `run ${runId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("run_completed", title, message, runId);
  }

  /** Loud plan-approval gate — OS toast plus prefs-gated ntfy. */
  planApprovalRequired(runId: string, question: string): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    const title = "Max plan approval required";
    const message = truncateMessage(question, 220);
    this.notifyToast(
      "plan_approval_required",
      `run ${runId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("plan_approval_required", title, message, runId);
  }

  /** Loud UX/design approval gate — OS toast plus prefs-gated ntfy (reserved seam). */
  uxApprovalRequired(runId: string, question: string): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    const title = "Max UX approval required";
    const message = truncateMessage(question, 220);
    this.notifyToast(
      "ux_approval_required",
      `run ${runId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("ux_approval_required", title, message, runId);
  }

  /**
   * Enriched per-phase completion for implement-fully workers — backlog id,
   * phase type, timer, and the same description shown on the kanban card.
   * Supersedes the generic `runCompleted` toast for these runs (never both).
   */
  phaseCompleted(runId: string, details: PhaseCompletionDetails): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    const phaseLabel = formatWorkerKeyLabel(details.workerKey);
    const title = `Max phase completed — ${phaseLabel}`;
    const timer =
      details.elapsedMs != null ? formatDurationShort(details.elapsedMs) : null;
    const header = [details.featureId, timer].filter(Boolean).join(" · ");
    const message = truncateMessage(
      header ? `${header}\n${details.description}` : details.description,
      220
    );
    this.notifyToast("run_completed", `run ${runId}`, title, message, deepLink);
    this.publishNtfy("run_completed", title, message, runId);
  }

  /** Loud pipeline success — OS toast plus prefs-gated ntfy. */
  pipelineComplete(runId: string, label?: string): void {
    const shortId = runId.slice(0, 8);
    const trimmedLabel = label?.trim();
    const title = "Max pipeline complete";
    const message = truncateMessage(
      trimmedLabel && trimmedLabel.length > 0
        ? `${trimmedLabel} finished (${shortId})`
        : `Pipeline finished (${shortId})`,
      220
    );
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    this.notifyToast(
      "pipeline_complete",
      `run ${runId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("pipeline_complete", title, message, runId);
  }

  /** Loud serial queue drain — OS toast plus prefs-gated ntfy (one per batch). */
  queueBatchComplete(facts: {
    workspaceLabel: string;
    doneCount: number;
    failedCount: number;
    blockedCount: number;
    failedFeatureIds: string[];
    blockedFeatureIds: string[];
  }): void {
    const title = truncateMessage(
      `Max queue complete — ${facts.workspaceLabel}`,
      220
    );
    const summary = `${facts.doneCount} done, ${facts.failedCount} failed, ${facts.blockedCount} blocked`;
    const parked = [
      ...facts.failedFeatureIds,
      ...facts.blockedFeatureIds.filter(
        (id) => !facts.failedFeatureIds.includes(id)
      ),
    ];
    const maxIds = 8;
    const listed = parked.slice(0, maxIds).join(", ");
    const overflow =
      parked.length > maxIds ? ` (+${parked.length - maxIds} more)` : "";
    const parkedPart =
      parked.length > 0 ? `. Parked: ${listed}${overflow}` : "";
    const message = truncateMessage(`${summary}${parkedPart}`, 220);
    const deepLink = this.options.dashboardUrl.replace(/\/+$/, "") + "/";
    this.notifyToast(
      "queue_batch_complete",
      `workspace ${facts.workspaceLabel}`,
      title,
      message,
      deepLink
    );
    this.publishNtfyWithClick("queue_batch_complete", title, message, deepLink);
  }

  /**
   * Dedicated toast after automatic halt recovery (retry/skip). Deep-links to
   * the source decision run; names the successor when present.
   */
  pipelineHaltRecovered(
    runId: string,
    action: "retry" | "skip",
    childRunId: string | null
  ): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    const childPart =
      childRunId != null && childRunId.length > 0
        ? ` Successor: ${childRunId.slice(0, 8)}.`
        : "";
    const title = "Max automatically recovered a pipeline halt";
    const message = truncateMessage(
      `Automatic ${action} for run ${runId.slice(0, 8)}.${childPart} No operator action needed.`,
      220
    );
    this.notifyToast(
      "pipeline_halt_recovered",
      `run ${runId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("pipeline_halt_recovered", title, message, runId);
  }

  /**
   * Dedicated toast when auto-recovery declines. Deep-links to the halted
   * source run and reminds that operator escalation remains available.
   */
  pipelineHaltUnrecovered(
    runId: string,
    code: string,
    detail: string
  ): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, runId);
    const title = "Max pipeline remains halted";
    const message = truncateMessage(
      `${code}: ${detail}. Operator escalation remains available (lca escalate ${runId.slice(0, 8)} …).`,
      220
    );
    this.notifyToast(
      "pipeline_halt_unrecovered",
      `run ${runId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("pipeline_halt_unrecovered", title, message, runId);
  }

  /**
   * Advisory briefing card is awaiting operator review (no timeout).
   * Deep-links to the advisory run that hosts the card.
   */
  haltDiscoveryRecommendationReady(
    advisoryRunId: string,
    sourceRunId: string
  ): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, advisoryRunId);
    const title = "Max halt discovery briefing ready";
    const message = truncateMessage(
      `Briefing for halted run ${sourceRunId.slice(0, 8)} awaits operator review (no timeout).`,
      220
    );
    this.notifyToast(
      "halt_discovery_ready",
      `run ${advisoryRunId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("halt_discovery_ready", title, message, advisoryRunId);
  }

  /**
   * Discovery spawn/diagnosis/briefing failed. Deep-links to the halted source
   * so existing halt controls remain one click away.
   */
  haltDiscoveryFailed(
    sourceRunId: string,
    stage: string,
    code: string,
    detail: string
  ): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, sourceRunId);
    const title = "Max halt discovery failed";
    const message = truncateMessage(
      `${stage}/${code}: ${detail}. See halted run ${sourceRunId.slice(0, 8)}.`,
      220
    );
    this.notifyToast(
      "halt_discovery_failed",
      `run ${sourceRunId}`,
      title,
      message,
      deepLink
    );
    this.publishNtfy("halt_discovery_failed", title, message, sourceRunId);
  }

  /**
   * Operator answered a halt-discovery briefing. Deep-links to the advisory;
   * does not claim source recovery success for refused/internal-failure.
   */
  haltDiscoveryActionResult(input: {
    advisoryRunId: string;
    sourceRunId: string;
    action: "retry" | "skip" | "abort";
    outcome: "acted" | "refused" | "internal-failure";
    code?: string;
    childRunId?: string;
  }): void {
    const deepLink = buildRunDeepLink(
      this.options.dashboardUrl,
      input.advisoryRunId
    );
    const sourceShort = input.sourceRunId.slice(0, 8);
    const advisoryShort = input.advisoryRunId.slice(0, 8);
    let title: string;
    let body: string;
    if (input.outcome === "acted") {
      title = "Max halt discovery action applied";
      const childPart =
        input.childRunId != null && input.childRunId.length > 0
          ? ` Child: ${input.childRunId.slice(0, 8)}.`
          : "";
      body = `Operator ${input.action} on source ${sourceShort} via advisory ${advisoryShort}.${childPart}`;
    } else if (input.outcome === "refused") {
      title = "Max halt discovery action refused";
      const codePart =
        input.code != null && input.code.length > 0 ? ` (${input.code})` : "";
      body = `Operator ${input.action} refused${codePart} for source ${sourceShort}; claim may be lost.`;
    } else {
      title = "Max halt discovery action failed";
      const codePart =
        input.code != null && input.code.length > 0 ? ` (${input.code})` : "";
      body = `Internal failure applying ${input.action} for source ${sourceShort}${codePart}. Source recovery not confirmed.`;
    }
    const toastMessage = truncateMessage(body, 220);
    this.notifyToast(
      "halt_discovery_action",
      `run ${input.advisoryRunId}`,
      title,
      toastMessage,
      deepLink
    );
    this.publishNtfy(
      "halt_discovery_action",
      title,
      toastMessage,
      input.advisoryRunId
    );
  }

  authExpired(id: string, message: string): void {
    const deepLink = buildRunDeepLink(this.options.dashboardUrl, id);
    const body = truncateMessage(message, 180);
    const title = "Cursor auth expired";
    const toastMessage =
      `${body} — refresh CURSOR_API_KEY in ~/.cursor-local-automations/.env or run cursor-agent login`;
    this.notifyToast(
      "auth_expired",
      `${id} auth expired`,
      title,
      toastMessage,
      deepLink
    );
    this.publishNtfy("auth_expired", title, toastMessage, id);
  }
}
