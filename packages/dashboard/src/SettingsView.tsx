import { useEffect, useState, type JSX } from "react";
import type {
  ModelSelection,
  UpdateWorkspaceChatDefaultsRequest,
  Workspace,
  WorkspaceChatDefaults,
} from "@lca/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AlertsSettingsPanel } from "./AlertsSettingsPanel";
import { ApplicationSettingsPanel } from "./ApplicationSettingsPanel";
import { api } from "./api";
import { workspaceLabel } from "./helpers";
import { ModelSelect } from "./ModelSelect";

export type SettingsViewProps = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  isNarrow: boolean;
};

type SettingsTab = "chat" | "alerts" | "application";

type FormState = {
  modelSelection: ModelSelection | null;
  systemPrompt: string;
  extraJson: string;
  disableList: string;
};

function defaultsToForm(defaults: WorkspaceChatDefaults): FormState {
  return {
    modelSelection: defaults.modelSelection ?? null,
    systemPrompt: defaults.systemPrompt ?? "",
    extraJson:
      defaults.mcp.extra && Object.keys(defaults.mcp.extra).length > 0
        ? JSON.stringify(defaults.mcp.extra, null, 2)
        : "",
    disableList: defaults.mcp.disable?.join(", ") ?? "",
  };
}

function parseDisableList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseExtraJson(
  text: string
): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, value: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "MCP extra must be a JSON object." };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Invalid JSON in MCP extra." };
  }
}

