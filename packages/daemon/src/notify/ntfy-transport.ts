import type { NtfyNotifySettings } from "@lca/shared";

const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

/** Notification fields published to ntfy (event filtering stays outside). */
export type NtfyPublishPayload = {
  title: string;
  message: string;
  click?: string;
};

export type NtfyTransportOptions = {
  /** Validated settings from Phase 1; omit for a permanent no-op sink. */
  settings?: NtfyNotifySettings;
  onLog?: (message: string) => void;
};

export type NtfyPublishResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Best-effort ntfy HTTP publisher. `publish` is synchronous void so callers
 * cannot await ntfy as part of run lifecycle control; network work is
 * fire-and-forget with isolated failures.
 */
export class NtfyTransport {
  private settings?: NtfyNotifySettings;
  private readonly onLog?: (message: string) => void;

  constructor(options: NtfyTransportOptions = {}) {
    this.settings = options.settings;
    this.onLog = options.onLog;
  }

  setSettings(settings?: NtfyNotifySettings): void {
    this.settings = settings;
  }

  private buildRequest(
    payload: NtfyPublishPayload
  ): { url: string; init: RequestInit } | null {
    const settings = this.settings;
    if (settings == null) {
      return null;
    }

    const server = (settings.server ?? DEFAULT_NTFY_SERVER).replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (settings.token != null && settings.token.length > 0) {
      headers.Authorization = `Bearer ${settings.token}`;
    }

    const body: Record<string, string> = {
      topic: settings.topic,
      title: payload.title,
      message: payload.message,
    };
    if (payload.click !== undefined) {
      body.click = payload.click;
    }

    return {
      url: server,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    };
  }

  publish(payload: NtfyPublishPayload): void {
    if (process.env.LCA_NO_NTFY === "1") {
      return;
    }

    try {
      const request = this.buildRequest(payload);
      if (request == null) {
        return;
      }

      const work = fetch(request.url, request.init).then(
        (res) => {
          if (!res.ok) {
            this.onLog?.(`ntfy publish failed: HTTP ${res.status}`);
          }
        },
        () => {
          // Secret-safe: never echo fetch error text (may include URL).
          this.onLog?.("ntfy publish failed: request error");
        }
      );

      void work.catch(() => {
        // Defensive: onLog or response handling must not become unhandled.
      });
    } catch {
      this.onLog?.("ntfy publish failed: request error");
    }
  }

  /** Awaited publish for operator test-send only. */
  async publishAwait(payload: NtfyPublishPayload): Promise<NtfyPublishResult> {
    if (process.env.LCA_NO_NTFY === "1") {
      return { ok: false, error: "ntfy disabled by LCA_NO_NTFY" };
    }

    try {
      const request = this.buildRequest(payload);
      if (request == null) {
        return { ok: false, error: "ntfy not configured" };
      }

      const res = await fetch(request.url, request.init);
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "request failed" };
    }
  }
}
