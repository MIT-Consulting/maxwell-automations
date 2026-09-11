import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AutomationYamlEntry } from "@lca/shared";
import { normalizeModelConfigValue } from "@lca/shared";
import { ChatStore } from "../chats/store.js";
import type { LcaDatabase } from "../db/index.js";
import { splitSelectionForDb } from "../models/selection-persist.js";
import {
  GLOBAL_CONFIG_PATH,
  workspaceAutomationsDir,
  workspaceChatConfigPath,
} from "../paths.js";
import { isGeneratedConfigKey } from "./generated-workers.js";
import {
  automationId,
  configKeyForEntry,
  type ParseLogOptions,
  parseGlobalConfig,
  parseWorkspaceAutomations,
  parseWorkspaceChatDefaults,
} from "./parse.js";

type ParsedAutomation = {
  workspacePath: string;
  configPath: string;
  configKey: string;
  entry: AutomationYamlEntry;
};

export type ReconcileOptions = {
  onLog?: (message: string) => void;
};

const upsertWorkspace = `
INSERT INTO workspaces (id, path, name, updated_at)
VALUES (@id, @path, @name, datetime('now'))
ON CONFLICT(path) DO UPDATE SET
  name = excluded.name,
  updated_at = datetime('now')
`;

const upsertAutomation = `
INSERT INTO automations (
  id, workspace_id, name, enabled, status, trigger_json, prompt, model,
  model_params_json, model_role, config_path, config_key, chain_json,
  archived_at, updated_at
) VALUES (
  @id, @workspaceId, @name, @enabled, @status, @triggerJson, @prompt, @model,
  @modelParamsJson, @modelRole, @configPath, @configKey, @chainJson,
  NULL, datetime('now')
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  enabled = excluded.enabled,
  status = excluded.status,
  trigger_json = excluded.trigger_json,
  prompt = excluded.prompt,
  model = excluded.model,
  model_params_json = excluded.model_params_json,
  model_role = excluded.model_role,
  config_path = excluded.config_path,
  config_key = excluded.config_key,
  chain_json = excluded.chain_json,
  archived_at = NULL,
  updated_at = datetime('now')
WHERE automations.origin = 'config'
`;

export function workspaceIdFromPath(workspacePath: string): string {
  return Buffer.from(resolve(workspacePath)).toString("base64url");
}

function collectWorkspacePaths(global: ReturnType<typeof parseGlobalConfig>): string[] {
  const paths = new Set<string>();
  for (const p of global.workspaces ?? []) {
    paths.add(resolve(p));
  }
  return [...paths];
}

function collectWorkspaceAutomations(
  workspacePath: string,
  parseOptions: ParseLogOptions
): ParsedAutomation[] {
  const dir = workspaceAutomationsDir(workspacePath);
  if (!existsSync(dir)) {
    return [];
  }
  const results: ParsedAutomation[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) {
      continue;
    }
    const configPath = join(dir, file);
    let entries: AutomationYamlEntry[];
    try {
      entries = parseWorkspaceAutomations(configPath, parseOptions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      parseOptions.onWarning?.(`Skipping ${configPath}: ${message}`);
      continue;
    }
    entries.forEach((entry, index) => {
      if (!entry.id) {
        parseOptions.onWarning?.(
          `${configPath} automation "${entry.name}" has no id; history is keyed to its name until an id is added.`
        );
      }
      const configKey = configKeyForEntry(configPath, entry, index);
      if (isGeneratedConfigKey(configKey)) {
        parseOptions.onWarning?.(
          `${configPath} automation "${entry.name}" uses reserved config key "${configKey}"; skipping (generated workers are provisioned, not YAML).`
        );
        return;
      }
      results.push({
        workspacePath,
        configPath,
        configKey,
        entry,
      });
    });
  }
  return results;
}

function collectGlobalAutomations(
  entries: AutomationYamlEntry[],
  parseOptions: ParseLogOptions
): ParsedAutomation[] {
  const results: ParsedAutomation[] = [];
  entries.forEach((entry, index) => {
    if (!entry.id) {
      parseOptions.onWarning?.(
        `${GLOBAL_CONFIG_PATH} automation "${entry.name}" has no id; history is keyed to its name until an id is added.`
      );
    }
    const configKey = configKeyForEntry(GLOBAL_CONFIG_PATH, entry, index);
    if (isGeneratedConfigKey(configKey)) {
      parseOptions.onWarning?.(
        `${GLOBAL_CONFIG_PATH} automation "${entry.name}" uses reserved config key "${configKey}"; skipping (generated workers are provisioned, not YAML).`
      );
      return;
    }
    results.push({
      workspacePath: "__global__",
      configPath: GLOBAL_CONFIG_PATH,
      configKey,
      entry,
    });
  });
  return results;
}

