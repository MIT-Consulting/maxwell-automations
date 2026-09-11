import type { WsServerMessage } from "@lca/shared";
import { getControlToken } from "./api";

export type LiveSocketOptions = {
  onMessage: (msg: WsServerMessage) => void;
  /** Fired on every successful open (initial connect and each reconnect). */
  onOpen?: () => void;
  /** Fired when the socket drops (before reconnect scheduling). */
  onClose?: () => void;
  reconnectDelayMs?: number;
};

/**
 * Dashboard live bus to `/ws`. Reconnects on close, and force-reconnects when
 * the page becomes visible / the network returns — mobile browsers often leave
 * a half-open socket that never fires `onclose` until a hard refresh.
 */
export function connectLiveSocket(options: LiveSocketOptions): () => void {
  const reconnectDelayMs = options.reconnectDelayMs ?? 1500;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const detachSocket = (): void => {
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    const previous = socket;
    socket = null;
    try {
      previous.close();
    } catch {
      /* ignore */
    }
  };

  const connect = (): void => {
    if (disposed) return;
    clearReconnectTimer();
    detachSocket();

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const token = getControlToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    const next = new WebSocket(`${proto}://${window.location.host}/ws${query}`);
    socket = next;

    next.onopen = () => {
      if (disposed || socket !== next) return;
      options.onOpen?.();
    };
    next.onclose = () => {
      if (socket === next) socket = null;
      options.onClose?.();
      if (!disposed) {
        reconnectTimer = setTimeout(connect, reconnectDelayMs);
      }
    };
    next.onerror = () => {
      try {
        next.close();
      } catch {
        /* ignore */
      }
    };
    next.onmessage = (ev) => {
      if (disposed || socket !== next) return;
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as WsServerMessage;
      } catch {
        return;
      }
      options.onMessage(msg);
    };
  };

  const resume = (): void => {
    if (disposed) return;
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    // Force a fresh socket: zombie connections stay OPEN and never call onclose.
    connect();
  };

  const onVisibility = (): void => {
    if (document.visibilityState === "visible") resume();
  };
  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) resume();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", resume);
  window.addEventListener("pageshow", onPageShow);

  connect();

  return () => {
    disposed = true;
    clearReconnectTimer();
    detachSocket();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", resume);
    window.removeEventListener("pageshow", onPageShow);
  };
}
