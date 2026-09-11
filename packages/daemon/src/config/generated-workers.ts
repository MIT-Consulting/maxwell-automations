import {
  GENERATED_CONFIG_KEY_PREFIX,
  normalizeModelConfigValue,
  type GeneratedWorkerPlan,
  type GeneratedWorkerPlanItem,
  type GeneratedWorkerSpec,
} from "@lca/shared";
import type { LcaDatabase } from "../db/index.js";
import { splitSelectionForDb } from "../models/selection-persist.js";
import { automationId } from "./parse.js";

export { GENERATED_CONFIG_KEY_PREFIX };
export const GENERATED_CONFIG_PATH = "__generated__";

export function isGeneratedConfigKey(configKey: string): boolean {
  return configKey.startsWith(GENERATED_CONFIG_KEY_PREFIX);
}

type ExistingRow = {
  id: string;
  origin: string;
  name: string;
  prompt: string;
  trigger_json: string;
  chain_json: string | null;
  model: string | null;
  model_params_json: string | null;
  model_role: string | null;
  enabled: number;
  archived_at: string | null;
  config_key: string;
};

type DesiredColumns = {
  name: string;
  prompt: string;
  triggerJson: string;
  chainJson: string | null;
  model: string | null;
  modelParamsJson: string | null;
  modelRole: string | null;
};

const COMPARED_COLUMNS = [
  "name",
  "prompt",
  "trigger_json",
  "chain_json",
  "model",
  "model_params_json",
  "model_role",
] as const;

type ComparedColumn = (typeof COMPARED_COLUMNS)[number];

function desiredFromSpec(spec: GeneratedWorkerSpec): DesiredColumns {
  const storedModel = splitSelectionForDb(
    normalizeModelConfigValue(spec.model)
  );
  return {
    name: spec.name,
    prompt: spec.prompt,
    triggerJson: JSON.stringify(spec.trigger),
    chainJson: spec.chain ? JSON.stringify(spec.chain) : null,
    model: storedModel.model,
    modelParamsJson: storedModel.modelParamsJson,
    modelRole: spec.modelRole ?? null,
  };
}

function diffColumns(
  existing: ExistingRow,
  desired: DesiredColumns
): ComparedColumn[] {
  const changed: ComparedColumn[] = [];
  if (existing.name !== desired.name) changed.push("name");
  if (existing.prompt !== desired.prompt) changed.push("prompt");
  if (existing.trigger_json !== desired.triggerJson) {
    changed.push("trigger_json");
  }
  if (existing.chain_json !== desired.chainJson) changed.push("chain_json");
  if (existing.model !== desired.model) changed.push("model");
  if (existing.model_params_json !== desired.modelParamsJson) {
    changed.push("model_params_json");
  }
  if (existing.model_role !== desired.modelRole) changed.push("model_role");
  return changed;
}

function enabledStatus(enabled: boolean): {
  enabled: number;
  status: "enabled" | "backlog";
} {
  return {
    enabled: enabled ? 1 : 0,
    status: enabled ? "enabled" : "backlog",
  };
}

/**
 * Plan (and optionally apply) generated-worker desired state for one workspace.
 * Dry-run and apply share the same planner; conflicts abort the whole write.
 */