export function SettingsView({
  workspaces,
  activeWorkspaceId,
  isNarrow,
}: SettingsViewProps): JSX.Element {
  const [activeTab, setActiveTab] = useState<SettingsTab>("chat");
  const [form, setForm] = useState<FormState>({
    modelSelection: null,
    systemPrompt: "",
    extraJson: "",
    disableList: "",
  });
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [extraJsonError, setExtraJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setLoading(false);
      setLoadError(null);
      return;
    }

    const workspaceId = activeWorkspaceId;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setExtraJsonError(null);

    api
      .getWorkspaceChatDefaults(workspaceId)
      .then((defaults) => {
        if (cancelled) return;
        setForm(defaultsToForm(defaults));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  const handleSave = async (): Promise<void> => {
    if (!activeWorkspaceId || saving) return;

    const extraResult = parseExtraJson(form.extraJson);
    if (!extraResult.ok) {
      setExtraJsonError(extraResult.error);
      return;
    }
    setExtraJsonError(null);

    const disable = parseDisableList(form.disableList);
    const patch: UpdateWorkspaceChatDefaultsRequest = {
      modelSelection: form.modelSelection,
      systemPrompt: form.systemPrompt.trim() === "" ? null : form.systemPrompt,
      mcp: {
        extra: extraResult.value,
        disable: disable.length > 0 ? disable : [],
      },
    };

    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.updateWorkspaceChatDefaults(activeWorkspaceId, patch);
      setForm(defaultsToForm(updated));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const chatTabId = "settings-tab-chat";
  const alertsTabId = "settings-tab-alerts";
  const applicationTabId = "settings-tab-application";
  const chatPanelId = "settings-panel-chat";
  const alertsPanelId = "settings-panel-alerts";
  const applicationPanelId = "settings-panel-application";

  const tabButtonClass = (selected: boolean) =>
    cn(
      "min-h-11 border-b-2 px-4 pb-3 text-sm font-medium transition-colors",
      selected
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"
    );

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-card",
        isNarrow && "pb-16"
      )}
    >
      <div
        className="mx-auto flex w-full max-w-3xl shrink-0 border-b border-border px-4 pt-4"
        role="tablist"
        aria-label="Settings sections"
      >
        <button
          type="button"
          id={chatTabId}
          role="tab"
          aria-selected={activeTab === "chat"}
          aria-controls={chatPanelId}
          className={tabButtonClass(activeTab === "chat")}
          onClick={() => setActiveTab("chat")}
        >
          Chat defaults
        </button>
        <button
          type="button"
          id={alertsTabId}
          role="tab"
          aria-selected={activeTab === "alerts"}
          aria-controls={alertsPanelId}
          className={tabButtonClass(activeTab === "alerts")}
          onClick={() => setActiveTab("alerts")}
        >
          Alerts
        </button>
        <button
          type="button"
          id={applicationTabId}
          role="tab"
          aria-selected={activeTab === "application"}
          aria-controls={applicationPanelId}
          className={tabButtonClass(activeTab === "application")}
          onClick={() => setActiveTab("application")}
        >
          Application
        </button>
      </div>

      {activeTab === "alerts" ? (
        <div
          id={alertsPanelId}
          role="tabpanel"
          aria-labelledby={alertsTabId}
          className="flex min-h-0 flex-1 flex-col"
        >
          <AlertsSettingsPanel isNarrow={isNarrow} />
        </div>
      ) : activeTab === "application" ? (
        <div
          id={applicationPanelId}
          role="tabpanel"
          aria-labelledby={applicationTabId}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ApplicationSettingsPanel />
        </div>
      ) : (
        <div
          id={chatPanelId}
          role="tabpanel"
          aria-labelledby={chatTabId}
          className="mx-auto flex w-full max-w-xl min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
        >
          {workspaces.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center border border-border bg-card p-6 text-center">
              <p className="m-0 text-sm text-muted-foreground">
                Map a workspace to configure chat defaults.
              </p>
            </div>
          ) : (
            <>
              <div>
                <h2 className="m-0 text-base font-semibold tracking-[0.2px]">
                  Workspace chat defaults
                </h2>
                <p className="m-0 mt-1 text-sm text-muted-foreground">
                  Defaults apply to new chats in the selected workspace and are saved
                  to <code className="text-xs">.cursor/chat.yaml</code>.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Workspace</Label>
                <p
                  className="m-0 truncate text-sm font-medium text-foreground"
                  title={
                    activeWorkspaceId
                      ? workspaceLabel(activeWorkspaceId, workspaces)
                      : undefined
                  }
                >
                  {activeWorkspaceId
                    ? workspaceLabel(activeWorkspaceId, workspaces)
                    : "None focused"}
                </p>
              </div>

              {loadError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                  {loadError}
                </div>
              )}

              {saveError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                  {saveError}
                </div>
              )}

              {loading ? (
                <p className="m-0 text-sm text-muted-foreground">Loading defaults…</p>
              ) : activeWorkspaceId ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="settings-model">Model (optional)</Label>
                    <ModelSelect
                      id="settings-model"
                      value={form.modelSelection}
                      onChange={(next) =>
                        setForm((prev) => ({ ...prev, modelSelection: next }))
                      }
                    />
                    <p className="m-0 text-xs text-muted-foreground">
                      Choose Default to fall through to the global default model.
                    </p>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="settings-system-prompt">
                      System prompt (optional)
                    </Label>
                    <Textarea
                      id="settings-system-prompt"
                      value={form.systemPrompt}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, systemPrompt: e.target.value }))
                      }
                      rows={6}
                      placeholder="Instructions prepended to every new chat in this workspace…"
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="settings-mcp-extra">MCP extra (JSON object)</Label>
                    <Textarea
                      id="settings-mcp-extra"
                      value={form.extraJson}
                      onChange={(e) => {
                        setExtraJsonError(null);
                        setForm((prev) => ({ ...prev, extraJson: e.target.value }));
                      }}
                      rows={8}
                      className="font-mono text-xs"
                      placeholder='{"my-server": {"command": "npx", "args": ["my-mcp"]}}'
                      aria-invalid={extraJsonError ? true : undefined}
                    />
                    {extraJsonError ? (
                      <p className="m-0 text-xs text-destructive">{extraJsonError}</p>
                    ) : (
                      <p className="m-0 text-xs text-muted-foreground">
                        Additional MCP servers merged into chats for this workspace.
                        Leave empty to clear.
                      </p>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="settings-mcp-disable">MCP disable</Label>
                    <Input
                      id="settings-mcp-disable"
                      type="text"
                      value={form.disableList}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, disableList: e.target.value }))
                      }
                      placeholder="server-a, server-b"
                    />
                    <p className="m-0 text-xs text-muted-foreground">
                      Comma- or newline-separated MCP server names to disable for this
                      workspace.
                    </p>
                  </div>

                  <div className="pt-2">
                    <Button
                      type="button"
                      onClick={() => void handleSave()}
                      disabled={saving}
                    >
                      {saving ? "Saving…" : "Save defaults"}
                    </Button>
                  </div>
                </>
              ) : (
                <p className="m-0 text-sm text-muted-foreground">
                  Select a workspace in the sidebar to edit its chat defaults.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
