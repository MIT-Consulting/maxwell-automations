import {
  DEFAULT_NOTIFY_EVENT_PREFS,
  type NotifySettingsPublic,
  type ResolvedNotifySettings,
} from "@lca/shared";

/** Build the public GET/PATCH snapshot (never includes raw token). */
export function buildNotifySettingsPublic(
  resolved: ResolvedNotifySettings
): NotifySettingsPublic {
  const envMutes = {
    toast: process.env.LCA_NO_TOAST === "1",
    ntfy: process.env.LCA_NO_NTFY === "1",
  };
  const ntfy = resolved.ntfy
    ? {
        topic: resolved.ntfy.topic,
        ...(resolved.ntfy.server !== undefined
          ? { server: resolved.ntfy.server }
          : {}),
        tokenPresent: Boolean(
          resolved.ntfy.token != null && resolved.ntfy.token.length > 0
        ),
      }
    : null;
  return {
    events: resolved.events,
    defaults: DEFAULT_NOTIFY_EVENT_PREFS,
    ntfy,
    envMutes,
    usable: { ntfy: ntfy != null && !envMutes.ntfy },
  };
}
