import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Agent, request } from "undici";
import { z } from "zod";
import type {
  ChainControlResponse,
  InputRequestMetadata,
  PipelineWaveControlRequest,
  PipelineWaveControlResponse,
} from "@lca/shared";
import {
  askRunInputSchema,
  pipelineWaveControlSchema,
} from "@lca/shared";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:3747";

/** Exact tool names registered by the automations-io MCP server. */
export const AUTOMATIONS_IO_TOOL_NAMES = [
  "ask_user",
  "chain_control",
  "pipeline_wave",
] as const;

export type AutomationsIoToolName = (typeof AUTOMATIONS_IO_TOOL_NAMES)[number];

const AUTOMATIONS_IO_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  AUTOMATIONS_IO_TOOL_NAMES
);

/**
 * Parse `LCA_AUTOMATIONS_IO_TOOLS` (comma-separated allowlist). Missing or blank
 * means all current tools. Unknown non-empty names fail closed.
 */
export function parseAutomationsIoToolsAllowlist(
  raw: string | undefined
): ReadonlySet<AutomationsIoToolName> {
  if (raw === undefined || raw.trim() === "") {
    return new Set(AUTOMATIONS_IO_TOOL_NAMES);
  }
  const names = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // Separator-only values are blank configuration, not an empty capability set.
  if (names.length === 0) {
    return new Set(AUTOMATIONS_IO_TOOL_NAMES);
  }
  const allowed = new Set<AutomationsIoToolName>();
  for (const name of names) {
    if (!AUTOMATIONS_IO_TOOL_NAME_SET.has(name)) {
      throw new Error(
        `Unknown automations-io tool in LCA_AUTOMATIONS_IO_TOOLS: ${name}`
      );
    }
    allowed.add(name as AutomationsIoToolName);
  }
  return allowed;
}

// `ask_user` blocks until a human answers, which can take far longer than
// undici's default 5-minute headers/body timeouts. This dispatcher disables
// those so a long human wait is never aborted client-side.
const noTimeoutDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
});

function daemonUrl(): string {
  return process.env.LCA_DAEMON_URL?.trim() || DEFAULT_DAEMON_URL;
}

function runId(): string {
  const id = process.env.LCA_RUN_ID?.trim();
  if (!id) {
    throw new Error("LCA_RUN_ID is required for automations-io MCP server");
  }
  return id;
}

function runTokenHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Per-run token proves this call came from the run's own spawned MCP child.
  const token = process.env.LCA_RUN_TOKEN?.trim();
  if (token) {
    headers["x-lca-run-token"] = token;
  }
  return headers;
}

// Exported for the regression test that guards the undici dispatcher path; not
// part of the package's public surface.
export async function askDaemon(
  question: string,
  metadata?: InputRequestMetadata
): Promise<string> {
  const id = runId();
  const url = `${daemonUrl()}/api/runs/${encodeURIComponent(id)}/ask`;
  const askBody = askRunInputSchema.parse(
    metadata !== undefined ? { question, metadata } : { question }
  );
  // Use undici's own `request` rather than the global `fetch`: the long-lived
  // no-timeout dispatcher is an undici Agent from this package, and Node's
  // built-in `fetch` is backed by a *different* bundled undici version. Handing
  // a cross-version dispatcher to global `fetch` throws
  // `UND_ERR_INVALID_ARG: invalid onRequestStart method`, which surfaced here as
  // a bare "fetch failed" and silently broke every ask_user call.
  const { statusCode, body } = await request(url, {
    method: "POST",
    headers: runTokenHeaders(),
    body: JSON.stringify(askBody),
    dispatcher: noTimeoutDispatcher,
  });
  if (statusCode < 200 || statusCode >= 300) {
    const text = await body.text();
    throw new Error(`daemon ask failed (${statusCode}): ${text}`);
  }
  const json = (await body.json()) as { answer?: string };
  if (!json.answer) {
    throw new Error("daemon ask returned no answer");
  }
  return json.answer;
}

export type ChainControlToolInput = {
  stop?: boolean;
  reason?: string;
  maxDepth?: number;
  /** Monotonic additive growth in transitions (mutually exclusive with maxDepth). */
  extendBy?: number;
};

/**
 * Agent-facing chain stop / re-budget / additive extension. Exported for tests;
 * the MCP tool wraps this. Uses undici's default dispatcher (control returns
 * immediately — never the ask_user no-timeout agent).
 */
