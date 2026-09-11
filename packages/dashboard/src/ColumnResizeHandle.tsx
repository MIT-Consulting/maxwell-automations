import {
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";
import {
  clampColumnWidth,
  OPEN_COLUMN_MAX_WIDTH_PX,
  OPEN_COLUMN_MIN_WIDTH_PX,
} from "./columnLayout";

type ColumnResizeHandleProps = {
  columnTitle: string;
  width: number;
  onWidthChange: (width: number) => void;
  /** Double-click: fit this column to its visible card titles. */
  onAutoFit?: () => void;
};

const KEYBOARD_STEP_PX = 16;

export function ColumnResizeHandle({
  columnTitle,
  width,
  onWidthChange,
  onAutoFit,
}: ColumnResizeHandleProps) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
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
    // Ignore the second click of a double-click so auto-fit isn't a drag.
    if (event.detail > 1) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const next = clampColumnWidth(drag.startWidth + (event.clientX - drag.startX));
    onWidthChange(next);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    endDrag(event.currentTarget, event.pointerId);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(clampColumnWidth(width - KEYBOARD_STEP_PX));
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(clampColumnWidth(width + KEYBOARD_STEP_PX));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      onWidthChange(OPEN_COLUMN_MIN_WIDTH_PX);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      onWidthChange(OPEN_COLUMN_MAX_WIDTH_PX);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${columnTitle} column`}
      title={`Drag to resize · Double-click to fit ${columnTitle} titles`}
      aria-valuemin={OPEN_COLUMN_MIN_WIDTH_PX}
      aria-valuemax={OPEN_COLUMN_MAX_WIDTH_PX}
      aria-valuenow={width}
      tabIndex={0}
      className={cn(
        "absolute inset-y-0 right-0 z-10 w-2 translate-x-1/2 cursor-col-resize touch-none",
        "after:absolute after:inset-y-2 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border",
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
        onAutoFit?.();
      }}
      onKeyDown={onKeyDown}
    />
  );
}
