import { useEffect, useState, type JSX } from "react";
import {
  ALERT_NOTIFY_EVENTS,
  type AlertNotifyEvent,
  type NotifySettingsPublic,
  type ResolvedNotifyEventPrefs,
  type UpdateNotifySettingsInput,
} from "@lca/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { api } from "./api";

export type AlertsSettingsPanelProps = {
  isNarrow: boolean;
};

type DraftState = {
  ntfyEnabled: boolean;
  topic: string;
  server: string;
  tokenInput: string;
  tokenClear: boolean;
  events: ResolvedNotifyEventPrefs;
};

const EVENT_LABELS: Record<AlertNotifyEvent, string> = {
  needs_input: "Needs input",
  run_failed: "Run failed",
  auth_expired: "Auth expired",
  run_completed: "Run completed",
  pipeline_complete: "Pipeline complete",
  queue_batch_complete: "Serial queue batch complete",
  plan_approval_required: "Plan approval required",
  ux_approval_required: "UX approval required",
  pipeline_halt_recovered: "Pipeline halt recovered",
  pipeline_halt_unrecovered: "Pipeline halt unrecovered",
  halt_discovery_ready: "Halt discovery ready",
  halt_discovery_failed: "Halt discovery failed",
  halt_discovery_action: "Halt discovery action",
};

function snapshotToDraft(snapshot: NotifySettingsPublic): DraftState {
  return {
    ntfyEnabled: snapshot.ntfy !== null,
    topic: snapshot.ntfy?.topic ?? "",
    server: snapshot.ntfy?.server ?? "",
    tokenInput: "",
    tokenClear: false,
    events: { ...snapshot.events },
  };
}

function buildNtfyPatch(draft: DraftState): UpdateNotifySettingsInput["ntfy"] {
  if (!draft.ntfyEnabled) {
    return null;
  }
  const ntfy: {
    topic: string;
    server?: string;
    token?: string | null;
  } = {
    topic: draft.topic.trim(),
  };
  const server = draft.server.trim();
  if (server) {
    ntfy.server = server;
  }
  if (draft.tokenClear) {
    ntfy.token = null;
  } else if (draft.tokenInput.trim()) {
    ntfy.token = draft.tokenInput.trim();
  }
  return ntfy;
}