export async function chainControlDaemon(
  input: ChainControlToolInput
): Promise<ChainControlResponse> {
  const stop = input.stop === true;
  const reason = input.reason?.trim();
  const maxDepth = input.maxDepth;
  const extendBy = input.extendBy;

  if (!stop && maxDepth === undefined && extendBy === undefined) {
    throw new Error(
      "chain_control requires stop, maxDepth, and/or extendBy"
    );
  }
  if (stop && !reason) {
    throw new Error("chain_control stop requires a non-empty reason");
  }
  if (maxDepth !== undefined && extendBy !== undefined) {
    throw new Error(
      "chain_control maxDepth and extendBy are mutually exclusive"
    );
  }
  if (
    extendBy !== undefined &&
    (!Number.isInteger(extendBy) || extendBy < 1)
  ) {
    throw new Error("chain_control extendBy must be a positive integer");
  }

  const wire: {
    stop?: { reason: string };
    rebudget?: { maxDepth: number };
    extendBudget?: { transitions: number };
  } = {};
  if (stop) {
    wire.stop = { reason: reason! };
  }
  if (maxDepth !== undefined) {
    wire.rebudget = { maxDepth };
  }
  if (extendBy !== undefined) {
    wire.extendBudget = { transitions: extendBy };
  }

  const id = runId();
  const url = `${daemonUrl()}/api/runs/${encodeURIComponent(id)}/chain-control`;
  const { statusCode, body } = await request(url, {
    method: "POST",
    headers: runTokenHeaders(),
    body: JSON.stringify(wire),
  });
  if (statusCode < 200 || statusCode >= 300) {
    const text = await body.text();
    throw new Error(`daemon chain_control failed (${statusCode}): ${text}`);
  }
  return (await body.json()) as ChainControlResponse;
}

export type PipelineWaveToolInput = {
  action: "fan-out" | "finalize" | "block";
  candidates?: Array<{ phaseRef: string; phaseFile: string }>;
  reason?: string;
};

/**
 * Agent-facing parallel wave fan-out / finalize / block. Exported for tests; the
 * MCP tool wraps this.
 */
export async function pipelineWaveDaemon(
  input: PipelineWaveToolInput
): Promise<PipelineWaveControlResponse> {
  let wire: PipelineWaveControlRequest;
  if (input.action === "fan-out") {
    if (!input.candidates || input.candidates.length === 0) {
      throw new Error("pipeline_wave fan-out requires candidates");
    }
    wire = { action: "fan-out", candidates: input.candidates };
  } else if (input.action === "finalize") {
    wire = { action: "finalize" };
  } else {
    const reason = input.reason?.trim();
    if (!reason) {
      throw new Error("pipeline_wave block requires a non-empty reason");
    }
    wire = { action: "block", reason };
  }

  const validated = pipelineWaveControlSchema.safeParse(wire);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new Error(`pipeline_wave validation failed: ${issues}`);
  }

  const id = runId();
  const url = `${daemonUrl()}/api/runs/${encodeURIComponent(id)}/pipeline-wave`;
  const { statusCode, body } = await request(url, {
    method: "POST",
    headers: runTokenHeaders(),
    body: JSON.stringify(validated.data),
  });
  if (statusCode < 200 || statusCode >= 300) {
    const text = await body.text();
    throw new Error(`daemon pipeline_wave failed (${statusCode}): ${text}`);
  }
  return (await body.json()) as PipelineWaveControlResponse;
}

function summarizePipelineWave(response: PipelineWaveControlResponse): string {
  if ("outcome" in response) {
    const parts = [
      `${response.outcome} (${response.reason})`,
      `accepted ${response.accepted.length}`,
      `deferred ${response.deferred.length}`,
    ];
    if (response.waveId) {
      parts.push(`waveId ${response.waveId.slice(0, 8)}`);
    }
    return `pipeline wave: ${parts.join("; ")}`;
  }
  return `pipeline wave ${response.action}: wave ${response.waveId.slice(0, 8)} → ${response.status}`;
}

function summarizeChainControl(response: ChainControlResponse): string {
  const parts: string[] = [];
  if (response.stopRequested) {
    parts.push(
      response.stopReason
        ? `stop recorded (${response.stopReason})`
        : "stop recorded"
    );
  }
  if (response.budgetExtension) {
    const ext = response.budgetExtension;
    parts.push(
      `extended budget by ${ext.appliedTransitions} of ${ext.requestedTransitions} requested` +
        ` (was ${ext.previousEffectiveMaxDepth}, now ${response.effectiveMaxDepth ?? "n/a"})` +
        (ext.clamped ? "; clamped at daemon max" : "")
    );
  } else if (response.effectiveMaxDepth != null) {
    parts.push(
      `descendants inherit budget ${response.effectiveMaxDepth}` +
        (response.maxDepthOverride != null
          ? ` (override; original ${response.maxDepth ?? "n/a"})`
          : "")
    );
  }
  if (parts.length === 0) {
    return "chain control accepted (no stop or budget change visible)";
  }
  return `chain control: ${parts.join("; ")}`;
}

