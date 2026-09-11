import type { ReactNode } from "react";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type MobileFilterSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
};

/** Bottom-anchored slide-up sheet. Mirrors the Portal → Overlay → Content
 *  structure of components/ui/dialog.tsx but pins to the bottom edge. */
export function MobileFilterSheet({
  open,
  onOpenChange,
  title = "Filters",
  children,
}: MobileFilterSheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-xl border-t border-border bg-card shadow-lg outline-none duration-300",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom"
          )}
        >
          <div className="flex justify-center pt-3" aria-hidden="true">
            <div className="h-1 w-9 rounded-full bg-border" />
          </div>

          <div className="flex items-center justify-between px-4 pb-3 pt-2">
            <DialogPrimitive.Title className="text-base font-semibold tracking-[0.2px]">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close filters"
              >
                <XIcon />
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
            {children}
          </div>

          <div className="border-t border-border p-3">
            <DialogPrimitive.Close asChild>
              <Button type="button" className="w-full">
                Done
              </Button>
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
