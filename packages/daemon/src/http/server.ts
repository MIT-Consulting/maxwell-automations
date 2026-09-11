import { createReadStream, existsSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer } from "ws";
import {
  automationCreateSchema,
  automationUpdateSchema,
  answerRunInputSchema,
  askRunInputSchema,
  chainControlSchema,
  pipelineWaveControlSchema,
  pipelineWaveOperatorSchema,
  runEscalationSchema,
  createChatSchema,
  provisionGeneratedWorkersSchema,
  provisionPipelineWorkersSchema,
  resolveImplementFullyKickoffSchema,
  resolveModelMutationInput,
  IMPLEMENT_FULLY_PIPELINE_ID,
  enqueueFeatureSchema,
  type DeleteRunsResponse,
  type AttachmentRef,
  type GeneratedWorkerPlan,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersResponse,
  type ResolveImplementFullyKickoffResponse,
  type InterruptChatRequest,
  type InterruptChatResponse,
  type ModelSelection,
  type InterruptRunRequest,
  type InterruptRunResponse,
  type PauseRunResponse,
  type QueueChatMessageRequest,
  type QueueChatMessageResponse,
  type QueueRunMessageRequest,
  type QueueRunMessageResponse,
  type ResumeRunRequest,
  type ResumeRunResponse,
  type SendChatMessageRequest,
  type SendChatMessageResponse,
  type SendRunMessageRequest,
  type SendRunMessageResponse,
  type SteerChatRequest,
  type SteerChatResponse,
  type UploadAttachmentRequest,
  type UploadAttachmentResponse,
  updateChatSchema,
  updateRunSchema,
  steerChatSchema,
  resolveSteerTargetRunId,
  triggerRunSchema,
  updateWorkspaceChatDefaultsSchema,
  updateNotifySettingsSchema,
  workspaceCreateSchema,
  type ChainRunContext,
  type McpOverlay,
  type NotifySettingsPublic,
  type UpdateNotifySettingsInput,
  type WorkspaceChatDefaults,
} from "@lca/shared";
import { ChatEngine, ChatMessageError } from "../chats/engine.js";
import { mapChatSession } from "../chats/store.js";
import {
  RunMessageError,
  TriggerRunValidationError,
  type RunEngine,
} from "../runs/engine.js";
import type { GitTriggerPayload, TriggerManager } from "../triggers/manager.js";
import { formatIssues } from "../config/parse.js";
import { provisionGeneratedWorkers } from "../config/generated-workers.js";
import {
  reconcileConfig,
  workspaceIdFromPath,
} from "../config/reconcile.js";
import {
  computeWorkspacePreconditions,
  getPipelineDefinition,
  pipelineRequiredSkills,
  toPipelineIntrospection,
} from "../pipelines/implement-fully.js";
import { appendWorkspaceToConfig, writeWorkspaceChatDefaults } from "../config/write.js";
import type { WorkspaceChatDefaultsRow } from "../chats/store.js";
import type { LcaDatabase } from "../db/index.js";
import { ModelCatalog } from "../models/catalog.js";
import { selectionFromStored } from "../models/selection-persist.js";
import { scanWorkspaceArtifacts } from "../artifacts/scan.js";
import {
  FileViewerError,
  listWorkspaceDir,
  readWorkspaceFile,
} from "../files/read.js";
import {
  RoadmapResolveError,
  resolveImplementFullyKickoff,
} from "../roadmap/resolve.js";
import type { PipelineWaveCoordinator } from "../runs/pipeline-wave-coordinator.js";
import {
  FeatureQueueError,
  FeatureQueueStore,
  toFeatureQueueEntry,
} from "../runs/feature-queue-store.js";
import type { FeatureQueueRunner } from "../runs/feature-queue-runner.js";
import type { DashboardStore } from "./dashboard-store.js";
import { WorkspaceNotFoundError } from "./dashboard-store.js";
import { pickWorkspaceFolder } from "./folder-picker.js";
import type { DaemonEventBus } from "../events.js";
import { runsToCsv, runsToJson } from "./export.js";
import { DASHBOARD_DIST, GLOBAL_CONFIG_PATH } from "../paths.js";
import type { ResolvedSettings } from "../config/settings.js";
import {
  AttachmentStore,
  mapAttachmentRow,
  toAttachmentRef,
} from "../attachments/store.js";
import {
  AttachmentValidationError,
  decodeBase64Content,
  readAttachmentBytes,
  validateAttachmentLimits,
  writeAttachmentBlob,
} from "../attachments/storage.js";

const DEFAULT_PORT = 3747;

/**
 * Dev-only single-port mode. When `LCA_DEV_VITE` points at a running Vite dev
 * server (e.g. http://127.0.0.1:5273), the daemon reverse-proxies every request
 * that isn't `/api/*` — including Vite's HMR websocket — to it. This means the
 * live-reloading dev UI is served on the daemon's own port/host, so it's
 * reachable wherever the daemon is (loopback, LAN, Tailscale) with no second
 * port to expose. Unset in production, where the daemon serves the static build.
 */
const DEV_VITE_TARGET = process.env.LCA_DEV_VITE
  ? new URL(process.env.LCA_DEV_VITE)
  : null;

export type HttpServer = {
  port: number;
  /** Primary configured bind host (back-compat; see `bindAddresses` for the full set). */
  host: string;
  /** Every address actually listened on — loopback plus any specific bind host. */
  bindAddresses: string[];
  close: () => Promise<void>;
};