export function AlertsSettingsPanel({
  isNarrow,
}: AlertsSettingsPanelProps): JSX.Element {
  const [defaults, setDefaults] = useState<ResolvedNotifyEventPrefs | null>(
    null
  );
  const [envMutes, setEnvMutes] = useState({ toast: false, ntfy: false });
  const [usableNtfy, setUsableNtfy] = useState(false);
  const [tokenPresent, setTokenPresent] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState<string | null>(null);
  const [topicError, setTopicError] = useState<string | null>(null);

  const applySnapshot = (snapshot: NotifySettingsPublic): void => {
    setDefaults(snapshot.defaults);
    setEnvMutes(snapshot.envMutes);
    setUsableNtfy(snapshot.usable.ntfy);
    setTokenPresent(snapshot.ntfy?.tokenPresent ?? false);
    setDraft(snapshotToDraft(snapshot));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    api
      .getNotifySettings()
      .then((snapshot) => {
        if (cancelled) return;
        applySnapshot(snapshot);
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
  }, []);

  const handleSave = async (): Promise<void> => {
    if (!draft || saving) return;

    if (draft.ntfyEnabled && draft.topic.trim() === "") {
      setTopicError("Topic is required when ntfy is enabled.");
      return;
    }
    setTopicError(null);
    setSaveError(null);
    setSaveSuccess(null);

    const patch = {
      events: draft.events,
      ntfy: buildNtfyPatch(draft),
    };

    setSaving(true);
    try {
      const updated = await api.updateNotifySettings(patch);
      applySnapshot(updated);
      setSaveSuccess("Alert preferences saved.");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = (): void => {
    if (!defaults || !draft) return;
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            events: { ...defaults },
          }
        : prev
    );
    setSaveSuccess(null);
    setSaveError(null);
  };

  const handleTestSend = async (): Promise<void> => {
    if (testing || !usableNtfy) return;
    setTesting(true);
    setTestError(null);
    setTestSuccess(null);
    try {
      const result = await api.testNotifySettings();
      if (result.ok) {
        setTestSuccess("Test notification sent.");
      } else {
        setTestError(result.error);
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const toastColumnMuted = envMutes.toast;
  const ntfyColumnMuted = envMutes.ntfy || !usableNtfy;

  const envMuteParts: string[] = [];
  if (envMutes.toast) envMuteParts.push("LCA_NO_TOAST");
  if (envMutes.ntfy) envMuteParts.push("LCA_NO_NTFY");

  return (
    <div
      className={cn(
        "mx-auto flex w-full min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4",
        isNarrow ? "max-w-full" : "max-w-3xl"
      )}
    >
      <div>
        <h2 className="m-0 text-base font-semibold tracking-[0.2px]">Alerts</h2>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          Configure toast and ntfy delivery for daemon-wide alert events. Changes
          apply immediately without restarting Max.
        </p>
      </div>

      {envMuteParts.length > 0 && (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200"
          role="status"
        >
          Environment mute active: {envMuteParts.join(", ")}. Greyed columns are
          muted at runtime but can still be edited for when mutes are removed.
        </div>
      )}

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

      {saveSuccess && (
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200"
          role="status"
        >
          {saveSuccess}
        </div>
      )}

      {loading || !draft ? (
        <p className="m-0 text-sm text-muted-foreground">Loading alert settings…</p>
      ) : (
        <>
          <section
            className="flex flex-col gap-4 rounded-md border border-border p-4"
            aria-labelledby="alerts-connection-heading"
          >
            <div>
              <h3
                id="alerts-connection-heading"
                className="m-0 text-sm font-semibold"
              >
                ntfy connection
              </h3>
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                Push alerts to an ntfy topic. Disable to turn off ntfy delivery.
              </p>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="alerts-ntfy-enabled" className="text-sm">
                Enable ntfy
              </Label>
              <Switch
                id="alerts-ntfy-enabled"
                checked={draft.ntfyEnabled}
                onCheckedChange={(checked) =>
                  setDraft((prev) =>
                    prev ? { ...prev, ntfyEnabled: checked } : prev
                  )
                }
              />
            </div>

            {draft.ntfyEnabled && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="alerts-ntfy-topic">Topic</Label>
                  <Input
                    id="alerts-ntfy-topic"
                    type="text"
                    value={draft.topic}
                    onChange={(e) => {
                      setTopicError(null);
                      setDraft((prev) =>
                        prev ? { ...prev, topic: e.target.value } : prev
                      );
                    }}
                    placeholder="my-max-alerts"
                    aria-invalid={topicError ? true : undefined}
                  />
                  {topicError ? (
                    <p className="m-0 text-xs text-destructive">{topicError}</p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="alerts-ntfy-server">Server URL (optional)</Label>
                  <Input
                    id="alerts-ntfy-server"
                    type="url"
                    value={draft.server}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev ? { ...prev, server: e.target.value } : prev
                      )
                    }
                    placeholder="https://ntfy.sh"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="alerts-ntfy-token">Access token (optional)</Label>
                  <Input
                    id="alerts-ntfy-token"
                    type="password"
                    autoComplete="new-password"
                    value={draft.tokenInput}
                    onChange={(e) =>
                      setDraft((prev) =>
                        prev
                          ? {
                              ...prev,
                              tokenInput: e.target.value,
                              tokenClear: false,
                            }
                          : prev
                      )
                    }
                    placeholder={
                      tokenPresent && !draft.tokenInput
                        ? "Token saved (enter new value to replace)"
                        : "Bearer token for private topics"
                    }
                  />
                  {tokenPresent && (
                    <p className="m-0 text-xs text-muted-foreground">
                      A token is saved. Leave blank to keep it, or clear below.
                    </p>
                  )}
                  {tokenPresent && (
                    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={draft.tokenClear}
                        onChange={(e) =>
                          setDraft((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  tokenClear: e.target.checked,
                                  tokenInput: e.target.checked
                                    ? ""
                                    : prev.tokenInput,
                                }
                              : prev
                          )
                        }
                      />
                      Clear saved token on save
                    </label>
                  )}
                </div>
              </>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleTestSend()}
                disabled={testing || !usableNtfy}
              >
                {testing ? "Sending…" : "Test send"}
              </Button>
              {!usableNtfy && (
                <p className="m-0 text-xs text-muted-foreground">
                  Configure and save a usable ntfy connection to test.
                </p>
              )}
            </div>

            {testError && (
              <p className="m-0 text-sm text-destructive" role="status">
                {testError}
              </p>
            )}
            {testSuccess && (
              <p
                className="m-0 text-sm text-emerald-700 dark:text-emerald-300"
                role="status"
              >
                {testSuccess}
              </p>
            )}
          </section>

          <section aria-labelledby="alerts-matrix-heading">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h3 id="alerts-matrix-heading" className="m-0 text-sm font-semibold">
                  Event channels
                </h3>
                <p className="m-0 mt-1 text-xs text-muted-foreground">
                  Choose toast and ntfy delivery per alert type. Dashboard alerts
                  are always on.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleReset}
                disabled={!defaults}
              >
                Reset to defaults
              </Button>
            </div>

            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[20rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Event
                    </th>
                    <th
                      scope="col"
                      className={cn(
                        "px-3 py-2 font-medium",
                        toastColumnMuted && "opacity-50"
                      )}
                    >
                      Toast
                    </th>
                    <th
                      scope="col"
                      className={cn(
                        "px-3 py-2 font-medium",
                        ntfyColumnMuted && "opacity-50"
                      )}
                    >
                      ntfy
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ALERT_NOTIFY_EVENTS.map((eventId) => (
                    <tr key={eventId} className="border-b border-border last:border-0">
                      <td className="px-3 py-2 align-middle">
                        <span title={eventId}>{EVENT_LABELS[eventId]}</span>
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 align-middle",
                          toastColumnMuted && "opacity-50"
                        )}
                      >
                        <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={draft.events[eventId].toast}
                            aria-label={`${EVENT_LABELS[eventId]} toast`}
                            onChange={(e) =>
                              setDraft((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      events: {
                                        ...prev.events,
                                        [eventId]: {
                                          ...prev.events[eventId],
                                          toast: e.target.checked,
                                        },
                                      },
                                    }
                                  : prev
                              )
                            }
                          />
                        </label>
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 align-middle",
                          ntfyColumnMuted && "opacity-50"
                        )}
                      >
                        <label className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={draft.events[eventId].ntfy}
                            aria-label={`${EVENT_LABELS[eventId]} ntfy`}
                            onChange={(e) =>
                              setDraft((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      events: {
                                        ...prev.events,
                                        [eventId]: {
                                          ...prev.events[eventId],
                                          ntfy: e.target.checked,
                                        },
                                      },
                                    }
                                  : prev
                              )
                            }
                          />
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="pt-2">
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving…" : "Save alerts"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
