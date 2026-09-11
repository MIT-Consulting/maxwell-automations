import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowRight,
  Copy,
  CornerUpLeft,
  GitBranch,
  Pencil,
  Play,
  Power,
  PowerOff,
  ScrollText,
  SkipForward,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import type {
  Automation,
  InputRequest,
  ModelInfo,
  ModelSelection,
  Run,
  RunEscalationAction,
} from "@lca/shared";
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
import { useCardPaneHeight } from "./cardPaneLayout";
import { CardResizeHandle } from "./CardResizeHandle";
import { ConfirmButton } from "./ConfirmButton";
import { InputRequestPanel } from "./InputRequestPanel";
import { isLocallyResumableAgentIdentity } from "./haltDiscoveryPromotionUi";
import { PromptReferenceText } from "./PromptReferenceText";
import { PromptReferenceViewer } from "./PromptReferenceViewer";
import { HeroExpandDialog } from "./HeroExpandDialog";
import { useLongPress } from "./useLongPress";
import { useIsNarrowViewport } from "./useIsNarrowViewport";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/StatusDot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { modelChipLabel, modelChipShortLabel } from "./modelControls";
import { FilesDocLink } from "./FilesDocLink";
import {
  effectiveChainBudget,
  escalationActionGates,
  isHaltedPipelineRun,
  pipelineChipLabelForRun,
} from "./pipelineGrouping";
import { effectivePhaseFileForRun, pipelineRunDocPathInDir } from "./pipelineDocLinks";
import { useFeatureRoadmapDir } from "./useFeatureRoadmapDir";
import { Transcript } from "./transcript";
import { useRunStream } from "./useRunStream";
import {
  TRIGGER_ICON,
  formatElapsed,
  formatRelativeToNow,
  formatTimestamp,
  triggerKindIcon,
  triggerKindLabel,
  triggerLabel,
  useNow,
} from "./helpers";

const CARD_BASE =
  "gap-0 rounded-md border border-border bg-muted p-2.5 text-card-foreground shadow-none";

function WorkspaceChip({ name }: { name: string }) {
  return (
    <Badge
      variant="outline"
      className="max-w-[60%] rounded-[6px] border-border bg-card font-normal text-muted-foreground"
    >
      <span className="truncate">{name}</span>
    </Badge>
  );
}

function ModelChip({
  selection,
  models,
}: {
  selection: ModelSelection | null;
  models: ModelInfo[];
}) {
  const shortLabel = modelChipShortLabel(selection, models);
  const fullLabel = modelChipLabel(selection, models);
  return (
    <Badge
      variant="outline"
      className="max-w-[10rem] min-w-0 shrink rounded-[6px] border-border bg-card font-mono text-[10px] font-normal text-muted-foreground"
      title={fullLabel}
    >
      <span className="truncate">{shortLabel}</span>
    </Badge>
  );
}

function ChainedChip({ parentRunId }: { parentRunId: string }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 rounded-[6px] border-border bg-card text-[10px] font-normal uppercase tracking-[0.3px] text-muted-foreground"
      title={`Chained from run ${parentRunId}`}
    >
      chained
    </Badge>
  );
}

