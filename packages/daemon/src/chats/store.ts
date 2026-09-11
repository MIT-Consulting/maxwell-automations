import type {
  ChatEvent,
  ChatSession,
  ChatStatus,
  ChatTitleSource,
  ModelSelection,
} from "@lca/shared";
import {
  modelSelectionFromLegacy,
  normalizeModelSelection,
} from "@lca/shared";
import { randomUUID } from "node:crypto";
import type { LcaDatabase } from "../db/index.js";
import type { DaemonEventSink } from "../events.js";
import { DEFAULT_SETTINGS } from "../config/settings.js";
import { capEventPayload } from "../events/payload-cap.js";
import {
  selectionFromStored,
  splitSelectionForDb,
} from "../models/selection-persist.js";

export type ChatSessionRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  title_source: ChatTitleSource | null;
  status: ChatStatus;
  agent_id: string | null;
  sdk_run_id: string | null;
  model: string | null;
  model_params_json: string | null;
  system_prompt: string | null;
  origin_run_id: string | null;
  attached_run_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
};

export type QueuedChatMessageStatus = "pending" | "delivered" | "cancelled";

export type WorkspaceChatDefaultsRow = {
  workspace_id: string;
  model: string | null;
  model_params_json: string | null;
  system_prompt: string | null;
  mcp_overlay_json: string;
  updated_at: string;
};

export type QueuedChatMessageRow = {
  id: string;
  chat_id: string;
  message: string;
  attachments_json: string | null;
  status: QueuedChatMessageStatus;
  created_at: string;
  delivered_at: string | null;
  cancelled_at: string | null;
};

export type ChatStoreOptions = {
  maxEventPayloadBytes?: number;
};

export function mapChatSession(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    titleSource: row.title_source ?? null,
    status: row.status,
    agentId: row.agent_id,
    sdkRunId: row.sdk_run_id,
    model: row.model,
    modelSelection: selectionFromStored(row.model, row.model_params_json),
    systemPrompt: row.system_prompt,
    originRunId: row.origin_run_id,
    attachedRunId: row.attached_run_id ?? null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
  };
}