export async function startAutomationsIoServer(): Promise<void> {
  const allowedTools = parseAutomationsIoToolsAllowlist(
    process.env.LCA_AUTOMATIONS_IO_TOOLS
  );

  const server = new McpServer({
    name: "automations-io",
    version: "0.0.1",
  });

  if (allowedTools.has("ask_user")) {
    server.registerTool(
      "ask_user",
      {
        description:
          "Ask the operator a question and block until they answer. Use when you need a decision or missing information. Optional metadata may declare named choices (the answer is the selected choice id), a recommendation, and workspace-relative artifact paths for the operator UI.",
        inputSchema: {
          question: z.string().min(1).describe("Question to show the operator"),
          metadata: z
            .object({
              kind: z
                .string()
                .min(1)
                .describe("Bounded kind label for this structured request"),
              choices: z
                .array(
                  z.object({
                    id: z
                      .string()
                      .min(1)
                      .describe("Stable choice id returned as the answer"),
                    label: z.string().min(1).describe("Operator-facing label"),
                    description: z
                      .string()
                      .min(1)
                      .optional()
                      .describe("Optional short description"),
                  })
                )
                .min(1)
                .optional()
                .describe("Named choices; answer is the selected id"),
              recommendedChoiceId: z
                .string()
                .min(1)
                .optional()
                .describe("Id of the recommended choice when choices are set"),
              artifacts: z
                .array(
                  z.object({
                    label: z.string().min(1).describe("Link label"),
                    path: z
                      .string()
                      .min(1)
                      .describe(
                        "Forward-slash workspace-relative path (never absolute)"
                      ),
                  })
                )
                .min(1)
                .optional()
                .describe("Workspace-relative artifact links for the operator"),
            })
            .optional()
            .describe("Optional structured request metadata"),
        },
      },
      async ({ question, metadata }) => {
        try {
          const parsed = askRunInputSchema.parse(
            metadata !== undefined ? { question, metadata } : { question }
          );
          const answer = await askDaemon(parsed.question, parsed.metadata);
          return {
            content: [{ type: "text" as const, text: answer }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [
              { type: "text" as const, text: `ask_user failed: ${message}` },
            ],
          };
        }
      }
    );
  }

  if (allowedTools.has("chain_control")) {
    server.registerTool(
      "chain_control",
      {
        description:
          "End this pipeline when no runnable work remains, or adjust the remaining transition budget. Affects this run's successor only — never edits an automation. Use stop:true with a reason to prevent chaining; use maxDepth for an absolute rebudget; use extendBy for monotonic additive growth from the current effective ceiling (mutually exclusive with maxDepth).",
        inputSchema: {
          stop: z
            .boolean()
            .optional()
            .describe("When true, prevent this run from enqueueing a successor"),
          reason: z
            .string()
            .optional()
            .describe("Required when stop is true — why the pipeline is ending"),
          maxDepth: z
            .number()
            .int()
            .optional()
            .describe(
              "Absolute transition budget from this run forward; descendants inherit it. Mutually exclusive with extendBy."
            ),
          extendBy: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Add this many transitions to the current effective ceiling (monotonic; clamped at the daemon max). Mutually exclusive with maxDepth."
            ),
        },
      },
      async ({ stop, reason, maxDepth, extendBy }) => {
        try {
          const response = await chainControlDaemon({
            stop,
            reason,
            maxDepth,
            extendBy,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: summarizeChainControl(response),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `chain_control failed: ${message}`,
              },
            ],
          };
        }
      }
    );
  }

  if (allowedTools.has("pipeline_wave")) {
    server.registerTool(
      "pipeline_wave",
      {
        description:
          "Control a parallel implement-fully wave from the active coordinator or integration run. Use fan-out with dependency-ready phase candidates, finalize after integration merges all tracks, or block when merge/integration cannot proceed safely.",
        inputSchema: {
          action: z
            .enum(["fan-out", "finalize", "block"])
            .describe(
              "fan-out: start parallel tracks; finalize: mark wave merged; block: halt integration"
            ),
          candidates: z
            .array(
              z.object({
                phaseRef: z
                  .string()
                  .min(1)
                  .describe("Phase ref from tracker (≤ 64 chars)"),
                phaseFile: z
                  .string()
                  .min(1)
                  .describe("Forward-slash relative .md path under featureDir"),
              })
            )
            .optional()
            .describe("Required for fan-out — 2–64 unique phase candidates"),
          reason: z
            .string()
            .optional()
            .describe("Required for block — why the wave is blocked"),
        },
      },
      async ({ action, candidates, reason }) => {
        try {
          const response = await pipelineWaveDaemon({
            action,
            candidates,
            reason,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: summarizePipelineWave(response),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `pipeline_wave failed: ${message}`,
              },
            ],
          };
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[automations-io] ready (run=${process.env.LCA_RUN_ID ?? "?"})`
  );
}
