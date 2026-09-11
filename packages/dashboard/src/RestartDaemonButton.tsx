import { useState } from "react";
import { RotateCw } from "lucide-react";
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
import { api } from "./api";

export type RestartDaemonButtonProps = {
  /**
   * `icon` — square icon trigger.
   * `full` — labelled trigger (Settings → Application).
   */
  variant?: "icon" | "full";
  className?: string;
};

/**
 * Self-contained remote-recovery control: confirms, asks the daemon to relaunch
 * itself, and leaves reconnection to the dashboard's WS loop. Lets a phone on
 * Tailscale kick a misbehaving daemon without shell access to the host. Lives
 * under Settings → Application. Calls `api.restart()` directly so it needs no
 * prop drilling.
 */
export function RestartDaemonButton({
  variant = "icon",
  className,
}: RestartDaemonButtonProps) {
  const [busy, setBusy] = useState(false);

  const onConfirm = () => {
    setBusy(true);
    // The daemon tears down its HTTP listener right after the 202, so this
    // settles (resolve or swallowed drop) quickly; clear busy once it's back to
    // the same port and the WS reconnects.
    void api.restart().finally(() => setBusy(false));
  };

  const trigger =
    variant === "full" ? (
      <Button
        type="button"
        variant="surface"
        className={className}
        disabled={busy}
        title="Restart the daemon (remote recovery)"
      >
        <RotateCw className={busy ? "animate-spin" : undefined} />
        {busy ? "Restarting…" : "Restart daemon"}
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={className}
        disabled={busy}
        aria-label="Restart daemon"
        title="Restart daemon"
      >
        <RotateCw className={busy ? "animate-spin" : undefined} />
      </Button>
    );

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Restart the daemon?</AlertDialogTitle>
          <AlertDialogDescription>
            The daemon stops and relaunches itself on the same port. In-flight
            runs are interrupted and the dashboard reconnects automatically after
            a few seconds.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Restart</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
