import WebSocket from "ws";
import {
  ACTOR_ID_HEADER,
  sanitizeActorId,
  IMPLEMENT_FULLY_PIPELINE_ID,
  type Automation,
  type ChatSession,
  type ChatSnapshot,
  type DaemonStatus,
  type UpdateSnapshot,
  type EnqueueFeatureRequest,
  type FeatureQueueEntry,
  type InputRequestMetadata,
  type InterruptRunResponse,
  type PauseRunResponse,
  type ListChatsResponse,
  type PipelineIntrospectionResponse,
  type ProvisionPipelineWorkersRequest,
  type ProvisionPipelineWorkersResponse,
  type QueueRunMessageResponse,
  type ResumeRunResponse,
  type ResolveImplementFullyKickoffRequest,
  type ResolveImplementFullyKickoffResponse,
  type GetWorkspaceRoadmapFixPlanResponse,
  type RoadmapReadinessReport,
  type RoadmapReadinessSummariesResponse,
  type Run,
  type RunEscalationRequest,
  type RunEscalationResponse,
  type PipelineWaveControlRequest,
  type PipelineWaveControlResponse,
  type PipelineWaveOperatorRequest,
  type PipelineWaveOperatorResponse,
  type PipelineDirectiveAppendRequest,
  type PipelineDirectiveAppendResponse,
  type PipelineFeedResponse,
  type PipelineSnapshot,
  type PipelineStopAfterStepResponse,
  type RunPipelineTrackDoctorDetail,
  type RunPipelineTrackSummary,
  type RunPipelineWaveDoctorDetail,
  type RunPipelineWaveSummary,
  type SendRunMessageResponse,
  type CreateWorkspaceRequest,
  type TriggerRunRequest,
  type Workspace,
  type WorkspaceMutationResponse,
  type WsServerMessage,
} from "@lca/shared";
import { readControlToken } from "./remote.js";

/** Resolve the control token from env (override) or persisted config. */
function controlToken(): string | undefined {
  return process.env.LCA_CONTROL_TOKEN?.trim() || readControlToken();
}

const CONTROL_TOKEN_HEADER = "X-LCA-Control-Token";

function actorRequestHeaders(): Record<string, string> {
  const raw = process.env.LCA_ACTOR?.trim();
  if (!raw) return {};
  const actorId = sanitizeActorId(raw);
  return actorId ? { [ACTOR_ID_HEADER]: actorId } : {};
}

export type RunSnapshot = {
  run: {
    id: string;
    status: Run["status"];
    automation_id: string;
    workspace_id: string;
    trigger_kind: string | null;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
    /** Present on engine snapshots for chained / pipeline runs (snake_case). */
    parent_run_id?: string | null;
    chain_root_run_id?: string | null;
    chain_depth?: number | null;
    chain_max_depth?: number | null;
    chain_max_depth_override?: number | null;
    chain_context_json?: string | null;
    chain_stop_requested_at?: string | null;
    chain_stop_reason?: string | null;
    chain_handled_at?: string | null;
    pipeline_wave_id?: string | null;
    pipeline_track_id?: string | null;
  };
  events: Array<{ seq: number; event_type: string; payload: string }>;
  inputRequests: Array<{
    id: string;
    runId: string;
    question: string;
    answer: string | null;
    status: string;
    createdAt: string;
    answeredAt: string | null;
    /** Absent/null when the request is free-form or historical. */
    metadata?: InputRequestMetadata | null;
  }>;
  /** Board-safe summaries from the dashboard read surface (detail GET only). */
  pipelineWave?: RunPipelineWaveSummary | null;
  pipelineTrack?: RunPipelineTrackSummary | null;
  /** Doctor/detail fields — branch, commits, blocked detail (detail GET only). */
  pipelineWaveDetail?: RunPipelineWaveDoctorDetail | null;
  pipelineTrackDetail?: RunPipelineTrackDoctorDetail | null;
};

/** Resolve the daemon base URL from env (LCA_DAEMON_URL or LCA_PORT). */
export function daemonBaseUrl(): string {
  const explicit = process.env.LCA_DAEMON_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const port = process.env.LCA_PORT?.trim() || "3747";
  return `http://127.0.0.1:${port}`;
}

