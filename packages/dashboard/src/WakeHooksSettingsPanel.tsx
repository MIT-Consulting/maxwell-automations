import { useCallback, useEffect, useState, type JSX } from "react";
import type { WakeHookPublic } from "@lca/shared";
import { Button } from "@/components/ui/button";
import { api } from "./api";

const WAKE_EVENT_LABELS: Record<string, string> = {
  needs_input: "Needs input",
  halted: "Halted",
  blocked: "Blocked",
  green: "Green",
  queue_batch_complete: "Queue drained",
};

function formatDelivery(d: WakeHookPublic["lastDeliveries"][number]): string {
  const parts = [d.status, d.kind];
  if (d.error) parts.push(d.error);
  if (d.attempt > 1) parts.push(`attempt ${d.attempt}`);
  return parts.join(" · ");
}

export function WakeHooksSettingsPanel(): JSX.Element {
  const [hooks, setHooks] = useState<WakeHookPublic[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});

  const loadHooks = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const data = await api.getWakeHooks();
      setHooks(data.hooks);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHooks();
  }, [loadHooks]);

  const handleTest = async (hookId: string): Promise<void> => {
    if (testingId != null) return;
    setTestingId(hookId);
    setTestErrors((prev) => {
      const next = { ...prev };
      delete next[hookId];
      return next;
    });
    try {
      const result = await api.testWakeHook(hookId);
      if (!result.ok) {
        setTestErrors((prev) => ({
          ...prev,
          [hookId]: result.error,
        }));
      }
      await loadHooks();
    } catch (err) {
      setTestErrors((prev) => ({
        ...prev,
        [hookId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      aria-labelledby="wake-hooks-heading"
    >
      <div>
        <h3 id="wake-hooks-heading" className="m-0 text-sm font-semibold">
          Wake hooks
        </h3>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          Outbound doorbells for orchestrators. Configure hooks in{" "}
          <code className="text-xs">settings.wakeHooks</code> in the global YAML;
          the list hot-reloads without a daemon restart.
        </p>
      </div>

      {loadError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {loading ? (
        <p className="m-0 text-sm text-muted-foreground">Loading wake hooks…</p>
      ) : loadError ? null : hooks == null || hooks.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          No wake hooks configured. Add entries under{" "}
          <code className="text-xs">settings.wakeHooks</code> in{" "}
          <code className="text-xs">~/.cursor-local-automations/automations.yaml</code>.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {hooks.map((hook) => {
            const lastFive = hook.lastDeliveries.slice(-5);
            const newest = hook.lastDeliveries.at(-1);
            const target =
              hook.sink === "chat"
                ? hook.chatId ?? "(chat)"
                : hook.urlHost ?? "(url)";
            return (
              <li
                key={hook.id}
                className="flex flex-col gap-3 rounded-md border border-border/60 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="m-0 text-sm font-medium">{hook.id}</p>
                    <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                      {hook.sink} · {target}
                      {hook.tokenEnv != null ? ` · token: ${hook.tokenEnv}` : null}
                    </p>
                    <p className="m-0 mt-0.5 text-xs text-muted-foreground">
                      Events:{" "}
                      {hook.events
                        .map((e) => WAKE_EVENT_LABELS[e] ?? e)
                        .join(", ")}
                    </p>
                    {hook.noActorActivitySince && (
                      <p
                        className="m-0 mt-1 text-xs text-amber-700 dark:text-amber-300"
                        role="status"
                      >
                        Delivered, no actor activity since
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={testingId != null}
                    onClick={() => void handleTest(hook.id)}
                  >
                    {testingId === hook.id ? "Sending…" : "Test send"}
                  </Button>
                </div>

                {testErrors[hook.id] && (
                  <p className="m-0 text-sm text-destructive" role="status">
                    {testErrors[hook.id]}
                  </p>
                )}

                {newest != null && testingId !== hook.id && (
                  <p className="m-0 text-xs text-muted-foreground" role="status">
                    Latest: {formatDelivery(newest)}
                  </p>
                )}

                {lastFive.length > 0 && (
                  <div>
                    <p className="m-0 text-xs font-medium text-muted-foreground">
                      Last deliveries
                    </p>
                    <ul className="m-0 mt-1 list-none p-0 text-xs text-muted-foreground">
                      {lastFive.map((d, i) => (
                        <li key={`${d.at}-${i}`}>
                          {d.at.slice(0, 19).replace("T", " ")} —{" "}
                          {formatDelivery(d)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
