import {
  IMPLEMENT_FULLY_PIPELINE_ID,
  type Automation,
  type AutomationMutationResponse,
  type Attachment,
  type AttachmentRef,
  type ChatSession,
  type ChatSnapshot,
  type CreateAutomationRequest,
  type CreateChatRequest,
  type CreateWorkspaceRequest,
  type ModelSelection,
  type PickFolderResponse,
  type InputRequest,
  type ListModelsResponse,
  type ListWorkspaceArtifactsResponse,
  type ListWorkspaceFilesResponse,
  type PipelineIntrospectionResponse,
  type PipelineWaveOperatorRequest,
  type PipelineWaveOperatorResponse,
  type ProvisionPipelineWorkersRequest,
  type ProvisionPipelineWorkersResponse,
  type ResolveImplementFullyKickoffRequest,
  type ResolveImplementFullyKickoffResponse,
  type Run,
  type RunEscalationRefusal,
  type RunEscalationRequest,
  type RunEscalationResponse,
  type RunEvent,
  type DeleteRunsResponse,
  type InterruptRunRequest,
  type InterruptRunResponse,
  type PauseRunResponse,
  type QueueRunMessageRequest,
  type QueueRunMessageResponse,
  type ResumeRunRequest,
  type ResumeRunResponse,
  type SendRunMessageRequest,
  type SendRunMessageResponse,
  type TriggerRunRequest,
  type UploadAttachmentResponse,
  type UpdateAutomationRequest,
  type SteerChatRequest,
  type SteerChatResponse,
  type UpdateChatRequest,
  type UpdateRunRequest,
  type UpdateNotifySettingsInput,
  type UpdateWorkspaceChatDefaultsRequest,
  type NotifySettingsPublic,
  type Workspace,
  type WorkspaceChatDefaults,
  type WorkspaceArtifact,
  type WorkspaceFileContentResponse,
  type WorkspaceMutationResponse,
} from "@lca/shared";
import { resolveAttachmentMimeType } from "./chatAttachments";

/** 409 from POST /api/pipelines/:id/workers — body is the plan, not `{ error }`. */
export class ProvisionConflictError extends Error {
  readonly response: ProvisionPipelineWorkersResponse;

  constructor(response: ProvisionPipelineWorkersResponse) {
    super("Provisioning conflict");
    this.name = "ProvisionConflictError";
    this.response = response;
  }
}

/** Escalation refusal with machine-readable code. */
export class EscalationError extends Error {
  readonly code: RunEscalationRefusal;
  readonly status: number;

  constructor(status: number, message: string, code: RunEscalationRefusal) {
    super(message);
    this.name = "EscalationError";
    this.status = status;
    this.code = code;
  }
}

export const CONTROL_TOKEN_KEY = "lca_control_token";

/** The control token entered by a remote operator, or null on loopback/unset. */
export function getControlToken(): string | null {
  return localStorage.getItem(CONTROL_TOKEN_KEY);
}

export function setControlToken(value: string | null): void {
  if (value) {
    localStorage.setItem(CONTROL_TOKEN_KEY, value);
  } else {
    localStorage.removeItem(CONTROL_TOKEN_KEY);
  }
  tokenVersion += 1;
  for (const cb of tokenChangeListeners) cb();
}

// Token-change signal: lets media that failed with 401 retry after the operator
// unlocks via TokenGate (their hrefs don't change, so they need this nudge).
let tokenVersion = 0;
const tokenChangeListeners = new Set<() => void>();

export function subscribeControlTokenChange(cb: () => void): () => void {
  tokenChangeListeners.add(cb);
  return () => {
    tokenChangeListeners.delete(cb);
  };
}

export function getControlTokenVersion(): number {
  return tokenVersion;
}

let authRequiredCb: (() => void) | null = null;

/** Register a handler fired when a request is rejected for auth (401/403). */
export function onAuthRequired(cb: () => void): void {
  authRequiredCb = cb;
}