export function mapChatEvent(row: {
  id?: number;
  seq: number;
  event_type: string;
  payload: string;
  created_at: string;
  chat_id?: string;
}): ChatEvent {
  return {
    id: row.id ?? 0,
    chatId: row.chat_id ?? "",
    seq: row.seq,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export class ChatStore {
  private readonly maxEventPayloadBytes: number;

  constructor(
    private readonly db: LcaDatabase,
    private readonly events?: DaemonEventSink,
    options: ChatStoreOptions = {}
  ) {
    this.maxEventPayloadBytes =
      options.maxEventPayloadBytes ?? DEFAULT_SETTINGS.maxEventPayloadBytes;
  }

  createChatSession(input: {
    workspaceId: string;
    title?: string | null;
    model?: ModelSelection | string | null;
    systemPrompt?: string | null;
    agentId?: string | null;
    sdkRunId?: string | null;
    originRunId?: string | null;
  }): ChatSessionRow {
    const id = randomUUID();
    const title = input.title ?? null;
    const titleSource: ChatTitleSource | null = title ? "user" : null;
    const selection =
      input.model === undefined || input.model === null
        ? null
        : typeof input.model === "string"
          ? modelSelectionFromLegacy(input.model)
          : normalizeModelSelection(input.model);
    const stored = splitSelectionForDb(selection);
    this.db
      .prepare(
        `INSERT INTO chat_sessions (
          id, workspace_id, title, title_source, status, model, model_params_json,
          system_prompt, agent_id, sdk_run_id, origin_run_id
        ) VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.workspaceId,
        title,
        titleSource,
        stored.model,
        stored.modelParamsJson,
        input.systemPrompt ?? null,
        input.agentId ?? null,
        input.sdkRunId ?? null,
        input.originRunId ?? null
      );
    return this.getChatSession(id)!;
  }

  getChatSession(id: string): ChatSessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM chat_sessions WHERE id = ?`)
      .get(id) as ChatSessionRow | undefined;
  }

  /**
   * Deterministic active chat for a run origin. Oldest created_at wins; id is
   * the tie-breaker. Does not scan all sessions in memory.
   */
  findActiveByOriginRunId(originRunId: string): ChatSessionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE origin_run_id = ? AND archived_at IS NULL
         ORDER BY created_at ASC, id ASC
         LIMIT 1`
      )
      .get(originRunId) as ChatSessionRow | undefined;
  }

  listChatSessions(workspaceId: string): ChatSessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE workspace_id = ?
         ORDER BY updated_at DESC`
      )
      .all(workspaceId) as ChatSessionRow[];
  }

  listActiveChatSessions(workspaceId: string): ChatSessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE workspace_id = ? AND archived_at IS NULL
         ORDER BY updated_at DESC`
      )
      .all(workspaceId) as ChatSessionRow[];
  }

  listArchivedChatSessions(workspaceId: string): ChatSessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE workspace_id = ? AND archived_at IS NOT NULL
         ORDER BY updated_at DESC`
      )
      .all(workspaceId) as ChatSessionRow[];
  }

  private capPayload(eventType: string, payloadJson: string): string {
    return capEventPayload(eventType, payloadJson, this.maxEventPayloadBytes);
  }

  appendEvent(chatId: string, eventType: string, payload: unknown): number {
    const seqRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM chat_events WHERE chat_id = ?`
      )
      .get(chatId) as { nextSeq: number };
    const seq = seqRow.nextSeq;
    const payloadJson = this.capPayload(eventType, JSON.stringify(payload) ?? "null");
    const info = this.db
      .prepare(
        `INSERT INTO chat_events (chat_id, seq, event_type, payload)
         VALUES (?, ?, ?, ?)`
      )
      .run(chatId, seq, eventType, payloadJson);
    this.db
      .prepare(`UPDATE chat_sessions SET updated_at = datetime('now') WHERE id = ?`)
      .run(chatId);
    this.events?.emitChatEvent(chatId, {
      id: Number(info.lastInsertRowid),
      chatId,
      seq,
      eventType,
      payload: payloadJson,
      createdAt: new Date().toISOString(),
    });
    return seq;
  }

  listChatEvents(chatId: string): Array<{
    seq: number;
    event_type: string;
    payload: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT seq, event_type, payload, created_at FROM chat_events
         WHERE chat_id = ? ORDER BY seq ASC`
      )
      .all(chatId) as Array<{
      seq: number;
      event_type: string;
      payload: string;
      created_at: string;
    }>;
  }

  countChatEvents(chatId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM chat_events WHERE chat_id = ?`)
      .get(chatId) as { n: number };
    return row.n;
  }

  pruneChatEvents(chatId: string, keep: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM chat_events
         WHERE chat_id = @chatId
           AND seq <= (
             SELECT COALESCE(MAX(seq), 0) - @keep FROM chat_events WHERE chat_id = @chatId
           )`
      )
      .run({ chatId, keep });
    return info.changes;
  }

  setStatus(chatId: string, status: ChatStatus): void {
    this.db
      .prepare(
        `UPDATE chat_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(status, chatId);
    this.events?.emitChatStatus(chatId, status);
  }

  setAgentIds(chatId: string, agentId: string, sdkRunId: string): void {
    this.db
      .prepare(
        `UPDATE chat_sessions SET agent_id = ?, sdk_run_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(agentId, sdkRunId, chatId);
  }

  touchLastMessageAt(chatId: string): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET last_message_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(chatId);
  }

  renameChatSession(
    chatId: string,
    title: string,
    source: ChatTitleSource = "user"
  ): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET title = ?, title_source = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(title, source, chatId);
  }

  setChatSessionAttachedRunId(chatId: string, runId: string | null): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET attached_run_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(runId, chatId);
  }

  setChatSessionModel(
    chatId: string,
    model: ModelSelection | string | null
  ): void {
    const selection =
      model === null
        ? null
        : typeof model === "string"
          ? modelSelectionFromLegacy(model)
          : normalizeModelSelection(model);
    const stored = splitSelectionForDb(selection);
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET model = ?, model_params_json = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(stored.model, stored.modelParamsJson, chatId);
  }

  /**
   * Race-safe auto-title write. Returns true when the row was updated.
   * Never overwrites a user-set title.
   */
  setAutoTitleIfEligible(chatId: string, title: string): boolean {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const info = this.db
      .prepare(
        `UPDATE chat_sessions
         SET title = ?, title_source = 'auto', updated_at = datetime('now')
         WHERE id = ?
           AND (title_source IS NULL OR title_source = 'auto')
           AND title_source IS NOT 'user'`
      )
      .run(trimmed, chatId);
    return info.changes > 0;
  }

  getFirstUserMessageText(chatId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM chat_events
         WHERE chat_id = ? AND event_type = 'chat.message'
         ORDER BY seq ASC
         LIMIT 1`
      )
      .get(chatId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : null;
    } catch {
      return null;
    }
  }

  countFinishedEvents(chatId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM chat_events
         WHERE chat_id = ? AND event_type = 'chat.finished'`
      )
      .get(chatId) as { n: number };
    return row.n;
  }

  deleteChatSession(chatId: string): boolean {
    const info = this.db
      .prepare(`DELETE FROM chat_sessions WHERE id = ?`)
      .run(chatId);
    return info.changes > 0;
  }

  archiveChatSession(chatId: string): void {
    this.db
      .prepare(
        `UPDATE chat_sessions SET archived_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(chatId);
  }

  unarchiveChatSession(chatId: string): void {
    this.db
      .prepare(
        `UPDATE chat_sessions SET archived_at = NULL, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(chatId);
  }

  enqueueQueuedMessage(
    chatId: string,
    message: string,
    attachmentsJson: string | null = null
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO chat_queued_messages (id, chat_id, message, attachments_json, status)
         VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(id, chatId, message, attachmentsJson);
    return id;
  }

  getOldestPendingQueuedMessage(chatId: string): QueuedChatMessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM chat_queued_messages
         WHERE chat_id = ? AND status = 'pending'
         ORDER BY created_at ASC, rowid ASC
         LIMIT 1`
      )
      .get(chatId) as QueuedChatMessageRow | undefined;
  }

  markQueuedMessageDelivered(id: string): void {
    this.db
      .prepare(
        `UPDATE chat_queued_messages
         SET status = 'delivered', delivered_at = datetime('now')
         WHERE id = ?`
      )
      .run(id);
  }

  cancelAllPendingQueuedMessages(chatId: string): number {
    const info = this.db
      .prepare(
        `UPDATE chat_queued_messages
         SET status = 'cancelled', cancelled_at = datetime('now')
         WHERE chat_id = ? AND status = 'pending'`
      )
      .run(chatId);
    return info.changes;
  }

  listQueuedMessages(chatId: string): QueuedChatMessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_queued_messages
         WHERE chat_id = ?
         ORDER BY created_at ASC, rowid ASC`
      )
      .all(chatId) as QueuedChatMessageRow[];
  }

  getWorkspacePath(workspaceId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT path FROM workspaces WHERE id = ?`)
      .get(workspaceId) as { path: string } | undefined;
    if (!row || row.path === "__global__") {
      return undefined;
    }
    return row.path;
  }

  getWorkspaceChatDefaults(workspaceId: string): WorkspaceChatDefaultsRow | undefined {
    return this.db
      .prepare(`SELECT * FROM workspace_chat_defaults WHERE workspace_id = ?`)
      .get(workspaceId) as WorkspaceChatDefaultsRow | undefined;
  }

  upsertWorkspaceChatDefaults(
    workspaceId: string,
    input: {
      model?: ModelSelection | string | null;
      systemPrompt?: string | null;
      mcpOverlayJson?: string;
    }
  ): void {
    const existing = this.getWorkspaceChatDefaults(workspaceId);
    let model: string | null;
    let modelParamsJson: string | null;
    if ("model" in input) {
      const selection =
        input.model === null || input.model === undefined
          ? null
          : typeof input.model === "string"
            ? modelSelectionFromLegacy(input.model)
            : normalizeModelSelection(input.model);
      const stored = splitSelectionForDb(selection);
      model = stored.model;
      modelParamsJson = stored.modelParamsJson;
    } else {
      model = existing?.model ?? null;
      modelParamsJson = existing?.model_params_json ?? null;
    }
    const systemPrompt =
      "systemPrompt" in input ? input.systemPrompt ?? null : existing?.system_prompt ?? null;
    const mcpOverlayJson =
      input.mcpOverlayJson ?? existing?.mcp_overlay_json ?? "{}";

    this.db
      .prepare(
        `INSERT INTO workspace_chat_defaults (
          workspace_id, model, model_params_json, system_prompt, mcp_overlay_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(workspace_id) DO UPDATE SET
          model = excluded.model,
          model_params_json = excluded.model_params_json,
          system_prompt = excluded.system_prompt,
          mcp_overlay_json = excluded.mcp_overlay_json,
          updated_at = datetime('now')`
      )
      .run(workspaceId, model, modelParamsJson, systemPrompt, mcpOverlayJson);
  }

  clearWorkspaceChatDefaults(workspaceId: string): void {
    this.db
      .prepare(`DELETE FROM workspace_chat_defaults WHERE workspace_id = ?`)
      .run(workspaceId);
  }

  listInterruptedChats(): ChatSessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_sessions
         WHERE archived_at IS NULL AND status IN ('running', 'needs_input')
         ORDER BY updated_at ASC`
      )
      .all() as ChatSessionRow[];
  }
}
