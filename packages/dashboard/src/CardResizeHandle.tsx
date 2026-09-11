import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";
import {
  getCardPaneStore,
  type CardPaneKind,
} from "./cardPaneLayout";

type CardResizeHandleProps = {
  pane: CardPaneKind;
  height: number;
  onHeightChange: (height: number) => void;
  /** Double-click: restore the default pane height. */
  onReset?: () => void;
};

const KEYBOARD_STEP_PX = 16;

const PANE_LABEL: Record<CardPaneKind, string> = {
  log: "run log",
  prompt: "prompt",
};

export function CardResizeHandle({
  pane,
  height,
  onHeightChange,
  onReset,
}: CardResizeHandleProps) {
  const store = getCardPaneStore(pane);
  const label = PANE_LABEL[pane];
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);

  const endDrag = (target: HTMLElement, pointerId: number): void => {
    if (dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    try {
      target.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // Ignore the second click of a double-click so reset isn't a drag.
    if (event.detail > 1) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: height,
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onHeightChange(
      store.clamp(drag.startHeight + (event.clientY - drag.startY))
    );
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    endDrag(event.currentTarget, event.pointerId);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onHeightChange(store.clamp(height - KEYBOARD_STEP_PX));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onHeightChange(store.clamp(height + KEYBOARD_STEP_PX));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      onHeightChange(store.minPx);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      onHeightChange(store.maxPx);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${label}`}
      title="Drag to resize · Double-click to reset height"
      aria-valuemin={store.minPx}
      aria-valuemax={store.maxPx}
      aria-valuenow={height}
      tabIndex={0}
      className={cn(
        "absolute inset-x-0 bottom-0 z-10 h-2 translate-y-1/2 cursor-row-resize touch-none",
        "after:absolute after:inset-x-2 after:top-1/2 after:h-px after:-translate-y-1/2 after:bg-border",
        "hover:after:bg-ring focus-visible:outline-none focus-visible:after:bg-ring",
        "active:after:bg-ring"
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onReset?.();
      }}
      onKeyDown={onKeyDown}
    />
  );
}