export class DaemonError extends Error {}

/**
 * Provisioning returned 409 with a usable plan (conflicts are fatal; the body
 * is the pipeline response, not `{ error }`).
 */
export class ProvisionConflictError extends DaemonError {
  readonly response: ProvisionPipelineWorkersResponse;

  constructor(response: ProvisionPipelineWorkersResponse) {
    const conflicts = response.plan.items.filter((i) => i.action === "conflict");
    const names = conflicts.map((i) => i.key).join(", ") || "unknown worker";
    super(
      `Provisioning conflict for pipeline worker(s): ${names}. ` +
        `A non-generated automation already owns that id.`
    );
    this.name = "ProvisionConflictError";
    this.response = response;
  }
}

/**
 * Exact workspace match by id, name, or path tail — no id prefix matching.
 */
export async function resolveExactWorkspaceTarget(
  client: DaemonClient,
  query: string
): Promise<string | null> {
  const workspaces = await client.listWorkspaces();
  const byId = workspaces.find((w) => w.id === query);
  if (byId) return byId.id;

  const lower = query.toLowerCase();
  const tail = (path: string) =>
    path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const matches = workspaces.filter(
    (w) =>
      (w.name && w.name.toLowerCase() === lower) || tail(w.path) === lower
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new DaemonError(`Ambiguous workspace "${query}". Use the full id.`);
  }
  return null;
}

/**
 * Resolve an optional `--workspace <id|name|path>` flag to a workspace id.
 * Matches an exact id, then a case-insensitive name or path-tail, then a unique
 * id prefix.
 */
export async function resolveWorkspaceId(
  client: DaemonClient,
  query: string
): Promise<string> {
  const workspaces = await client.listWorkspaces();
  const byId = workspaces.find((w) => w.id === query);
  if (byId) return byId.id;

  const lower = query.toLowerCase();
  const tail = (path: string) =>
    path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const matches = workspaces.filter(
    (w) =>
      (w.name && w.name.toLowerCase() === lower) ||
      tail(w.path) === lower ||
      w.id.startsWith(query)
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new DaemonError(`Ambiguous workspace "${query}". Use the full id.`);
  }
  throw new DaemonError(`No workspace matches "${query}".`);
}

/**
 * Thin REST/WS client over the daemon's localhost API. Mirrors the dashboard's
 * `api.ts` surface so the CLI is just another sink onto the same endpoints.
 */
export class DaemonClient {
  readonly base: string;

