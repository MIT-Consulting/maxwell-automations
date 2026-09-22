import { useCallback, useEffect, useState } from "react";
import type { DaemonStatus } from "@lca/shared";
import { api } from "./api";

/** Local status for the update chip. Does not call GitHub. */
export function useDaemonStatus(connected: boolean): {
  status: DaemonStatus | null;
  reload: () => Promise<void>;
} {
  const [status, setStatus] = useState<DaemonStatus | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.daemonStatus());
    } catch {
      /* Chip is optional chrome. */
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    void reload();
    const later = window.setTimeout(() => void reload(), 8000);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(later);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connected, reload]);

  return { status, reload };
}