/**
 * Central fetch wrapper: attaches the control token when present and notifies
 * the app when a request is rejected for auth so it can prompt for a token.
 */
async function request(path: string, init?: RequestInit): Promise<Response> {
  const token = getControlToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("X-LCA-Control-Token", token);
  }
  const res = await window.fetch(path, { ...init, headers });
  if (res.status === 401 || res.status === 403) {
    authRequiredCb?.();
  }
  return res;
}

/**
 * Fetch a same-origin path as a Blob with the control token attached.
 * Needed for `<img>` / download links: browsers cannot set custom headers on
 * those navigations, so remote (non-loopback) GETs would 401 without this.
 */
export async function fetchAuthenticatedBlob(path: string): Promise<Blob> {
  const res = await request(path);
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `: ${body.error}`;
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return res.blob();
}

export type RunSnapshot = {
  run: {
    id: string;
    status: Run["status"];
    automation_id: string;
    workspace_id: string;
    trigger_kind: string | null;
    agent_id: string | null;
    sdk_run_id: string | null;
    prompt: string | null;
    title: string | null;
    summary: string | null;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
  };
  events: Array<{
    seq: number;
    event_type: string;
    payload: string;
    created_at: string;
  }>;
  inputRequests: InputRequest[];
};

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail}`);
  }
  return (await res.json()) as T;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Failed to encode file"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export const api = {
  async listAutomations(): Promise<Automation[]> {
    const data = await jsonOrThrow<{ automations: Automation[] }>(
      await request("/api/automations")
    );
    return data.automations;
  },

  async listRuns(): Promise<Run[]> {
    const data = await jsonOrThrow<{ runs: Run[] }>(await request("/api/runs"));
    return data.runs;
  },

  async listWorkspaces(): Promise<Workspace[]> {
    const data = await jsonOrThrow<{ workspaces: Workspace[] }>(
      await request("/api/workspaces")
    );
    return data.workspaces;
  },

  async listModels(): Promise<ListModelsResponse> {
    return jsonOrThrow<ListModelsResponse>(await request("/api/models"));
  },

  async listWorkspaceArtifacts(workspaceId: string): Promise<WorkspaceArtifact[]> {
    const data = await jsonOrThrow<ListWorkspaceArtifactsResponse>(
      await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts`)
    );
    return data.artifacts;
  },

  async listWorkspaceFiles(
    workspaceId: string,
    dir: string
  ): Promise<ListWorkspaceFilesResponse> {
    return jsonOrThrow<ListWorkspaceFilesResponse>(
      await request(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files?dir=${encodeURIComponent(dir)}`
      )
    );
  },

  async getWorkspaceFileContent(
    workspaceId: string,
    path: string
  ): Promise<WorkspaceFileContentResponse> {
    return jsonOrThrow<WorkspaceFileContentResponse>(
      await request(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(path)}`
      )
    );
  },

  async createWorkspace(input: CreateWorkspaceRequest): Promise<Workspace> {
    const data = await jsonOrThrow<WorkspaceMutationResponse>(
      await request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
    );
    return data.workspace;
  },

  async pickWorkspaceFolder(base?: string): Promise<PickFolderResponse> {
    return jsonOrThrow<PickFolderResponse>(
      await request("/api/workspaces/pick-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(base ? { base } : {}),
      })
    );
  },

  async getRun(runId: string): Promise<RunSnapshot> {
    return jsonOrThrow<RunSnapshot>(
      await request(`/api/runs/${encodeURIComponent(runId)}`)
    );
  },

  async triggerRun(automationId: string): Promise<string> {
    const data = await jsonOrThrow<{ runId: string }>(
      await request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId }),
      })
    );
    return data.runId;
  },

  /** Context-aware kickoff — full TriggerRunRequest body. */
  async triggerRunWithContext(body: TriggerRunRequest): Promise<string> {
    const data = await jsonOrThrow<{ runId: string }>(
      await request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    return data.runId;
  },

  async getPipeline(
    pipelineId: string,
    workspaceId?: string
  ): Promise<PipelineIntrospectionResponse> {
    const qs =
      workspaceId != null && workspaceId !== ""
        ? `?workspaceId=${encodeURIComponent(workspaceId)}`
        : "";
    return jsonOrThrow<PipelineIntrospectionResponse>(
      await request(`/api/pipelines/${encodeURIComponent(pipelineId)}${qs}`)
    );
  },

  async provisionPipelineWorkers(
    pipelineId: string,
    body: ProvisionPipelineWorkersRequest
  ): Promise<ProvisionPipelineWorkersResponse> {
    const res = await request(
      `/api/pipelines/${encodeURIComponent(pipelineId)}/workers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (res.status === 409) {
      let response: ProvisionPipelineWorkersResponse;
      try {
        response = (await res.json()) as ProvisionPipelineWorkersResponse;
      } catch {
        throw new Error("409 Conflict");
      }
      throw new ProvisionConflictError(response);
    }
    return jsonOrThrow<ProvisionPipelineWorkersResponse>(res);
  },

  async resolveImplementFullyKickoff(
    body: ResolveImplementFullyKickoffRequest
  ): Promise<ResolveImplementFullyKickoffResponse> {
    return jsonOrThrow<ResolveImplementFullyKickoffResponse>(
      await request(
        `/api/pipelines/${encodeURIComponent(IMPLEMENT_FULLY_PIPELINE_ID)}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      )
    );
  },

  async escalate(
    runId: string,
    body: RunEscalationRequest
  ): Promise<RunEscalationResponse> {
    const res = await request(
      `/api/runs/${encodeURIComponent(runId)}/escalate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      let code: RunEscalationRefusal | undefined;
      try {
        const errBody = (await res.json()) as {
          error?: string;
          code?: RunEscalationRefusal;
        };
        if (errBody.error) message = errBody.error;
        code = errBody.code;
      } catch {
        /* non-JSON */
      }
      if (code) {
        throw new EscalationError(res.status, message, code);
      }
      throw new Error(message);
    }
    return (await res.json()) as RunEscalationResponse;
  },

  async waveAction(
    waveId: string,
    body: PipelineWaveOperatorRequest
  ): Promise<PipelineWaveOperatorResponse> {
    return jsonOrThrow<PipelineWaveOperatorResponse>(
      await request(`/api/pipeline-waves/${encodeURIComponent(waveId)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  },

  async uploadRunAttachment(runId: string, file: File): Promise<Attachment> {
    const contentBase64 = await fileToBase64(file);
    const data = await jsonOrThrow<UploadAttachmentResponse>(
      await request(`/api/runs/${encodeURIComponent(runId)}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mimeType: resolveAttachmentMimeType(file),
          contentBase64,
        }),
      })
    );
    return data.attachment;
  },

  runAttachmentUrl(runId: string, attachmentId: string): string {
    return `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(
      attachmentId
    )}`;
  },

  async setEnabled(automationId: string, enabled: boolean): Promise<Automation> {
    const data = await jsonOrThrow<{ automation: Automation }>(
      await request(
        `/api/automations/${encodeURIComponent(automationId)}/enabled`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }
      )
    );
    return data.automation;
  },

  async answer(runId: string, answer: string): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/runs/${encodeURIComponent(runId)}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      })
    );
  },

  async sendMessage(
    runId: string,
    message: string,
    attachments?: AttachmentRef[]
  ): Promise<void> {
    const payload: SendRunMessageRequest = { message, attachments };
    await jsonOrThrow<SendRunMessageResponse>(
      await request(`/api/runs/${encodeURIComponent(runId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  },

  async queueMessage(
    runId: string,
    message: string,
    attachments?: AttachmentRef[]
  ): Promise<string | undefined> {
    const payload: QueueRunMessageRequest = { message, attachments };
    const data = await jsonOrThrow<QueueRunMessageResponse>(
      await request(`/api/runs/${encodeURIComponent(runId)}/queue-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
    return data.queuedMessageId;
  },

  async interrupt(
    runId: string,
    message: string,
    attachments?: AttachmentRef[]
  ): Promise<void> {
    const payload: InterruptRunRequest = { message, attachments };
    await jsonOrThrow<InterruptRunResponse>(
      await request(`/api/runs/${encodeURIComponent(runId)}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  },

  /**
   * Ask the daemon to relaunch itself (remote recovery for a misbehaving daemon
   * on a Tailscale device). The daemon replies 202 then tears down its HTTP
   * listener, so a dropped connection after a 202 — or even before the reply
   * arrives — is expected and treated as success. The dashboard's WS reconnect
   * loop will re-attach once the fresh daemon is back on the same port.
   */
  async restart(): Promise<void> {
    try {
      const res = await request("/api/restart", { method: "POST" });
      if (res.status === 501) {
        await jsonOrThrow(res); // surface "not supported in dev"
      }
    } catch {
      /* connection dropped as the daemon went down — expected */
    }
  },

  async cancel(runId: string): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      })
    );
  },

  async pause(runId: string): Promise<void> {
    await jsonOrThrow<PauseRunResponse>(
      await request(`/api/runs/${encodeURIComponent(runId)}/pause`, {
        method: "POST",
      })
    );
  },

  async resume(runId: string, note?: string): Promise<void> {
    const body: ResumeRunRequest = note !== undefined ? { note } : {};
    await jsonOrThrow<ResumeRunResponse>(
      await request(`/api/runs/${encodeURIComponent(runId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  },

  async updateRun(runId: string, patch: UpdateRunRequest): Promise<Run> {
    const data = await jsonOrThrow<{ run: Run }>(
      await request(`/api/runs/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
    );
    return data.run;
  },

  async promoteRunToChat(runId: string): Promise<ChatSession> {
    const data = await jsonOrThrow<{ chat: ChatSession }>(
      await request(`/api/runs/${encodeURIComponent(runId)}/promote-to-chat`, {
        method: "POST",
      })
    );
    return data.chat;
  },

  async listWorkspaceChats(workspaceId: string): Promise<ChatSession[]> {
    const data = await jsonOrThrow<{ chats: ChatSession[] }>(
      await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/chats`)
    );
    return data.chats;
  },

  async listArchivedWorkspaceChats(workspaceId: string): Promise<ChatSession[]> {
    const data = await jsonOrThrow<{ chats: ChatSession[] }>(
      await request(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/chats?archived=true`
      )
    );
    return data.chats;
  },

  async getWorkspaceChatDefaults(workspaceId: string): Promise<WorkspaceChatDefaults> {
    const data = await jsonOrThrow<{ defaults: WorkspaceChatDefaults }>(
      await request(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/chat-defaults`
      )
    );
    return data.defaults;
  },

  async updateWorkspaceChatDefaults(
    workspaceId: string,
    patch: UpdateWorkspaceChatDefaultsRequest
  ): Promise<WorkspaceChatDefaults> {
    const data = await jsonOrThrow<{ defaults: WorkspaceChatDefaults }>(
      await request(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/chat-defaults`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }
      )
    );
    return data.defaults;
  },

  async getNotifySettings(): Promise<NotifySettingsPublic> {
    return jsonOrThrow<NotifySettingsPublic>(
      await request("/api/settings/notify")
    );
  },

  async updateNotifySettings(
    patch: UpdateNotifySettingsInput
  ): Promise<NotifySettingsPublic> {
    return jsonOrThrow<NotifySettingsPublic>(
      await request("/api/settings/notify", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
    );
  },

  async testNotifySettings(): Promise<
    { ok: true } | { ok: false; error: string }
  > {
    const res = await request("/api/settings/notify/test", { method: "POST" });
    if (res.ok) {
      return { ok: true };
    }
    try {
      const body = (await res.json()) as { error?: string; ok?: boolean };
      if (typeof body.error === "string" && body.error.length > 0) {
        return { ok: false, error: body.error };
      }
    } catch {
      /* ignore */
    }
    return { ok: false, error: `${res.status} ${res.statusText}` };
  },

  async createChat(
    workspaceId: string,
    title?: string,
    modelSelection?: ModelSelection | null
  ): Promise<ChatSession> {
    const body: CreateChatRequest = {};
    if (title) body.title = title;
    if (modelSelection != null) body.modelSelection = modelSelection;
    const data = await jsonOrThrow<{ chat: ChatSession }>(
      await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    return data.chat;
  },

  async getChat(chatId: string): Promise<ChatSnapshot> {
    return jsonOrThrow<ChatSnapshot>(
      await request(`/api/chats/${encodeURIComponent(chatId)}`)
    );
  },

  async sendChatMessage(
    chatId: string,
    message: string,
    attachments?: AttachmentRef[]
  ): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/chats/${encodeURIComponent(chatId)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, attachments }),
      })
    );
  },

  async queueChatMessage(
    chatId: string,
    message: string,
    attachments?: AttachmentRef[]
  ): Promise<string | undefined> {
    const data = await jsonOrThrow<{ ok: true; queuedMessageId?: string }>(
      await request(`/api/chats/${encodeURIComponent(chatId)}/queue-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, attachments }),
      })
    );
    return data.queuedMessageId;
  },

  async interruptChat(
    chatId: string,
    message: string,
    attachments?: AttachmentRef[]
  ): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/chats/${encodeURIComponent(chatId)}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, attachments }),
      })
    );
  },

  async cancelChat(chatId: string): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/chats/${encodeURIComponent(chatId)}/cancel`, {
        method: "POST",
      })
    );
  },

  async uploadChatAttachment(chatId: string, file: File): Promise<Attachment> {
    const contentBase64 = await fileToBase64(file);
    const data = await jsonOrThrow<UploadAttachmentResponse>(
      await request(`/api/chats/${encodeURIComponent(chatId)}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mimeType: resolveAttachmentMimeType(file),
          contentBase64,
        }),
      })
    );
    return data.attachment;
  },

  chatAttachmentUrl(chatId: string, attachmentId: string): string {
    return `/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(
      attachmentId
    )}`;
  },

  async answerChat(chatId: string, answer: string): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/chats/${encodeURIComponent(chatId)}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      })
    );
  },

  async updateChat(chatId: string, patch: UpdateChatRequest): Promise<ChatSession> {
    const data = await jsonOrThrow<{ chat: ChatSession }>(
      await request(`/api/chats/${encodeURIComponent(chatId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
    );
    return data.chat;
  },

  async steerChat(
    chatId: string,
    message: string,
    runId?: string
  ): Promise<SteerChatResponse> {
    const body: SteerChatRequest = { message, ...(runId ? { runId } : {}) };
    return jsonOrThrow<SteerChatResponse>(
      await request(`/api/chats/${encodeURIComponent(chatId)}/steer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  },

  async deleteChat(chatId: string): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/chats/${encodeURIComponent(chatId)}`, {
        method: "DELETE",
      })
    );
  },

  async createAutomation(input: CreateAutomationRequest): Promise<Automation> {
    const data = await jsonOrThrow<AutomationMutationResponse>(
      await request("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
    );
    return data.automation;
  },

  async updateAutomation(
    id: string,
    patch: UpdateAutomationRequest
  ): Promise<Automation> {
    const data = await jsonOrThrow<AutomationMutationResponse>(
      await request(`/api/automations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
    );
    return data.automation;
  },

  async deleteAutomation(id: string): Promise<void> {
    await jsonOrThrow<{ ok: true }>(
      await request(`/api/automations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
    );
  },

  async deleteRuns(runIds: string[]): Promise<DeleteRunsResponse> {
    return jsonOrThrow<DeleteRunsResponse>(
      await request("/api/runs/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runIds }),
      })
    );
  },
};

export type {
  Automation,
  ChatSession,
  ChatSnapshot,
  InputRequest,
  Run,
  RunEvent,
  Workspace,
  WorkspaceArtifact,
};