function PipelineChip({
  run,
  configKey,
  halted,
}: {
  run: Run;
  configKey: string | null | undefined;
  halted: boolean;
}) {
  const summary = run.pipeline!;
  const label = pipelineChipLabelForRun(run, configKey);
  const budget = effectiveChainBudget(run);
  const depth =
    typeof run.chainDepth === "number" ? String(run.chainDepth) : "?";
  const budgetLabel = budget != null ? String(budget) : "?";
  const root = run.chainRootRunId ?? "?";
  const featureDir = useFeatureRoadmapDir(run.workspaceId, summary.featureSlug);
  const docPath = pipelineRunDocPathInDir(featureDir, effectivePhaseFileForRun(run));
  const title = [
    `pipeline ${summary.pipelineId}`,
    `root ${root}`,
    `depth ${depth}/${budgetLabel}`,
    docPath ? `docs ${docPath}` : null,
    halted ? "pipeline stopped here" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const chipClass =
    "max-w-[12rem] shrink-0 truncate rounded-[6px] border-border bg-card text-[10px] font-normal text-muted-foreground";

  if (docPath) {
    return (
      <Badge variant="outline" className={chipClass} title={title} asChild>
        <FilesDocLink
          workspaceId={run.workspaceId}
          path={docPath}
          className="text-muted-foreground no-underline hover:text-primary hover:underline"
          title={title}
        >
          {label}
        </FilesDocLink>
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={chipClass} title={title}>
      {label}
    </Badge>
  );
}

function EscalationConfirmButton({
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
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled
        title={title}
        aria-label={label}
      >
        {icon}
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
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          title={title ?? label}
          aria-label={label}
        >
          {icon}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{label} this pipeline step?</AlertDialogTitle>
          <AlertDialogDescription>
            {action === "retry" &&
              "Re-run this step at the same depth with the stored prompt."}
            {action === "skip" &&
              "Enqueue the successor as if this step finished by hand."}
            {action === "abort" &&
              "Stop the pipeline here. This cannot be undone."}
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

function InlineRunLog({ runId }: { runId: string }) {
  const isNarrow = useIsNarrowViewport();
  const sourceRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [logHeight, setLogHeight, logPane] = useCardPaneHeight("log");
  const { messages, runStatus, pendingQuestion, error } = useRunStream(runId);
  const emptyJumpLabel = `status: ${runStatus}`;

  return (
    <>
      <div className="relative mt-2">
        <div
          ref={sourceRef}
          className="flex min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card"
          style={{ height: logHeight }}
        >
          {error && (
            <div className="shrink-0 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </div>
          )}
          <Transcript
            messages={messages}
            runStatus={runStatus}
            pendingQuestion={pendingQuestion}
            showToolbar={false}
            showPromptJump
            promptJumpEmptyLabel={isNarrow ? emptyJumpLabel : undefined}
            onExpandPromptJump={
              isNarrow ? () => setFullscreen(true) : undefined
            }
          />
        </div>
        <CardResizeHandle
          pane="log"
          height={logHeight}
          onHeightChange={setLogHeight}
          onReset={logPane.reset}
        />
      </div>
      {isNarrow ? (
        <HeroExpandDialog
          open={fullscreen}
          onOpenChange={setFullscreen}
          sourceRef={sourceRef}
          title="log"
          header={
            error ? (
              <div className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null
          }
        >
          <Transcript
            messages={messages}
            runStatus={runStatus}
            pendingQuestion={pendingQuestion}
            showToolbar={false}
            showPromptJump
            promptJumpEmptyLabel={emptyJumpLabel}
          />
        </HeroExpandDialog>
      ) : null}
    </>
  );
}

export type AutomationCardProps = {
  automation: Automation;
  workspaceName: string;
  /** When false (single-workspace board scope), hide the redundant workspace chip. */
  showWorkspace?: boolean;
  lastRunStatus: Run["status"] | null;
  models: ModelInfo[];
  onDragStart: () => void;
  onDragEnd: () => void;
  onRun: () => void;
  onToggleEnabled: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onLongPress?: () => void;
  /** Narrow viewport: a tap on the card toggles the prompt expander. */
  tapExpands?: boolean;
};

export function AutomationCard({
  automation,
  workspaceName,
  showWorkspace = false,
  lastRunStatus,
  models,
  onDragStart,
  onDragEnd,
  onRun,
  onToggleEnabled,
  onEdit,
  onDelete,
  onDuplicate,
  selectionMode = false,
  selected = false,
  onToggleSelect,
  onLongPress,
  tapExpands = false,
}: AutomationCardProps) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptHeight, setPromptHeight, promptPane] =
    useCardPaneHeight("prompt");
  const isDashboardOrigin = automation.origin === "dashboard";
  const promptPreview =
    automation.prompt.split(/\r?\n/, 1)[0]?.trim() || "prompt";
  const showNextRun =
    automation.enabled &&
    automation.trigger.type === "cron" &&
    Boolean(automation.nextRunAt);
  const longPressedRef = useRef(false);
  const longPress = useLongPress(() => {
    longPressedRef.current = true;
    onLongPress?.();
  });
  const longPressHandlers = onLongPress
    ? {
        ...longPress,
        onPointerDown: (e: ReactPointerEvent) => {
          longPressedRef.current = false;
          longPress.onPointerDown(e);
        },
      }
    : {};

  return (
    <Card
      draggable={!selectionMode}
      onDragStart={selectionMode ? undefined : onDragStart}
      onDragEnd={selectionMode ? undefined : onDragEnd}
      className={cn(
        CARD_BASE,
        "group relative",
        selectionMode || tapExpands ? "cursor-pointer" : "cursor-grab",
        selected && "border-ring"
      )}
      onClick={
        selectionMode
          ? () => {
              if (longPressedRef.current) {
                longPressedRef.current = false;
                return;
              }
              onToggleSelect?.();
            }
          : tapExpands
            ? () => {
                if (longPressedRef.current) {
                  longPressedRef.current = false;
                  return;
                }
                setPromptExpanded((v) => !v);
              }
            : undefined
      }
      {...longPressHandlers}
    >
      {selectionMode && (
        <label
          className="absolute right-2 top-2 flex cursor-pointer items-center"
          onClick={(e) => e.stopPropagation()}
          title="Select automation"
        >
          <input
            type="checkbox"
            className="m-0 cursor-pointer accent-primary"
            checked={selected}
            onChange={() => onToggleSelect?.()}
          />
        </label>
      )}

      <div className={cn("flex items-center gap-2", selectionMode && "pr-5")}>
        <span className="text-sm" title={triggerLabel(automation.trigger)}>
          {TRIGGER_ICON[automation.trigger.type]}
        </span>
        <span
          className="flex-1 truncate font-semibold"
          title={automation.name}
        >
          {automation.name}
        </span>
        {automation.origin === "config" && (
          <Badge
            variant="outline"
            className="rounded-[6px] border-status-needs-input/40 bg-status-needs-input/10 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-[0.3px] text-status-needs-input"
          >
            from config
          </Badge>
        )}
        {lastRunStatus && (
          <StatusDot status={lastRunStatus} title={lastRunStatus} />
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
          {showWorkspace ? <WorkspaceChip name={workspaceName} /> : null}
          <ModelChip
            selection={automation.modelSelection}
            models={models}
          />
        </div>
        {automation.trigger.type !== "manual" && (
          <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
            {triggerLabel(automation.trigger)}
          </span>
        )}
      </div>

      <div className="mt-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {promptExpanded ? (
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center border-none bg-transparent p-0 text-left text-[11px] hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                setPromptExpanded((v) => !v);
              }}
              title="Collapse prompt"
              aria-expanded
            >
              <span className="mr-1 shrink-0 text-muted-foreground">▾</span>
              <span className="text-muted-foreground">prompt</span>
            </button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center border-none bg-transparent p-0 text-left text-[11px] hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPromptExpanded((v) => !v);
                  }}
                  aria-label="Expand prompt"
                  aria-expanded={false}
                >
                  <span className="mr-1 shrink-0 text-muted-foreground">▸</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
                    {promptPreview}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                align="start"
                sideOffset={6}
                showArrow={false}
                className="column-scrollbar max-h-64 max-w-xl overflow-y-auto border border-border bg-card px-2.5 py-2 text-left text-pretty text-card-foreground shadow-md"
              >
                <PromptReferenceText
                  text={automation.prompt}
                  className="font-mono text-[11px] text-muted-foreground"
                />
              </TooltipContent>
            </Tooltip>
          )}

          {!selectionMode && (
            <div
              className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                title="Run"
                aria-label="Run automation"
                onClick={onRun}
              >
                <Play />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                title={automation.enabled ? "Disable" : "Enable"}
                aria-label={
                  automation.enabled
                    ? "Disable automation"
                    : "Enable automation"
                }
                onClick={onToggleEnabled}
              >
                {automation.enabled ? <Power /> : <PowerOff />}
              </Button>
              {onDuplicate && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  title="Duplicate"
                  aria-label="Duplicate automation"
                  onClick={onDuplicate}
                >
                  <Copy />
                </Button>
              )}
              {isDashboardOrigin && onEdit && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  title="Edit"
                  aria-label="Edit automation"
                  onClick={onEdit}
                >
                  <Pencil />
                </Button>
              )}
              {isDashboardOrigin && onDelete && (
                <ConfirmButton
                  label={<Trash2 aria-hidden="true" />}
                  confirmLabel="Delete"
                  size="icon-xs"
                  title="Delete"
                  onConfirm={onDelete}
                />
              )}
            </div>
          )}
        </div>
        {promptExpanded && (
          <div className="relative mt-1.5" style={{ height: promptHeight }}>
            <PromptReferenceViewer
              text={automation.prompt}
              className="h-full"
            />
            <CardResizeHandle
              pane="prompt"
              height={promptHeight}
              onHeightChange={setPromptHeight}
              onReset={promptPane.reset}
            />
          </div>
        )}
      </div>

      {showNextRun && (
        <div
          className="mt-1.5 text-[11px] text-muted-foreground"
          title={formatTimestamp(automation.nextRunAt) ?? undefined}
        >
          Next run {formatRelativeToNow(automation.nextRunAt)} ·{" "}
          {formatTimestamp(automation.nextRunAt)}
        </div>
      )}
    </Card>
  );
}

