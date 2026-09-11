import type { McpServerConfig, RunResult, SDKMessage } from "@cursor/sdk";
import type { ModelSelection, RunStatus } from "@lca/shared";

export type ExecutorKind = "sdk-local" | "cli-headless";

/** Tool names the reserved automations-io MCP bridge may expose for a run. */
export type AutomationsIoToolName =
  | "ask_user"
  | "chain_control"
  | "pipeline_wave";

export type SpawnParams = {
  apiKey: string;
  cwd: string;
  model: ModelSelection;
  /** Initial user turn: plain text, or structured text + attachments. */
  prompt: string | OperatorMessage;
  runId: string;
  /** Per-run secret passed to the run's MCP child and required on `/ask`. */
  runToken?: string;
  mcpExtra?: Record<string, McpServerConfig>;
  mcpDisable?: string[];
  /**
   * Optional allowlist for the reserved automations-io bridge. Omitted means
   * all current tools (backward compatible). Halt-discovery passes only
   * `ask_user`.
   */
  automationsIoTools?: readonly AutomationsIoToolName[];
};

export type ResumeParams = SpawnParams & {
  agentId: string;
  sdkRunId: string;
};

export type OperatorAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "file";
  storagePath: string;
};

export type OperatorMessage = {
  text: string;
  attachments?: OperatorAttachment[];
};

export function normalizeOperatorMessage(
  message: string | OperatorMessage,
): OperatorMessage {
  if (typeof message === "string") {
    return { text: message };
  }
  return {
    text: message.text,
    ...(message.attachments && message.attachments.length > 0
      ? { attachments: message.attachments }
      : {}),
  };
}

export function addWorkspaceContext(
  message: string | OperatorMessage,
  cwd: string,
): OperatorMessage {
  const normalized = normalizeOperatorMessage(message);
  return {
    ...normalized,
    text: [
      `Workspace root: ${cwd}`,
      "Run repository commands from this workspace. Pass this path as the shell working directory; do not rely on the shell default.",
      "",
      normalized.text,
    ].join("\n"),
  };
}

export type ActiveRun = {
  kind: ExecutorKind;
  agentId: string;
  sdkRunId: string;
  stream(): AsyncGenerator<SDKMessage, void>;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
  /** Deliver an operator answer / follow-up (text or structured attachments). */
  sendFollowUp?(
    message: string | OperatorMessage,
    model: ModelSelection,
  ): Promise<ActiveRun>;
};

export interface Executor {
  readonly kind: ExecutorKind;
  spawn(params: SpawnParams): Promise<ActiveRun>;
  resume(params: ResumeParams): Promise<ActiveRun>;
}

export type TerminalRunStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled"
>;

export function mapSdkResultStatus(
  status: RunResult["status"],
): TerminalRunStatus {
  switch (status) {
    case "finished":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}