  constructor(base: string = daemonBaseUrl()) {
    this.base = base.replace(/\/+$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    const token = controlToken();
    const withToken: RequestInit = {
      ...init,
      headers: {
        ...init?.headers,
        ...actorRequestHeaders(),
        ...(token ? { [CONTROL_TOKEN_HEADER]: token } : {}),
      },
    };
    try {
      res = await fetch(`${this.base}${path}`, withToken);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.cause as
        | NodeJS.ErrnoException
        | undefined;
      if (code?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(err))) {
        throw new DaemonError(
          `Cannot reach the daemon at ${this.base}. Is it running? Start it with: npm run daemon`
        );
      }
      throw new DaemonError(
        `Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: string };
        detail = body.error ? `: ${body.error}` : "";
      } catch {
        /* non-JSON body */
      }
      throw new DaemonError(`${res.status} ${res.statusText}${detail}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    return (await res.json()) as T;
  }

  private postJson<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private actorBody<T extends Record<string, unknown>>(body: T): T {
    const raw = process.env.LCA_ACTOR?.trim();
    if (!raw) return body;
    const actorId = sanitizeActorId(raw);
    return actorId ? { ...body, actorId } : body;
  }

  health(): Promise<{ ok: boolean; version: string }> {
    return this.request("/health");
  }

  status(): Promise<DaemonStatus> {
    return this.request("/api/status");
  }

  checkUpdate(): Promise<UpdateSnapshot & { ok: true }> {
    return this.postJson("/api/update/check");
  }

  async listAutomations(): Promise<Automation[]> {
    const data = await this.request<{ automations: Automation[] }>(
      "/api/automations"
    );
    return data.automations;
  }

  async listRuns(limit = 200): Promise<Run[]> {
    const data = await this.request<{ runs: Run[] }>(
      `/api/runs?limit=${limit}`
    );
    return data.runs;
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const data = await this.request<{ workspaces: Workspace[] }>(
      "/api/workspaces"
    );
    return data.workspaces;
  }

  async createWorkspace(input: CreateWorkspaceRequest): Promise<Workspace> {
    const data = await this.postJson<WorkspaceMutationResponse>(
      "/api/workspaces",
      input
    );
    return data.workspace;
  }

  getRun(runId: string): Promise<RunSnapshot> {
    return this.request<RunSnapshot>(
      `/api/runs/${encodeURIComponent(runId)}`
    );
  }

  /** Hydrated pipeline snapshot for a root run id. */
  async getPipelineSnapshot(rootRunId: string): Promise<PipelineSnapshot> {
    const data = await this.request<{
      rootRunId: string;
      snapshot: PipelineSnapshot;
    }>(`/api/pipeline-runs/${encodeURIComponent(rootRunId)}`);
    return data.snapshot;
  }

  /** Newest implement-fully root for a feature in a workspace. */
  async resolvePipelineSnapshot(
    workspaceId: string,
    featureId: string
  ): Promise<{ rootRunId: string; snapshot: PipelineSnapshot }> {
    const params = new URLSearchParams({
      workspace: workspaceId,
      feature: featureId,
    });
    return this.request<{ rootRunId: string; snapshot: PipelineSnapshot }>(
      `/api/pipeline-runs?${params.toString()}`
    );
  }

  /** Long-poll pipeline lifecycle feed for `max watch`. */
  pollPipelineFeed(
    rootRunId: string,
    since: number,
    waitSeconds: number,
    signal?: AbortSignal
  ): Promise<PipelineFeedResponse> {
    const params = new URLSearchParams({
      since: String(since),
      wait: String(waitSeconds),
    });
    return this.request<PipelineFeedResponse>(
      `/api/pipeline-runs/${encodeURIComponent(rootRunId)}/events?${params.toString()}`,
      { signal }
    );
  }

  appendPipelineDirective(
    rootRunId: string,
    body: PipelineDirectiveAppendRequest
  ): Promise<PipelineDirectiveAppendResponse> {
    return this.postJson<PipelineDirectiveAppendResponse>(
      `/api/pipeline-runs/${encodeURIComponent(rootRunId)}/directives`,
      this.actorBody(body)
    );
  }

  pipelineStopAfterStep(
    rootRunId: string,
    body?: { reason?: string }
  ): Promise<PipelineStopAfterStepResponse> {
    return this.postJson<PipelineStopAfterStepResponse>(
      `/api/pipeline-runs/${encodeURIComponent(rootRunId)}/stop`,
      this.actorBody(body ?? {})
    );
  }

  getChat(chatId: string): Promise<ChatSnapshot> {
    return this.request<ChatSnapshot>(
      `/api/chats/${encodeURIComponent(chatId)}`
    );
  }

  async listWorkspaceChats(workspaceId: string): Promise<ChatSession[]> {
    const data = await this.request<ListChatsResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/chats`
    );
    return data.chats;
  }

  async triggerRun(automationId: string): Promise<string> {
    const data = await this.postJson<{ runId: string }>("/api/runs", {
      automationId,
    });
    return data.runId;
  }

  /** Context-aware kickoff (`variables`, `roleModels`, `maxDepth`, …). */
  async triggerRunWithContext(body: TriggerRunRequest): Promise<string> {
    const data = await this.postJson<{ runId: string }>("/api/runs", body);
    return data.runId;
  }

  getPipeline(
    pipelineId: string,
    workspaceId?: string
  ): Promise<PipelineIntrospectionResponse> {
    const suffix =
      workspaceId != null && workspaceId !== ""
        ? `?workspaceId=${encodeURIComponent(workspaceId)}`
        : "";
    return this.request<PipelineIntrospectionResponse>(
      `/api/pipelines/${encodeURIComponent(pipelineId)}${suffix}`
    );
  }

  getRoadmapReadinessSummaries(): Promise<RoadmapReadinessSummariesResponse> {
    return this.request<RoadmapReadinessSummariesResponse>(
      "/api/roadmap-readiness"
    );
  }

  getWorkspaceRoadmapReadiness(
    workspaceId: string
  ): Promise<RoadmapReadinessReport> {
    return this.request<RoadmapReadinessReport>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmap-readiness`
    );
  }

  getWorkspaceRoadmapFixPlan(
    workspaceId: string
  ): Promise<GetWorkspaceRoadmapFixPlanResponse> {
    return this.request<GetWorkspaceRoadmapFixPlanResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/roadmap-fix-plan`
    );
  }

  /**
   * Resolve thin implement-fully kickoff input to the canonical triple.
   * Does not provision workers or create runs.
   */
  resolveImplementFullyKickoff(
    body: ResolveImplementFullyKickoffRequest
  ): Promise<ResolveImplementFullyKickoffResponse> {
    return this.postJson<ResolveImplementFullyKickoffResponse>(
      `/api/pipelines/${encodeURIComponent(IMPLEMENT_FULLY_PIPELINE_ID)}/resolve`,
      body
    );
  }

  /**
   * Provision a known pipeline's workers. On conflict (409) throws
   * {@link ProvisionConflictError} carrying the response plan.
   */
  async provisionPipelineWorkers(
    pipelineId: string,
    body: ProvisionPipelineWorkersRequest
  ): Promise<ProvisionPipelineWorkersResponse> {
    const path = `/api/pipelines/${encodeURIComponent(pipelineId)}/workers`;
    let res: Response;
    const token = controlToken();
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { [CONTROL_TOKEN_HEADER]: token } : {}),
      },
      body: JSON.stringify(body),
    };
    try {
      res = await fetch(`${this.base}${path}`, init);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.cause as
        | NodeJS.ErrnoException
        | undefined;
      if (code?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(err))) {
        throw new DaemonError(
          `Cannot reach the daemon at ${this.base}. Is it running? Start it with: npm run daemon`
        );
      }
      throw new DaemonError(
        `Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (res.status === 409) {
      let response: ProvisionPipelineWorkersResponse;
      try {
        response = (await res.json()) as ProvisionPipelineWorkersResponse;
      } catch {
        throw new DaemonError("409 Conflict");
      }
      throw new ProvisionConflictError(response);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const errBody = (await res.json()) as { error?: string };
        detail = errBody.error ? `: ${errBody.error}` : "";
      } catch {
        /* non-JSON body */
      }
      throw new DaemonError(`${res.status} ${res.statusText}${detail}`);
    }
    return (await res.json()) as ProvisionPipelineWorkersResponse;
  }

