import type { TriggerConfig } from "./triggers.js";
import type { ModelConfigValue, ModelSelection } from "../model.js";
import type { PipelineModelRole } from "./api.js";

export type ChainConfig = {
  next: string;
  when?: "completed" | "failed" | "always";
  passResult?: boolean;
};

/** Shallow template value: string or one nested string map. */
export type ChainTemplateValue = string | Record<string, string>;

/** Operator-visible pipeline variables for `{{name}}` / `{{name.key}}` rendering. */
export type ChainVariables = Record<string, ChainTemplateValue>;

/**
 * Immutable per-pipeline snapshot stored on every run in a context-aware chain.
 * Role mappings are concrete ModelSelection values (not catalog-inferred).
 */
export type ChainRunContext = {
  variables: ChainVariables;
  roleModels: Record<string, ModelSelection>;
};

export type AutomationYamlEntry = {
  id?: string;
  name: string;
  enabled?: boolean;
  trigger: TriggerConfig;
  prompt: string;
  model?: ModelConfigValue;
  /** Role key looked up in the pipeline's `roleModels` when this automation is chained. */
  modelRole?: string;
  chain?: ChainConfig;
};

/** Canonical ntfy event allowlist ids (YAML + transport). */
export const NTFY_NOTIFY_EVENTS = [
  "needs_input",
  "run_failed",
  "auth_expired",
  "run_completed",
  "pipeline_complete",
  "queue_batch_complete",
  "plan_approval_required",
  "ux_approval_required",
] as const;

export type NtfyNotifyEvent = (typeof NTFY_NOTIFY_EVENTS)[number];

/** Halt/discovery alert ids (YAML prefs keys). */
export const HALT_DISCOVERY_NOTIFY_EVENTS = [
  "pipeline_halt_recovered",
  "pipeline_halt_unrecovered",
  "halt_discovery_ready",
  "halt_discovery_failed",
  "halt_discovery_action",
] as const;

export type HaltDiscoveryNotifyEvent =
  (typeof HALT_DISCOVERY_NOTIFY_EVENTS)[number];

/** Full operator alert catalog (eight catalog + five halt/discovery). */
export const ALERT_NOTIFY_EVENTS = [
  ...NTFY_NOTIFY_EVENTS,
  ...HALT_DISCOVERY_NOTIFY_EVENTS,
] as const;

export type AlertNotifyEvent = (typeof ALERT_NOTIFY_EVENTS)[number];

export type NotifyEventChannelPrefs = {
  toast: boolean;
  ntfy: boolean;
};

/** Partial YAML map under `settings.notify.events`. */
export type NotifyEventPrefsMap = Partial<
  Record<AlertNotifyEvent, NotifyEventChannelPrefs>
>;

/** Fully materialized per-event toast/ntfy prefs after defaults + migrate. */
export type ResolvedNotifyEventPrefs = Record<
  AlertNotifyEvent,
  NotifyEventChannelPrefs
>;

/** Smart defaults for all thirteen alert ids (b51 + b58). */
export const DEFAULT_NOTIFY_EVENT_PREFS: ResolvedNotifyEventPrefs = {
  needs_input: { toast: true, ntfy: true },
  run_failed: { toast: true, ntfy: true },
  auth_expired: { toast: true, ntfy: true },
  run_completed: { toast: false, ntfy: false },
  pipeline_complete: { toast: true, ntfy: true },
  queue_batch_complete: { toast: true, ntfy: true },
  plan_approval_required: { toast: true, ntfy: true },
  ux_approval_required: { toast: true, ntfy: true },
  pipeline_halt_recovered: { toast: false, ntfy: false },
  pipeline_halt_unrecovered: { toast: true, ntfy: true },
  halt_discovery_ready: { toast: true, ntfy: true },
  halt_discovery_failed: { toast: true, ntfy: true },
  halt_discovery_action: { toast: false, ntfy: false },
};

/**
 * Merge smart defaults, optional YAML partial map, and legacy ntfy allowlist.
 * Legacy allowlist sets `ntfy: true` for listed ids; toast stays from defaults
 * unless the partial map already set it.
 */
export function mergeNotifyEventPrefs(
  partial?: NotifyEventPrefsMap,
  legacyAllowlist?: readonly NtfyNotifyEvent[]
): ResolvedNotifyEventPrefs {
  const result = {} as ResolvedNotifyEventPrefs;
  for (const id of ALERT_NOTIFY_EVENTS) {
    result[id] = { ...DEFAULT_NOTIFY_EVENT_PREFS[id] };
    const overlay = partial?.[id];
    if (overlay) {
      result[id] = { ...result[id], ...overlay };
    }
  }
  if (legacyAllowlist) {
    for (const id of legacyAllowlist) {
      result[id] = { ...result[id], ntfy: true };
    }
  }
  return result;
}

/** Resolved ntfy connection (topic/server/token only). */
export type NtfyNotifySettings = {
  topic: string;
  server?: string;
  token?: string;
};

/** Parsed YAML ntfy block; may carry legacy `events` for load-time migrate. */
export type NtfyNotifyYamlSettings = NtfyNotifySettings & {
  events?: NtfyNotifyEvent[];
};

