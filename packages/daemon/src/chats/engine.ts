import { randomUUID } from "node:crypto";
import { CursorAgentError } from "@cursor/sdk";
import type { McpServerConfig, SDKMessage } from "@cursor/sdk";
import {
  type AttachmentRef,
  type ChatPromotedFromRunPayload,
  type ChatSession,
  type ChatSnapshot,
  type ChatStatus,
  type InputRequest,
  type InputRequestMetadata,
  type McpOverlay,
  type ModelSelection,
  type RunStatus,
} from "@lca/shared";
import type { LcaDatabase } from "../db/index.js";
import {
  type ResumeRetryPolicy,
  isAuthResumeError,
  resolveResumeRetryPolicy,
  resumeWithRetry,
} from "../executor/resume-retry.js";
import type {
  ActiveRun,
  Executor,
  OperatorAttachment,
  OperatorMessage,
} from "../executor/types.js";
import { mapSdkResultStatus } from "../executor/types.js";
import { AttachmentStore } from "../attachments/store.js";
import {
  buildOperatorMessage,
  operatorMessageFromQueued,
  resolveOperatorAttachments,
  serializeAttachmentRefs,
} from "../attachments/resolve.js";
import { removeAttachmentOwnerDir } from "../attachments/storage.js";
import { extractRunIdFromMessage } from "../executor/sdk-local.js";
import type { DaemonEventSink } from "../events.js";
import { buildRevivePrimer } from "../handoff/continuePrompt.js";
import { synthesizeTranscript } from "../handoff/transcript.js";
import { resolveModelSelection } from "../models/resolve.js";
import { selectionFromStored } from "../models/selection-persist.js";
import {
  deriveHeuristicTitle,
  refineTitleWithLlm,
  shouldRefineWithLlm,
} from "./auto-title.js";
import {
  ChatStore,
  mapChatEvent,
  mapChatSession,
  type ChatSessionRow,
} from "./store.js";
import { assertChatTransition } from "./state-machine.js";

export type ChatDefaults = {
  model: ModelSelection | null;
  systemPrompt: string | null;
  mcpExtra?: Record<string, McpServerConfig>;
  mcpDisable?: string[];
};
export type ChatDefaultsResolver = (workspaceId: string) => ChatDefaults;

const RESERVED_MCP_SERVER = "automations-io";

function parseMcpOverlayJson(
  json: string
): Pick<ChatDefaults, "mcpExtra" | "mcpDisable"> {
  try {
    const overlay = JSON.parse(json) as McpOverlay;
    const extra = overlay.extra;
    const disable = overlay.disable?.filter((name) => name !== RESERVED_MCP_SERVER);
    return {
      mcpExtra: extra
        ? (extra as Record<string, McpServerConfig>)
        : undefined,
      mcpDisable: disable?.length ? disable : undefined,
    };
  } catch {
    return {};
  }
}

export function createChatDefaultsResolver(
  store: ChatStore
): ChatDefaultsResolver {
  return (workspaceId) => {
    const row = store.getWorkspaceChatDefaults(workspaceId);
    if (!row) {
      return { model: null, systemPrompt: null };
    }
    const { mcpExtra, mcpDisable } = parseMcpOverlayJson(row.mcp_overlay_json);
    return {
      model: selectionFromStored(row.model, row.model_params_json),
      systemPrompt: row.system_prompt,
      mcpExtra,
      mcpDisable,
    };
  };
}

export type ChatEngineOptions = {
  apiKey: string;
  executor: Executor;
  events?: DaemonEventSink;
  onLog?: (message: string) => void;
  /** Shared ChatStore; when omitted the engine creates its own. */
  store?: ChatStore;
  /** Workspace-default resolver (chat.yaml → SQLite). Default: nulls. */
  resolveDefaults?: ChatDefaultsResolver;
  /** needs_input sink (log/toast). Receives an InputRequest whose runId carries the chatId. */
  onChatNeedsInput?: (chatId: string, request: InputRequest) => void;
  /** Dead-login alert sink (toast + log); never throws. */
  onAuthExpired?: (kind: "run" | "chat", id: string, message: string) => void;
  /** Events retained per chat after a turn. Default 2000. */
  eventRetentionPerChat?: number;
  /** Hard cap on a single event payload in bytes. Forwarded to ChatStore. Default 64KB. */
  maxEventPayloadBytes?: number;
  /** Revive expired interactive sessions from their stored transcript. Default true. */
  sessionRevive?: boolean;
  /** Internal test seam for cold-resume retry policy. */
  resumeRetryPolicy?: Partial<ResumeRetryPolicy>;
  /** Run lookup for attach validation (workspace + status). */
  lookupRun?: (
    runId: string
  ) => { workspaceId: string; status: RunStatus } | undefined;
};

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export type ChatMessageErrorCode =
  | "not_found"
  | "busy"
  | "needs_input"
  | "context_missing"
  | "empty_message"
  | "archived";