  async setEnabled(automationId: string, enabled: boolean): Promise<Automation> {
    const data = await this.postJson<{ automation: Automation }>(
      `/api/automations/${encodeURIComponent(automationId)}/enabled`,
      { enabled }
    );
    return data.automation;
  }

  async answer(runId: string, answer: string): Promise<void> {
    await this.postJson(
      `/api/runs/${encodeURIComponent(runId)}/answer`,
      this.actorBody({ answer })
    );
  }

  async cancel(runId: string): Promise<void> {
    await this.postJson(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      this.actorBody({})
    );
  }

  /** Operator escalation: retry / skip / abort a halted pipeline run. */
  escalate(
    runId: string,
    body: RunEscalationRequest
  ): Promise<RunEscalationResponse> {
    return this.postJson<RunEscalationResponse>(
      `/api/runs/${encodeURIComponent(runId)}/escalate`,
      this.actorBody(body)
    );
  }

  /** Run-token wave control: fan-out, finalize, or block from an active run. */
  pipelineWave(
    runId: string,
    body: PipelineWaveControlRequest,
    runToken?: string
  ): Promise<PipelineWaveControlResponse> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (runToken?.trim()) {
      headers["x-lca-run-token"] = runToken.trim();
    }
    return this.request<PipelineWaveControlResponse>(
      `/api/runs/${encodeURIComponent(runId)}/pipeline-wave`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }
    );
  }

  /** Operator wave action: retry integration or abort a blocked wave. */
  waveAction(
    waveId: string,
    body: PipelineWaveOperatorRequest
  ): Promise<PipelineWaveOperatorResponse> {
    return this.postJson<PipelineWaveOperatorResponse>(
      `/api/pipeline-waves/${encodeURIComponent(waveId)}/actions`,
      body
    );
  }

  enqueueFeature(body: EnqueueFeatureRequest): Promise<FeatureQueueEntry> {
    return this.postJson<{ entry: FeatureQueueEntry }>(
      "/api/feature-queue",
      body
    ).then((data) => data.entry);
  }

  async listFeatureQueue(workspaceId?: string): Promise<FeatureQueueEntry[]> {
    const query =
      workspaceId != null
        ? `?workspaceId=${encodeURIComponent(workspaceId)}`
        : "";
    const data = await this.request<{ entries: FeatureQueueEntry[] }>(
      `/api/feature-queue${query}`
    );
    return data.entries;
  }

  cancelFeatureQueueEntry(id: string): Promise<FeatureQueueEntry> {
    return this.request<{ entry: FeatureQueueEntry }>(
      `/api/feature-queue/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ).then((data) => data.entry);
  }

  async sendMessage(runId: string, message: string): Promise<void> {
    await this.postJson<SendRunMessageResponse>(
      `/api/runs/${encodeURIComponent(runId)}/message`,
      this.actorBody({ message })
    );
  }

  async queueMessage(runId: string, message: string): Promise<string | undefined> {
    const data = await this.postJson<QueueRunMessageResponse>(
      `/api/runs/${encodeURIComponent(runId)}/queue-message`,
      this.actorBody({ message })
    );
    return data.queuedMessageId;
  }

  async interrupt(runId: string, message: string): Promise<void> {
    await this.postJson<InterruptRunResponse>(
      `/api/runs/${encodeURIComponent(runId)}/interrupt`,
      this.actorBody({ message })
    );
  }

  async pause(runId: string): Promise<void> {
    await this.postJson<PauseRunResponse>(
      `/api/runs/${encodeURIComponent(runId)}/pause`,
      this.actorBody({})
    );
  }

  async resume(runId: string, note?: string): Promise<void> {
    await this.postJson<ResumeRunResponse>(
      `/api/runs/${encodeURIComponent(runId)}/resume`,
      this.actorBody(note !== undefined ? { note } : {})
    );
  }

  /** Ask the daemon to run its graceful teardown and exit. */
  async shutdown(): Promise<void> {
    await this.postJson("/api/shutdown");
  }

  /** Fetch the raw run-history export (CSV or JSON text). */
  async exportRuns(
    format: "json" | "csv",
    workspaceId?: string
  ): Promise<string> {
    const params = new URLSearchParams({ format });
    if (workspaceId) {
      params.set("workspaceId", workspaceId);
    }
    const token = controlToken();
    const init: RequestInit | undefined = token
      ? { headers: { [CONTROL_TOKEN_HEADER]: token } }
      : undefined;
    let res: Response;
    try {
      res = await fetch(
        `${this.base}/api/runs/export?${params.toString()}`,
        init
      );
    } catch (err) {
      if (/ECONNREFUSED/.test(String(err))) {
        throw new DaemonError(
          `Cannot reach the daemon at ${this.base}. Is it running? Start it with: npm run daemon`
        );
      }
      throw new DaemonError(
        `Export request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      throw new DaemonError(`${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  /**
   * Open the live event stream. Returns the socket plus a promise that resolves
   * once it is open (rejects on connection failure).
   */
  connect(onMessage: (msg: WsServerMessage) => void): {
    socket: WebSocket;
    opened: Promise<void>;
  } {
    const token = controlToken();
    const wsUrl =
      `${this.base.replace(/^http/, "ws")}/ws` +
      (token ? `?token=${encodeURIComponent(token)}` : "");
    const socket = new WebSocket(wsUrl);
    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (err) =>
        reject(
          new DaemonError(
            `Cannot open event stream at ${wsUrl}: ${err.message}`
          )
        )
      );
    });
    socket.on("message", (raw) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as WsServerMessage;
      } catch {
        return;
      }
      onMessage(msg);
    });
    return { socket, opened };
  }
}