/** Optional notification sinks under `settings.notify` (YAML shape). */
export type NotifySettings = {
  events?: NotifyEventPrefsMap;
  ntfy?: NtfyNotifyYamlSettings;
};

/** Resolved notify snapshot: always materialized events; connection-only ntfy. */
export type ResolvedNotifySettings = {
  events: ResolvedNotifyEventPrefs;
  ntfy?: NtfyNotifySettings;
};

/** Public ntfy connection fields for GET /api/settings/notify (no raw token). */
export type NotifySettingsPublicNtfy = {
  topic: string;
  server?: string;
  tokenPresent: boolean;
};

/** GET /api/settings/notify response shape (Phase 3 Alerts UI consumes this). */
export type NotifySettingsPublic = {
  events: ResolvedNotifyEventPrefs;
  defaults: ResolvedNotifyEventPrefs;
  ntfy: NotifySettingsPublicNtfy | null;
  envMutes: { toast: boolean; ntfy: boolean };
  usable: { ntfy: boolean };
};

export type DaemonSettings = {
  maxConcurrentRuns?: number;
  eventRetentionPerRun?: number;
  maxEventPayloadBytes?: number;
  /** Max time for `spawn()`/`resume()` to return before the attempt is treated as failed. */
  spawnTimeoutMs?: number;
  /** A `running` run with no new event for longer than this is considered stalled. */
  runStallTimeoutMs?: number;
  /** Total spawn attempts per run (1 = no retry). */
  maxSpawnAttempts?: number;
  /** Base backoff before a retry; grows per attempt (capped). */
  retryBackoffMs?: number;
  /** Max idle time before a terminal run's retained session is disposed (ms). 0 = never. */
  retainedSessionTtlMs?: number;
  /** Revive expired interactive sessions from their stored transcript. */
  sessionRevive?: boolean;
  /** Address the HTTP/WS server binds to (default `127.0.0.1`, loopback-only). */
  host?: string;
  /**
   * Source IPs permitted to reach the dashboard/API in addition to loopback.
   * Empty means "no allowlist" — every IP that reaches the bound `host` is
   * allowed. Set this (e.g. a phone's Tailscale IP) to restrict access to
   * specific devices.
   */
  allowedIps?: string[];
  /**
   * Shared remote-access app-auth secret (`X-LCA-Control-Token`). Required for
   * every non-loopback request when remote is enabled; loopback is exempt.
   * Provisioned by `lca remote on`. Never logged or returned by the API.
   */
  controlToken?: string;
  /**
   * Default model recipe for pipeline kickoff (`planner` / `implementer` /
   * `reviewer` / `docs`). Consumed by pipeline kickoff; loaded once at daemon
   * startup. Changing it requires `lca restart`.
   */
  pipelineRoleModels?: Partial<Record<PipelineModelRole, ModelConfigValue>>;
  /**
   * Named role-model recipes beside the synthetic `default` map (`pipelineRoleModels`).
   * Loaded once at startup; changing requires `lca restart`.
   */
  pipelineRoleModelProfiles?: Record<
    string,
    Partial<Record<PipelineModelRole, ModelConfigValue>>
  >;
  /**
   * Optional default named profile id (must exist in `pipelineRoleModelProfiles`).
   * Loaded once at startup; changing requires `lca restart`.
   */
  defaultPipelineRoleModelProfile?: string;
  /**
   * How far back (ms) the boot sweep looks for completed context-aware runs
   * whose chain transition was lost to a restart. `0` disables the sweep.
   * Loaded once at startup; changing it requires `lca restart`.
   */
  pipelineResumeLookbackMs?: number;
  /**
   * When true, the daemon may auto-escalate safe post-terminal pipeline halts.
   * Loaded once at startup; changing it requires `lca restart`.
   */
  pipelineAutoEscalate?: boolean;
  /**
   * Max daemon-attributed escalations per pipeline lineage (positive integer).
   * Loaded once at startup; changing it requires `lca restart`.
   */
  pipelineAutoEscalateMaxPerPipeline?: number;
  /**
   * When true, the daemon may request a halt-discovery advisory after an
   * unrecovered pipeline halt. Loaded once at startup; changing it requires
   * `lca restart`.
   */
  pipelineHaltDiscovery?: boolean;
  /** Max bytes for a single chat attachment upload. */
  maxAttachmentBytes?: number;
  /** Max attachments allowed on one send/queue/interrupt message. */
  maxAttachmentsPerMessage?: number;
  /** MIME allowlist for attachment uploads. */
  allowedAttachmentMimeTypes?: string[];
  /** Max bytes returned for a single file-viewer content read. */
  maxFileViewerBytes?: number;
  /** Max directory entries returned by the file-viewer listing API. */
  maxFileViewerEntries?: number;
  /**
   * Optional phone-notify sinks (b48). Loaded once at startup; changing it
   * requires `lca restart`. Topic/token must stay in the gitignored home
   * config — never commit them.
   */
  notify?: NotifySettings;
};

export type GlobalConfigYaml = {
  workspaces?: string[];
  automations?: AutomationYamlEntry[];
  settings?: DaemonSettings;
};

export type WorkspaceAutomationsYaml = {
  automations: AutomationYamlEntry[];
};
