import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from "yaml";
import type { McpOverlay, ModelSelection, UpdateNotifySettingsInput } from "@lca/shared";
import { modelConfigForYaml } from "../models/selection-persist.js";
import { workspaceChatConfigPath } from "../paths.js";

/**
 * Append a workspace path to the global config `workspaces` list, preserving
 * YAML comments/formatting via `parseDocument`. Idempotent: returns false when
 * the resolved path is already listed.
 */
export function appendWorkspaceToConfig(
  configPath: string,
  workspacePath: string
): boolean {
  const resolved = resolve(workspacePath);

  mkdirSync(dirname(configPath), { recursive: true });

  let doc;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    doc = parseDocument(raw.trim() ? raw : "{}");
  } else {
    doc = parseDocument("{}");
  }

  let workspaces = doc.get("workspaces");
  if (!workspaces || !isSeq(workspaces)) {
    doc.set("workspaces", []);
    workspaces = doc.get("workspaces");
  }

  if (!workspaces || !isSeq(workspaces)) {
    throw new Error("Failed to initialize workspaces sequence in config");
  }

  const seq: YAMLSeq = workspaces;
  for (const item of seq.items) {
    const raw =
      item && typeof item === "object" && "value" in item
        ? String(item.value)
        : String(item);
    if (resolve(raw) === resolved) {
      return false;
    }
  }

  seq.add(resolved);
  writeFileSync(configPath, doc.toString(), "utf8");
  return true;
}

function setOrDeleteKey(
  doc: ReturnType<typeof parseDocument>,
  key: string,
  value: string | null | undefined
): void {
  if (value === undefined) {
    return;
  }
  if (value === null || value.trim() === "") {
    doc.delete(key);
    return;
  }
  doc.set(key, value);
}

function setOrDeleteModelKey(
  doc: ReturnType<typeof parseDocument>,
  value: string | ModelSelection | null | undefined
): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    doc.delete("model");
    return;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      doc.delete("model");
      return;
    }
    doc.set("model", value);
    return;
  }
  doc.set("model", {
    id: value.id,
    ...(value.params?.length ? { params: value.params } : {}),
  });
}

/**
 * Write workspace chat defaults to `chat.yaml`, preserving comments/formatting
 * via `parseDocument`. Omitted fields are left unchanged; explicit null/empty
 * removes the key. Scalar model ids stay scalars; parameterized selections emit
 * a mapping.
 */
export function writeWorkspaceChatDefaults(
  workspacePath: string,
  defaults: {
    model?: string | ModelSelection | null;
    systemPrompt?: string | null;
    mcp?: McpOverlay;
  }
): void {
  const configPath = workspaceChatConfigPath(workspacePath);
  const cursorDir = dirname(configPath);
  mkdirSync(cursorDir, { recursive: true });

  let doc;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    doc = parseDocument(raw.trim() ? raw : "{}");
  } else {
    doc = parseDocument("{}");
  }

  const modelYaml =
    typeof defaults.model === "string" ||
    defaults.model === null ||
    defaults.model === undefined
      ? defaults.model
      : modelConfigForYaml(defaults.model);
  setOrDeleteModelKey(doc, modelYaml);
  setOrDeleteKey(doc, "systemPrompt", defaults.systemPrompt);

  if (defaults.mcp !== undefined) {
    const mcpOut: Record<string, unknown> = {};
    if (defaults.mcp.extra && Object.keys(defaults.mcp.extra).length > 0) {
      mcpOut.extra = defaults.mcp.extra;
    }
    if (defaults.mcp.disable && defaults.mcp.disable.length > 0) {
      mcpOut.disable = defaults.mcp.disable;
    }
    if (Object.keys(mcpOut).length === 0) {
      doc.delete("mcp");
    } else {
      doc.set("mcp", mcpOut);
    }
  }

  writeFileSync(configPath, doc.toString(), "utf8");
}

function readYamlNtfyToken(
  doc: ReturnType<typeof parseDocument>
): string | undefined {
  const ntfy = doc.getIn(["settings", "notify", "ntfy"]);
  if (!isMap(ntfy)) {
    return undefined;
  }
  const token = ntfy.get("token");
  if (token == null) {
    return undefined;
  }
  const text = String(token).trim();
  return text.length > 0 ? text : undefined;
}

function readYamlNtfyServer(
  doc: ReturnType<typeof parseDocument>
): string | undefined {
  const ntfy = doc.getIn(["settings", "notify", "ntfy"]);
  if (!isMap(ntfy)) {
    return undefined;
  }
  const server = ntfy.get("server");
  if (server == null) {
    return undefined;
  }
  const text = String(server).trim();
  return text.length > 0 ? text : undefined;
}

function ensureSettingsMap(doc: ReturnType<typeof parseDocument>): YAMLMap {
  let settings = doc.get("settings");
  if (!settings || !isMap(settings)) {
    doc.set("settings", {});
    settings = doc.get("settings");
  }
  if (!settings || !isMap(settings)) {
    throw new Error("Failed to initialize settings map in config");
  }
  return settings;
}

/**
 * Persist `settings.notify` in the global YAML via comment-preserving
 * `parseDocument`. Token/topic are never logged.
 */
export function writeNotifySettings(
  configPath: string,
  patch: UpdateNotifySettingsInput
): void {
  mkdirSync(dirname(configPath), { recursive: true });

  let doc;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    doc = parseDocument(raw.trim() ? raw : "{}");
  } else {
    doc = parseDocument("{}");
  }

  ensureSettingsMap(doc);
  const preservedToken = readYamlNtfyToken(doc);
  const preservedServer = readYamlNtfyServer(doc);

  if (patch.events !== undefined) {
    doc.setIn(["settings", "notify", "events"], doc.createNode(patch.events));
  }

  if (patch.ntfy === null) {
    doc.deleteIn(["settings", "notify", "ntfy"]);
  } else if (patch.ntfy !== undefined) {
    const ntfyOut: Record<string, string> = { topic: patch.ntfy.topic };

    if (patch.ntfy.server === null || patch.ntfy.server === "") {
      // omit server key
    } else if (patch.ntfy.server !== undefined) {
      ntfyOut.server = patch.ntfy.server;
    } else if (preservedServer !== undefined) {
      ntfyOut.server = preservedServer;
    }

    if (patch.ntfy.token === undefined) {
      if (preservedToken !== undefined) {
        ntfyOut.token = preservedToken;
      }
    } else if (patch.ntfy.token !== null && patch.ntfy.token !== "") {
      ntfyOut.token = patch.ntfy.token;
    }

    doc.setIn(["settings", "notify", "ntfy"], doc.createNode(ntfyOut));
    doc.deleteIn(["settings", "notify", "ntfy", "events"]);
  }

  writeFileSync(configPath, doc.toString(), "utf8");
}