export function reconcileConfig(
  db: LcaDatabase,
  options: ReconcileOptions = {}
): number {
  const parseOptions: ParseLogOptions = {
    onWarning: (message) => options.onLog?.(message),
  };
  const global = parseGlobalConfig(GLOBAL_CONFIG_PATH, parseOptions);
  const workspacePaths = collectWorkspacePaths(global);

  // Ergonomic guard: a configured workspace path that doesn't exist on disk is
  // almost always a typo or a moved repo. Warn clearly rather than silently
  // contributing zero automations.
  for (const workspacePath of workspacePaths) {
    if (!existsSync(workspacePath)) {
      parseOptions.onWarning?.(
        `Configured workspace path does not exist: ${workspacePath} (check ${GLOBAL_CONFIG_PATH})`
      );
    }
  }

  const parsed: ParsedAutomation[] = [
    ...collectGlobalAutomations(global.automations ?? [], parseOptions),
    ...workspacePaths.flatMap((workspacePath) =>
      collectWorkspaceAutomations(workspacePath, parseOptions)
    ),
  ];

  const upsertWs = db.prepare(upsertWorkspace);
  const upsertAuto = db.prepare(upsertAutomation);
  const chatStore = new ChatStore(db);

  const activeIds = new Set<string>();

  const reconcile = db.transaction(() => {
    for (const workspacePath of workspacePaths) {
      const wsId = workspaceIdFromPath(workspacePath);
      upsertWs.run({
        id: wsId,
        path: resolve(workspacePath),
        name: null,
      });

      const chatDefaults = parseWorkspaceChatDefaults(
        workspaceChatConfigPath(workspacePath),
        parseOptions
      );
      if (chatDefaults) {
        chatStore.upsertWorkspaceChatDefaults(wsId, {
          model: chatDefaults.model,
          systemPrompt: chatDefaults.systemPrompt,
          mcpOverlayJson: JSON.stringify(chatDefaults.mcp),
        });
      } else {
        chatStore.clearWorkspaceChatDefaults(wsId);
      }
    }

    for (const item of parsed) {
      const wsId =
        item.workspacePath === "__global__"
          ? "__global__"
          : workspaceIdFromPath(item.workspacePath);

      if (item.workspacePath !== "__global__") {
        upsertWs.run({
          id: wsId,
          path: resolve(item.workspacePath),
          name: null,
        });
      } else {
        upsertWs.run({
          id: "__global__",
          path: "__global__",
          name: "Global",
        });
      }

      const enabled = item.entry.enabled === true ? 1 : 0;
      const status = enabled ? "enabled" : "backlog";
      const id = automationId(wsId, item.configKey);
      activeIds.add(id);
      const storedModel = splitSelectionForDb(
        normalizeModelConfigValue(item.entry.model)
      );

      upsertAuto.run({
        id,
        workspaceId: wsId,
        name: item.entry.name,
        enabled,
        status,
        triggerJson: JSON.stringify(item.entry.trigger),
        prompt: item.entry.prompt,
        model: storedModel.model,
        modelParamsJson: storedModel.modelParamsJson,
        modelRole: item.entry.modelRole ?? null,
        configPath: item.configPath,
        configKey: item.configKey,
        chainJson: item.entry.chain ? JSON.stringify(item.entry.chain) : null,
      });
    }

    const existing = db
      .prepare("SELECT id FROM automations WHERE origin = 'config'")
      .all() as Array<{ id: string }>;

    const archiveAutomation = db.prepare(
      `UPDATE automations SET
        enabled = 0,
        status = 'backlog',
        archived_at = COALESCE(archived_at, datetime('now')),
        updated_at = datetime('now')
       WHERE id = ?`
    );
    for (const row of existing) {
      if (!activeIds.has(row.id)) {
        archiveAutomation.run(row.id);
      }
    }
  });

  reconcile();
  return activeIds.size;
}

export function listWatchedPaths(): string[] {
  const global = parseGlobalConfig(GLOBAL_CONFIG_PATH);
  const paths = new Set<string>([GLOBAL_CONFIG_PATH]);
  for (const workspacePath of collectWorkspacePaths(global)) {
    paths.add(workspaceAutomationsDir(workspacePath));
    paths.add(dirname(workspaceChatConfigPath(workspacePath)));
  }
  return [...paths];
}
