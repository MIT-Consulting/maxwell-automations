import { useCallback, useEffect, useState, type JSX } from "react";
import {
  formatPersistedUpgradeActionsLines,
  formatRunningLabel,
  formatRunningNodeLabel,
  satisfiesNodeFloor,
  updateStateDetail,
  type DaemonStatus,
  type UpdateState,
} from "@lca/shared";
import {
  AlertCircle,
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  GitBranch,
  RefreshCw,
  Sparkles,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { RestartDaemonButton } from "./RestartDaemonButton";

type AboutSettingsPanelProps = {
  onUpdateChanged?: () => void;
};

function formatChecked(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function StateBadge({ state }: { state?: UpdateState }): JSX.Element {
  switch (state) {
    case "available":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-0.5 text-xs font-semibold text-blue-400">
          <ArrowUpCircle className="size-3.5" />
          Update available
        </span>
      );
    case "restart-required":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-semibold text-amber-400">
          <RefreshCw className="size-3.5" />
          Restart required
        </span>
      );
    case "current":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
          <CheckCircle2 className="size-3.5" />
          Up to date
        </span>
      );
    case "ahead/dev":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/40 bg-purple-500/10 px-2.5 py-0.5 text-xs font-semibold text-purple-400">
          <GitBranch className="size-3.5" />
          Factory Dev
        </span>
      );
    case "offline":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          <WifiOff className="size-3.5" />
          Offline
        </span>
      );
    case "disabled":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          Checks disabled
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          Status unknown
        </span>
      );
  }
}