export type HttpServerDeps = {
  engine: RunEngine;
  chatEngine: ChatEngine;
  store: DashboardStore;
  db: LcaDatabase;
  events: DaemonEventBus;
  apiKey: string;
  settings: Pick<
    ResolvedSettings,
    | "maxAttachmentBytes"
    | "maxAttachmentsPerMessage"
    | "allowedAttachmentMimeTypes"
    | "maxFileViewerBytes"
    | "maxFileViewerEntries"
    | "pipelineRoleModels"
    | "pipelineRoleModelProfiles"
    | "defaultPipelineRoleModelProfile"
  >;
  /**
   * Optional catalog source for tests/verify scripts. When omitted, the daemon
   * calls `Cursor.models.list` with `apiKey`.
   */
  listModels?: (apiKey: string) => Promise<unknown>;
  triggers?: TriggerManager;
  port?: number;
  /** Address to bind on (default `127.0.0.1`). */
  host?: string;
  /**
   * Non-loopback source IPs allowed to reach the server. Empty disables the
   * allowlist (any IP that reaches the bound host is allowed); loopback is
   * always permitted so the CLI, git-hook triggers, and the MCP bridge keep
   * working regardless of this list.
   */
  allowedIps?: readonly string[];
  /**
   * Shared app-auth token. When set, every non-loopback request (reads, writes,
   * and the `/ws` upgrade) must present it via `X-LCA-Control-Token` (or `?token=`
   * on `/ws`); loopback is exempt. Undefined leaves the daemon token-free.
   */
  controlToken?: string;
  /**
   * Invoked by `POST /api/shutdown` to run the daemon's full graceful teardown
   * (stop triggers, close http/db, drain the engine, exit). Enables a clean,
   * cross-platform stop without relying on OS signals (Windows `Stop-Process`
   * is a hard kill and never triggers SIGINT/SIGTERM handlers).
   */
  onShutdown?: (reason: string) => void | Promise<void>;
  /**
   * Invoked by `POST /api/restart` to gracefully tear the daemon down and spawn
   * a fresh detached copy that re-binds the same port. This is the remote
   * recovery path: a Tailscale-connected phone can kick a misbehaving daemon
   * without shell access to the host. Gated by the control token like every
   * other `/api/*` mutation.
   */
  onRestart?: (reason: string) => void | Promise<void>;
  /**
   * Whether self-relaunch is available. False in dev (Vite + `node --watch`
   * already hot-restart the daemon, and a self-spawn would fight the watch rig),
   * so `POST /api/restart` reports 501 there instead of orphaning a process.
   */
  restartSupported?: boolean;
  /** Daemon logger for audit/degrade lines. No-ops when omitted (tests, standalone). */
  onLog?: (message: string) => void;
  /** Parallel-wave fan-out, finalize, block, and operator recovery. */
  waveCoordinator?: PipelineWaveCoordinator;
  /** Per-workspace implement-fully feature queue (b58). */
  featureQueue?: FeatureQueueStore;
  /** Settle runner for idle enqueue starts (b58 phase 2). */
  featureQueueRunner?: FeatureQueueRunner;
  /** Hot-reloadable notify settings (GET/PATCH/test). Omitted in tests that skip notify. */
  notify?: {
    getPublic: () => NotifySettingsPublic;
    patch: (body: UpdateNotifySettingsInput) => NotifySettingsPublic;
    testSend: () => Promise<{ ok: true } | { ok: false; error: string }>;
  };
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Strip the IPv4-mapped-IPv6 prefix so `::ffff:100.64.0.1` compares as `100.64.0.1`. */
function normalizeIp(addr: string | undefined): string {
  if (!addr) {
    return "";
  }
  return addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
}

function isLoopback(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.");
}

/**
 * Gate an incoming connection by source IP. Loopback is always allowed (local
 * CLI, triggers, MCP bridge). With an empty allowlist every source is allowed
 * and exposure is governed solely by the bind host; a non-empty allowlist
 * restricts access to loopback plus the listed device IPs.
 */
export function isAllowedSource(
  remoteAddress: string | undefined,
  allowedIps: readonly string[]
): boolean {
  const ip = normalizeIp(remoteAddress);
  if (isLoopback(ip)) {
    return true;
  }
  if (allowedIps.length === 0) {
    return true;
  }
  return allowedIps.includes(ip);
}

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Always bound alongside a specific host so local tooling keeps reaching loopback. */
const LOOPBACK_COMPANION = "127.0.0.1";

/**
 * Whether an accepted request should produce a remote-mutation audit line. Only
 * state-changing methods from a non-loopback source qualify — loopback traffic
 * (local CLI, git hooks, MCP bridge) is the common case and must not be logged.
 */
export function shouldAuditMutation(
  method: string,
  isLoopbackSource: boolean
): boolean {
  if (isLoopbackSource) {
    return false;
  }
  return MUTATING_METHODS.has(method.toUpperCase());
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function formatOriginHost(addr: string): string {
  return addr.includes(":") ? `[${addr}]` : addr;
}

function httpOrigin(addr: string, port: number): string {
  return `http://${formatOriginHost(addr)}:${port}`;
}

/**
 * Origins browsers may use for same-origin dashboard/API traffic on this daemon.
 * Loopback origins are always allowed; remote bind/allowlist addresses are added
 * when configured.
 */
export function buildAllowedOrigins(args: {
  host: string;
  port: number;
  allowedIps: readonly string[];
}): Set<string> {
  const { host, port, allowedIps } = args;
  const origins = new Set<string>();
  origins.add(httpOrigin("127.0.0.1", port));
  origins.add(httpOrigin("localhost", port));
  origins.add(httpOrigin("::1", port));

  if (!WILDCARD_HOSTS.has(host) && !isLoopbackHost(host)) {
    origins.add(httpOrigin(host, port));
  }

  for (const ip of allowedIps) {
    if (!isLoopback(ip)) {
      origins.add(httpOrigin(ip, port));
    }
  }

  return origins;
}

/**
 * Map the configured `host` to the set of addresses the daemon listens on.
 * A specific (non-loopback, non-wildcard) host is paired with a loopback
 * companion so the CLI, git hooks, and the MCP bridge keep reaching
 * `127.0.0.1` while the port is *not* exposed on every interface. Loopback and
 * wildcard hosts already cover local traffic, so they listen on a single address.
 */
export function resolveBindHosts(host: string): string[] {
  if (isLoopbackHost(host) || WILDCARD_HOSTS.has(host)) {
    return [host];
  }
  return [LOOPBACK_COMPANION, host];
}

/**
 * Whether a listener error on `host` should degrade to loopback-only rather than
 * be fatal. Only a *specific* (non-loopback, non-wildcard) host that isn't
 * assigned at boot (`EADDRNOTAVAIL` — e.g. Tailscale not up yet after a reboot)
 * qualifies; the loopback companion must always bind, and `EADDRINUSE`/other
 * codes stay fatal so genuine misconfig is loud.
 */
export function isDegradableBindError(
  err: NodeJS.ErrnoException,
  host: string
): boolean {
  if (isLoopbackHost(host) || WILDCARD_HOSTS.has(host)) {
    return false;
  }
  return err.code === "EADDRNOTAVAIL";
}

function mediaType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * Pre-dispatch CSRF guard for state-changing HTTP methods. Rejects foreign
 * Origin/Referer and non-JSON Content-Type when a type is declared.
 */
export function isCsrfSafe(
  req: { method: string; origin?: string; referer?: string; contentType?: string },
  allowedOrigins: ReadonlySet<string>
): boolean {
  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method)) {
    return true;
  }

  let candidateOrigin: string | undefined;
  if (req.origin?.trim()) {
    candidateOrigin = req.origin.trim();
  } else if (req.referer?.trim()) {
    try {
      candidateOrigin = new URL(req.referer.trim()).origin;
    } catch {
      candidateOrigin = "__invalid__";
    }
  }

  if (candidateOrigin !== undefined && !allowedOrigins.has(candidateOrigin)) {
    return false;
  }

  if (req.contentType?.trim()) {
    if (mediaType(req.contentType) !== "application/json") {
      return false;
    }
  }

  return true;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time string compare; length mismatch short-circuits without throwing. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export type ControlTokenResult = "ok" | "missing" | "mismatch" | "unprovisioned";

/**
 * Decide whether a request may proceed under the control-token app-auth layer.
 * Loopback sources are always exempt. Non-loopback sources require a valid token
 * when one is configured, and are refused (fail-closed) when remote was enabled
 * without provisioning a token.
 */
export function checkControlToken(args: {
  isLoopbackSource: boolean;
  controlToken?: string;
  presented?: string;
}): ControlTokenResult {
  if (args.isLoopbackSource) {
    return "ok";
  }
  if (!args.controlToken) {
    return "unprovisioned";
  }
  if (!args.presented) {
    return "missing";
  }
  return safeEqual(args.presented, args.controlToken) ? "ok" : "mismatch";
}

function runMessageErrorStatus(err: unknown): number {
  if (err instanceof RunMessageError) {
    switch (err.code) {
      case "not_found":
        return 404;
      case "busy":
      case "needs_input":
        return 409;
      case "not_resumable":
        return 422;
      case "context_missing":
      case "empty_message":
        return 400;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  return /not found/i.test(message)
    ? 404
    : /not resumable/i.test(message)
      ? 422
      : /busy|running|queued|awaiting input|needs_input/i.test(message)
        ? 409
        : 400;
}

function chatMessageErrorStatus(err: unknown): number {
  if (err instanceof ChatMessageError) {
    switch (err.code) {
      case "not_found":
        return 404;
      case "busy":
      case "needs_input":
      case "archived":
        return 409;
      case "context_missing":
      case "empty_message":
        return 400;
    }
  }
  return runMessageErrorStatus(err);
}

function attachmentErrorStatus(err: AttachmentValidationError): number {
  if (/^Attachment not found:/i.test(err.message)) {
    return 404;
  }
  switch (err.code) {
    case "payload_too_large":
      return 413;
    case "unsupported_media":
      return 415;
    case "bad_request":
      return 400;
  }
}

function parseAttachmentRefs(
  value: unknown,
  settings: HttpServerDeps["settings"],
  store: AttachmentStore,
  ownerKind: "run" | "chat",
  ownerId: string
): AttachmentRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new AttachmentValidationError("bad_request", "attachments must be an array");
  }
  if (value.some((item) => typeof item !== "string" && (!item || typeof item !== "object"))) {
    throw new AttachmentValidationError("bad_request", "attachments are invalid");
  }

  const refs: AttachmentRef[] = [];
  for (const item of value) {
    const id =
      typeof item === "string"
        ? item
        : typeof (item as Record<string, unknown>).id === "string"
          ? (item as Record<string, unknown>).id as string
          : undefined;
    if (!id) {
      throw new AttachmentValidationError("bad_request", "attachments are invalid");
    }
    const attachment = store.getById(ownerKind, ownerId, id);
    if (!attachment) {
      throw new AttachmentValidationError("bad_request", `Attachment not found: ${id}`);
    }
    validateAttachmentLimits(settings, {
      mimeType: attachment.mime_type,
      sizeBytes: attachment.size_bytes,
      attachmentCount: value.length,
    });
    refs.push(toAttachmentRef(attachment));
  }
  return refs;
}

function sendAttachment(res: ServerResponse, attachment: {
  filename: string;
  mime_type: string;
  kind: "image" | "file";
  storage_path: string;
}): void {
  const content = readAttachmentBytes(attachment.storage_path);
  const disposition = attachment.kind === "image" ? "inline" : "attachment";
  res.writeHead(200, {
    "Content-Type": attachment.mime_type,
    "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(
      attachment.filename
    )}`,
    "Content-Length": content.length,
  });
  res.end(content);
}

function assertRunnableWorkspace(
  store: DashboardStore,
  workspaceId: string
): { path: string } | null {
  const lookup = store.getWorkspacePath(workspaceId);
  if (!lookup.found || !lookup.path) {
    return null;
  }
  return { path: lookup.path };
}

function parseMcpOverlay(json: string): McpOverlay {
  try {
    const parsed = JSON.parse(json) as McpOverlay;
    return parsed ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolve a mutation's legacy/canonical model fields to a canonical selection.
 * `undefined` means the request left the model unchanged.
 */
function resolveRequestModel(input: {
  model?: string | null;
  modelSelection?: ModelSelection | null;
}): ModelSelection | null | undefined {
  return resolveModelMutationInput(input);
}

function mapWorkspaceChatDefaults(
  workspaceId: string,
  row: WorkspaceChatDefaultsRow | undefined
): WorkspaceChatDefaults {
  if (!row) {
    return { workspaceId, model: null, modelSelection: null, systemPrompt: null, mcp: {} };
  }
  const modelSelection = selectionFromStored(row.model, row.model_params_json);
  return {
    workspaceId,
    model: row.model,
    modelSelection,
    systemPrompt: row.system_prompt,
    mcp: parseMcpOverlay(row.mcp_overlay_json),
  };
}

/**
 * Serve the built dashboard SPA with a history-API fallback to index.html.
 * Returns false when no build exists (dev runs the Vite server instead).
 */
function serveStatic(pathname: string, res: ServerResponse): boolean {
  if (!existsSync(DASHBOARD_DIST)) {
    return false;
  }

  const indexHtml = join(DASHBOARD_DIST, "index.html");
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // Block path traversal: resolved file must stay inside the dist root.
  const candidate = normalize(join(DASHBOARD_DIST, rel));
  let filePath = candidate;
  if (
    !candidate.startsWith(normalize(DASHBOARD_DIST)) ||
    !existsSync(candidate) ||
    statSync(candidate).isDirectory()
  ) {
    filePath = indexHtml;
  }

  if (!existsSync(filePath)) {
    return false;
  }

  const mime = MIME[extname(filePath)] ?? "application/octet-stream";
  // index.html references content-hashed asset filenames, so it must never be
  // cached — otherwise a fresh build's new bundle is invisible until a *hard*
  // refresh. The hashed assets themselves are safe to cache forever.
  const isHtml = extname(filePath) === ".html";
  const cacheControl = isHtml
    ? "no-cache, no-store, must-revalidate"
    : "public, max-age=31536000, immutable";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": cacheControl });
  createReadStream(filePath).pipe(res);
  return true;
}

/** Serialize Node response headers into raw HTTP header lines. */
function rawHeaderLines(res: IncomingMessage): string {
  const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
  for (const [key, value] of Object.entries(res.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${key}: ${v}`);
    } else if (value !== undefined) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\r\n") + "\r\n\r\n";
}

