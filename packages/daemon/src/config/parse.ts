import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  automationYamlEntrySchema,
  globalConfigYamlSchema,
  normalizeModelConfigValue,
  workspaceAutomationsYamlSchema,
  workspaceChatDefaultsYamlSchema,
  type AutomationYamlEntry,
  type GlobalConfigYaml,
  type McpOverlay,
  type ModelSelection,
} from "@lca/shared";

export type WorkspaceChatDefaultsParsed = {
  /** Canonical selection (scalar YAML becomes id-only). */
  model: ModelSelection | null;
  systemPrompt: string | null;
  mcp: McpOverlay;
};

export type ParseLogOptions = {
  onWarning?: (message: string) => void;
};

export function readYamlFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return null;
  }
  return parseYaml(raw) as T;
}

export function formatIssues(
  issues: Array<{ path: PropertyKey[]; message: string }>
): string {
  return issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function trimOrNull(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mcpOverlayHasValues(mcp: McpOverlay): boolean {
  if (mcp.extra && Object.keys(mcp.extra).length > 0) {
    return true;
  }
  return (mcp.disable?.length ?? 0) > 0;
}

export function parseWorkspaceChatDefaults(
  filePath: string,
  options: ParseLogOptions = {}
): WorkspaceChatDefaultsParsed | null {
  if (!existsSync(filePath)) {
    return null;
  }

  let doc: unknown;
  try {
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return null;
    }
    doc = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.onWarning?.(`Skipping ${filePath}: ${message}`);
    return null;
  }

  const parsed = workspaceChatDefaultsYamlSchema.safeParse(doc);
  if (!parsed.success) {
    options.onWarning?.(
      `Skipping ${filePath}: invalid chat defaults file shape (${formatIssues(parsed.error.issues)})`
    );
    return null;
  }

  const model = normalizeModelConfigValue(parsed.data.model);
  const systemPrompt = trimOrNull(parsed.data.systemPrompt);
  const mcp: McpOverlay = parsed.data.mcp ?? {};

  if (model === null && systemPrompt === null && !mcpOverlayHasValues(mcp)) {
    return null;
  }

  return { model, systemPrompt, mcp };
}

export function parseWorkspaceAutomations(
  filePath: string,
  options: ParseLogOptions = {}
): AutomationYamlEntry[] {
  const doc = readYamlFile<unknown>(filePath);
  if (!doc) {
    return [];
  }

  const parsed = workspaceAutomationsYamlSchema.safeParse(doc);
  if (!parsed.success) {
    options.onWarning?.(
      `Skipping ${filePath}: invalid automation file shape (${formatIssues(parsed.error.issues)})`
    );
    return [];
  }

  const entries = Array.isArray(parsed.data)
    ? parsed.data
    : (parsed.data.automations ?? []);
  return validateAutomationEntries(filePath, entries, options);
}

export function parseGlobalConfig(
  filePath: string,
  options: ParseLogOptions = {}
): GlobalConfigYaml {
  const doc = readYamlFile<unknown>(filePath);
  if (!doc) {
    return {};
  }

  const parsed = globalConfigYamlSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(
      `Invalid global config ${filePath}: ${formatIssues(parsed.error.issues)}`
    );
  }

  return {
    workspaces: parsed.data.workspaces,
    settings: parsed.data.settings,
    automations: validateAutomationEntries(
      filePath,
      parsed.data.automations ?? [],
      options
    ),
  };
}

export function validateAutomationEntries(
  filePath: string,
  entries: unknown[],
  options: ParseLogOptions = {}
): AutomationYamlEntry[] {
  const valid: AutomationYamlEntry[] = [];
  entries.forEach((entry, index) => {
    const parsed = automationYamlEntrySchema.safeParse(entry);
    if (!parsed.success) {
      options.onWarning?.(
        `Skipping ${filePath} automation #${index + 1}: ${formatIssues(parsed.error.issues)}`
      );
      return;
    }
    valid.push(parsed.data);
  });
  return valid;
}

export function configKeyForEntry(
  filePath: string,
  entry: AutomationYamlEntry,
  index: number
): string {
  if (entry.id) {
    return entry.id;
  }
  const stem = basename(filePath, ".yaml").replace(/\.yml$/, "");
  const name = typeof entry.name === "string" ? entry.name : String(index);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${stem}:${slug || index}`;
}

export function automationId(workspaceId: string, configKey: string): string {
  return `${workspaceId}::${configKey}`;
}