export function AboutSettingsPanel({
  onUpdateChanged,
}: AboutSettingsPanelProps): JSX.Element {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await api.daemonStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      const snapshot = await api.checkForUpdate();
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              version: snapshot.running.version,
              running: snapshot.running,
              checkout: snapshot.checkout,
              available: snapshot.available,
              publicAvailable: snapshot.publicAvailable,
              updateState: snapshot.updateState,
              lastCheckedAt: snapshot.lastCheckedAt,
              releaseUrl: snapshot.releaseUrl,
              runningNode: snapshot.runningNode,
            }
          : prev
      );
      onUpdateChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const running = status?.running;
  const checkout = status?.checkout;
  const showCheckout =
    Boolean(checkout) && checkout!.version !== running?.version;
  const state = status?.updateState;
  const runningNode = status?.runningNode ?? null;
  const available = status?.available;
  const nodeFloor = available?.nodeFloor ?? null;
  const floorCheck =
    nodeFloor && runningNode
      ? satisfiesNodeFloor(runningNode, nodeFloor)
      : null;
  const unmetFloor =
    state === "available" &&
    floorCheck !== null &&
    !floorCheck.ok &&
    floorCheck.minimum !== null;
  const updateDetailInput =
    state && available
      ? { updateState: state, available, runningNode }
      : null;

  return (
    <div className="mx-auto flex w-full max-w-2xl min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 sm:p-6">
      {error && (
        <div
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          role="alert"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Hero / Branding Card */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-border bg-card p-5 shadow-xs">
        <div className="flex items-center gap-3.5">
          <div className="relative flex size-12 shrink-0 items-center justify-center rounded-xl border border-border/80 bg-gradient-to-b from-muted to-muted/40 shadow-inner">
            <span className="text-xl font-black tracking-wider text-foreground">
              M
            </span>
            <span className="absolute -bottom-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full bg-card">
              <span className="size-2 rounded-full bg-status-live" />
            </span>
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <h2 className="m-0 text-lg font-bold tracking-tight text-foreground">
                Max
              </h2>
              <span className="rounded-md border border-border/80 bg-muted/60 px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
                {running ? formatRunningLabel(running) : (status?.version ?? "…")}
              </span>
            </div>
            <p className="m-0 text-xs text-muted-foreground">
              Maxwell — local agent factory
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <StateBadge state={state} />
        </div>
      </div>

      {/* Approved Release Spotlight Banner (newer approved tag only) */}
      {state === "available" && status?.available && (
        <div className="relative overflow-hidden rounded-xl border border-blue-500/40 bg-gradient-to-b from-blue-500/10 via-blue-500/5 to-transparent p-5">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="flex size-8 items-center justify-center rounded-lg bg-blue-500/20 text-blue-400">
                  <Sparkles className="size-4.5" />
                </div>
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-400">
                    Approved Release Available
                  </span>
                  <h3 className="m-0 text-base font-bold text-foreground">
                    v{status.available.version}
                  </h3>
                </div>
              </div>

              {(status.releaseUrl || status.available.url) && (
                <a
                  href={status.releaseUrl ?? status.available.url ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/15 px-3 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-500/25 hover:border-blue-500/50 hover:text-white transition-colors cursor-pointer"
                >
                  <span>Release Notes</span>
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>

            {status.available.notes && (
              <div className="rounded-lg border border-border/80 bg-background/60 p-3.5 text-xs font-mono leading-relaxed text-muted-foreground whitespace-pre-wrap">
                {status.available.notes}
              </div>
            )}

            {(nodeFloor || runningNode) && (
              <div className="rounded-lg border border-border/80 bg-background/60 p-3.5 text-xs text-muted-foreground">
                <p className="m-0 font-medium text-foreground">Node requirement</p>
                <p className="m-0 mt-1">
                  Required:{" "}
                  <span className="font-mono text-foreground">
                    {nodeFloor ?? "unknown"}
                  </span>
                  {" · "}
                  Running:{" "}
                  <span className="font-mono text-foreground">
                    {runningNode ? formatRunningNodeLabel(runningNode) : "unknown"}
                  </span>
                </p>
                {unmetFloor && (
                  <p className="m-0 mt-2 text-amber-300/90">
                    Install Node {nodeFloor?.replace(/^>=\s*/, "") ?? "22 LTS"} from{" "}
                    <a
                      href="https://nodejs.org/en/download"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-amber-200"
                    >
                      nodejs.org
                    </a>
                    , then retry Check now.
                  </p>
                )}
              </div>
            )}

            {available && (
              <div className="rounded-lg border border-border/80 bg-background/60 p-3.5 text-xs text-muted-foreground">
                <p className="m-0 font-medium text-foreground">Upgrade actions</p>
                <ul className="m-0 mt-1.5 list-none space-y-1 pl-0 font-mono">
                  {formatPersistedUpgradeActionsLines(available.upgradeActions).map(
                    (line) => (
                      <li key={line} className="whitespace-pre-wrap">
                        {line}
                      </li>
                    )
                  )}
                </ul>
              </div>
            )}

            {state && (
              <p className="m-0 text-xs text-muted-foreground">
                {updateStateDetail(state, updateDetailInput)}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Restart Required Alert (when restart-required without available release) */}
      {!status?.available && state === "restart-required" && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-5">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-400">
              <RefreshCw className="size-4" />
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-sm font-semibold text-amber-300">
                Restart Required
              </h3>
              <p className="m-0 text-xs text-muted-foreground">
                {updateStateDetail("restart-required")}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Version Identities & Environment Details */}
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-3">
          <div>
            <h3 className="m-0 text-sm font-semibold tracking-wide text-foreground">
              Version &amp; Build
            </h3>
            <p className="m-0 mt-0.5 text-xs text-muted-foreground">
              Running binary, disk checkout, and release channel
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-muted-foreground">
              Last checked {formatChecked(status?.lastCheckedAt)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs cursor-pointer border-border/80 hover:bg-muted"
              disabled={checking}
              onClick={() => void checkNow()}
            >
              <RefreshCw className={cn("size-3.5", checking && "animate-spin")} />
              <span>{checking ? "Checking…" : "Check now"}</span>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3.5">
            <span className="text-muted-foreground font-medium">
              Running Version
            </span>
            <span className="font-mono text-sm font-semibold text-foreground">
              {running ? formatRunningLabel(running) : (status?.version ?? "…")}
            </span>
            <span className="text-[11px] text-muted-foreground capitalize">
              Channel: {running?.channel ?? "unknown"}
            </span>
          </div>

          {showCheckout && checkout ? (
            <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3.5">
              <span className="text-muted-foreground font-medium">
                Checkout on Disk
              </span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {formatRunningLabel(checkout)}
              </span>
              <span className="text-[11px] text-muted-foreground capitalize">
                Channel: {checkout.channel}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3.5">
              <span className="text-muted-foreground font-medium">
                Disk Checkout
              </span>
              <span className="font-mono text-sm font-semibold text-foreground">
                {checkout ? formatRunningLabel(checkout) : "Matches running build"}
              </span>
              <span className="text-[11px] text-muted-foreground">
                In sync with running binary
              </span>
            </div>
          )}

          <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3.5">
            <span className="text-muted-foreground font-medium">
              Update State
            </span>
            <span className="font-semibold text-foreground capitalize">
              {state ?? "Unknown"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {state ? updateStateDetail(state, updateDetailInput) : "No state reported"}
            </span>
          </div>

          <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-3.5">
            <span className="text-muted-foreground font-medium">
              Release Source
            </span>
            <span className="font-semibold text-foreground">
              {status?.available
                ? `Approved: v${status.available.version}`
                : "Configured pin"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {status?.publicAvailable
                ? `Public latest: v${status.publicAvailable.version} (informational)`
                : "Local & org-managed"}
            </span>
          </div>
        </div>

        {status?.publicAvailable && !status.available && (
          <p className="m-0 text-xs text-muted-foreground">
            Public latest {status.publicAvailable.version} (informational)
          </p>
        )}
      </section>

      {/* Legal & Licenses */}
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="m-0 text-sm font-semibold tracking-wide text-foreground">
              License
            </h3>
            <p className="m-0 mt-0.5 text-xs text-muted-foreground">
              Apache License 2.0
            </p>
          </div>

          <div className="flex items-center gap-2">
            <a
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted hover:border-border/80 transition-colors cursor-pointer"
              href="/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileText className="size-3.5 text-muted-foreground" />
              <span>License</span>
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
            <a
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted hover:border-border/80 transition-colors cursor-pointer"
              href="/NOTICE"
              target="_blank"
              rel="noopener noreferrer"
            >
              <FileText className="size-3.5 text-muted-foreground" />
              <span>Notice</span>
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          </div>
        </div>
      </section>

      {/* Daemon Management */}
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
        <div>
          <h3 className="m-0 text-sm font-semibold tracking-wide text-foreground">
            Daemon
          </h3>
          <p className="m-0 mt-1 text-xs text-muted-foreground leading-relaxed">
            Restart Max when the daemon is stuck or after picking up local code
            changes. In-flight runs are interrupted; the dashboard reconnects on
            its own. This does not install a release.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-border/60">
          <RestartDaemonButton variant="full" className="w-fit" />
          <p className="m-0 text-xs text-muted-foreground">
            Useful for remote recovery over Tailscale when you don&apos;t have
            shell access to the host.
          </p>
        </div>
      </section>
    </div>
  );
}
