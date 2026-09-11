import { useEffect, useId, useState, type ReactNode } from "react";
import { Plus, Rocket, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type MobileCreateFabProps = {
  onNewAutomation: () => void;
  onRunFeaturePipeline: () => void;
};

type SpeedDialAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

/**
 * Material-style speed dial for the mobile board FAB: one primary + expands
 * into labeled secondary actions (automation vs feature pipeline).
 */
export function MobileCreateFab({
  onNewAutomation,
  onRunFeaturePipeline,
}: MobileCreateFabProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const actions: SpeedDialAction[] = [
    {
      id: "automation",
      label: "Automation",
      icon: <Plus />,
      onSelect: onNewAutomation,
    },
    {
      id: "pipeline",
      label: "Feature",
      icon: <Rocket />,
      onSelect: onRunFeaturePipeline,
    },
  ];

  const pick = (action: SpeedDialAction): void => {
    setOpen(false);
    action.onSelect();
  };

  return (
    <div className="absolute bottom-20 right-5 z-40 flex flex-col items-end gap-3.5">
      {open && (
        <button
          type="button"
          aria-label="Dismiss create menu"
          className="fixed inset-0 z-[-1] cursor-default bg-black/55"
          onClick={() => setOpen(false)}
        />
      )}

      <ul
        id={listId}
        role="menu"
        aria-label="Create"
        className={cn(
          "flex w-[min(16.5rem,calc(100vw-2.5rem))] flex-col items-stretch gap-3 transition-[opacity,transform] duration-150",
          open
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none translate-y-2 opacity-0"
        )}
      >
        {actions.map((action) => (
          <li key={action.id} role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={open ? 0 : -1}
              className="flex min-h-14 w-full items-center gap-3 rounded-2xl bg-primary px-5 py-3.5 text-base font-semibold text-primary-foreground shadow-lg active:bg-primary/90"
              onClick={() => pick(action)}
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center [&_svg]:size-6">
                {action.icon}
              </span>
              <span>{action.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <Button
        type="button"
        size="icon"
        aria-label={open ? "Close create menu" : "Create"}
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="menu"
        className="size-14 rounded-full shadow-lg"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X className="size-6" /> : <Plus className="size-6" />}
      </Button>
    </div>
  );
}
