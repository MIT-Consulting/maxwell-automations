import type { ModelSelection, TriggerConfig } from "@lca/shared";
import type { LcaDatabase } from "../db/index.js";
import { selectionFromStored } from "../models/selection-persist.js";

export type EnabledAutomation = {
  id: string;
  workspaceId: string;
  workspacePath: string;
  name: string;
  prompt: string;
  model: string | null;
  modelSelection: ModelSelection | null;
  trigger: TriggerConfig;
};

export class TriggerStore {
  constructor(private readonly db: LcaDatabase) {}

  listEnabledWorkspaceAutomations(): EnabledAutomation[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.workspace_id, a.name, a.prompt, a.model, a.model_params_json,
                a.trigger_json, w.path
         FROM automations a
         JOIN workspaces w ON w.id = a.workspace_id
         WHERE a.enabled = 1
           AND a.archived_at IS NULL
           AND w.path != '__global__'`
      )
      .all() as Array<{
      id: string;
      workspace_id: string;
      name: string;
      prompt: string;
      model: string | null;
      model_params_json: string | null;
      trigger_json: string;
      path: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      workspacePath: row.path,
      name: row.name,
      prompt: row.prompt,
      model: row.model,
      modelSelection: selectionFromStored(row.model, row.model_params_json),
      trigger: JSON.parse(row.trigger_json) as TriggerConfig,
    }));
  }

  isAutomationEnabled(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT enabled FROM automations WHERE id = ? AND archived_at IS NULL`
      )
      .get(id) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }
}