export type RunCardProps = {
  run: Run;
  automationName: string;
  workspaceName: string;
  /** When false (single-workspace board scope), hide the redundant workspace chip. */
  showWorkspace?: boolean;
  /** Automation config key — needed for pipeline step labels. */
  configKey?: string | null;
  /** Whether the automation has a configured chain successor. */
  hasSuccessor?: boolean;
  selection: ModelSelection | null;
  models: ModelInfo[];
  triggerKind: string | null;
  lastEvent: string | undefined;
  pendingInput: InputRequest | undefined;
  onViewLogs: () => void;
  onCancel: () => void;
  onAnswer: (answer: string) => void | Promise<void>;
  /** Durable halt-discovery briefing → chat; absent keeps generic panel. */
  onPromoteToChat?: () => void | Promise<void>;
  onOpenRun?: (runId: string) => void;
  parentRunLoaded?: boolean;
  rootRunLoaded?: boolean;
  successorRunIds?: string[];
  onEscalate?: (action: RunEscalationAction, reason?: string) => void;
  escalationError?: string | null;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onDelete?: () => void;
  selectionMode?: boolean;
  onLongPress?: () => void;
  /** Narrow viewport: a tap on the card toggles the log expander. */
  tapExpands?: boolean;
};

export function RunCard({
  run,
  automationName,
  workspaceName,
  showWorkspace = false,
  configKey = null,
  hasSuccessor = false,
  selection,
  models,
  triggerKind,
  lastEvent,
  pendingInput,
  onViewLogs,
  onCancel,
  onAnswer,
  onPromoteToChat,
  onOpenRun,
  parentRunLoaded = true,
  rootRunLoaded = true,
  successorRunIds = [],
  onEscalate,
  escalationError = null,
  selectable = false,
  selected = false,
  onToggleSelect,
  onDelete,
  selectionMode = false,
  onLongPress,
  tapExpands = false,
}: RunCardProps) {
  const [logExpanded, setLogExpanded] = useState(
    () => run.status === "running"
  );
  const prevStatusRef = useRef(run.status);
  const longPressedRef = useRef(false);
  const longPress = useLongPress(() => {
    longPressedRef.current = true;
    onLongPress?.();
  });
  const longPressHandlers = onLongPress
    ? {
        ...longPress,
        onPointerDown: (e: ReactPointerEvent) => {
          longPressedRef.current = false;
          longPress.onPointerDown(e);
        },
      }
    : {};
  const active = run.status === "running" || run.status === "needs_input" || run.status === "paused";
  const now = useNow(run.status === "running");
  const elapsed = formatElapsed(run.startedAt, run.endedAt, now);
  const terminal =
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled";
  const stamp = formatTimestamp(
    terminal ? run.endedAt ?? run.createdAt : run.startedAt ?? run.createdAt
  );
  const halted = isHaltedPipelineRun(run);
  const gates = escalationActionGates(run, hasSuccessor);
  const parentId = run.parentRunId;
  const rootId = run.chainRootRunId;
  const showLineage =
    run.pipeline != null &&
    onOpenRun &&
    ((parentId != null && parentId !== run.id) ||
      (rootId != null && rootId !== run.id && rootId !== parentId) ||
      successorRunIds.length > 0);
  const generatedTitle = run.title?.trim() || "";
  const displayTitle = generatedTitle || automationName;
  const generatedSummary =
    (run.status === "completed" || run.status === "failed") &&
    run.summary?.trim()
      ? run.summary.trim()
      : null;
  const contextLine = generatedSummary ?? lastEvent;

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = run.status;
    if (run.status === "running" && prev !== "running") {
      setLogExpanded(true);
    }
  }, [run.status]);

  return (
    <Card
      className={cn(
        CARD_BASE,
        "group relative",
        selectionMode || tapExpands ? "cursor-pointer" : "cursor-default",
        run.status === "needs_input" &&
          "border-status-needs-input ring-1 ring-status-needs-input/40",
        halted &&
          "border-status-failed ring-1 ring-status-failed/40",
        selected && "border-ring"
      )}
      onClick={
        selectionMode
          ? () => {
              if (longPressedRef.current) {
                longPressedRef.current = false;
                return;
              }
              onToggleSelect?.();
            }
          : tapExpands
            ? () => {
                if (longPressedRef.current) {
                  longPressedRef.current = false;
                  return;
                }
                setLogExpanded((v) => !v);
              }
            : undefined
      }
      onDoubleClick={
        selectionMode
          ? undefined
          : (e) => {
              // Leave interactive chrome alone; open the full run dialog.
              if (
                (e.target as HTMLElement).closest(
                  "button, a, input, label, textarea, [role='button']"
                )
              ) {
                return;
              }
              onViewLogs();
            }
      }
      {...longPressHandlers}
    >
      {(selectable || selectionMode) && (
        <label
          className={cn(
            "absolute right-2 top-2 cursor-pointer items-center",
            selectionMode
              ? "flex"
              : cn("group-hover:flex", selected ? "flex" : "hidden")
          )}
          onClick={(e) => e.stopPropagation()}
          title="Select run"
        >
          <input
            type="checkbox"
            className="m-0 cursor-pointer accent-primary"
            checked={selected}
            onChange={() => onToggleSelect?.()}
          />
        </label>
      )}

      <div
        className={cn(
          "flex items-center gap-2",
          (selectable || selectionMode) && "pr-5"
        )}
      >
        {triggerKind && (
          <span className="text-sm" title={triggerKindLabel(triggerKind)}>
            {triggerKindIcon(triggerKind)}
          </span>
        )}
        <span
          className="flex-1 truncate font-semibold"
          title={
            displayTitle !== automationName
              ? `${displayTitle} · ${automationName}`
              : automationName
          }
        >
          {displayTitle}
        </span>
        <StatusDot
          status={run.status}
          title={run.status === "paused" ? "Paused" : run.status}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
          {showWorkspace ? <WorkspaceChip name={workspaceName} /> : null}
          <ModelChip selection={selection} models={models} />
          {run.pipeline ? (
            <PipelineChip run={run} configKey={configKey} halted={halted} />
          ) : (
            run.parentRunId &&
            triggerKind !== "chain" && (
              <ChainedChip parentRunId={run.parentRunId} />
            )
          )}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
          {stamp && <span>{stamp}</span>}
          {(active || run.startedAt) && <span>⏲ {elapsed}</span>}
        </span>
      </div>

      <div className="mt-2 flex min-w-0 items-center gap-1">
        {!terminal ||
        Boolean(generatedSummary) ||
        (run.status === "failed" && lastEvent) ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 cursor-pointer items-center border-none bg-transparent p-0 text-left text-[11px] hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setLogExpanded((v) => !v);
            }}
            title={logExpanded ? "Collapse log" : "Expand log"}
            aria-expanded={logExpanded}
          >
            <span className="mr-1 shrink-0 text-muted-foreground">
              {logExpanded ? "▾" : "▸"}
            </span>
            {contextLine ? (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono",
                  run.status === "failed"
                    ? "text-destructive/80"
                    : "text-muted-foreground"
                )}
                title={contextLine}
              >
                {contextLine}
              </span>
            ) : (
              <span className="text-muted-foreground">live log</span>
            )}
          </button>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer border-none bg-transparent p-0 text-left text-[11px] text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setLogExpanded((v) => !v);
            }}
            title={logExpanded ? "Collapse log" : "Expand log"}
            aria-expanded={logExpanded}
          >
            <span className="mr-1">{logExpanded ? "▾" : "▸"}</span>
            log
          </button>
        )}

        {!selectionMode && (
          <div
            className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            {showLineage && parentId && parentId !== run.id && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                disabled={!parentRunLoaded}
                title={
                  parentRunLoaded
                    ? `Open parent ${parentId.slice(0, 8)}`
                    : "Parent run is not available in the loaded run list"
                }
                aria-label="Open parent run"
                onClick={() => onOpenRun?.(parentId)}
              >
                <CornerUpLeft />
              </Button>
            )}
            {showLineage &&
              rootId &&
              rootId !== run.id &&
              rootId !== parentId && (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={!rootRunLoaded}
                  title={
                    rootRunLoaded
                      ? `Open root ${rootId.slice(0, 8)}`
                      : "Root run is not available in the loaded run list"
                  }
                  aria-label="Open root run"
                  onClick={() => onOpenRun?.(rootId)}
                >
                  <GitBranch />
                </Button>
              )}
            {showLineage &&
              successorRunIds.map((successorId) => (
                <Button
                  key={successorId}
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  title={`Open successor ${successorId.slice(0, 8)}`}
                  aria-label="Open successor run"
                  onClick={() => onOpenRun?.(successorId)}
                >
                  <ArrowRight />
                </Button>
              ))}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground hover:text-foreground"
              title="Logs"
              aria-label="View logs"
              onClick={onViewLogs}
            >
              <ScrollText />
            </Button>
            {active && (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                title="Cancel"
                aria-label="Cancel run"
                onClick={onCancel}
              >
                <Square />
              </Button>
            )}
            {halted && onEscalate && (
              <>
                <EscalationConfirmButton
                  action="retry"
                  label="Retry"
                  icon={<Play aria-hidden="true" />}
                  enabled={gates.retry.enabled}
                  title={gates.retry.title ?? "Retry"}
                  onConfirm={onEscalate}
                />
                <EscalationConfirmButton
                  action="skip"
                  label="Skip"
                  icon={<SkipForward aria-hidden="true" />}
                  enabled={gates.skip.enabled}
                  title={gates.skip.title ?? "Skip"}
                  onConfirm={onEscalate}
                />
                <EscalationConfirmButton
                  action="abort"
                  label="Abort"
                  icon={<XCircle aria-hidden="true" />}
                  enabled={gates.abort.enabled}
                  title={gates.abort.title ?? "Abort"}
                  onConfirm={onEscalate}
                />
              </>
            )}
            {selectable && onDelete && (
              <ConfirmButton
                label={<Trash2 aria-hidden="true" />}
                confirmLabel="Delete"
                size="icon-xs"
                title="Delete"
                onConfirm={onDelete}
              />
            )}
          </div>
        )}
      </div>

      {escalationError && (
        <div className="mt-2 text-[11px] text-destructive">{escalationError}</div>
      )}

      {logExpanded && (
        <div
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <InlineRunLog runId={run.id} />
        </div>
      )}

      {run.status === "needs_input" && pendingInput && (
        <InputRequestPanel
          request={pendingInput}
          workspaceId={run.workspaceId}
          onSubmit={onAnswer}
          canPromoteToChat={isLocallyResumableAgentIdentity(
            run.agentId,
            run.sdkRunId
          )}
          onPromoteToChat={onPromoteToChat}
        />
      )}
    </Card>
  );
}