/** Reverse-proxy a plain HTTP request to the Vite dev server (dev mode only). */
function proxyHttpToVite(req: IncomingMessage, res: ServerResponse): void {
  const target = DEV_VITE_TARGET!;
  const proxyReq = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      // Rewrite Host to Vite's own origin so Vite's dev-server host checks
      // accept requests that arrived at the daemon under a LAN/Tailscale host.
      headers: { ...req.headers, host: target.host },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  // Swallow client/proxy socket errors (aborted loads, flaky phone links) so a
  // dropped connection can never take the daemon down.
  proxyReq.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`vite dev proxy error: ${err.message}`);
  });
  req.on("error", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

/** Reverse-proxy a websocket upgrade (Vite HMR) to the Vite dev server. */
function proxyUpgradeToVite(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer
): void {
  const target = DEV_VITE_TARGET!;
  // Attach the client error handler up front: if the client aborts before Vite
  // completes the handshake, the socket must already have an 'error' listener
  // or Node throws an unhandled error and crashes the daemon.
  clientSocket.on("error", () => clientSocket.destroy());

  const proxyReq = httpRequest({
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    // Vite authorizes HMR via a per-session ?token= (issued in /@vite/client),
    // so the Origin is irrelevant — no rewrite needed. Host is normalized so
    // Vite's host checks accept LAN/Tailscale-fronted requests.
    headers: { ...req.headers, host: target.host },
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    proxySocket.on("error", () => clientSocket.destroy());
    clientSocket.write(rawHeaderLines(proxyRes));
    if (proxyHead?.length) proxySocket.unshift(proxyHead);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });
  // Vite refused the upgrade (e.g. bad/missing token): relay its response and
  // close, rather than leaving the client hanging.
  proxyReq.on("response", (proxyRes) => {
    clientSocket.write(rawHeaderLines(proxyRes));
    proxyRes.pipe(clientSocket);
    proxyRes.on("end", () => clientSocket.end());
  });
  proxyReq.on("error", () => clientSocket.destroy());
  if (head?.length) proxyReq.write(head);
  proxyReq.end();
}

export function startHttpServer(deps: HttpServerDeps): Promise<HttpServer> {
  const {
    engine,
    chatEngine,
    store,
    db,
    events,
    triggers,
    onShutdown,
    onRestart,
    apiKey,
    settings,
    waveCoordinator,
  } = deps;
  const featureQueue = deps.featureQueue ?? new FeatureQueueStore(db);
  const notify = deps.notify;
  const attachmentStore = new AttachmentStore(db);
  const modelCatalog = new ModelCatalog({
    apiKey,
    listModels: deps.listModels,
  });
  const restartSupported = deps.restartSupported ?? false;
  const port = deps.port ?? Number(process.env.LCA_PORT ?? DEFAULT_PORT);
  const host = deps.host ?? "127.0.0.1";
  const bindHosts = resolveBindHosts(host);
  const allowedIps = deps.allowedIps ?? [];
  const controlToken = deps.controlToken;
  const log = deps.onLog ?? (() => {});
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const allowedOrigins = buildAllowedOrigins({ host, port, allowedIps });
  // One-shot warning when a non-loopback request arrives with remote enabled but
  // no token provisioned (fail-closed); avoids per-request log spam.
  let warnedUnprovisioned = false;
  // One-shot INFO when the first non-loopback source of the boot is seen, so an
  // operator can confirm a remote device actually reached the daemon.
  let loggedFirstRemote = false;

  const requestListener = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    if (!isAllowedSource(req.socket.remoteAddress, allowedIps)) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    const sourceIp = normalizeIp(req.socket.remoteAddress);
    const isLoopbackSource = isLoopback(sourceIp);
    if (!isLoopbackSource && !loggedFirstRemote) {
      loggedFirstRemote = true;
      log(
        `First non-loopback request from ${sourceIp} ` +
          `(allowlisted: ${allowedIps.includes(sourceIp)})`
      );
    }
    // The control token gates the data plane (`/api/*` here, `/ws` on upgrade).
    // The static SPA shell and `/health` carry no run data and must stay loadable
    // so a remote browser can boot the app and render the token prompt.
    const reqPath = (req.url ?? "/").split("?")[0];
    if (reqPath.startsWith("/api/")) {
      const tokenResult = checkControlToken({
        isLoopbackSource,
        controlToken,
        presented: headerValue(req.headers["x-lca-control-token"]),
      });
      if (tokenResult !== "ok") {
        if (tokenResult === "missing") {
          sendJson(res, 401, { error: "missing control token" });
        } else if (tokenResult === "mismatch") {
          sendJson(res, 403, { error: "forbidden" });
        } else {
          if (!warnedUnprovisioned) {
            warnedUnprovisioned = true;
            console.error(
              "[lca-daemon] Non-loopback request refused: remote is enabled but no " +
                "control token is provisioned. Run `lca remote on <ip>` to provision one."
            );
          }
          sendJson(res, 401, { error: "remote auth not provisioned" });
        }
        return;
      }
    }
    const method = req.method ?? "GET";
    if (
      !isCsrfSafe(
        {
          method,
          origin: headerValue(req.headers.origin),
          referer: headerValue(req.headers.referer),
          contentType: headerValue(req.headers["content-type"]),
        },
        allowedOrigins
      )
    ) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    // Audit accepted remote mutations (after the IP/token/CSRF gates). `reqPath`
    // is already query-string-stripped, so no token in `/ws?token=`-style URLs
    // or elsewhere can leak into the log.
    if (shouldAuditMutation(method, isLoopbackSource)) {
      log(`remote ${method.toUpperCase()} ${reqPath} from ${sourceIp}`);
    }
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, version: "0.0.0" });
        return;
      }

      if (method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, {
          ok: true,
          version: "0.0.0",
          pid: process.pid,
          port,
          host,
          bindAddresses: bindHosts,
          allowedIps,
          remoteAuth: Boolean(controlToken),
          mode: DEV_VITE_TARGET ? "dev" : "prod",
          startedAt,
          uptimeMs: Date.now() - startedAtMs,
        });
        return;
      }

      if (notify && url.pathname === "/api/settings/notify") {
        if (method === "GET") {
          sendJson(res, 200, notify.getPublic());
          return;
        }

        if (method === "PATCH") {
          const body = await readJson<unknown>(req);
          const parsed = updateNotifySettingsSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
            return;
          }
          sendJson(res, 200, notify.patch(parsed.data));
          return;
        }

        sendJson(res, 404, { error: "not found" });
        return;
      }

      if (notify && method === "POST" && url.pathname === "/api/settings/notify/test") {
        const snapshot = notify.getPublic();
        if (!snapshot.usable.ntfy) {
          sendJson(res, 400, {
            error: snapshot.ntfy
              ? "ntfy disabled or unavailable"
              : "ntfy not configured",
          });
          return;
        }
        const result = await notify.testSend();
        if (result.ok) {
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 502, { ok: false, error: result.error });
        return;
      }

      if (method === "GET" && url.pathname === "/api/automations") {
        sendJson(res, 200, { automations: store.listAutomations() });
        return;
      }

      if (method === "GET" && url.pathname === "/api/models") {
        sendJson(res, 200, await modelCatalog.list());
        return;
      }

      if (method === "POST" && url.pathname === "/api/automations") {
        const body = await readJson<unknown>(req);
        const parsed = automationCreateSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        try {
          const automation = store.createAutomation(parsed.data);
          triggers?.refresh();
          events.emitAutomationEvent("created", automation.id, automation);
          sendJson(res, 201, { automation });
        } catch (err) {
          if (err instanceof WorkspaceNotFoundError) {
            sendJson(res, 404, { error: err.message });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === "POST" && url.pathname === "/api/generated-workers") {
        const body = await readJson<unknown>(req);
        const parsed = provisionGeneratedWorkersSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        const { workers, dryRun, prune } = parsed.data;
        let workspaceId = parsed.data.workspaceId;
        if (parsed.data.workspacePath !== undefined) {
          workspaceId = workspaceIdFromPath(parsed.data.workspacePath);
        }
        if (!workspaceId) {
          sendJson(res, 400, {
            error: "exactly one of workspaceId or workspacePath is required",
          });
          return;
        }
        if (workspaceId === "__global__") {
          sendJson(res, 400, {
            error:
              "generated workers cannot be provisioned in the global workspace (they cannot run)",
          });
          return;
        }
        const workspace = db
          .prepare("SELECT id FROM workspaces WHERE id = ?")
          .get(workspaceId) as { id: string } | undefined;
        if (!workspace) {
          sendJson(res, 404, { error: "workspace not found" });
          return;
        }
        const plan: GeneratedWorkerPlan = provisionGeneratedWorkers(
          db,
          workspaceId,
          workers,
          { dryRun, prune }
        );
        if (plan.items.some((item) => item.action === "conflict")) {
          sendJson(res, 409, plan);
          return;
        }
        const wrote =
          plan.applied &&
          plan.items.some(
            (item) =>
              item.action === "create" ||
              item.action === "update" ||
              item.action === "revive" ||
              item.action === "archive"
          );
        if (wrote) {
          triggers?.refresh();
          for (const item of plan.items) {
            if (
              item.action === "create" ||
              item.action === "update" ||
              item.action === "revive"
            ) {
              const automation = store.listAutomations().find(
                (a) => a.id === item.automationId
              );
              events.emitAutomationEvent(
                item.action === "create" ? "created" : "updated",
                item.automationId,
                automation
              );
            } else if (item.action === "archive") {
              // Archived automations disappear from listAutomations, matching the
              // dashboard DELETE route's soft-delete semantics.
              events.emitAutomationEvent("deleted", item.automationId);
            }
          }
        }
        sendJson(res, 200, plan);
        return;
      }

      const pipelineResolveMatch = url.pathname.match(
        /^\/api\/pipelines\/([^/]+)\/resolve$/
      );
      if (pipelineResolveMatch) {
        if (method !== "POST") {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const pipelineId = decodeURIComponent(pipelineResolveMatch[1]!);
        if (pipelineId !== IMPLEMENT_FULLY_PIPELINE_ID) {
          if (!getPipelineDefinition(pipelineId)) {
            sendJson(res, 404, {
              error: `unknown pipeline: ${pipelineId}`,
            });
          } else {
            sendJson(res, 404, {
              error: `resolve is not supported for pipeline: ${pipelineId}`,
            });
          }
          return;
        }
        const body = await readJson<unknown>(req);
        const parsed = resolveImplementFullyKickoffSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        const { workspaceId, input } = parsed.data;
        if (workspaceId === "__global__") {
          sendJson(res, 400, {
            error:
              "implement-fully resolve cannot use the global workspace",
          });
          return;
        }
        const workspace = assertRunnableWorkspace(store, workspaceId);
        if (!workspace) {
          sendJson(res, 404, { error: "workspace not found" });
          return;
        }
        const preconditions = computeWorkspacePreconditions(
          workspaceId,
          workspace.path
        );
        if (!preconditions.gitRepo) {
          sendJson(res, 400, {
            error: "workspace is not a git repository",
          });
          return;
        }
        if (!preconditions.roadmapIndex) {
          sendJson(res, 404, {
            error: "roadmap index not found",
          });
          return;
        }
        try {
          const resolved: ResolveImplementFullyKickoffResponse =
            resolveImplementFullyKickoff(workspace.path, input, {
              maxBytes: settings.maxFileViewerBytes,
              maxEntries: settings.maxFileViewerEntries,
            });
          sendJson(res, 200, resolved);
        } catch (err) {
          if (err instanceof RoadmapResolveError) {
            sendJson(
              res,
              err.category === "bad_request" ? 400 : 404,
              { error: err.message }
            );
            return;
          }
          throw err;
        }
        return;
      }

      const pipelineWorkersMatch = url.pathname.match(
        /^\/api\/pipelines\/([^/]+)\/workers$/
      );
      if (pipelineWorkersMatch) {
        if (method !== "POST") {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const pipelineId = decodeURIComponent(pipelineWorkersMatch[1]);
        const definition = getPipelineDefinition(pipelineId);
        if (!definition) {
          sendJson(res, 404, {
            error: `unknown pipeline: ${pipelineId}`,
          });
          return;
        }
        const body = await readJson<unknown>(req);
        const parsed = provisionPipelineWorkersSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        const { dryRun, prune } = parsed.data;
        // prune archives generated rows in this workspace that are absent from
        // the desired set. With one registered pipeline that is exactly "remove
        // workers this pipeline no longer defines". A second pipeline would make
        // prune cross-pipeline, so the flag stays opt-in and defaults to false.
        let workspaceId = parsed.data.workspaceId;
        if (parsed.data.workspacePath !== undefined) {
          workspaceId = workspaceIdFromPath(parsed.data.workspacePath);
        }
        if (!workspaceId) {
          sendJson(res, 400, {
            error: "exactly one of workspaceId or workspacePath is required",
          });
          return;
        }
        if (workspaceId === "__global__") {
          sendJson(res, 400, {
            error:
              "generated workers cannot be provisioned in the global workspace (they cannot run)",
          });
          return;
        }
        const workspace = db
          .prepare("SELECT id, path FROM workspaces WHERE id = ?")
          .get(workspaceId) as { id: string; path: string } | undefined;
        if (!workspace) {
          sendJson(res, 404, { error: "workspace not found" });
          return;
        }
        const plan: GeneratedWorkerPlan = provisionGeneratedWorkers(
          db,
          workspaceId,
          definition.workers,
          { dryRun, prune }
        );
        const artifacts = scanWorkspaceArtifacts(workspace.path);
        const presentSkills = new Set(
          artifacts
            .filter((artifact) => artifact.kind === "skill")
            .map((artifact) => artifact.name)
        );
        const missingSkills = pipelineRequiredSkills(definition).filter(
          (skill) => !presentSkills.has(skill)
        );
        const response: ProvisionPipelineWorkersResponse = {
          pipelineId,
          plan,
          missingSkills,
        };
        if (plan.items.some((item) => item.action === "conflict")) {
          sendJson(res, 409, response);
          return;
        }
        const wrote =
          plan.applied &&
          plan.items.some(
            (item) =>
              item.action === "create" ||
              item.action === "update" ||
              item.action === "revive" ||
              item.action === "archive"
          );
        if (wrote) {
          triggers?.refresh();
          for (const item of plan.items) {
            if (
              item.action === "create" ||
              item.action === "update" ||
              item.action === "revive"
            ) {
              const automation = store.listAutomations().find(
                (a) => a.id === item.automationId
              );
              events.emitAutomationEvent(
                item.action === "create" ? "created" : "updated",
                item.automationId,
                automation
              );
            } else if (item.action === "archive") {
              events.emitAutomationEvent("deleted", item.automationId);
            }
          }
        }
        sendJson(res, 200, response);
        return;
      }

      const pipelineMatch = url.pathname.match(/^\/api\/pipelines\/([^/]+)$/);
      if (pipelineMatch) {
        if (method !== "GET") {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const pipelineId = decodeURIComponent(pipelineMatch[1]);
        const definition = getPipelineDefinition(pipelineId);
        if (!definition) {
          sendJson(res, 404, {
            error: `unknown pipeline: ${pipelineId}`,
          });
          return;
        }
        const introspection: PipelineIntrospectionResponse =
          toPipelineIntrospection(definition, {
            pipelineRoleModels: settings.pipelineRoleModels,
            pipelineRoleModelProfiles: settings.pipelineRoleModelProfiles,
            defaultPipelineRoleModelProfile:
              settings.defaultPipelineRoleModelProfile,
          });
        const workspaceIdParam = url.searchParams.get("workspaceId");
        if (workspaceIdParam != null && workspaceIdParam !== "") {
          const lookup = store.getWorkspacePath(workspaceIdParam);
          if (!lookup.found || lookup.path == null) {
            sendJson(res, 400, {
              error: `unknown or unregistered workspace: ${workspaceIdParam}`,
            });
            return;
          }
          introspection.preconditions = computeWorkspacePreconditions(
            workspaceIdParam,
            lookup.path
          );
        }
        sendJson(res, 200, introspection);
        return;
      }

      const artifactsMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/artifacts$/
      );
      if (artifactsMatch) {
        if (method !== "GET") {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const workspaceId = decodeURIComponent(artifactsMatch[1]);
        const workspace = store.getWorkspacePath(workspaceId);
        if (!workspace.found) {
          sendJson(res, 404, { error: "workspace not found" });
          return;
        }
        sendJson(res, 200, {
          artifacts: scanWorkspaceArtifacts(workspace.path),
        });
        return;
      }

      const filesContentMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/files\/content$/
      );
      if (filesContentMatch) {
        if (method !== "GET") {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const workspaceId = decodeURIComponent(filesContentMatch[1]);
        const workspace = assertRunnableWorkspace(store, workspaceId);
        if (!workspace) {
          sendJson(res, 404, { error: "workspace not found" });
          return;
        }
        const filePath = url.searchParams.get("path");
        if (filePath === null || filePath === "") {
          sendJson(res, 400, { error: "path is required" });
          return;
        }
        try {
          sendJson(
            res,
            200,
            readWorkspaceFile(workspace.path, filePath, {
              maxBytes: settings.maxFileViewerBytes,
            })
          );
        } catch (err) {
          if (err instanceof FileViewerError) {
            sendJson(
              res,
              err.code === "bad_request" ? 400 : 404,
              { error: err.message }
            );
            return;
          }
          throw err;
        }
        return;
      }

      const filesListMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/files$/
      );
      if (filesListMatch) {
        if (method !== "GET") {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const workspaceId = decodeURIComponent(filesListMatch[1]);
        const workspace = assertRunnableWorkspace(store, workspaceId);
        if (!workspace) {
          sendJson(res, 404, { error: "workspace not found" });
          return;
        }
        const dir = url.searchParams.get("dir") ?? "";
        try {
          sendJson(
            res,
            200,
            listWorkspaceDir(workspace.path, dir, {
              maxEntries: settings.maxFileViewerEntries,
            })
          );
        } catch (err) {
          if (err instanceof FileViewerError) {
            sendJson(
              res,
              err.code === "bad_request" ? 400 : 404,
              { error: err.message }
            );
            return;
          }
          throw err;
        }
        return;
      }

      const workspaceChatDefaultsMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/chat-defaults$/
      );
      if (workspaceChatDefaultsMatch) {
        const workspaceId = decodeURIComponent(workspaceChatDefaultsMatch[1]);
        const chatStore = chatEngine.getChatStore();

        if (method === "GET") {
          if (!assertRunnableWorkspace(store, workspaceId)) {
            sendJson(res, 404, { error: "workspace not found" });
            return;
          }
          const row = chatStore.getWorkspaceChatDefaults(workspaceId);
          sendJson(res, 200, {
            defaults: mapWorkspaceChatDefaults(workspaceId, row),
          });
          return;
        }

        if (method === "PATCH") {
          const body = await readJson<unknown>(req);
          const parsed = updateWorkspaceChatDefaultsSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
            return;
          }
          const workspace = assertRunnableWorkspace(store, workspaceId);
          if (!workspace) {
            sendJson(res, 404, { error: "workspace not found" });
            return;
          }
          writeWorkspaceChatDefaults(workspace.path, {
            model: resolveRequestModel(parsed.data),
            systemPrompt: parsed.data.systemPrompt,
            mcp: parsed.data.mcp,
          });
          reconcileConfig(db);
          const row = chatStore.getWorkspaceChatDefaults(workspaceId);
          sendJson(res, 200, {
            defaults: mapWorkspaceChatDefaults(workspaceId, row),
          });
          return;
        }

        sendJson(res, 404, { error: "not found" });
        return;
      }

      const workspaceChatsMatch = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/chats$/
      );
      if (workspaceChatsMatch) {
        const workspaceId = decodeURIComponent(workspaceChatsMatch[1]);
        if (method === "GET") {
          if (!assertRunnableWorkspace(store, workspaceId)) {
            sendJson(res, 404, { error: "workspace not found" });
            return;
          }
          const archivedParam = url.searchParams.get("archived");
          if (archivedParam === null || archivedParam === "") {
            sendJson(res, 200, { chats: chatEngine.listWorkspaceChats(workspaceId) });
            return;
          }
          if (archivedParam === "true") {
            sendJson(res, 200, {
              chats: chatEngine.listArchivedWorkspaceChats(workspaceId),
            });
            return;
          }
          if (archivedParam === "false") {
            sendJson(res, 200, { chats: chatEngine.listWorkspaceChats(workspaceId) });
            return;
          }
          sendJson(res, 400, {
            error: 'archived query must be "true" or "false"',
          });
          return;
        }
        if (method === "POST") {
          const body = await readJson<unknown>(req);
          const parsed = createChatSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
            return;
          }
          if (!assertRunnableWorkspace(store, workspaceId)) {
            sendJson(res, 404, { error: "workspace not found" });
            return;
          }
          const chat = chatEngine.createChat({
            workspaceId,
            title: parsed.data.title,
            model: resolveRequestModel(parsed.data),
          });
          sendJson(res, 201, { chat: mapChatSession(chat) });
          return;
        }
        sendJson(res, 404, { error: "not found" });
        return;
      }

      if (method === "POST" && url.pathname === "/api/workspaces/pick-folder") {
        const body = await readJson<{ base?: string }>(req);
        const base =
          typeof body.base === "string" && body.base.trim()
            ? body.base.trim()
            : undefined;
        const result = await pickWorkspaceFolder(base);
        sendJson(res, 200, result);
        return;
      }

      if (url.pathname === "/api/workspaces") {
        if (method === "GET") {
          sendJson(res, 200, { workspaces: store.listWorkspaces() });
          return;
        }

        if (method === "POST") {
          const body = await readJson<unknown>(req);
          const parsed = workspaceCreateSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
            return;
          }

          const resolvedPath = resolve(parsed.data.path);
          if (!existsSync(resolvedPath)) {
            sendJson(res, 400, {
              error: `Path does not exist on disk: ${resolvedPath}`,
            });
            return;
          }

          const alreadyRegistered = store
            .listWorkspaces()
            .some((w) => resolve(w.path) === resolvedPath);
          if (alreadyRegistered) {
            sendJson(res, 409, {
              error: `Workspace already registered: ${resolvedPath}`,
            });
            return;
          }

          appendWorkspaceToConfig(GLOBAL_CONFIG_PATH, resolvedPath);
          reconcileConfig(db);

          const workspace = store
            .listWorkspaces()
            .find((w) => resolve(w.path) === resolvedPath);
          if (!workspace) {
            sendJson(res, 500, {
              error: "Workspace registered but not found after reconcile",
            });
            return;
          }

          sendJson(res, 201, { workspace });
          return;
        }
      }

      if (method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson<unknown>(req);
        const parsed = triggerRunSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        const data = parsed.data;
        const hasContext =
          data.variables !== undefined ||
          data.roleModels !== undefined ||
          data.maxDepth !== undefined;
        const modelOverride = resolveRequestModel(data);
        try {
          const runId = await engine.triggerRun(data.automationId, "manual", {
            modelSelectionOverride: modelOverride,
            ...(hasContext
              ? {
                  chainContext: {
                    variables: data.variables ?? {},
                    roleModels: data.roleModels ?? {},
                  } satisfies ChainRunContext,
                  chainMaxDepth: data.maxDepth!,
                }
              : {}),
          });
          sendJson(res, 201, { runId });
        } catch (err) {
          if (err instanceof TriggerRunValidationError) {
            sendJson(res, 400, { error: err.message });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === "POST" && url.pathname === "/api/feature-queue") {
        const body = await readJson<unknown>(req);
        const parsed = enqueueFeatureSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        const data = parsed.data;
        if (!assertRunnableWorkspace(store, data.workspaceId)) {
          sendJson(res, 404, { error: "workspace not found" });
          return;
        }
        try {
          const row = featureQueue.enqueue({
            workspaceId: data.workspaceId,
            featureId: data.featureId,
            after: data.after,
            kickoff: data.kickoff,
          });
          sendJson(res, 201, { entry: toFeatureQueueEntry(row) });
          const runner = deps.featureQueueRunner;
          if (runner) {
            void runner.startNextIfIdle(data.workspaceId).catch((err) => {
              const text = err instanceof Error ? err.message : String(err);
              deps.onLog?.(
                `Feature queue idle start after enqueue failed: ${text}`
              );
            });
          }
        } catch (err) {
          if (err instanceof FeatureQueueError) {
            const status = err.code === "duplicate" ? 409 : 400;
            sendJson(res, status, { error: err.message });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === "GET" && url.pathname === "/api/feature-queue") {
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        const rows = featureQueue.listEntries(workspaceId);
        sendJson(res, 200, {
          entries: rows.map(toFeatureQueueEntry),
        });
        return;
      }

      const featureQueueMatch = url.pathname.match(/^\/api\/feature-queue\/([^/]+)$/);
      if (featureQueueMatch && method === "DELETE") {
        const entryId = decodeURIComponent(featureQueueMatch[1]!);
        const outcome = featureQueue.cancelEntry(entryId);
        if (outcome === "missing") {
          sendJson(res, 404, { error: "feature queue entry not found" });
          return;
        }
        if (outcome === "running") {
          sendJson(res, 409, { error: "cannot cancel a running feature queue entry" });
          return;
        }
        const entry = featureQueue.getEntry(entryId);
        sendJson(res, 200, { entry: toFeatureQueueEntry(entry!) });
        return;
      }

      if (method === "GET" && url.pathname === "/api/runs/export") {
        const format = (url.searchParams.get("format") ?? "json").toLowerCase();
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
        const limitParam = Number(url.searchParams.get("limit"));
        const limit =
          Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
        const rows = store.exportRuns({ workspaceId, limit });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        if (format === "csv") {
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="lca-runs-${stamp}.csv"`,
          });
          res.end(runsToCsv(rows));
          return;
        }
        if (format === "json") {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="lca-runs-${stamp}.json"`,
          });
          res.end(runsToJson(rows));
          return;
        }
        sendJson(res, 400, { error: "format must be 'json' or 'csv'" });
        return;
      }

      if (method === "POST" && url.pathname === "/api/runs/delete") {
        const body = await readJson<{ runIds?: string[] }>(req);
        if (!Array.isArray(body.runIds) || body.runIds.length === 0) {
          sendJson(res, 400, { error: "runIds required" });
          return;
        }
        const deleted = await engine.purgeRuns(body.runIds);
        const response: DeleteRunsResponse = {
          deleted: deleted.length,
          runIds: deleted,
        };
        sendJson(res, 200, response);
        return;
      }

      if (method === "GET" && url.pathname === "/api/runs") {
        const limitParam = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 200;
        sendJson(res, 200, { runs: store.listRuns(limit) });
        return;
      }

      const enableMatch = url.pathname.match(/^\/api\/automations\/([^/]+)\/enabled$/);
      if (enableMatch && method === "POST") {
        const automationId = decodeURIComponent(enableMatch[1]);
        const body = await readJson<{ enabled?: boolean }>(req);
        if (typeof body.enabled !== "boolean") {
          sendJson(res, 400, { error: "enabled (boolean) is required" });
          return;
        }
        const updated = store.setAutomationEnabled(automationId, body.enabled);
        if (!updated) {
          sendJson(res, 404, { error: "automation not found" });
          return;
        }
        // Re-arm/disarm triggers so the change takes effect immediately.
        triggers?.refresh();
        sendJson(res, 200, { automation: updated });
        return;
      }

      const automationMatch = url.pathname.match(/^\/api\/automations\/([^/]+)$/);
      if (automationMatch) {
        const automationId = decodeURIComponent(automationMatch[1]);

        if (method === "PATCH") {
          const body = await readJson<unknown>(req);
          const parsed = automationUpdateSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
            return;
          }
          const result = store.updateAutomation(automationId, parsed.data);
          if (result === "not_found") {
            sendJson(res, 404, { error: "automation not found" });
            return;
          }
          if (result === "forbidden") {
            sendJson(res, 403, {
              error: "only dashboard-origin automations can be edited",
            });
            return;
          }
          triggers?.refresh();
          events.emitAutomationEvent("updated", automationId, result);
          sendJson(res, 200, { automation: result });
          return;
        }

        if (method === "DELETE") {
          const result = store.deleteAutomation(automationId);
          if (result === "not_found") {
            sendJson(res, 404, { error: "automation not found" });
            return;
          }
          if (result === "forbidden") {
            sendJson(res, 403, {
              error: "only dashboard-origin automations can be edited",
            });
            return;
          }
          triggers?.refresh();
          events.emitAutomationEvent("deleted", automationId);
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      if (method === "POST" && url.pathname === "/api/triggers/git") {
        if (!triggers) {
          sendJson(res, 503, { error: "trigger manager not ready" });
          return;
        }
        const body = await readJson<Partial<GitTriggerPayload>>(req);
        if (!body.workspace || !body.event || !body.sha) {
          sendJson(res, 400, {
            error: "workspace, event, and sha are required",
          });
          return;
        }
        const validEvents = ["post-commit", "pre-push", "post-merge"];
        if (!validEvents.includes(body.event)) {
          sendJson(res, 400, { error: `event must be one of: ${validEvents.join(", ")}` });
          return;
        }
        const runIds = await triggers.handleGitEvent({
          workspace: body.workspace,
          event: body.event,
          sha: body.sha,
        });
        sendJson(res, 200, { runIds });
        return;
      }

      const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
      if (chatMatch) {
        const chatId = decodeURIComponent(chatMatch[1]);

        if (method === "GET") {
          const snapshot = chatEngine.getChatSnapshot(chatId);
          if (!snapshot) {
            sendJson(res, 404, { error: "chat not found" });
            return;
          }
          sendJson(res, 200, snapshot);
          return;
        }

        if (method === "PATCH") {
          const body = await readJson<unknown>(req);
          const parsed = updateChatSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
            return;
          }
          try {
            const chat = await chatEngine.patchChat(chatId, {
              title: parsed.data.title,
              archived: parsed.data.archived,
              model: resolveRequestModel(parsed.data),
              attachedRunId: parsed.data.attachedRunId,
            });
            if (!chat) {
              sendJson(res, 404, { error: "chat not found" });
              return;
            }
            sendJson(res, 200, { chat });
          } catch (err) {
            const errMessage = err instanceof Error ? err.message : String(err);
            sendJson(res, chatMessageErrorStatus(err), { error: errMessage });
          }
          return;
        }

        if (method === "DELETE") {
          const deleted = await chatEngine.purgeChat(chatId);
          if (!deleted) {
            sendJson(res, 404, { error: "chat not found" });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      const chatAttachmentMatch = url.pathname.match(
        /^\/api\/chats\/([^/]+)\/attachments(?:\/([^/]+))?$/
      );
      if (chatAttachmentMatch) {
        const chatId = decodeURIComponent(chatAttachmentMatch[1]);
        const attachmentId = chatAttachmentMatch[2]
          ? decodeURIComponent(chatAttachmentMatch[2])
          : undefined;
        if (!chatEngine.getChatSnapshot(chatId)) {
          sendJson(res, 404, { error: "chat not found" });
          return;
        }
        if (method === "POST" && !attachmentId) {
          const body = await readJson<Partial<UploadAttachmentRequest>>(req);
          if (
            typeof body.filename !== "string" ||
            typeof body.mimeType !== "string" ||
            typeof body.contentBase64 !== "string"
          ) {
            sendJson(res, 400, {
              error: "filename, mimeType, and contentBase64 are required",
            });
            return;
          }
          try {
            const bytes = decodeBase64Content(body.contentBase64, settings.maxAttachmentBytes);
            const blob = writeAttachmentBlob({
              ownerKind: "chat",
              ownerId: chatId,
              filename: body.filename,
              mimeType: body.mimeType,
              bytes,
              settings,
            });
            const attachment = attachmentStore.insertUploaded({
              ...blob,
              ownerKind: "chat",
              ownerId: chatId,
            });
            const response: UploadAttachmentResponse = {
              ok: true,
              attachment: mapAttachmentRow(attachment),
            };
            sendJson(res, 201, response);
          } catch (err) {
            if (err instanceof AttachmentValidationError) {
              sendJson(res, attachmentErrorStatus(err), { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
        if (method === "GET" && attachmentId) {
          const attachment = attachmentStore.getById("chat", chatId, attachmentId);
          if (!attachment) {
            sendJson(res, 404, { error: "attachment not found" });
            return;
          }
          try {
            sendAttachment(res, attachment);
          } catch (err) {
            if (err instanceof AttachmentValidationError) {
              sendJson(res, 404, { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const chatMessageMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/message$/);
      if (chatMessageMatch && method === "POST") {
        const chatId = decodeURIComponent(chatMessageMatch[1]);
        const body = await readJson<Partial<SendChatMessageRequest>>(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        let attachments: AttachmentRef[];
        try {
          attachments = parseAttachmentRefs(
            body.attachments,
            settings,
            attachmentStore,
            "chat",
            chatId
          );
        } catch (err) {
          if (err instanceof AttachmentValidationError) {
            sendJson(res, attachmentErrorStatus(err), { error: err.message });
            return;
          }
          throw err;
        }
        if (!message && attachments.length === 0) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        try {
          await (chatEngine.sendMessage as (
            id: string,
            text: string,
            refs?: AttachmentRef[]
          ) => Promise<void>)(chatId, message, attachments);
          const response: SendChatMessageResponse = { ok: true };
          sendJson(res, 202, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, chatMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const chatQueueMessageMatch = url.pathname.match(
        /^\/api\/chats\/([^/]+)\/queue-message$/
      );
      if (chatQueueMessageMatch && method === "POST") {
        const chatId = decodeURIComponent(chatQueueMessageMatch[1]);
        const body = await readJson<Partial<QueueChatMessageRequest>>(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        let attachments: AttachmentRef[];
        try {
          attachments = parseAttachmentRefs(
            body.attachments,
            settings,
            attachmentStore,
            "chat",
            chatId
          );
        } catch (err) {
          if (err instanceof AttachmentValidationError) {
            sendJson(res, attachmentErrorStatus(err), { error: err.message });
            return;
          }
          throw err;
        }
        if (!message && attachments.length === 0) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        try {
          const queuedMessageId = await (chatEngine.queueMessage as (
            id: string,
            text: string,
            refs?: AttachmentRef[]
          ) => Promise<string>)(chatId, message, attachments);
          const response: QueueChatMessageResponse = {
            ok: true,
            ...(queuedMessageId ? { queuedMessageId } : {}),
          };
          sendJson(res, 202, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, chatMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const chatSteerMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/steer$/);
      if (chatSteerMatch && method === "POST") {
        const chatId = decodeURIComponent(chatSteerMatch[1]);
        const body = await readJson<Partial<SteerChatRequest>>(req);
        const parsed = steerChatSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }

        const snapshot = chatEngine.getChatSnapshot(chatId);
        if (!snapshot) {
          sendJson(res, 404, { error: "chat not found" });
          return;
        }

        const candidates = engine.listSteerCandidateRunsForWorkspace(
          snapshot.session.workspaceId
        );
        const resolution = resolveSteerTargetRunId({
          pinnedRunId: parsed.data.runId,
          attachedRunId: snapshot.session.attachedRunId,
          candidates,
        });

        if (resolution.kind === "none") {
          sendJson(res, 409, { error: resolution.reason });
          return;
        }
        if (resolution.kind === "ambiguous") {
          sendJson(res, 409, {
            error: `${resolution.reason} (${resolution.runIds.join(", ")})`,
          });
          return;
        }

        try {
          const queuedMessageId = await engine.queueMessage(
            resolution.runId,
            parsed.data.message
          );
          chatEngine.recordSteerQueued(chatId, {
            runId: resolution.runId,
            queuedMessageId,
            text: parsed.data.message,
          });
          const response: SteerChatResponse = {
            ok: true,
            runId: resolution.runId,
            ...(queuedMessageId ? { queuedMessageId } : {}),
          };
          sendJson(res, 202, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, runMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const chatInterruptMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/interrupt$/);
      if (chatInterruptMatch && method === "POST") {
        const chatId = decodeURIComponent(chatInterruptMatch[1]);
        const body = await readJson<Partial<InterruptChatRequest>>(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        let attachments: AttachmentRef[];
        try {
          attachments = parseAttachmentRefs(
            body.attachments,
            settings,
            attachmentStore,
            "chat",
            chatId
          );
        } catch (err) {
          if (err instanceof AttachmentValidationError) {
            sendJson(res, attachmentErrorStatus(err), { error: err.message });
            return;
          }
          throw err;
        }
        if (!message && attachments.length === 0) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        try {
          await (chatEngine.interruptChat as (
            id: string,
            text: string,
            refs?: AttachmentRef[]
          ) => Promise<void>)(chatId, message, attachments);
          const response: InterruptChatResponse = { ok: true };
          sendJson(res, 202, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, chatMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const chatCancelMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/cancel$/);
      if (chatCancelMatch && method === "POST") {
        const chatId = decodeURIComponent(chatCancelMatch[1]);
        try {
          await chatEngine.cancelChat(chatId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, chatMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const chatAnswerMatch = url.pathname.match(/^\/api\/chats\/([^/]+)\/answer$/);
      if (chatAnswerMatch && method === "POST") {
        const chatId = decodeURIComponent(chatAnswerMatch[1]);
        const body = await readJson<{ answer?: string }>(req);
        if (!body.answer?.trim()) {
          sendJson(res, 400, { error: "answer is required" });
          return;
        }
        try {
          chatEngine.answerChat(chatId, body.answer.trim());
          sendJson(res, 200, { ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = /run token/i.test(message) ? 403 : 400;
          sendJson(res, status, { error: message });
        }
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch) {
        const runId = decodeURIComponent(runMatch[1]);

        if (method === "GET") {
          const snapshot = engine.getRun(runId);
          if (!snapshot) {
            sendJson(res, 404, { error: "run not found" });
            return;
          }
          const detail = store.getRunDetail(runId);
          sendJson(res, 200, {
            ...snapshot,
            pipelineWave: detail?.run.pipelineWave ?? null,
            pipelineTrack: detail?.run.pipelineTrack ?? null,
            pipelineWaveDetail: detail?.pipelineWaveDetail ?? null,
            pipelineTrackDetail: detail?.pipelineTrackDetail ?? null,
          });
          return;
        }

        if (method === "PATCH") {
          const body = await readJson<unknown>(req);
          const parsed = updateRunSchema.safeParse(body);
          if (!parsed.success) {
            sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
            return;
          }
          const ok = engine.setRunModel(
            runId,
            resolveRequestModel(parsed.data) ?? null
          );
          if (!ok) {
            sendJson(res, 404, { error: "run not found" });
            return;
          }
          const run = store.getRun(runId);
          if (!run) {
            sendJson(res, 404, { error: "run not found" });
            return;
          }
          sendJson(res, 200, { run });
          return;
        }
      }

      const runAttachmentMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/attachments(?:\/([^/]+))?$/
      );
      if (runAttachmentMatch) {
        const runId = decodeURIComponent(runAttachmentMatch[1]);
        const attachmentId = runAttachmentMatch[2]
          ? decodeURIComponent(runAttachmentMatch[2])
          : undefined;
        if (!engine.getRun(runId)) {
          sendJson(res, 404, { error: "run not found" });
          return;
        }
        if (method === "POST" && !attachmentId) {
          const body = await readJson<Partial<UploadAttachmentRequest>>(req);
          if (
            typeof body.filename !== "string" ||
            typeof body.mimeType !== "string" ||
            typeof body.contentBase64 !== "string"
          ) {
            sendJson(res, 400, {
              error: "filename, mimeType, and contentBase64 are required",
            });
            return;
          }
          try {
            const bytes = decodeBase64Content(body.contentBase64, settings.maxAttachmentBytes);
            const blob = writeAttachmentBlob({
              ownerKind: "run",
              ownerId: runId,
              filename: body.filename,
              mimeType: body.mimeType,
              bytes,
              settings,
            });
            const attachment = attachmentStore.insertUploaded({
              ...blob,
              ownerKind: "run",
              ownerId: runId,
            });
            const response: UploadAttachmentResponse = {
              ok: true,
              attachment: mapAttachmentRow(attachment),
            };
            sendJson(res, 201, response);
          } catch (err) {
            if (err instanceof AttachmentValidationError) {
              sendJson(res, attachmentErrorStatus(err), { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
        if (method === "GET" && attachmentId) {
          const attachment = attachmentStore.getById("run", runId, attachmentId);
          if (!attachment) {
            sendJson(res, 404, { error: "attachment not found" });
            return;
          }
          try {
            sendAttachment(res, attachment);
          } catch (err) {
            if (err instanceof AttachmentValidationError) {
              sendJson(res, 404, { error: err.message });
              return;
            }
            throw err;
          }
          return;
        }
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const askMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/ask$/);
      if (askMatch && method === "POST") {
        const runId = decodeURIComponent(askMatch[1]);
        const body = await readJson<unknown>(req);
        const parsed = askRunInputSchema.safeParse(body);
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((i) => i.message)
            .join("; ");
          sendJson(res, 400, { error: message || "invalid ask body" });
          return;
        }
        const { question, metadata } = parsed.data;
        const header = req.headers["x-lca-run-token"];
        const token = Array.isArray(header) ? header[0] : header;
        const snapshot = chatEngine.getChatSnapshot(runId);
        if (snapshot) {
          try {
            const answer = await chatEngine.askAndWait(
              runId,
              question,
              token,
              metadata
            );
            sendJson(res, 200, { answer });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const status = /run token/i.test(message) ? 403 : 400;
            sendJson(res, status, { error: message });
          }
          return;
        }
        try {
          const answer = await engine.askAndWait(
            runId,
            question,
            token,
            metadata
          );
          sendJson(res, 200, { answer });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A token mismatch is the one case we treat as forbidden; everything
          // else (bad status, missing run) stays a generic error.
          const status = /run token/i.test(message) ? 403 : 400;
          sendJson(res, status, { error: message });
        }
        return;
      }

      const chainControlMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/chain-control$/
      );
      if (chainControlMatch && method === "POST") {
        const runId = decodeURIComponent(chainControlMatch[1]);
        const body = await readJson<unknown>(req);
        const parsed = chainControlSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        const header = req.headers["x-lca-run-token"];
        const token = Array.isArray(header) ? header[0] : header;
        const result = engine.applyChainControl(runId, parsed.data, token);
        if (!result.ok) {
          if (result.reason === "forbidden") {
            sendJson(res, 403, {
              error: `Run ${runId}: invalid or missing run token`,
            });
            return;
          }
          if (result.reason === "not-found") {
            sendJson(res, 404, { error: `Run not found: ${runId}` });
            return;
          }
          if (result.reason === "terminal") {
            sendJson(res, 409, {
              error: `Run ${runId} is already terminal; chain control refused`,
            });
            return;
          }
          if (result.reason === "no-budget-context") {
            sendJson(res, 409, {
              error: `Run ${runId} lacks context-aware budget metadata for extendBudget`,
            });
            return;
          }
          if (result.reason === "extend-conflict") {
            sendJson(res, 409, {
              error: `Run ${runId} already has a different budget override; extendBudget refused`,
            });
            return;
          }
          sendJson(res, 409, {
            error: `Run ${runId} already has a different maxDepth override`,
          });
          return;
        }
        sendJson(res, 200, result.response);
        return;
      }

      const pipelineWaveMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/pipeline-wave$/
      );
      if (pipelineWaveMatch && method === "POST") {
        const runId = decodeURIComponent(pipelineWaveMatch[1]);
        const body = await readJson<unknown>(req);
        const parsed = pipelineWaveControlSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        const header = req.headers["x-lca-run-token"];
        const token = Array.isArray(header) ? header[0] : header;
        try {
          engine.verifyRunToken(runId, token);
        } catch {
          sendJson(res, 403, {
            error: `Run ${runId}: invalid or missing run token`,
          });
          return;
        }
        if (!waveCoordinator) {
          sendJson(res, 503, { error: "pipeline wave coordinator unavailable" });
          return;
        }
        if (!store.getRun(runId)) {
          sendJson(res, 404, { error: `Run not found: ${runId}`, code: "not-found" });
          return;
        }

        const request = parsed.data;
        if (request.action === "fan-out") {
          const response = await waveCoordinator.fanOut(
            runId,
            request.candidates
          );
          sendJson(res, 200, response);
          return;
        }
        if (request.action === "finalize") {
          const result = await waveCoordinator.finalize(runId);
          if (!result.ok) {
            if (result.reason === "not-found") {
              sendJson(res, 404, {
                error: `Run or wave not found: ${runId}`,
                code: result.reason,
              });
              return;
            }
            sendJson(res, 409, {
              error: result.reason,
              code: result.reason,
            });
            return;
          }
          sendJson(res, 200, result.response);
          return;
        }

        const result = await waveCoordinator.block(runId, request.reason);
        if (!result.ok) {
          if (result.reason === "not-found") {
            sendJson(res, 404, {
              error: `Run or wave not found: ${runId}`,
              code: result.reason,
            });
            return;
          }
          sendJson(res, 409, {
            error: result.reason,
            code: result.reason,
          });
          return;
        }
        sendJson(res, 200, result.response);
        return;
      }

      const waveActionMatch = url.pathname.match(
        /^\/api\/pipeline-waves\/([^/]+)\/actions$/
      );
      if (waveActionMatch && method === "POST") {
        const waveId = decodeURIComponent(waveActionMatch[1]);
        const body = await readJson<unknown>(req);
        const parsed = pipelineWaveOperatorSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        if (!waveCoordinator) {
          sendJson(res, 503, { error: "pipeline wave coordinator unavailable" });
          return;
        }
        const result = await waveCoordinator.operatorAction(waveId, parsed.data);
        if (!result.ok) {
          if (result.reason === "not-found") {
            sendJson(res, 404, {
              error: `Wave not found: ${waveId}`,
              code: result.reason,
            });
            return;
          }
          sendJson(res, 409, {
            error: result.reason,
            code: result.reason,
          });
          return;
        }
        sendJson(res, 200, result.response);
        return;
      }

      const escalateMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/escalate$/
      );
      if (escalateMatch && method === "POST") {
        const runId = decodeURIComponent(escalateMatch[1]);
        const body = await readJson<unknown>(req);
        const parsed = runEscalationSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: formatIssues(parsed.error.issues) });
          return;
        }
        try {
          const result = await engine.escalateRun(runId, parsed.data);
          if (!result.ok) {
            if (result.reason === "not-found") {
              sendJson(res, 404, {
                error: result.message,
                code: result.reason,
              });
              return;
            }
            sendJson(res, 409, {
              error: result.message,
              code: result.reason,
            });
            return;
          }
          sendJson(res, 200, result.response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: message });
        }
        return;
      }

      const answerMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/answer$/);
      if (answerMatch && method === "POST") {
        const runId = decodeURIComponent(answerMatch[1]);
        const body = await readJson<unknown>(req);
        const parsed = answerRunInputSchema.safeParse(body);
        if (!parsed.success) {
          const message =
            parsed.error.issues[0]?.message ?? "Invalid answer body";
          sendJson(res, 400, { error: message });
          return;
        }
        try {
          await engine.submitAnswer(runId, parsed.data.answer);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: message });
        }
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/message$/);
      if (messageMatch && method === "POST") {
        const runId = decodeURIComponent(messageMatch[1]);
        const body = await readJson<Partial<SendRunMessageRequest>>(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        let attachments: AttachmentRef[];
        try {
          attachments = parseAttachmentRefs(
            body.attachments,
            settings,
            attachmentStore,
            "run",
            runId
          );
        } catch (err) {
          if (err instanceof AttachmentValidationError) {
            sendJson(res, attachmentErrorStatus(err), { error: err.message });
            return;
          }
          throw err;
        }
        if (!message && attachments.length === 0) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        try {
          await engine.sendMessage(runId, message, attachments);
          const response: SendRunMessageResponse = { ok: true };
          sendJson(res, 202, response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, runMessageErrorStatus(err), { error: message });
        }
        return;
      }

      const queueMessageMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/queue-message$/
      );
      if (queueMessageMatch && method === "POST") {
        const runId = decodeURIComponent(queueMessageMatch[1]);
        const body = await readJson<Partial<QueueRunMessageRequest>>(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        let attachments: AttachmentRef[];
        try {
          attachments = parseAttachmentRefs(
            body.attachments,
            settings,
            attachmentStore,
            "run",
            runId
          );
        } catch (err) {
          if (err instanceof AttachmentValidationError) {
            sendJson(res, attachmentErrorStatus(err), { error: err.message });
            return;
          }
          throw err;
        }
        if (!message && attachments.length === 0) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        try {
          const queuedMessageId = await engine.queueMessage(runId, message, attachments);
          const response: QueueRunMessageResponse = {
            ok: true,
            ...(queuedMessageId ? { queuedMessageId } : {}),
          };
          sendJson(res, 202, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, runMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const interruptMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/interrupt$/);
      if (interruptMatch && method === "POST") {
        const runId = decodeURIComponent(interruptMatch[1]);
        const body = await readJson<Partial<InterruptRunRequest>>(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        let attachments: AttachmentRef[];
        try {
          attachments = parseAttachmentRefs(
            body.attachments,
            settings,
            attachmentStore,
            "run",
            runId
          );
        } catch (err) {
          if (err instanceof AttachmentValidationError) {
            sendJson(res, attachmentErrorStatus(err), { error: err.message });
            return;
          }
          throw err;
        }
        if (!message && attachments.length === 0) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        try {
          await engine.interruptRun(runId, message, attachments);
          const response: InterruptRunResponse = { ok: true };
          sendJson(res, 202, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, runMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        const runId = decodeURIComponent(cancelMatch[1]);
        await engine.cancelRun(runId);
        sendJson(res, 200, { ok: true });
        return;
      }

      const pauseMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/pause$/);
      if (pauseMatch && method === "POST") {
        const runId = decodeURIComponent(pauseMatch[1]);
        try {
          await engine.pauseRun(runId);
          const response: PauseRunResponse = { ok: true };
          sendJson(res, 200, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, runMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const resumeMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/resume$/);
      if (resumeMatch && method === "POST") {
        const runId = decodeURIComponent(resumeMatch[1]);
        const body = await readJson<Partial<ResumeRunRequest>>(req);
        const note =
          typeof body.note === "string" && body.note.trim()
            ? body.note.trim()
            : undefined;
        try {
          await engine.resumeRun(runId, note);
          const response: ResumeRunResponse = { ok: true };
          sendJson(res, 202, response);
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, runMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      const promoteMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)\/promote-to-chat$/
      );
      if (promoteMatch && method === "POST") {
        const runId = decodeURIComponent(promoteMatch[1]);
        try {
          const advisoryPromo =
            typeof engine.promoteHaltDiscoveryToChatIfApplicable === "function"
              ? await engine.promoteHaltDiscoveryToChatIfApplicable(
                  runId,
                  chatEngine
                )
              : null;
          if (advisoryPromo) {
            sendJson(res, advisoryPromo.kind === "created" ? 201 : 200, {
              chat: mapChatSession(advisoryPromo.chat),
            });
            return;
          }

          const source = engine.prepareForPromotion(runId);
          const chat = chatEngine.promoteFromRun({
            runId,
            workspaceId: source.run.workspace_id,
            agentId: source.run.agent_id,
            sdkRunId: source.run.sdk_run_id,
            model: source.model,
            events: source.events,
          });
          await engine.releaseRetainedRun(runId);
          sendJson(res, 201, { chat: mapChatSession(chat) });
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          sendJson(res, runMessageErrorStatus(err), { error: errMessage });
        }
        return;
      }

      if (method === "POST" && url.pathname === "/api/shutdown") {
        if (!onShutdown) {
          sendJson(res, 501, { error: "shutdown not supported" });
          return;
        }
        sendJson(res, 202, { ok: true, message: "shutting down" });
        // Let the 202 flush before teardown closes the server / exits.
        setTimeout(() => void onShutdown("api"), 50);
        return;
      }

      if (method === "POST" && url.pathname === "/api/restart") {
        if (!onRestart || !restartSupported) {
          sendJson(res, 501, {
            error: DEV_VITE_TARGET
              ? "restart not supported in dev (hot reload handles it)"
              : "restart not supported",
          });
          return;
        }
        sendJson(res, 202, { ok: true, message: "restarting" });
        // Let the 202 flush before teardown closes the server and re-spawns.
        setTimeout(() => void onRestart("api"), 50);
        return;
      }

      // API misses fall through to 404; everything else is the frontend.
      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      // Dev mode: hand the frontend (and HMR) to Vite over the daemon's port.
      if (DEV_VITE_TARGET) {
        proxyHttpToVite(req, res);
        return;
      }

      if (method === "GET" && serveStatic(url.pathname, res)) {
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  };

  // Live event fan-out: each dashboard tab opens a WS to /ws and receives the
  // same WsServerMessage stream the daemon publishes on the event bus.
  // Protocol-level ping culls half-open mobile sockets so clients reconnect
  // (browsers auto-pong; no app-level ping frame required).
  const WS_HEARTBEAT_MS = 25_000;
  type HeartbeatSocket = import("ws").WebSocket & { isAlive?: boolean };
  const wss = new WebSocketServer({ noServer: true });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as HeartbeatSocket;
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, WS_HEARTBEAT_MS);
  // Don't keep the process alive solely for the heartbeat timer.
  heartbeat.unref?.();

  wss.on("connection", (socket) => {
    const hbSocket = socket as HeartbeatSocket;
    hbSocket.isAlive = true;
    hbSocket.on("pong", () => {
      hbSocket.isAlive = true;
    });
    const unsubscribe = events.subscribe((message) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  const upgradeListener = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    if (!isAllowedSource(req.socket.remoteAddress, allowedIps)) {
      socket.destroy();
      return;
    }
    const origin = headerValue(req.headers.origin);
    if (origin && !allowedOrigins.has(origin)) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/ws") {
      // Vite's HMR websocket (any non-/ws upgrade) is proxied in dev mode. It is
      // authorized by Vite's own `?token=` + the origin/IP gates above, so the
      // control token does not apply here.
      if (DEV_VITE_TARGET) {
        proxyUpgradeToVite(req, socket, head);
        return;
      }
      socket.destroy();
      return;
    }
    // `/ws` carries the same sensitive run output as REST reads, so it needs the
    // control token for non-loopback clients. Browsers can't set custom WS
    // headers, so the token rides as `?token=`; never log this query string.
    const wsTokenResult = checkControlToken({
      isLoopbackSource: isLoopback(normalizeIp(req.socket.remoteAddress)),
      controlToken,
      presented: url.searchParams.get("token") ?? undefined,
    });
    if (wsTokenResult !== "ok") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  // One listener per resolved bind address (loopback + any specific host),
  // all sharing the same request/upgrade handlers and the single `wss` above.
  // The blocking `POST /api/runs/:id/ask` request stays open until a human
  // answers, which can be many minutes; Node's default request/headers timeouts
  // would abort it, so they are disabled (this server is single-operator).
  const servers = bindHosts.map((bindHost) => {
    const srv = createServer(requestListener);
    srv.requestTimeout = 0;
    srv.headersTimeout = 0;
    srv.on("upgrade", upgradeListener);
    return { host: bindHost, server: srv };
  });

  // Only listeners that actually bound; a degraded specific-host listener is
  // dropped so `close()` never trips on a server that isn't running.
  const boundServers: { host: string; server: ReturnType<typeof createServer> }[] = [];

  const close = (): Promise<void> =>
    new Promise((res, rej) => {
      // A phone leaves a persistent `/ws` connection (plus keep-alive HTTP
      // sockets) open across a restart. `server.close()` only stops accepting
      // new connections — its callback waits for every existing connection to
      // drain, which a live dashboard socket never does. That stalls teardown
      // so the daemon never reaches the relaunch and goes down with no
      // replacement (the "restart failed from my phone" symptom). Terminate WS
      // clients and force-destroy remaining sockets so close() resolves and the
      // port is released deterministically for the relaunched daemon.
      for (const client of wss.clients) {
        client.terminate();
      }
      clearInterval(heartbeat);
      wss.close();
      if (boundServers.length === 0) {
        res();
        return;
      }
      let pending = boundServers.length;
      let failed: Error | null = null;
      for (const { server } of boundServers) {
        server.close((err) => {
          if (err && !failed) {
            failed = err;
          }
          pending -= 1;
          if (pending === 0) {
            if (failed) rej(failed);
            else res();
          }
        });
        // Node 18.2+: drop in-flight connections (the persistent `/ws` sockets,
        // keep-alive HTTP, and the restart POST itself) that would otherwise
        // keep the close() callback pending indefinitely.
        server.closeAllConnections?.();
      }
    });

  return new Promise((resolve, reject) => {
    let settled = false;
    // Each listener settles its own outcome exactly once (bound or degraded or
    // fatal). When every listener has reported, resolve with the addresses that
    // actually bound — the loopback companion can never degrade, so a non-fatal
    // outcome always leaves local tooling reachable.
    let pending = servers.length;
    const finishOne = (): void => {
      pending -= 1;
      if (pending === 0 && !settled) {
        settled = true;
        resolve({
          port,
          host,
          bindAddresses: boundServers.map((s) => s.host),
          close,
        });
      }
    };
    // A relaunched daemon (e.g. a phone-triggered restart) can momentarily race
    // the outgoing daemon's socket release; retry EADDRINUSE a bounded number of
    // times before going fatal so the handoff survives that window. ~5s total
    // comfortably covers a graceful teardown that force-closes its connections.
    const BIND_RETRY_DELAY_MS = 250;
    const MAX_BIND_ATTEMPTS = 20;

    const attemptListen = (
      bindHost: string,
      server: ReturnType<typeof createServer>,
      attempt: number
    ): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (settled) return;
        if (isDegradableBindError(err, bindHost)) {
          log(
            `Bind ${bindHost}:${port} failed (${err.code}) — serving loopback only. ` +
              `Restore with: lca remote off && lca up (or once the interface is up)`
          );
          finishOne();
          return;
        }
        if (err.code === "EADDRINUSE" && attempt < MAX_BIND_ATTEMPTS) {
          log(
            `Bind ${bindHost}:${port} in use (attempt ${attempt}/${MAX_BIND_ATTEMPTS}) — ` +
              `retrying in ${BIND_RETRY_DELAY_MS}ms (previous daemon still releasing the port)`
          );
          const timer = setTimeout(
            () => attemptListen(bindHost, server, attempt + 1),
            BIND_RETRY_DELAY_MS
          );
          timer.unref?.();
          return;
        }
        settled = true;
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${port} on ${bindHost} is already in use (another lca-daemon is ` +
                `probably running). Stop that process, or start with LCA_PORT=3748 npm run daemon`
            )
          );
          return;
        }
        reject(err);
      };
      server.once("error", onError);
      server.listen(port, bindHost, () => {
        // Drop the bind-time error handler so a later runtime error can't be
        // mistaken for a failed (and retryable) bind.
        server.removeListener("error", onError);
        boundServers.push({ host: bindHost, server });
        finishOne();
      });
    };

    for (const { host: bindHost, server } of servers) {
      attemptListen(bindHost, server, 1);
    }
  });
}
