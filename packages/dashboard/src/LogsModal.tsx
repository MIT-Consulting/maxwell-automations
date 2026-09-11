import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Play, SkipForward, X, XCircle } from "lucide-react";
import type {
  ChatSession,
  ModelSelection,
  Run,
  RunEscalationAction,
} from "@lca/shared";
import { modelSelectionsEqual } from "@lca/shared";
import { api } from "./api";
import { AgentCompose } from "./AgentCompose";
import { InputRequestPanel } from "./InputRequestPanel";
import { selectionLabel } from "./modelControls";
import { ModelSelect } from "./ModelSelect";
import {
  comparePipelineRunOrder,
  escalationActionGates,
  isHaltedPipelineRun,
  pipelineChipLabelForRun,
} from "./pipelineGrouping";
import { Transcript } from "./transcript";
import { useAvailableModels } from "./useAvailableModels";
import { useRunStream } from "./useRunStream";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatTimestamp } from "./helpers";
import { useIsNarrowViewport } from "./useIsNarrowViewport";

const RUN_MODAL_SIZE_KEY = "lca.runModalSize";

type RunModalSize = { width?: number; height?: number };

function positiveSize(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.round(value);
}

function loadRunModalSize(): RunModalSize {
  try {
    const raw = localStorage.getItem(RUN_MODAL_SIZE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown };
    const width = positiveSize(parsed.width);
    const height = positiveSize(parsed.height);
    if (width === undefined && height === undefined) return {};
    return {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  } catch {
    return {};
  }
}

function saveRunModalSize(width: number, height: number): void {
  try {
    localStorage.setItem(
      RUN_MODAL_SIZE_KEY,
      JSON.stringify({ width, height })
    );
  } catch {
    /* storage unavailable (private mode) */
  }
}

function readObservedSize(entry: ResizeObserverEntry): {
  width: number;
  height: number;
} {
  const box = entry.borderBoxSize?.[0];
  if (box) {
    return {
      width: Math.round(box.inlineSize),
      height: Math.round(box.blockSize),
    };
  }
  return {
    width: Math.round(entry.contentRect.width),
    height: Math.round(entry.contentRect.height),
  };
}

function isTerminalStatus(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function RunCompose({
  runId,
  runStatus,
  pendingQuestion,
  canContinue,
  workspaceId,
  onTypeaheadOpenChange,
  modelOverride,
  defaultLabel,
  modelSaving,
  onModelChange,
  onResync,
}: {
  runId: string;
  runStatus: Run["status"];
  pendingQuestion: string | null;
  canContinue: boolean;
  workspaceId?: string;
  onTypeaheadOpenChange?: (open: boolean) => void;
  modelOverride: ModelSelection | null;
  defaultLabel: string;
  modelSaving: boolean;
  onModelChange: (next: ModelSelection | null) => void;
  onResync: () => void;
}) {
  return (
    <AgentCompose
      status={runStatus}
      canContinue={canContinue}
      workspaceId={workspaceId}
      pendingQuestion={pendingQuestion}
      onTypeaheadOpenChange={onTypeaheadOpenChange}
      onAnswer={async (text) => {
        await api.answer(runId, text);
        onResync();
      }}
      onUploadAttachment={(file) => api.uploadRunAttachment(runId, file)}
      attachmentUrl={(id) => api.runAttachmentUrl(runId, id)}
      onQueue={async (text, attachments) => {
        await api.queueMessage(runId, text, attachments);
        onResync();
      }}
      onSend={async (text, attachments) => {
        await api.sendMessage(runId, text, attachments);
        onResync();
      }}
      onInterrupt={async (text, attachments) => {
        await api.interrupt(runId, text, attachments);
        onResync();
      }}
      toolbarLeft={
        <ModelSelect
          id={`run-model-${runId}`}
          value={modelOverride}
          onChange={onModelChange}
          defaultLabel={defaultLabel}
          disabled={modelSaving}
          commitOnBlur
          variant="ghost"
        />
      }
    />
  );
}

function LineageEscalateButton({
  action,
  label,
  icon,
  enabled,
  title,
  onConfirm,
}: {
  action: RunEscalationAction;
  label: string;
  icon: ReactNode;
  enabled: boolean;
  title?: string;
  onConfirm: (action: RunEscalationAction, reason?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const needsReason = action === "skip" || action === "abort";

  if (!enabled) {
    return (
      <Button type="button" variant="outline" size="sm" disabled title={title}>
        {label}
      </Button>
    );
  }

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) setReason("");
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" title={title ?? label}>
          <span className="mr-1 inline-flex">{icon}</span>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{label} this pipeline step?</AlertDialogTitle>
          <AlertDialogDescription>
            Confirm before spending a model turn or stopping the pipeline.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {needsReason && (
          <Input
            className="h-8 text-xs"
            placeholder="Optional reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={action === "abort" ? "destructive" : "default"}
            onClick={() =>
              onConfirm(action, reason.trim() ? reason.trim() : undefined)
            }
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const DESKTOP_MODAL_CLASS =
  "flex min-h-[320px] min-w-[420px] max-h-[92vh] max-w-[92vw] resize flex-col gap-0 overflow-hidden p-0 sm:max-w-[92vw]";

const MOBILE_MODAL_CLASS =
  "inset-0 flex h-dvh w-full min-h-0 min-w-0 max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 resize-none";

export function LogsModal({
  runId,
  workspaceId,
  workspaceName,
  automationName,
  configKey,
  hasSuccessor = false,
  modelOverride,
  automationSelection,
  startedAt,
  createdAt,
  lineageRuns,
  onOpenRun,
  onEscalate,
  escalationError,
  onClose,
  onPromoteSuccess,
  onRunUpdated,
}: {
  runId: string;
  workspaceId?: string;
  workspaceName?: string;
  automationName?: string;
  configKey?: string | null;
  hasSuccessor?: boolean;
  /** Persisted per-run override; null/undefined = automation fall-through. */
  modelOverride?: ModelSelection | null;
  automationSelection?: ModelSelection | null;
  startedAt?: string | null;
  createdAt?: string | null;
  /** Pipeline peers (same root), already filtered by App. */
  lineageRuns?: Run[];
  onOpenRun?: (id: string) => void;
  onEscalate?: (action: RunEscalationAction, reason?: string) => void;
  escalationError?: string | null;
  onClose: () => void;
  onPromoteSuccess?: (chat: ChatSession) => void;
  onRunUpdated?: (run: Run) => void;
}) {
  const { models: availableModels, defaultModel } = useAvailableModels();
  const automationLabel = automationSelection
    ? selectionLabel(automationSelection, availableModels)
    : defaultModel;
  const modelDefaultLabel = `Default (${automationLabel})`;
  const startedLabel = formatTimestamp(startedAt ?? createdAt);
  const isNarrowViewport = useIsNarrowViewport();
  const { messages, runStatus, pendingInput, pendingQuestion, canContinue, error, resync } =
    useRunStream(runId);
  // Only suppress the free-form compose answer route when the constrained
  // panel can actually render (it needs the run's authoritative workspace).
  const structuredPending =
    Boolean(pendingInput?.metadata?.choices?.length) &&
    runStatus === "needs_input" &&
    Boolean(workspaceId);

  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [composeTypeaheadOpen, setComposeTypeaheadOpen] = useState(false);
  const canStop =
    runStatus === "queued" ||
    runStatus === "running" ||
    runStatus === "needs_input" ||
    runStatus === "paused";
  const canPause = runStatus === "running";
  const canResume = runStatus === "paused";
  const canPromoteToChat =
    isTerminalStatus(runStatus) && canContinue && Boolean(workspaceId);

  const currentRun = useMemo(
    () => lineageRuns?.find((r) => r.id === runId) ?? null,
    [lineageRuns, runId]
  );
  const halted = currentRun ? isHaltedPipelineRun(currentRun) : false;
  const gates = currentRun
    ? escalationActionGates(currentRun, hasSuccessor)
    : null;

  const orderedLineage = useMemo(() => {
    if (!lineageRuns || lineageRuns.length === 0) return [];
    return [...lineageRuns].sort(comparePipelineRunOrder);
  }, [lineageRuns]);

  const stopRun = async () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await api.cancel(runId);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const pauseRun = async () => {
    if (pausing) return;
    setPausing(true);
    setStopError(null);
    try {
      await api.pause(runId);
      resync();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setPausing(false);
    }
  };

  const resumeRun = async () => {
    if (resuming) return;
    setResuming(true);
    setStopError(null);
    try {
      await api.resume(runId);
      resync();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setResuming(false);
    }
  };

  const promoteRun = async () => {
    if (promoting) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const chat = await api.promoteRunToChat(runId);
      onPromoteSuccess?.(chat);
      onClose();
    } catch (err) {
      setPromoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setPromoting(false);
    }
  };

  const changeModel = async (next: ModelSelection | null): Promise<void> => {
    if (modelSaving) return;
    if (modelSelectionsEqual(modelOverride ?? null, next)) return;
    setModelSaving(true);
    setStopError(null);
    try {
      const updated = await api.updateRun(runId, { modelSelection: next });
      onRunUpdated?.(updated);
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelSaving(false);
    }
  };

  const [modalSeed] = useState(() => {
    const stored = loadRunModalSize();
    return {
      width: stored.width ?? 820,
      height: stored.height,
    };
  });

  const contentRef = useRef<HTMLDivElement | null>(null);
  const skipFirstResizeRef = useRef(true);

  useEffect(() => {
    if (isNarrowViewport) return;
    const node = contentRef.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (skipFirstResizeRef.current) {
        skipFirstResizeRef.current = false;
        return;
      }
      // Only persist deliberate resizes. Dragging the native grip makes the
      // browser write an explicit inline height; while height is auto
      // (style.height === ""), size changes come from streaming transcript
      // content or the auto-growing compose box, not the user.
      if (node.style.height === "") return;
      const { width, height } = readObservedSize(entry);
      saveRunModalSize(width, height);
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [isNarrowViewport]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        ref={contentRef}
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (composeTypeaheadOpen) event.preventDefault();
        }}
        style={
          isNarrowViewport
            ? undefined
            : { width: modalSeed.width, height: modalSeed.height }
        }
        className={isNarrowViewport ? MOBILE_MODAL_CLASS : DESKTOP_MODAL_CLASS}
      >
        <DialogHeader className="space-y-0 border-b border-border px-4 py-3 text-left">
          <div className="flex flex-row items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col">
              <DialogTitle className="truncate text-sm font-semibold">
                {automationName ?? `Run ${runId.slice(0, 8)}`}
              </DialogTitle>
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {workspaceName && (
                  <span
                    className="min-w-0 truncate rounded border border-border bg-muted px-1.5 py-0.5"
                    title={workspaceName}
                  >
                    {workspaceName}
                  </span>
                )}
                <span className="shrink-0 font-mono">{runId.slice(0, 8)}</span>
                {startedLabel && (
                  <span className="shrink-0">· {startedLabel}</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {halted && onEscalate && gates && (
                <>
                  <LineageEscalateButton
                    action="retry"
                    label="Retry"
                    icon={<Play className="size-3.5" aria-hidden="true" />}
                    enabled={gates.retry.enabled}
                    title={gates.retry.title}
                    onConfirm={onEscalate}
                  />
                  <LineageEscalateButton
                    action="skip"
                    label="Skip"
                    icon={
                      <SkipForward className="size-3.5" aria-hidden="true" />
                    }
                    enabled={gates.skip.enabled}
                    title={gates.skip.title}
                    onConfirm={onEscalate}
                  />
                  <LineageEscalateButton
                    action="abort"
                    label="Abort"
                    icon={<XCircle className="size-3.5" aria-hidden="true" />}
                    enabled={gates.abort.enabled}
                    title={gates.abort.title}
                    onConfirm={onEscalate}
                  />
                </>
              )}
              {canPromoteToChat && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={promoting}
                  onClick={() => void promoteRun()}
                >
                  {promoting ? "Promoting..." : "Continue as chat"}
                </Button>
              )}
              {canPause && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pausing}
                  onClick={() => void pauseRun()}
                >
                  {pausing ? "Pausing..." : "Pause"}
                </Button>
              )}
              {canResume && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={resuming}
                  onClick={() => void resumeRun()}
                >
                  {resuming ? "Resuming..." : "Resume"}
                </Button>
              )}
              {canStop && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={stopping}
                  onClick={() => void stopRun()}
                >
                  {stopping ? "Stopping..." : "Stop"}
                </Button>
              )}
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Close"
                >
                  <X />
                </Button>
              </DialogClose>
            </div>
          </div>
          {orderedLineage.length > 0 && (
            <div
              className="no-scrollbar mt-2 flex gap-1 overflow-x-auto pb-0.5"
              role="navigation"
              aria-label="Pipeline lineage"
            >
              {orderedLineage.map((r) => {
                const label = r.pipeline
                  ? pipelineChipLabelForRun(r, r.id === runId ? configKey : null)
                  : r.id.slice(0, 8);
                const current = r.id === runId;
                return (
                  <button
                    key={r.id}
                    type="button"
                    disabled={!onOpenRun}
                    title={
                      onOpenRun
                        ? `Open run ${r.id}`
                        : "Run not available in loaded list"
                    }
                    className={cn(
                      "shrink-0 rounded border px-2 py-1 text-[11px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      current
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-muted text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => onOpenRun?.(r.id)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </DialogHeader>

        {(error || stopError || promoteError || escalationError) && (
          <div className="px-4 py-3 text-sm text-destructive">
            {escalationError ?? error ?? stopError ?? promoteError}
          </div>
        )}

        <Transcript
          messages={messages}
          runStatus={runStatus}
          pendingQuestion={pendingQuestion}
        />
        {structuredPending && pendingInput && workspaceId && (
          <div className="border-t border-border px-4 py-2">
            <InputRequestPanel
              request={pendingInput}
              workspaceId={workspaceId}
              onSubmit={(answer) => api.answer(runId, answer)}
              canPromoteToChat={canContinue}
              onPromoteToChat={async () => {
                const chat = await api.promoteRunToChat(runId);
                onPromoteSuccess?.(chat);
                onClose();
              }}
              className="mt-0"
            />
          </div>
        )}
        <RunCompose
          runId={runId}
          runStatus={runStatus}
          pendingQuestion={structuredPending ? null : pendingQuestion}
          canContinue={canContinue}
          workspaceId={workspaceId}
          onTypeaheadOpenChange={setComposeTypeaheadOpen}
          modelOverride={modelOverride ?? null}
          defaultLabel={modelDefaultLabel}
          modelSaving={modelSaving}
          onModelChange={(next) => void changeModel(next)}
          onResync={resync}
        />
      </DialogContent>
    </Dialog>
  );
}
