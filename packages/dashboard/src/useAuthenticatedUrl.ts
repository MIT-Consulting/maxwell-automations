import { useEffect, useState, useSyncExternalStore } from "react";
import {
  fetchAuthenticatedBlob,
  getControlTokenVersion,
  subscribeControlTokenChange,
} from "./api";

function isDirectUrl(href: string): boolean {
  return (
    href.startsWith("blob:") ||
    href.startsWith("data:") ||
    href.startsWith("http://") ||
    href.startsWith("https://")
  );
}

/**
 * Resolve a same-origin `/api/...` path to a blob: URL via authenticated fetch.
 * Direct blob:/data:/http(s): URLs pass through unchanged.
 * Revokes the object URL on change/unmount.
 */
export function useAuthenticatedUrl(href: string | null | undefined): {
  url: string | null;
  error: string | null;
  loading: boolean;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Re-run the fetch when the control token changes so images that 401'd
  // before the operator unlocked TokenGate retry instead of staying failed.
  const tokenVersion = useSyncExternalStore(
    subscribeControlTokenChange,
    getControlTokenVersion
  );

  useEffect(() => {
    if (!href) {
      setUrl(null);
      setError(null);
      setLoading(false);
      return;
    }

    if (isDirectUrl(href)) {
      setUrl(href);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setUrl(null);

    void (async () => {
      try {
        const blob = await fetchAuthenticatedBlob(href);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setUrl(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [href, tokenVersion]);

  return { url, error, loading };
}
