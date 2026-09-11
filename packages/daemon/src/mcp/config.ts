import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@cursor/sdk";
import type { AutomationsIoToolName } from "../executor/types.js";

const require = createRequire(import.meta.url);

const AUTOMATIONS_IO_ENTRY = join(
  dirname(require.resolve("@lca/automations-io/package.json")),
  "dist/index.js"
);

const DEFAULT_PORT = 3747;

/**
 * Reserved server name owned by the daemon. Workspace config can never shadow
 * it — the run's input/output bridge must always be the one we spawn.
 */
const RESERVED_SERVER_NAME = "automations-io";

/**
 * Resolve Cursor's `${env:VAR}` placeholders from the daemon's environment.
 * The Cursor app does this from the user's shell; the SDK does not touch inline
 * server config, so we substitute here before handing servers to the agent.
 * Unknown references are left intact rather than blanked, so a missing var is a
 * visible misconfiguration instead of a silently empty value.
 */
function substituteEnvPlaceholders(value: string): string {
  return value.replace(/\$\{env:([^}]+)\}/g, (whole, name: string) => {
    const resolved = process.env[name];
    return resolved !== undefined ? resolved : whole;
  });
}

function substituteDeep<T>(value: T): T {
  if (typeof value === "string") {
    return substituteEnvPlaceholders(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteDeep(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteDeep(v);
    }
    return out as T;
  }
  return value;
}

function readMcpServersFile(
  path: string,
  onLog?: (message: string) => void
): Record<string, McpServerConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Missing file is the common case (no config at that layer) — not an error.
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object") {
      return {};
    }
    return servers;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onLog?.(`Ignoring malformed MCP config at ${path}: ${message}`);
    return {};
  }
}

/**
 * Load the MCP servers a Cursor IDE session would see for a workspace: the
 * user-global `~/.cursor/mcp.json` overlaid by the project's
 * `<cwd>/.cursor/mcp.json` (project wins on name collisions). The SDK only
 * exposes servers passed inline on the agent options — it does not merge the
 * workspace `mcp.json` even with `settingSources: ["all"]` — so the daemon must
 * read and forward them itself. The reserved `automations-io` name is dropped
 * so workspace config cannot shadow the daemon's own bridge.
 */
export function loadWorkspaceMcpServers(
  cwd: string,
  options: { onLog?: (message: string) => void } = {}
): Record<string, McpServerConfig> {
  const globalServers = readMcpServersFile(
    join(homedir(), ".cursor", "mcp.json"),
    options.onLog
  );
  const projectServers = readMcpServersFile(
    join(cwd, ".cursor", "mcp.json"),
    options.onLog
  );

  const merged: Record<string, McpServerConfig> = {
    ...globalServers,
    ...projectServers,
  };

  delete merged[RESERVED_SERVER_NAME];

  return substituteDeep(merged);
}

export function automationsIoMcpServers(
  runId: string,
  options: {
    runToken?: string;
    port?: number;
    /** When set, restrict registered automations-io tools via env allowlist. */
    automationsIoTools?: readonly AutomationsIoToolName[];
  } = {}
): Record<string, McpServerConfig> {
  const port = options.port ?? Number(process.env.LCA_PORT ?? DEFAULT_PORT);
  const env: Record<string, string> = {
    LCA_RUN_ID: runId,
    LCA_DAEMON_URL: `http://127.0.0.1:${port}`,
  };
  if (options.runToken) {
    env.LCA_RUN_TOKEN = options.runToken;
  }
  if (options.automationsIoTools !== undefined) {
    env.LCA_AUTOMATIONS_IO_TOOLS = options.automationsIoTools.join(",");
  }
  return {
    [RESERVED_SERVER_NAME]: {
      type: "stdio",
      command: process.execPath,
      args: [AUTOMATIONS_IO_ENTRY],
      env,
    },
  };
}

/**
 * The full inline MCP server map for a run: the workspace's own servers plus the
 * daemon's `automations-io` bridge. `automations-io` is applied last so it can
 * never be shadowed by workspace config.
 */
export function buildRunMcpServers(
  runId: string,
  cwd: string,
  options: {
    runToken?: string;
    port?: number;
    onLog?: (message: string) => void;
    mcpExtra?: Record<string, McpServerConfig>;
    mcpDisable?: string[];
    automationsIoTools?: readonly AutomationsIoToolName[];
  } = {}
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = {
    ...loadWorkspaceMcpServers(cwd, { onLog: options.onLog }),
  };

  if (options.mcpExtra) {
    const extra = { ...options.mcpExtra };
    delete extra[RESERVED_SERVER_NAME];
    Object.assign(merged, substituteDeep(extra));
  }

  if (options.mcpDisable) {
    for (const name of options.mcpDisable) {
      if (name !== RESERVED_SERVER_NAME) {
        delete merged[name];
      }
    }
  }

  return {
    ...merged,
    ...automationsIoMcpServers(runId, {
      runToken: options.runToken,
      port: options.port,
      automationsIoTools: options.automationsIoTools,
    }),
  };
}

export { AUTOMATIONS_IO_ENTRY };
