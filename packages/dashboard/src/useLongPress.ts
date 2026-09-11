import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export type LongPressHandlers = {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerLeave: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
};

export function useLongPress(
  callback: () => void,
  opts?: { delayMs?: number; moveThresholdPx?: number }
): LongPressHandlers {
  const delayMs = opts?.delayMs ?? 450;
  const moveThresholdPx = opts?.moveThresholdPx ?? 10;
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const clearTimer = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent): void => {
      clearTimer();
      startRef.current = { x: e.clientX, y: e.clientY };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        startRef.current = null;
        callbackRef.current();
      }, delayMs);
    },
    [clearTimer, delayMs]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent): void => {
      const start = startRef.current;
      if (!start || timerRef.current === null) return;
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > moveThresholdPx || dy > moveThresholdPx) {
        clearTimer();
      }
    },
    [clearTimer, moveThresholdPx]
  );

  const onPointerUp = useCallback((): void => {
    clearTimer();
  }, [clearTimer]);

  const onPointerLeave = useCallback((): void => {
    clearTimer();
  }, [clearTimer]);

  const onPointerCancel = useCallback((): void => {
    clearTimer();
  }, [clearTimer]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
  };
}
