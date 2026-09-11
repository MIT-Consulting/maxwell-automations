import { useEffect, useState } from "react";

/** True when the primary input can hover (mouse/trackpad). False on touch-first. */
export const CAN_HOVER_QUERY = "(hover: hover)";

export function useCanHover(): boolean {
  const [canHover, setCanHover] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return true;
    }
    return window.matchMedia(CAN_HOVER_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(CAN_HOVER_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setCanHover(event.matches);
    };
    setCanHover(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return canHover;
}
