import type { JSX } from "react";
import { RestartDaemonButton } from "./RestartDaemonButton";

/**
 * Application-level controls that aren't workspace-scoped (daemon lifecycle,
 * etc.). Kept as its own panel so Settings tabs stay consistent with Alerts.
 */
export function ApplicationSettingsPanel(): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-xl min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h2 className="m-0 text-base font-semibold tracking-[0.2px]">Daemon</h2>
        <p className="m-0 mt-1 text-sm text-muted-foreground">
          Restart Max when the daemon is stuck or after picking up local code
          changes. In-flight runs are interrupted; the dashboard reconnects on
          its own.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <RestartDaemonButton variant="full" className="w-fit" />
        <p className="m-0 text-xs text-muted-foreground">
          Useful for remote recovery over Tailscale when you don&apos;t have shell
          access to the host.
        </p>
      </div>
    </div>
  );
}
