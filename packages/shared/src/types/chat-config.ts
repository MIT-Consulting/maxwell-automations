import type { ModelSelection } from "../model.js";

export type McpOverlay = {
  /** server-name → MCP server config (validated loosely in shared; daemon treats as McpServerConfig) */
  extra?: Record<string, unknown>;
  /** filesystem/global server names to remove for this workspace's chats */
  disable?: string[];
};

export type WorkspaceChatDefaults = {
  workspaceId: string;
  model: string | null;
  modelSelection: ModelSelection | null;
  systemPrompt: string | null;
  mcp: McpOverlay;
};

/** REST PATCH body — every field optional; omitted field = leave as-is, explicit null = clear */
export type UpdateWorkspaceChatDefaultsRequest = {
  model?: string | null;
  modelSelection?: ModelSelection | null;
  systemPrompt?: string | null;
  mcp?: McpOverlay;
};
