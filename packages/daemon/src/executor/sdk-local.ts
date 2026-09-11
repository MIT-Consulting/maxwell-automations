import { Agent } from "@cursor/sdk";
import type { McpServerConfig, SDKAgent, SDKMessage } from "@cursor/sdk";
import type { ModelSelection } from "@lca/shared";
import { buildRunMcpServers } from "../mcp/config.js";
import { toSdkSendInput } from "./operator-message.js";
import { addWorkspaceContext } from "./types.js";
import type {
  ActiveRun,
  Executor,
  OperatorMessage,
  ResumeParams,
  SpawnParams,
} from "./types.js";

function isNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found/i.test(message);
}

function wrapAgentRun(
  agent: SDKAgent,
  sdkRun: Awaited<ReturnType<SDKAgent["send"]>>,
  mcpServers: Record<string, McpServerConfig>,
): ActiveRun {
  return {
    kind: "sdk-local",
    agentId: agent.agentId,
    sdkRunId: sdkRun.id,
    stream: () => sdkRun.stream(),
    wait: () => sdkRun.wait(),
    cancel: async () => {
      if (sdkRun.supports("cancel")) {
        await sdkRun.cancel();
      }
    },
    dispose: async () => {
      await agent[Symbol.asyncDispose]();
    },
    sendFollowUp: async (
      message: string | OperatorMessage,
      model: ModelSelection,
    ) => {
      const followUp = await agent.send(toSdkSendInput(message), {
        mcpServers,
        model,
        local: { force: true },
      });
      return wrapAgentRun(agent, followUp, mcpServers);
    },
  };
}

/**
 * Agent.resume succeeded but the prior SDK run record is gone (typical after a
 * daemon restart). Conversation context lives on the agent; follow-ups mint a
 * new run via sendFollowUp.
 */
function wrapResumedAgentOnly(
  agent: SDKAgent,
  sdkRunId: string,
  mcpServers: Record<string, McpServerConfig>,
): ActiveRun {
  return {
    kind: "sdk-local",
    agentId: agent.agentId,
    sdkRunId,
    stream: async function* () {},
    wait: async () =>
      ({ status: "finished", id: sdkRunId, result: undefined }) as Awaited<
        ReturnType<ActiveRun["wait"]>
      >,
    cancel: async () => undefined,
    dispose: async () => {
      await agent[Symbol.asyncDispose]();
    },
    sendFollowUp: async (
      message: string | OperatorMessage,
      model: ModelSelection,
    ) => {
      const followUp = await agent.send(toSdkSendInput(message), {
        mcpServers,
        model,
        local: { force: true },
      });
      return wrapAgentRun(agent, followUp, mcpServers);
    },
  };
}

export class SdkLocalExecutor implements Executor {
  readonly kind = "sdk-local" as const;

  async spawn(params: SpawnParams): Promise<ActiveRun> {
    const mcpServers = buildRunMcpServers(params.runId, params.cwd, {
      runToken: params.runToken,
      mcpExtra: params.mcpExtra,
      mcpDisable: params.mcpDisable,
      automationsIoTools: params.automationsIoTools,
    });
    const agent = await Agent.create({
      apiKey: params.apiKey,
      model: params.model,
      local: {
        cwd: params.cwd,
        settingSources: ["all"],
      },
      mcpServers,
    });

    const sdkRun = await agent.send(
      toSdkSendInput(addWorkspaceContext(params.prompt, params.cwd)),
      {
        mcpServers,
        model: params.model,
      },
    );
    return wrapAgentRun(agent, sdkRun, mcpServers);
  }

  async resume(params: ResumeParams): Promise<ActiveRun> {
    const mcpServers = buildRunMcpServers(params.runId, params.cwd, {
      runToken: params.runToken,
      mcpExtra: params.mcpExtra,
      mcpDisable: params.mcpDisable,
      automationsIoTools: params.automationsIoTools,
    });
    const agent = await Agent.resume(params.agentId, {
      apiKey: params.apiKey,
      model: params.model,
      local: {
        cwd: params.cwd,
        settingSources: ["all"],
      },
      mcpServers,
    });

    try {
      const sdkRun = await Agent.getRun(params.sdkRunId, {
        runtime: "local",
        cwd: params.cwd,
      });
      return wrapAgentRun(agent, sdkRun, mcpServers);
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
      return wrapResumedAgentOnly(agent, params.sdkRunId, mcpServers);
    }
  }
}

export function extractRunIdFromMessage(message: SDKMessage): string | null {
  if ("run_id" in message && typeof message.run_id === "string") {
    return message.run_id;
  }
  return null;
}

/** Stream sentinel fallback: `NEEDS_INPUT: <question>` */
export function extractNeedsInputFromMessage(
  message: SDKMessage,
): string | null {
  if (message.type !== "assistant") {
    return null;
  }
  const parts: string[] = [];
  for (const block of message.message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  const text = parts.join("");
  const match = text.match(/NEEDS_INPUT:\s*(.+)/s);
  return match?.[1]?.trim() ?? null;
}
