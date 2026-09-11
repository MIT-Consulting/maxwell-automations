import {
  DEFAULT_NOTIFY_EVENT_PREFS,
  mergeNotifyEventPrefs,
  modelSelectionFromLegacy,
  normalizeModelSelection,
  PIPELINE_MODEL_ROLES,
  type DaemonSettings,
  type ModelConfigValue,
  type ModelSelection,
  type NotifySettings,
  type NtfyNotifySettings,
  type PipelineModelRole,
  type ResolvedNotifySettings,
} from "@lca/shared";
import { GLOBAL_CONFIG_PATH } from "../paths.js";
import { parseGlobalConfig } from "./parse.js";

export type ResolvedSettings = {
  /** Max runs executing concurrently; excess runs stay `queued` until a slot frees. */
  maxConcurrentRuns: number;
  /** Most recent events retained per run; older events are pruned when a run ends. */
  eventRetentionPerRun: number;
  /** Hard cap on a single event payload (bytes); larger payloads are truncated. */
  maxEventPayloadBytes: number;
  /** Max time for `spawn()`/`resume()` to return before the attempt is treated as failed. */
  spawnTimeoutMs: number;
  /** A `running` run with no new event for longer than this is considered stalled. */
  runStallTimeoutMs: number;
  /** Total spawn attempts per run (1 = no retry). */
  maxSpawnAttempts: number;
  /** Base backoff before a retry; grows per attempt (capped). */
  retryBackoffMs: number;
  /** Max idle time before a terminal run's retained session is disposed. 0 = never. */
  retainedSessionTtlMs: number;
  /** Revive expired interactive sessions from their stored transcript. */
  sessionRevive: boolean;
  /** Address the HTTP/WS server binds to; `127.0.0.1` keeps it loopback-only. */
  host: string;
  /**
   * Non-loopback source IPs permitted to reach the dashboard/API. Empty means
   * no allowlist (any IP reaching `host` is allowed); loopback is always allowed.
   */
  allowedIps: string[];
  /**
   * Shared app-auth token (`X-LCA-Control-Token`). When set, every non-loopback
   * request must present it; loopback stays exempt. Resolved from
   * `LCA_CONTROL_TOKEN` → global YAML → undefined. Never logged.
   */
  controlToken?: string;
  /**
   * Normalized default model recipe for pipeline kickoff. Empty map when unset.
   * YAML only — no env override (a nested role→selection map has no sane flat
   * encoding). Loaded once at startup; changing it requires `lca restart`.
   */
  pipelineRoleModels: Partial<Record<PipelineModelRole, ModelSelection>>;
  /**
   * Normalized named role-model recipes. Empty when YAML omits profiles.
   * Loaded once at startup; changing requires `lca restart`.
   */
  pipelineRoleModelProfiles: Record<
    string,
    Partial<Record<PipelineModelRole, ModelSelection>>
  >;
  /**
   * Resolved default named profile id, or null when unset/unknown.
   * Loaded once at startup; changing requires `lca restart`.
   */
  defaultPipelineRoleModelProfile: string | null;
  /**
   * Boot-sweep lookback for missed chain transitions. `0` disables the sweep.
   * Default 24h. Loaded once at startup.
   */
  pipelineResumeLookbackMs: number;
  /**
   * Auto-escalate safe post-terminal pipeline halts. Default on.
   * Kill switch: `LCA_PIPELINE_AUTO_ESCALATE=0`. Loaded once at startup.
   */
  pipelineAutoEscalate: boolean;
  /**
   * Max daemon escalations per pipeline lineage. Default 2.
   * Override: `LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE`. Loaded once at startup.
   */
  pipelineAutoEscalateMaxPerPipeline: number;
  /**
   * Request halt-discovery after unrecovered pipeline halts. Default on.
   * Kill switch: `LCA_PIPELINE_HALT_DISCOVERY=0`. Loaded once at startup.
   */
  pipelineHaltDiscovery: boolean;
  /** Max bytes for a single chat attachment upload. */
  maxAttachmentBytes: number;
  /** Max attachments allowed on one send/queue/interrupt message. */
  maxAttachmentsPerMessage: number;
  /** MIME allowlist for attachment uploads. */
  allowedAttachmentMimeTypes: string[];
  /** Max bytes returned for a single file-viewer content read. */
  maxFileViewerBytes: number;
  /** Max directory entries returned by the file-viewer listing API. */
  maxFileViewerEntries: number;
  /**
   * Resolved phone-notify prefs and optional ntfy connection. `events` is always
   * materialized (smart defaults + YAML + legacy migrate). Never fabricate
   * topic/token; topic/token are never logged. Unlike other settings knobs,
   * notify is hot-reloadable via `loadNotifySettings` (PATCH + config watcher).
   */
  notify: ResolvedNotifySettings;
};

