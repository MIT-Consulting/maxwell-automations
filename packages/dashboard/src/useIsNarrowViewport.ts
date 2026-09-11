import { useEffect, useState } from "react";

export const NARROW_VIEWPORT_QUERY = "(max-width: 720px)";

export function useIsNarrowViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setIsNarrow(event.matches);
    };
    setIsNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isNarrow;
}
