import { type ComponentProps, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export type ConfirmButtonProps = {
  /** Label for the resting trigger button. */
  label: ReactNode;
  /** Label for the confirm action button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Class applied to the resting trigger button. */
  className?: string;
  title?: string;
  size?: ComponentProps<typeof Button>["size"];
  onConfirm: () => void;
};

/**
 * Destructive-action button that opens a shadcn `AlertDialog` for confirmation.
 * The public contract (label / confirmLabel / className / title / onConfirm) is
 * unchanged so existing call sites keep working without edits.
 */
export function ConfirmButton({
  label,
  confirmLabel = "Confirm",
  className,
  title,
  size = "xs",
  onConfirm,
}: ConfirmButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="surface-destructive"
          size={size}
          className={className}
          title={title}
        >
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