export const DEFAULT_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/x-yaml",
  "text/yaml",
  "text/x-log",
] as const;

export const DEFAULT_SETTINGS: ResolvedSettings = {
  maxConcurrentRuns: 3,
  eventRetentionPerRun: 2000,
  maxEventPayloadBytes: 64 * 1024,
  spawnTimeoutMs: 120000,
  runStallTimeoutMs: 600000,
  maxSpawnAttempts: 3,
  retryBackoffMs: 5000,
  retainedSessionTtlMs: 1_800_000,
  sessionRevive: true,
  host: "127.0.0.1",
  allowedIps: [],
  pipelineRoleModels: {},
  pipelineRoleModelProfiles: {},
  defaultPipelineRoleModelProfile: null,
  pipelineResumeLookbackMs: 86_400_000,
  pipelineAutoEscalate: true,
  pipelineAutoEscalateMaxPerPipeline: 2,
  pipelineHaltDiscovery: true,
  maxAttachmentBytes: 15 * 1024 * 1024,
  maxAttachmentsPerMessage: 5,
  allowedAttachmentMimeTypes: [...DEFAULT_ATTACHMENT_MIME_TYPES],
  maxFileViewerBytes: 2 * 1024 * 1024,
  maxFileViewerEntries: 1000,
  notify: {
    events: DEFAULT_NOTIFY_EVENT_PREFS,
  },
};

// Generous floors keep an over-eager config from wedging the daemon: a run
// always gets at least one slot, and retention never drops so low that a live
// run loses its own tail mid-stream.
const MIN_RETENTION = 50;
const MIN_PAYLOAD_BYTES = 1024;
const MIN_SPAWN_TIMEOUT_MS = 10000;
const MIN_RUN_STALL_TIMEOUT_MS = 60000;
const MIN_MAX_SPAWN_ATTEMPTS = 1;
const MIN_RETRY_BACKOFF_MS = 0;
const MIN_RETAINED_SESSION_TTL_MS = 60000;
const MIN_ATTACHMENT_BYTES = 1024;
const MIN_ATTACHMENTS_PER_MESSAGE = 1;
const MIN_FILE_VIEWER_BYTES = 64 * 1024;
const MIN_FILE_VIEWER_ENTRIES = 50;

function envInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Like {@link envInt} but accepts `0` (used by lookback disable). */
function envNonNegInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function envStr(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

export type NetworkSafety =
  | { level: "ok" }
  | { level: "warn"; message: string }
  | { level: "fatal"; message: string };

export function validateNetworkSettings(
  host: string,
  allowedIps: readonly string[],
  opts?: { unsafeOptIn?: boolean }
): NetworkSafety {
  if (isLoopbackHost(host) || allowedIps.length > 0) {
    return { level: "ok" };
  }

  const warnMessage =
    `WARNING: host=${host} exposes the dashboard beyond loopback with ` +
    `no device allowlist. Set settings.allowedIps (or LCA_ALLOWED_IPS) to ` +
    `restrict access to specific devices.`;

  if (opts?.unsafeOptIn) {
    return { level: "warn", message: warnMessage };
  }

  return {
    level: "fatal",
    message:
      `host=${host} exposes the dashboard beyond loopback with no device allowlist. ` +
      `Set settings.allowedIps (or LCA_ALLOWED_IPS) to restrict access to specific devices, ` +
      `or set LCA_UNSAFE_NETWORK=1 to acknowledge the risk and start anyway.`,
  };
}

/** Parse a comma-separated IP list; returns undefined when empty so callers can fall back. */
function parseIpList(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const list = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Parse a comma-separated MIME allowlist; returns undefined when empty. */
function parseMimeList(raw: string | undefined): string[] | undefined {
  return parseIpList(raw);
}

type PipelineRoleModelsRaw =
  | Partial<Record<PipelineModelRole, ModelConfigValue>>
  | undefined;

/**
 * Normalize a YAML role→model map to ModelSelection values. Drop unusable
 * entries (empty id / normalize throw) so one bad role does not discard the rest.
 */
function normalizePipelineRoleModels(
  raw: PipelineRoleModelsRaw,
  logPrefix: string,
  onLog?: (message: string) => void
): Partial<Record<PipelineModelRole, ModelSelection>> {
  const resolved: Partial<Record<PipelineModelRole, ModelSelection>> = {};
  if (!raw) {
    return resolved;
  }
  for (const role of PIPELINE_MODEL_ROLES) {
    const value = raw[role];
    if (value === undefined) {
      continue;
    }
    try {
      const selection =
        typeof value === "string"
          ? modelSelectionFromLegacy(value)
          : normalizeModelSelection(value);
      if (!selection) {
        onLog?.(
          `${logPrefix}.${role} ignored (empty or whitespace model id)`
        );
        continue;
      }
      resolved[role] = selection;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLog?.(`${logPrefix}.${role} ignored: ${message}`);
    }
  }
  return resolved;
}

/**
 * Normalize YAML role defaults to ModelSelection values. No env override — a
 * nested role→selection map has no sane flat encoding.
 */
function resolvePipelineRoleModels(
  raw: DaemonSettings["pipelineRoleModels"],
  onLog?: (message: string) => void
): Partial<Record<PipelineModelRole, ModelSelection>> {
  return normalizePipelineRoleModels(raw, "pipelineRoleModels", onLog);
}

const VALID_PROFILE_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Normalize named profile recipes at load time. Invalid profile ids are dropped;
 * partial role maps inside a valid profile are kept.
 */
function resolvePipelineRoleModelProfiles(
  raw: DaemonSettings["pipelineRoleModelProfiles"],
  onLog?: (message: string) => void
): Record<string, Partial<Record<PipelineModelRole, ModelSelection>>> {
  const resolved: Record<
    string,
    Partial<Record<PipelineModelRole, ModelSelection>>
  > = {};
  if (!raw) {
    return resolved;
  }
  for (const [profileId, profileMap] of Object.entries(raw)) {
    if (!VALID_PROFILE_ID.test(profileId) || profileId === "default") {
      onLog?.(
        `pipelineRoleModelProfiles.${profileId} ignored (invalid profile id)`
      );
      continue;
    }
    resolved[profileId] = normalizePipelineRoleModels(
      profileMap,
      `pipelineRoleModelProfiles.${profileId}`,
      onLog
    );
  }
  return resolved;
}

function resolveDefaultPipelineRoleModelProfile(
  requested: string | undefined,
  profiles: Record<string, Partial<Record<PipelineModelRole, ModelSelection>>>,
  onLog?: (message: string) => void
): string | null {
  if (!requested?.trim()) {
    return null;
  }
  const id = requested.trim();
  if (!(id in profiles)) {
    onLog?.(
      `defaultPipelineRoleModelProfile "${id}" ignored (profile not found)`
    );
    return null;
  }
  return id;
}

/**
 * Materialize notify prefs and copy connection-only ntfy. Legacy
 * `notify.ntfy.events` allowlist migrates into per-event `ntfy: true` flags.
 * No env override and no fabricated topic defaults.
 */
export function resolveNotifySettings(
  fileNotify: NotifySettings | undefined
): ResolvedNotifySettings {
  const legacyAllowlist = fileNotify?.ntfy?.events;
  const events = mergeNotifyEventPrefs(fileNotify?.events, legacyAllowlist);

  const ntfyYaml = fileNotify?.ntfy;
  if (!ntfyYaml) {
    return { events };
  }

  const ntfy: NtfyNotifySettings = { topic: ntfyYaml.topic };
  if (ntfyYaml.server !== undefined) {
    ntfy.server = ntfyYaml.server;
  }
  if (ntfyYaml.token !== undefined) {
    ntfy.token = ntfyYaml.token;
  }
  return { events, ntfy };
}

/**
 * Re-read notify settings from the global YAML without reloading bind/host/
 * allowlist. Safe to call from the config watcher or notify PATCH handler.
 */
export function loadNotifySettings(
  options: { onLog?: (message: string) => void } = {}
): ResolvedNotifySettings {
  try {
    const fileSettings = parseGlobalConfig(GLOBAL_CONFIG_PATH).settings ?? {};
    return resolveNotifySettings(fileSettings.notify);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.onLog?.(`Notify settings ignored (invalid global config): ${message}`);
    return resolveNotifySettings(undefined);
  }
}

/**
 * Resolve daemon settings with precedence: env var → global YAML `settings:` →
 * built-in default, then clamp to safe floors. Read once at startup; changing
 * these requires a daemon restart (documented in the config reference).
 */
export function loadSettings(
  options: { onLog?: (message: string) => void } = {}
): ResolvedSettings {
  let fileSettings: DaemonSettings = {};
  try {
    fileSettings = parseGlobalConfig(GLOBAL_CONFIG_PATH).settings ?? {};
  } catch (err) {
    // A malformed `settings:` block is surfaced loudly but must not stop the
    // daemon from booting on safe defaults.
    const message = err instanceof Error ? err.message : String(err);
    options.onLog?.(`Settings ignored (invalid global config): ${message}`);
  }

  const pick = (env: string, file: number | undefined, fallback: number): number =>
    envInt(env) ?? file ?? fallback;

  const pipelineRoleModelProfiles = resolvePipelineRoleModelProfiles(
    fileSettings.pipelineRoleModelProfiles,
    options.onLog
  );

  const resolved: ResolvedSettings = {
    maxConcurrentRuns: Math.max(
      1,
      pick(
        "LCA_MAX_CONCURRENT",
        fileSettings.maxConcurrentRuns,
        DEFAULT_SETTINGS.maxConcurrentRuns
      )
    ),
    eventRetentionPerRun: Math.max(
      MIN_RETENTION,
      pick(
        "LCA_EVENT_RETENTION",
        fileSettings.eventRetentionPerRun,
        DEFAULT_SETTINGS.eventRetentionPerRun
      )
    ),
    maxEventPayloadBytes: Math.max(
      MIN_PAYLOAD_BYTES,
      pick(
        "LCA_MAX_EVENT_BYTES",
        fileSettings.maxEventPayloadBytes,
        DEFAULT_SETTINGS.maxEventPayloadBytes
      )
    ),
    spawnTimeoutMs: Math.max(
      MIN_SPAWN_TIMEOUT_MS,
      pick(
        "LCA_SPAWN_TIMEOUT_MS",
        fileSettings.spawnTimeoutMs,
        DEFAULT_SETTINGS.spawnTimeoutMs
      )
    ),
    runStallTimeoutMs: Math.max(
      MIN_RUN_STALL_TIMEOUT_MS,
      pick(
        "LCA_RUN_STALL_TIMEOUT_MS",
        fileSettings.runStallTimeoutMs,
        DEFAULT_SETTINGS.runStallTimeoutMs
      )
    ),
    maxSpawnAttempts: Math.max(
      MIN_MAX_SPAWN_ATTEMPTS,
      pick(
        "LCA_MAX_SPAWN_ATTEMPTS",
        fileSettings.maxSpawnAttempts,
        DEFAULT_SETTINGS.maxSpawnAttempts
      )
    ),
    retryBackoffMs: Math.max(
      MIN_RETRY_BACKOFF_MS,
      pick(
        "LCA_RETRY_BACKOFF_MS",
        fileSettings.retryBackoffMs,
        DEFAULT_SETTINGS.retryBackoffMs
      )
    ),
    retainedSessionTtlMs: (() => {
      const raw =
        envInt("LCA_RETAINED_SESSION_TTL_MS") ??
        fileSettings.retainedSessionTtlMs ??
        DEFAULT_SETTINGS.retainedSessionTtlMs;
      if (raw <= 0) {
        return 0;
      }
      return Math.max(MIN_RETAINED_SESSION_TTL_MS, raw);
    })(),
    sessionRevive:
      envBool("LCA_SESSION_REVIVE") ??
      fileSettings.sessionRevive ??
      DEFAULT_SETTINGS.sessionRevive,
    host: envStr("LCA_HOST") ?? fileSettings.host ?? DEFAULT_SETTINGS.host,
    allowedIps:
      parseIpList(envStr("LCA_ALLOWED_IPS")) ??
      fileSettings.allowedIps ??
      DEFAULT_SETTINGS.allowedIps,
    controlToken:
      envStr("LCA_CONTROL_TOKEN") ?? fileSettings.controlToken ?? undefined,
    // No env override for pipelineRoleModels (nested map; see helper comment).
    pipelineRoleModels: resolvePipelineRoleModels(
      fileSettings.pipelineRoleModels,
      options.onLog
    ),
    pipelineRoleModelProfiles,
    defaultPipelineRoleModelProfile: resolveDefaultPipelineRoleModelProfile(
      fileSettings.defaultPipelineRoleModelProfile,
      pipelineRoleModelProfiles,
      options.onLog
    ),
    pipelineResumeLookbackMs:
      envNonNegInt("LCA_PIPELINE_RESUME_LOOKBACK_MS") ??
      fileSettings.pipelineResumeLookbackMs ??
      DEFAULT_SETTINGS.pipelineResumeLookbackMs,
    pipelineAutoEscalate:
      envBool("LCA_PIPELINE_AUTO_ESCALATE") ??
      fileSettings.pipelineAutoEscalate ??
      DEFAULT_SETTINGS.pipelineAutoEscalate,
    pipelineAutoEscalateMaxPerPipeline: Math.max(
      1,
      pick(
        "LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE",
        fileSettings.pipelineAutoEscalateMaxPerPipeline,
        DEFAULT_SETTINGS.pipelineAutoEscalateMaxPerPipeline
      )
    ),
    pipelineHaltDiscovery:
      envBool("LCA_PIPELINE_HALT_DISCOVERY") ??
      fileSettings.pipelineHaltDiscovery ??
      DEFAULT_SETTINGS.pipelineHaltDiscovery,
    maxAttachmentBytes: Math.max(
      MIN_ATTACHMENT_BYTES,
      pick(
        "LCA_MAX_ATTACHMENT_BYTES",
        fileSettings.maxAttachmentBytes,
        DEFAULT_SETTINGS.maxAttachmentBytes
      )
    ),
    maxAttachmentsPerMessage: Math.max(
      MIN_ATTACHMENTS_PER_MESSAGE,
      pick(
        "LCA_MAX_ATTACHMENTS_PER_MESSAGE",
        fileSettings.maxAttachmentsPerMessage,
        DEFAULT_SETTINGS.maxAttachmentsPerMessage
      )
    ),
    allowedAttachmentMimeTypes:
      parseMimeList(envStr("LCA_ALLOWED_ATTACHMENT_MIME_TYPES")) ??
      fileSettings.allowedAttachmentMimeTypes ??
      DEFAULT_SETTINGS.allowedAttachmentMimeTypes,
    maxFileViewerBytes: Math.max(
      MIN_FILE_VIEWER_BYTES,
      pick(
        "LCA_MAX_FILE_VIEWER_BYTES",
        fileSettings.maxFileViewerBytes,
        DEFAULT_SETTINGS.maxFileViewerBytes
      )
    ),
    maxFileViewerEntries: Math.max(
      MIN_FILE_VIEWER_ENTRIES,
      pick(
        "LCA_MAX_FILE_VIEWER_ENTRIES",
        fileSettings.maxFileViewerEntries,
        DEFAULT_SETTINGS.maxFileViewerEntries
      )
    ),
    // YAML only — no env precedence / LCA_NO_NTFY here (transport phase).
    notify: resolveNotifySettings(fileSettings.notify),
  };

  const safety = validateNetworkSettings(resolved.host, resolved.allowedIps, {
    unsafeOptIn: process.env.LCA_UNSAFE_NETWORK === "1",
  });
  if (safety.level === "fatal") {
    throw new Error(safety.message);
  }
  if (safety.level === "warn") {
    options.onLog?.(safety.message);
  }

  return resolved;
}