export class ChatMessageError extends Error {
  constructor(
    readonly code: ChatMessageErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ChatMessageError";
  }
}

type ChatContext = {
  cwd: string;
  /** Legacy base id; always equals `modelSelection.id`. */
  model: string;
  modelSelection: ModelSelection;
  systemPrompt: string | null;
  mcpExtra?: Record<string, McpServerConfig>;
  mcpDisable?: string[];
};

const DEFAULT_EVENT_RETENTION = 2000;

export class ChatEngine {
  private readonly store: ChatStore;
  private readonly attachments: AttachmentStore;
  private readonly activeChats = new Map<string, ActiveRun>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly sessionTokens = new Map<string, string>();
  private readonly pendingInterrupts = new Map<string, OperatorMessage>();
  private readonly answerWaiters = new Map<string, (answer: string) => void>();
  /**
   * Pending ask_user state per chat (in-memory; chats can't use input_requests).
   * Retains metadata so structured answers can be validated.
   */
  private readonly pendingQuestions = new Map<
    string,
    { question: string; metadata?: InputRequestMetadata | null }
  >();
  private readonly tasks = new Set<Promise<void>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly eventRetentionPerChat: number;
  private readonly resumeRetryPolicy: ResumeRetryPolicy;
  private readonly sessionRevive: boolean;
  private shuttingDown = false;

  constructor(
    db: LcaDatabase,
    private readonly options: ChatEngineOptions
  ) {
    this.eventRetentionPerChat =
      options.eventRetentionPerChat ?? DEFAULT_EVENT_RETENTION;
    this.resumeRetryPolicy = resolveResumeRetryPolicy(options.resumeRetryPolicy);
    this.sessionRevive = options.sessionRevive ?? true;
    this.store =
      options.store ??
      new ChatStore(db, options.events, {
        maxEventPayloadBytes: options.maxEventPayloadBytes,
      });
    this.attachments = new AttachmentStore(db);
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }

  private async resumeChatWithRetry(
    chatId: string,
    make: () => Promise<ActiveRun>,
    signal: AbortSignal
  ): Promise<ActiveRun> {
    return resumeWithRetry({
      make,
      signal,
      policy: this.resumeRetryPolicy,
      onRetry: ({ attempt, maxAttempts, delayMs, message }) => {
        this.log(
          `Chat ${chatId}: resume failed (${message}); retrying attempt ${attempt + 1}/${maxAttempts} in ${delayMs}ms`
        );
        this.store.appendEvent(chatId, "chat.resume.retry", {
          attempt,
          maxAttempts,
          delayMs,
          message,
        });
      },
    });
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private scheduleDeferred(delayMs: number, fn: () => void): void {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      try {
        fn();
      } catch (err) {
        this.log(
          `Deferred chat task failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }, delayMs);
    handle.unref?.();
    this.timers.add(handle);
  }

  private transition(chatId: string, from: ChatStatus, to: ChatStatus): void {
    assertChatTransition(from, to);
    this.store.setStatus(chatId, to);
    this.log(`Chat ${chatId}: ${from} → ${to}`);
  }

  createChat(input: {
    workspaceId: string;
    title?: string | null;
    model?: ModelSelection | string | null;
    systemPrompt?: string | null;
    agentId?: string | null;
    sdkRunId?: string | null;
    originRunId?: string | null;
  }): ChatSessionRow {
    return this.store.createChatSession(input);
  }

  promoteFromRun(input: {
    runId: string;
    workspaceId: string;
    agentId: string;
    sdkRunId: string;
    model: ModelSelection | string | null;
    events: Array<{ event_type: string; payload: string }>;
    title?: string | null;
    /** Optional halted source when promoting a halt-discovery advisory. */
    sourceRunId?: string | null;
    /** Optional user context message appended after copied run events. */
    seedMessage?: string | null;
  }): ChatSessionRow {
    const chat = this.store.createChatSession({
      workspaceId: input.workspaceId,
      title: input.title ?? null,
      model: input.model ?? null,
      systemPrompt: null,
      agentId: input.agentId,
      sdkRunId: input.sdkRunId,
      originRunId: input.runId,
    });

    const promotedPayload: ChatPromotedFromRunPayload = {
      originRunId: input.runId,
    };
    if (input.sourceRunId != null && input.sourceRunId !== "") {
      promotedPayload.sourceRunId = input.sourceRunId;
    }
    this.store.appendEvent(chat.id, "chat.promoted_from_run", promotedPayload);

    for (const ev of input.events) {
      let payload: unknown;
      try {
        payload = JSON.parse(ev.payload);
      } catch {
        payload = ev.payload;
      }
      this.store.appendEvent(chat.id, ev.event_type, payload);
    }

    const seed = input.seedMessage?.trim();
    if (seed) {
      this.store.appendEvent(chat.id, "chat.message", {
        role: "user",
        text: seed,
      });
    }

    return chat;
  }

  getChat(chatId: string) {
    const session = this.store.getChatSession(chatId);
    if (!session) return undefined;
    return { session, events: this.store.listChatEvents(chatId) };
  }

  listWorkspaceChats(workspaceId: string): ChatSession[] {
    return this.store.listActiveChatSessions(workspaceId).map(mapChatSession);
  }

  listArchivedWorkspaceChats(workspaceId: string): ChatSession[] {
    return this.store.listArchivedChatSessions(workspaceId).map(mapChatSession);
  }

  getChatSnapshot(chatId: string): ChatSnapshot | undefined {
    const got = this.getChat(chatId);
    if (!got) return undefined;
    return {
      session: mapChatSession(got.session),
      events: got.events.map((row) =>
        mapChatEvent({ ...row, chat_id: chatId })
      ),
    };
  }

  private assertNotArchived(row: ChatSessionRow): void {
    if (row.archived_at) {
      throw new ChatMessageError(
        "archived",
        `Chat ${row.id} is archived; restore it before messaging`
      );
    }
  }

  async patchChat(
    chatId: string,
    patch: {
      title?: string;
      archived?: boolean;
      model?: ModelSelection | string | null;
      attachedRunId?: string | null;
    }
  ): Promise<ChatSession | undefined> {
    const row = this.store.getChatSession(chatId);
    if (!row) return undefined;
    if (patch.title !== undefined) {
      this.store.renameChatSession(chatId, patch.title, "user");
    }
    if (patch.model !== undefined) {
      this.store.setChatSessionModel(chatId, patch.model);
    }
    if (patch.attachedRunId !== undefined) {
      if (patch.attachedRunId === null) {
        this.store.setChatSessionAttachedRunId(chatId, null);
      } else {
        const run = this.options.lookupRun?.(patch.attachedRunId);
        if (!run) {
          throw new ChatMessageError(
            "not_found",
            `Run not found: ${patch.attachedRunId}`
          );
        }
        if (run.workspaceId !== row.workspace_id) {
          throw new ChatMessageError(
            "busy",
            `Run ${patch.attachedRunId} belongs to a different workspace than this chat`
          );
        }
        if (TERMINAL_RUN_STATUSES.has(run.status)) {
          throw new ChatMessageError(
            "busy",
            `Run ${patch.attachedRunId} is terminal (status=${run.status}); attach is for live runs`
          );
        }
        this.store.setChatSessionAttachedRunId(chatId, patch.attachedRunId);
      }
    }
    if (patch.archived === true) {
      // Cancel in-flight work first so we never leave a running archived chat.
      if (row.status === "running" || row.status === "needs_input") {
        await this.cancelChat(chatId);
      }
      this.store.archiveChatSession(chatId);
    } else if (patch.archived === false) {
      this.store.unarchiveChatSession(chatId);
    }
    const updated = this.store.getChatSession(chatId);
    if (!updated) return undefined;
    const session = mapChatSession(updated);
    if (
      patch.title !== undefined ||
      patch.archived !== undefined ||
      patch.model !== undefined ||
      patch.attachedRunId !== undefined
    ) {
      this.options.events?.emitChatSession?.(chatId, session);
    }
    return session;
  }

  recordSteerQueued(
    chatId: string,
    payload: { runId: string; queuedMessageId?: string; text: string }
  ): void {
    this.store.appendEvent(chatId, "chat.steer.queued", payload);
  }

  /** model + systemPrompt precedence: per-chat field → workspace default → global. */
  private buildContext(row: ChatSessionRow): ChatContext | undefined {
    const cwd = this.store.getWorkspacePath(row.workspace_id);
    if (!cwd) return undefined;
    const defaults = this.options.resolveDefaults?.(row.workspace_id) ?? {
      model: null,
      systemPrompt: null,
    };
    const modelSelection = resolveModelSelection(
      selectionFromStored(row.model, row.model_params_json),
      defaults.model
    );
    const systemPrompt = row.system_prompt ?? defaults.systemPrompt ?? null;
    return {
      cwd,
      model: modelSelection.id,
      modelSelection,
      systemPrompt,
      mcpExtra: defaults.mcpExtra,
      mcpDisable: defaults.mcpDisable,
    };
  }

  async sendMessage(
    chatId: string,
    text: string,
    attachmentRefs?: AttachmentRef[]
  ): Promise<void> {
    const row = this.store.getChatSession(chatId);
    if (!row) throw new ChatMessageError("not_found", `Chat not found: ${chatId}`);
    this.assertNotArchived(row);
    const attachments = resolveOperatorAttachments(
      this.attachments,
      "chat",
      chatId,
      attachmentRefs
    );
    if (!text.trim() && attachments.length === 0) {
      throw new ChatMessageError("empty_message", "message is required");
    }
    if (row.status === "running") {
      throw new ChatMessageError("busy", `Chat ${chatId} is busy (status=running)`);
    }
    if (row.status === "needs_input") {
      throw new ChatMessageError(
        "needs_input",
        `Chat ${chatId} is awaiting input; use answerChat`
      );
    }

    const ctx = this.buildContext(row);
    if (!ctx) {
      throw new ChatMessageError(
        "context_missing",
        `Chat ${chatId}: workspace path unavailable (global/unmapped workspaces have no cwd)`
      );
    }

    const trimmed = text.trim();
    const attachmentMeta = this.toAttachmentRefs(attachments);
    const seq = this.store.appendEvent(chatId, "chat.message", {
      role: "user",
      text: trimmed,
      ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
    });
    if (attachmentMeta.length > 0) {
      this.attachments.associateWithMessageSeq(
        "chat",
        chatId,
        attachmentMeta.map((attachment) => attachment.id),
        seq
      );
    }
    this.store.touchLastMessageAt(chatId);
    this.applyHeuristicTitle(chatId, trimmed, attachmentMeta.map((a) => a.name));
    this.transition(chatId, row.status, "running");

    const abort = new AbortController();
    this.inFlight.set(chatId, abort);
    const sessionToken = randomUUID();
    this.sessionTokens.set(chatId, sessionToken);

    const isFresh = !row.agent_id || !row.sdk_run_id;
    const operatorMessage = buildOperatorMessage(trimmed, attachments);
    if (isFresh) {
      this.track(
        this.runSpawnTurn(chatId, ctx, operatorMessage, abort, sessionToken)
      );
    } else {
      this.track(
        this.runResumeTurn(
          chatId,
          ctx,
          row.agent_id!,
          row.sdk_run_id!,
          operatorMessage,
          abort,
          sessionToken
        )
      );
    }
  }

  private async runSpawnTurn(
    chatId: string,
    ctx: ChatContext,
    message: OperatorMessage,
    abort: AbortController,
    sessionToken: string
  ): Promise<void> {
    let activeRun: ActiveRun | undefined;
    try {
      // Fresh chats spawn via agent.send. The local SDK can drop images on that
      // first send, so deliver raster images on an immediate follow-up instead.
      const attachments = message.attachments ?? [];
      const imageAttachments = attachments.filter((a) => a.kind === "image");
      const nonImageAttachments = attachments.filter((a) => a.kind !== "image");
      const promptText = ctx.systemPrompt
        ? `${ctx.systemPrompt}\n\n${message.text}`
        : message.text;
      const prompt = buildOperatorMessage(promptText, nonImageAttachments);
      activeRun = await this.options.executor.spawn({
        apiKey: this.options.apiKey,
        cwd: ctx.cwd,
        model: ctx.modelSelection,
        prompt,
        runId: chatId,
        runToken: sessionToken,
        mcpExtra: ctx.mcpExtra,
        mcpDisable: ctx.mcpDisable,
      });
      this.activeChats.set(chatId, activeRun);
      this.store.setAgentIds(chatId, activeRun.agentId, activeRun.sdkRunId);
      this.store.appendEvent(chatId, "chat.started", {
        agentId: activeRun.agentId,
        sdkRunId: activeRun.sdkRunId,
        model: ctx.model,
        modelSelection: ctx.modelSelection,
      });
      if (imageAttachments.length > 0) {
        if (!activeRun.sendFollowUp) {
          throw new Error("Executor cannot deliver image attachments");
        }
        activeRun = await activeRun.sendFollowUp(
          buildOperatorMessage("", imageAttachments),
          ctx.modelSelection
        );
        this.activeChats.set(chatId, activeRun);
        this.store.setAgentIds(chatId, activeRun.agentId, activeRun.sdkRunId);
      }
      await this.consumeAndFinalize(chatId, activeRun, abort.signal);
    } catch (err) {
      this.handleTurnError(chatId, err, abort);
    } finally {
      await this.settleTurn(chatId, activeRun, abort);
    }
  }

  private async runResumeTurn(
    chatId: string,
    ctx: ChatContext,
    agentId: string,
    sdkRunId: string,
    message: OperatorMessage,
    abort: AbortController,
    sessionToken: string
  ): Promise<void> {
    let activeRun: ActiveRun | undefined;
    try {
      activeRun = await this.resumeChatWithRetry(
        chatId,
        () =>
          this.options.executor.resume({
            apiKey: this.options.apiKey,
            cwd: ctx.cwd,
            model: ctx.modelSelection,
            prompt: message.text,
            runId: chatId,
            runToken: sessionToken,
            agentId,
            sdkRunId,
            mcpExtra: ctx.mcpExtra,
            mcpDisable: ctx.mcpDisable,
          }),
        abort.signal
      );
      this.activeChats.set(chatId, activeRun);
      this.store.setAgentIds(chatId, activeRun.agentId, activeRun.sdkRunId);
      this.store.appendEvent(chatId, "chat.resumed", {
        agentId: activeRun.agentId,
        sdkRunId: activeRun.sdkRunId,
        model: ctx.model,
        modelSelection: ctx.modelSelection,
      });
      if (!activeRun.sendFollowUp) {
        throw new Error("Executor cannot deliver chat follow-up");
      }
      const next = await activeRun.sendFollowUp(message, ctx.modelSelection);
      this.activeChats.set(chatId, next);
      this.store.setAgentIds(chatId, next.agentId, next.sdkRunId);
      activeRun = next;
      await this.consumeAndFinalize(chatId, activeRun, abort.signal);
    } catch (err) {
      const messageText =
        err instanceof CursorAgentError
          ? `startup failed: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      if (
        this.sessionRevive &&
        !abort.signal.aborted &&
        !isAuthResumeError(err) &&
        /not found/i.test(messageText)
      ) {
        const revived = await this.reviveChatTurn(
          chatId,
          ctx,
          agentId,
          sdkRunId,
          message,
          abort,
          sessionToken
        );
        if (revived) {
          activeRun = revived;
          return;
        }
        this.handleTurnError(chatId, err, abort, true);
        return;
      }
      this.handleTurnError(chatId, err, abort);
    } finally {
      await this.settleTurn(chatId, activeRun, abort);
    }
  }

  private async reviveChatTurn(
    chatId: string,
    ctx: ChatContext,
    previousAgentId: string,
    previousSdkRunId: string,
    message: OperatorMessage,
    abort: AbortController,
    sessionToken: string
  ): Promise<ActiveRun | undefined> {
    if (abort.signal.aborted) return undefined;
    const transcript = synthesizeTranscript(this.store.listChatEvents(chatId));
    const primer = buildRevivePrimer({
      transcript,
      newMessage: message.text,
    });
    const attachments = message.attachments ?? [];
    const imageAttachments = attachments.filter((a) => a.kind === "image");
    const nonImageAttachments = attachments.filter((a) => a.kind !== "image");
    const promptText = ctx.systemPrompt
      ? `${ctx.systemPrompt}\n\n${primer.text}`
      : primer.text;
    let fresh: ActiveRun;
    try {
      this.log(`Chat ${chatId}: session gone; reviving with transcript primer`);
      fresh = await this.options.executor.spawn({
        apiKey: this.options.apiKey,
        cwd: ctx.cwd,
        model: ctx.modelSelection,
        prompt: buildOperatorMessage(promptText, nonImageAttachments),
        runId: chatId,
        runToken: sessionToken,
        mcpExtra: ctx.mcpExtra,
        mcpDisable: ctx.mcpDisable,
      });
    } catch {
      return undefined;
    }

    if (abort.signal.aborted) {
      await fresh.dispose().catch(() => {});
      return undefined;
    }

    try {
      this.activeChats.set(chatId, fresh);
      this.store.setAgentIds(chatId, fresh.agentId, fresh.sdkRunId);
      this.store.appendEvent(chatId, "chat.revived", {
        previousAgentId,
        previousSdkRunId,
        agentId: fresh.agentId,
        sdkRunId: fresh.sdkRunId,
        model: ctx.model,
        modelSelection: ctx.modelSelection,
        transcriptMessages: primer.transcriptMessages,
        truncated: primer.truncated,
      });
      if (imageAttachments.length > 0) {
        if (!fresh.sendFollowUp) {
          throw new Error("Executor cannot deliver image attachments");
        }
        fresh = await fresh.sendFollowUp(
          buildOperatorMessage("", imageAttachments),
          ctx.modelSelection
        );
        this.activeChats.set(chatId, fresh);
        this.store.setAgentIds(chatId, fresh.agentId, fresh.sdkRunId);
      }
      await this.consumeAndFinalize(chatId, fresh, abort.signal);
    } catch (err) {
      // The revive spawn succeeded; a later failure is a genuine turn error of
      // the revived agent, handled exactly like a normal spawn turn's.
      this.handleTurnError(chatId, err, abort);
    }
    return fresh;
  }

  private async consumeAndFinalize(
    chatId: string,
    activeRun: ActiveRun,
    signal: AbortSignal
  ): Promise<void> {
    for await (const message of activeRun.stream()) {
      if (signal.aborted) {
        await activeRun.cancel();
        return;
      }
      const sdkRunId = extractRunIdFromMessage(message);
      if (sdkRunId) {
        const row = this.store.getChatSession(chatId);
        if (row && !row.sdk_run_id) {
          this.store.setAgentIds(chatId, activeRun.agentId, sdkRunId);
        }
      }
      this.store.appendEvent(chatId, message.type, message as SDKMessage);
    }

    if (signal.aborted) return;

    const result = await activeRun.wait();
    this.store.appendEvent(chatId, "chat.finished", {
      sdkStatus: result.status,
      result: result.result ?? null,
    });
    if (mapSdkResultStatus(result.status) === "failed") {
      const cur = this.store.getChatSession(chatId);
      if (cur && cur.status === "running") {
        this.transition(chatId, "running", "error");
      }
    }
  }

  private handleTurnError(
    chatId: string,
    err: unknown,
    abort: AbortController,
    reviveFailed = false
  ): void {
    if (abort.signal.aborted) return;
    const message =
      err instanceof CursorAgentError
        ? `startup failed: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    const stale = /not found/i.test(message);
    const authExpired = isAuthResumeError(err);
    this.log(`Chat ${chatId} turn error: ${message}`);
    this.store.appendEvent(chatId, "chat.error", {
      message,
      ...(stale ? { stale: true } : {}),
      ...(reviveFailed ? { reviveFailed: true } : {}),
      ...(authExpired ? { reason: "auth_expired" } : {}),
    });
    if (authExpired) {
      this.options.onAuthExpired?.("chat", chatId, message);
    }
    const cur = this.store.getChatSession(chatId);
    if (cur && (cur.status === "running" || cur.status === "needs_input")) {
      this.transition(chatId, cur.status, "error");
    }
  }

  private async settleTurn(
    chatId: string,
    activeRun: ActiveRun | undefined,
    abort: AbortController
  ): Promise<void> {
    if (this.shuttingDown) return;

    if (this.inFlight.get(chatId) === abort) this.inFlight.delete(chatId);
    this.activeChats.delete(chatId);
    if (activeRun) {
      try {
        await activeRun.dispose();
      } catch {
        /* ignore */
      }
    }

    const row = this.store.getChatSession(chatId);
    if (row && row.status === "running") {
      this.transition(chatId, "running", "idle");
    }

    this.sessionTokens.delete(chatId);

    if (this.maybeStartPendingInterrupt(chatId)) return;

    const settled = this.store.getChatSession(chatId);
    if (settled && settled.status === "idle") {
      const pruned = this.store.pruneChatEvents(chatId, this.eventRetentionPerChat);
      if (pruned > 0) this.log(`Chat ${chatId}: pruned ${pruned} old event(s)`);
      this.scheduleDeferred(0, () => this.deliverNextQueuedMessage(chatId));
      this.scheduleDeferred(0, () => {
        void this.maybeAutoTitle(chatId);
      });
    }
  }

  private applyHeuristicTitle(
    chatId: string,
    text: string,
    attachmentNames: string[]
  ): void {
    const row = this.store.getChatSession(chatId);
    // Only the first untitled message may set a heuristic title — never rewrite
    // an existing auto title from later turns.
    if (!row || row.title_source != null || row.title?.trim()) return;
    const heuristic = deriveHeuristicTitle({ text, attachmentNames });
    if (!heuristic) return;
    if (!this.store.setAutoTitleIfEligible(chatId, heuristic)) return;
    const updated = this.store.getChatSession(chatId);
    if (updated) {
      this.options.events?.emitChatSession?.(chatId, mapChatSession(updated));
    }
  }

  private async maybeAutoTitle(chatId: string): Promise<void> {
    try {
      const row = this.store.getChatSession(chatId);
      if (!row || row.title_source === "user") return;

      const firstText = this.store.getFirstUserMessageText(chatId);
      const attachmentNames = this.attachments
        .listForOwner("chat", chatId)
        .map((a) => a.filename);
      let title = row.title?.trim() || null;
      if (!title) {
        const heuristic = deriveHeuristicTitle({
          text: firstText,
          attachmentNames,
        });
        if (heuristic && this.store.setAutoTitleIfEligible(chatId, heuristic)) {
          title = heuristic;
          const updated = this.store.getChatSession(chatId);
          if (updated) {
            this.options.events?.emitChatSession?.(
              chatId,
              mapChatSession(updated)
            );
          }
        }
      }

      // LLM refine is one-shot after the first successful turn only.
      const finished = this.store.countFinishedEvents(chatId);
      if (finished !== 1 || !shouldRefineWithLlm(title)) return;

      const cwd = this.store.getWorkspacePath(row.workspace_id);
      if (!cwd) return;

      const refined = await refineTitleWithLlm({
        apiKey: this.options.apiKey,
        cwd,
        heuristic: title,
        firstMessageText: firstText,
        attachmentNames,
      });
      if (!refined) return;
      if (!this.store.setAutoTitleIfEligible(chatId, refined)) return;
      const updated = this.store.getChatSession(chatId);
      if (updated) {
        this.options.events?.emitChatSession?.(chatId, mapChatSession(updated));
      }
    } catch (err) {
      this.log(
        `Chat ${chatId}: auto-title failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Hard-delete a chat: cancel in-flight work, drop DB rows (events/queue CASCADE),
   * and remove attachment blobs. Running chats are deletable after cancel.
   */
  async purgeChat(chatId: string): Promise<boolean> {
    const row = this.store.getChatSession(chatId);
    if (!row) return false;

    this.pendingInterrupts.delete(chatId);
    this.cancelPendingQuestion(chatId);
    this.store.cancelAllPendingQueuedMessages(chatId);

    const controller = this.inFlight.get(chatId);
    controller?.abort();
    this.inFlight.delete(chatId);

    const active = this.activeChats.get(chatId);
    if (active) {
      try {
        await active.cancel();
      } catch {
        /* ignore */
      }
      try {
        await active.dispose();
      } catch {
        /* ignore */
      }
      this.activeChats.delete(chatId);
    }

    this.sessionTokens.delete(chatId);
    this.answerWaiters.delete(chatId);
    this.pendingQuestions.delete(chatId);

    try {
      removeAttachmentOwnerDir("chat", chatId);
    } catch (err) {
      this.log(
        `Chat ${chatId}: attachment dir cleanup failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    this.attachments.deleteForOwner("chat", chatId);

    const deleted = this.store.deleteChatSession(chatId);
    if (deleted) {
      this.options.events?.emitChatsDeleted?.([chatId]);
    }
    return deleted;
  }

  private deliverNextQueuedMessage(chatId: string): void {
    if (this.shuttingDown) return;
    if (this.inFlight.has(chatId) || this.activeChats.has(chatId)) return;
    const row = this.store.getChatSession(chatId);
    if (!row || row.status !== "idle") return;
    const pending = this.store.getOldestPendingQueuedMessage(chatId);
    if (!pending) return;
    try {
      this.store.markQueuedMessageDelivered(pending.id);
      const operatorMessage = operatorMessageFromQueued(
        this.attachments,
        "chat",
        chatId,
        pending.message,
        pending.attachments_json
      );
      void this.sendMessage(
        chatId,
        operatorMessage.text,
        this.toAttachmentRefs(operatorMessage.attachments ?? [])
      );
    } catch (err) {
      this.log(
        `Chat ${chatId}: queued delivery failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async queueMessage(
    chatId: string,
    text: string,
    attachmentRefs?: AttachmentRef[]
  ): Promise<string> {
    const row = this.store.getChatSession(chatId);
    if (!row) throw new ChatMessageError("not_found", `Chat not found: ${chatId}`);
    this.assertNotArchived(row);
    const attachments = resolveOperatorAttachments(
      this.attachments,
      "chat",
      chatId,
      attachmentRefs
    );
    if (!text.trim() && attachments.length === 0) {
      throw new ChatMessageError("empty_message", "message is required");
    }
    if (row.status === "needs_input") {
      throw new ChatMessageError(
        "needs_input",
        `Chat ${chatId} is awaiting input; use answerChat`
      );
    }
    if (row.status !== "running") {
      throw new ChatMessageError("busy", `Chat ${chatId} not running; use sendMessage`);
    }
    const trimmed = text.trim();
    const attachmentMeta = this.toAttachmentRefs(attachments);
    const queuedMessageId = this.store.enqueueQueuedMessage(
      chatId,
      trimmed,
      serializeAttachmentRefs(attachmentMeta)
    );
    this.store.appendEvent(chatId, "chat.message.queued", {
      role: "user",
      text: trimmed,
      queuedMessageId,
      ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
    });
    return queuedMessageId;
  }

  async interruptChat(
    chatId: string,
    text: string,
    attachmentRefs?: AttachmentRef[]
  ): Promise<void> {
    const row = this.store.getChatSession(chatId);
    if (!row) throw new ChatMessageError("not_found", `Chat not found: ${chatId}`);
    this.assertNotArchived(row);
    const attachments = resolveOperatorAttachments(
      this.attachments,
      "chat",
      chatId,
      attachmentRefs
    );
    if (!text.trim() && attachments.length === 0) {
      throw new ChatMessageError("empty_message", "message is required");
    }
    if (row.status === "needs_input") {
      throw new ChatMessageError(
        "needs_input",
        `Chat ${chatId} is awaiting input; use answerChat`
      );
    }
    if (row.status !== "running") {
      await this.sendMessage(chatId, text, attachmentRefs);
      return;
    }
    const trimmed = text.trim();
    const attachmentMeta = this.toAttachmentRefs(attachments);
    this.store.appendEvent(chatId, "chat.interrupted", {
      role: "user",
      text: trimmed,
      ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
    });
    this.pendingInterrupts.set(
      chatId,
      buildOperatorMessage(trimmed, attachments)
    );
    this.cancelPendingQuestion(chatId);
    this.inFlight.get(chatId)?.abort();
    const active = this.activeChats.get(chatId);
    if (active) {
      void active.cancel().catch(() => {});
    } else {
      this.maybeStartPendingInterrupt(chatId);
    }
  }

  async cancelChat(chatId: string): Promise<void> {
    const row = this.store.getChatSession(chatId);
    if (!row) throw new ChatMessageError("not_found", `Chat not found: ${chatId}`);
    this.pendingInterrupts.delete(chatId);
    this.cancelPendingQuestion(chatId);
    this.store.cancelAllPendingQueuedMessages(chatId);
    this.inFlight.get(chatId)?.abort();
    const active = this.activeChats.get(chatId);
    if (active) {
      void active.cancel().catch(() => {});
    }
    if (row.status === "running" || row.status === "needs_input") {
      this.transition(chatId, row.status, "idle");
    }
  }

  private maybeStartPendingInterrupt(chatId: string): boolean {
    const message = this.pendingInterrupts.get(chatId);
    if (!message) return false;
    this.pendingInterrupts.delete(chatId);
    this.scheduleDeferred(0, () => {
      const row = this.store.getChatSession(chatId);
      if (!row || row.status === "running") return;
      try {
        void this.sendMessage(
          chatId,
          message.text,
          this.toAttachmentRefs(message.attachments ?? [])
        );
      } catch (err) {
        this.log(
          `Chat ${chatId}: interrupt follow-up failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });
    return true;
  }

  verifyChatToken(chatId: string, token: string | undefined): void {
    const expected = this.sessionTokens.get(chatId);
    if (expected && token !== expected) {
      throw new Error(`Chat ${chatId}: invalid or missing session token`);
    }
  }

  async askAndWait(
    chatId: string,
    question: string,
    token?: string,
    metadata?: InputRequestMetadata | null
  ): Promise<string> {
    const row = this.store.getChatSession(chatId);
    if (!row) throw new Error(`Chat not found: ${chatId}`);
    this.verifyChatToken(chatId, token);
    if (row.status !== "running") {
      throw new Error(`Chat ${chatId} cannot accept ask_user in status ${row.status}`);
    }
    if (this.pendingQuestions.has(chatId)) {
      throw new Error(`Chat ${chatId} already has a pending input request`);
    }

    this.pendingQuestions.set(chatId, { question, metadata });
    const askedPayload: Record<string, unknown> = { question };
    if (metadata != null) {
      askedPayload.metadata = metadata;
    }
    this.store.appendEvent(chatId, "input.asked", askedPayload);
    this.transition(chatId, "running", "needs_input");

    const request: InputRequest = {
      id: randomUUID(),
      runId: chatId,
      question,
      answer: null,
      status: "pending",
      createdAt: new Date().toISOString(),
      answeredAt: null,
      metadata: metadata ?? null,
    };
    this.options.events?.emitChatInputRequest(chatId, request);
    this.options.onChatNeedsInput?.(chatId, request);

    return new Promise<string>((resolve) => {
      this.answerWaiters.set(chatId, resolve);
    });
  }

  answerChat(chatId: string, answer: string): void {
    const row = this.store.getChatSession(chatId);
    if (!row) throw new Error(`Chat not found: ${chatId}`);
    if (row.status !== "needs_input") {
      throw new Error(`Chat ${chatId} is not awaiting input (status=${row.status})`);
    }
    const pending = this.pendingQuestions.get(chatId);
    const choices = pending?.metadata?.choices;
    if (choices && choices.length > 0) {
      const ids = new Set(choices.map((c) => c.id));
      if (!ids.has(answer)) {
        throw new Error(
          `Answer must be one of the declared choice ids (${[...ids].join(", ")}); got "${answer}"`
        );
      }
    } else if (!answer.trim()) {
      throw new Error("answer is required");
    }
    const waiter = this.answerWaiters.get(chatId);
    this.pendingQuestions.delete(chatId);
    this.answerWaiters.delete(chatId);
    this.store.appendEvent(chatId, "input.delivered", { answer });
    this.transition(chatId, "needs_input", "running");
    waiter?.(answer);
  }

  private cancelPendingQuestion(chatId: string): void {
    if (this.pendingQuestions.delete(chatId)) {
      this.answerWaiters.delete(chatId);
    }
  }

  private toAttachmentRefs(attachments: OperatorAttachment[]): AttachmentRef[] {
    return attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: attachment.kind,
    }));
  }

  async resumeInterruptedChats(): Promise<void> {
    for (const row of this.store.listInterruptedChats()) {
      this.store.appendEvent(row.id, "chat.reconciled", { priorStatus: row.status });
      this.transition(row.id, row.status, "idle");
      this.log(`Chat ${row.id}: ${row.status} → idle (reconciled at boot)`);
    }
  }

  /** Shared ChatStore handle (same instance routes use for workspace defaults). */
  getChatStore(): ChatStore {
    return this.store;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const abort of this.inFlight.values()) abort.abort();
    const handles = [...this.activeChats.values()];
    await Promise.allSettled(handles.map((h) => h.cancel()));
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled(handles.map((h) => h.dispose()));
    this.activeChats.clear();
    this.inFlight.clear();
    this.sessionTokens.clear();
    this.pendingInterrupts.clear();
    this.answerWaiters.clear();
    this.pendingQuestions.clear();
  }
}