export function provisionGeneratedWorkers(
  db: LcaDatabase,
  workspaceId: string,
  workers: GeneratedWorkerSpec[],
  options: { dryRun?: boolean; prune?: boolean } = {}
): GeneratedWorkerPlan {
  const dryRun = options.dryRun === true;
  const prune = options.prune === true;

  const existingRows = db
    .prepare(
      `SELECT id, origin, name, prompt, trigger_json, chain_json, model,
              model_params_json, model_role, enabled, archived_at, config_key
       FROM automations
       WHERE workspace_id = ?`
    )
    .all(workspaceId) as ExistingRow[];

  const byId = new Map(existingRows.map((row) => [row.id, row]));
  const requestedKeys = new Set<string>();
  const items: GeneratedWorkerPlanItem[] = [];

  type WriteOp =
    | {
        kind: "upsert";
        id: string;
        configKey: string;
        desired: DesiredColumns;
        enabled: boolean;
      }
    | { kind: "archive"; id: string };

  const writes: WriteOp[] = [];

  for (const spec of workers) {
    const configKey = GENERATED_CONFIG_KEY_PREFIX + spec.key;
    requestedKeys.add(configKey);
    const id = automationId(workspaceId, configKey);
    const existing = byId.get(id);
    const base: GeneratedWorkerPlanItem = {
      key: spec.key,
      configKey,
      automationId: id,
      action: "unchanged",
    };

    if (!existing) {
      const desired = desiredFromSpec(spec);
      const enabled = spec.enabled ?? true;
      items.push({ ...base, action: "create" });
      writes.push({ kind: "upsert", id, configKey, desired, enabled });
      continue;
    }

    if (existing.origin !== "generated") {
      items.push({
        ...base,
        action: "conflict",
        detail: [`origin=${existing.origin}`],
      });
      continue;
    }

    const desired = desiredFromSpec(spec);

    if (existing.archived_at !== null) {
      const enabled = spec.enabled ?? true;
      items.push({ ...base, action: "revive" });
      writes.push({ kind: "upsert", id, configKey, desired, enabled });
      continue;
    }

    const changed = diffColumns(existing, desired);
    if (changed.length === 0) {
      items.push({ ...base, action: "unchanged" });
      continue;
    }

    // Preserve operator-chosen enabled on live updates.
    const enabled = existing.enabled === 1;
    items.push({ ...base, action: "update", detail: [...changed] });
    writes.push({ kind: "upsert", id, configKey, desired, enabled });
  }

  if (prune) {
    for (const row of existingRows) {
      if (row.origin !== "generated") continue;
      if (row.archived_at !== null) continue;
      if (requestedKeys.has(row.config_key)) continue;
      const key = row.config_key.startsWith(GENERATED_CONFIG_KEY_PREFIX)
        ? row.config_key.slice(GENERATED_CONFIG_KEY_PREFIX.length)
        : row.config_key;
      items.push({
        key,
        configKey: row.config_key,
        automationId: row.id,
        action: "archive",
      });
      writes.push({ kind: "archive", id: row.id });
    }
  }

  const hasConflict = items.some((item) => item.action === "conflict");
  if (hasConflict) {
    return {
      workspaceId,
      dryRun,
      applied: false,
      items,
    };
  }
  if (dryRun) {
    return {
      workspaceId,
      dryRun: true,
      applied: false,
      items,
    };
  }

  if (writes.length > 0) {
    const upsertStmt = db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        model_params_json, model_role, config_path, config_key, origin, chain_json,
        archived_at, updated_at
      ) VALUES (
        @id, @workspaceId, @name, @enabled, @status, @triggerJson, @prompt, @model,
        @modelParamsJson, @modelRole, @configPath, @configKey, 'generated', @chainJson,
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
        origin = 'generated',
        chain_json = excluded.chain_json,
        archived_at = NULL,
        updated_at = datetime('now')
      WHERE automations.origin = 'generated'`
    );

    const archiveStmt = db.prepare(
      `UPDATE automations SET
        enabled = 0,
        status = 'backlog',
        archived_at = COALESCE(archived_at, datetime('now')),
        updated_at = datetime('now')
       WHERE id = ? AND origin = 'generated' AND workspace_id = ?`
    );

    const apply = db.transaction(() => {
      for (const op of writes) {
        if (op.kind === "archive") {
          archiveStmt.run(op.id, workspaceId);
          continue;
        }
        const { enabled, status } = enabledStatus(op.enabled);
        upsertStmt.run({
          id: op.id,
          workspaceId,
          name: op.desired.name,
          enabled,
          status,
          triggerJson: op.desired.triggerJson,
          prompt: op.desired.prompt,
          model: op.desired.model,
          modelParamsJson: op.desired.modelParamsJson,
          modelRole: op.desired.modelRole,
          configPath: GENERATED_CONFIG_PATH,
          configKey: op.configKey,
          chainJson: op.desired.chainJson,
        });
      }
    });

    apply();
  }

  return {
    workspaceId,
    dryRun: false,
    applied: true,
    items,
  };
}
