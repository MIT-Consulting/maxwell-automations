import type { ReactNode } from "react";
import {
  Braces,
  ChevronLeft,
  ChevronUp,
  Columns3,
  Download,
  FolderOpen,
  LayoutGrid,
  ListFilter,
  MessageSquare,
  Plus,
  Rocket,
  Search,
  Settings,
} from "lucide-react";
import type { Workspace } from "@lca/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusDot } from "@/components/StatusDot";
import { cn } from "@/lib/utils";
import { workspaceLabel } from "./helpers";
export type ControlBarProps = {
  connected: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Full workspace list, used for label lookups (custom labels, `w.path`). */
  workspaces: Workspace[];
  /** Selectable workspaces for the single sidebar picker (excludes `__global__`). */
  pickerWorkspaces: Workspace[];
  automationCountByWs: Map<string, number>;
  /** True when the sidebar is scoped to "All" rather than one focused workspace. */
  boardScopeAll: boolean;
  /** The one focused workspace — drives Board (when not "All"), Chat, Files, Settings. */
  activeWorkspaceId: string | null;
  onSelectAllWorkspaces: () => void;
  onSelectWorkspace: (id: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onResetLayout: () => void;
  onNewAutomation: () => void;
  onImplementFully?: () => void;
  onExport: (format: "csv" | "json") => void;
  /** Render the controls bare (no rail/sidebar frame) for the mobile bottom sheet. */
  asSheet?: boolean;
  activeView?: "board" | "chat" | "files" | "settings";
  onSelectView?: (view: "board" | "chat" | "files" | "settings") => void;
};

export type WorkspacePickerProps = {
  workspaces: Workspace[];
  pickerWorkspaces: Workspace[];
  automationCountByWs: Map<string, number>;
  boardScopeAll: boolean;
  activeWorkspaceId: string | null;
  onSelectAllWorkspaces: () => void;
  onSelectWorkspace: (id: string) => void;
  /** "All" only makes sense as a Board aggregate — Chat/Files/Settings always
   *  need exactly one focused workspace, so they never offer it. */
  showAllOption: boolean;
  className?: string;
};

const ALL_WORKSPACES_VALUE = "__all__";

/** The single workspace context switcher — one dropdown, used identically in
 *  the desktop sidebar and the mobile top bar, on every view. Selecting a
 *  specific workspace focuses it everywhere (Board filter + Chat/Files/
 *  Settings); "All" is a Board-only aggregate. */
export function WorkspacePicker({
  workspaces,
  pickerWorkspaces,
  automationCountByWs,
  boardScopeAll,
  activeWorkspaceId,
  onSelectAllWorkspaces,
  onSelectWorkspace,
  showAllOption,
  className,
}: WorkspacePickerProps) {
  const value =
    showAllOption && boardScopeAll
      ? ALL_WORKSPACES_VALUE
      : (activeWorkspaceId ?? undefined);
  const totalCount = pickerWorkspaces.reduce(
    (sum, w) => sum + (automationCountByWs.get(w.id) ?? 0),
    0
  );
  // Trigger shows just the name — the "(count)" only renders in the open
  // list, where there's room for it. Otherwise a long name pushes the count
  // past the trigger's width and it gets cut off mid-digit.
  const triggerLabel =
    value === ALL_WORKSPACES_VALUE
      ? "All"
      : activeWorkspaceId
        ? workspaceLabel(activeWorkspaceId, workspaces)
        : undefined;

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === ALL_WORKSPACES_VALUE) onSelectAllWorkspaces();
        else onSelectWorkspace(v);
      }}
    >
      <SelectTrigger
        className={cn(
          "w-full border-border bg-muted font-medium shadow-md transition-shadow hover:shadow-lg data-[state=open]:shadow-lg",
          className
        )}
        aria-label="Workspace"
      >
        <SelectValue placeholder="Select workspace">
          {triggerLabel !== undefined ? (
            <span className="truncate">{triggerLabel}</span>
          ) : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {showAllOption && (
          <SelectItem value={ALL_WORKSPACES_VALUE}>
            All ({totalCount})
          </SelectItem>
        )}
        {pickerWorkspaces.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {/* Automation counts are Board context — showing them on
                Chat/Files/Settings implies a relevance they don't have there. */}
            {showAllOption
              ? `${workspaceLabel(w.id, workspaces)} (${automationCountByWs.get(w.id) ?? 0})`
              : workspaceLabel(w.id, workspaces)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type ControlBarControlsProps = Pick<
  ControlBarProps,
  | "search"
  | "onSearchChange"
  | "onResetLayout"
  | "onNewAutomation"
  | "onImplementFully"
  | "onExport"
  | "activeView"
  | "onSelectView"
>;

/** Shared body (search + actions) for the desktop sidebar and the mobile
 *  sheet, so the two cannot drift. The workspace picker is rendered
 *  separately (once in the sidebar, once in the mobile top bar) — it isn't
 *  part of this shared body so the mobile sheet doesn't duplicate it. */
function ControlBarControls({
  search,
  onSearchChange,
  onResetLayout,
  onNewAutomation,
  onImplementFully,
  onExport,
  activeView,
  onSelectView,
}: ControlBarControlsProps) {
  const showBoardCluster = activeView === undefined || activeView === "board";

  return (
    <>
      {showBoardCluster && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            className="h-9 pl-8 [&::-webkit-search-cancel-button]:appearance-none"
            placeholder="Search automations…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        {showBoardCluster && (
          <Button type="button" onClick={onNewAutomation}>
            <Plus />
            New automation
          </Button>
        )}
        {onImplementFully && (
          <Button
            type="button"
            variant="surface"
            onClick={onImplementFully}
            title="Run a feature pipeline on a workspace"
          >
            <Rocket />
            Run feature pipeline
          </Button>
        )}
        {showBoardCluster && (
          <>
            <Button
              type="button"
              variant="surface"
              onClick={onResetLayout}
              title="Reset columns to auto show/hide and fit widths to card titles"
            >
              Smart layout
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="surface"
                className="flex-1"
                onClick={() => onExport("csv")}
                title="Export run history as CSV"
              >
                Export CSV
              </Button>
              <Button
                type="button"
                variant="surface"
                className="flex-1"
                onClick={() => onExport("json")}
                title="Export run history as JSON"
              >
                JSON
              </Button>
            </div>
          </>
        )}
        {activeView && onSelectView && (
          <Button
            type="button"
            variant="surface"
            onClick={() => onSelectView("settings")}
            aria-pressed={activeView === "settings"}
          >
            <Settings />
            Settings
          </Button>
        )}
      </div>
    </>
  );
}

function RailButton({
  label,
  onClick,
  children,
  variant = "surface",
  active = false,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  variant?: "surface" | "default";
  active?: boolean;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size="icon"
          className="relative size-[38px] rounded-lg"
          onClick={onClick}
          title={label}
          aria-label={label}
          aria-pressed={pressed}
        >
          {children}
          {active && (
            <span
              className="absolute right-1 top-1 size-[7px] rounded-full bg-primary"
              aria-hidden="true"
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function ViewToggle({
  activeView,
  onSelectView,
  className,
}: {
  activeView: "board" | "chat" | "files" | "settings";
  onSelectView: (view: "board" | "chat" | "files" | "settings") => void;
  className?: string;
}) {
  // Note: the "settings" view is surfaced via a full-width button at the
  // bottom of the sidebar (below the export buttons), not in this toggle.
  return (
    <div
      className={cn("flex gap-1 rounded-md border border-border bg-muted p-0.5", className)}
      role="group"
      aria-label="View"
    >
      <button
        type="button"
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          activeView === "board"
            ? "border border-primary bg-primary text-primary-foreground"
            : "border border-transparent text-foreground hover:bg-card"
        )}
        aria-pressed={activeView === "board"}
        onClick={() => onSelectView("board")}
      >
        <Columns3 className="size-3.5 shrink-0" aria-hidden="true" />
        Board
      </button>
      <button
        type="button"
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          activeView === "chat"
            ? "border border-primary bg-primary text-primary-foreground"
            : "border border-transparent text-foreground hover:bg-card"
        )}
        aria-pressed={activeView === "chat"}
        onClick={() => onSelectView("chat")}
      >
        <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
        Chat
      </button>
      <button
        type="button"
        className={cn(
          "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          activeView === "files"
            ? "border border-primary bg-primary text-primary-foreground"
            : "border border-transparent text-foreground hover:bg-card"
        )}
        aria-pressed={activeView === "files"}
        onClick={() => onSelectView("files")}
      >
        <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
        Files
      </button>
    </div>
  );
}

export function ControlBar({
  connected,
  collapsed,
  onToggleCollapse,
  workspaces,
  pickerWorkspaces,
  automationCountByWs,
  boardScopeAll,
  activeWorkspaceId,
  onSelectAllWorkspaces,
  onSelectWorkspace,
  search,
  onSearchChange,
  onResetLayout,
  onNewAutomation,
  onImplementFully,
  onExport,
  asSheet = false,
  activeView,
  onSelectView,
}: ControlBarProps) {
  const connLabel = connected ? "Daemon connected" : "Daemon offline";
  const showBoardCluster = activeView === undefined || activeView === "board";

  const controls = (
    <ControlBarControls
      search={search}
      onSearchChange={onSearchChange}
      onResetLayout={onResetLayout}
      onNewAutomation={onNewAutomation}
      onImplementFully={onImplementFully}
      onExport={onExport}
      activeView={activeView}
      onSelectView={onSelectView}
    />
  );

  if (asSheet) {
    return <div className="flex min-h-0 flex-1 flex-col gap-3">{controls}</div>;
  }

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-border bg-card px-2 py-3">
        <div
          className="relative flex size-[38px] shrink-0 items-center justify-center rounded-lg border border-border bg-muted"
          title="Max"
        >
          <span className="text-[13px] font-bold tracking-wide text-foreground">
            M
          </span>
          <StatusDot
            status={connected ? "live" : "offline"}
            title={connLabel}
            className="absolute right-1 top-1 size-[7px]"
          />
        </div>

        <RailButton
          label="Expand control bar"
          onClick={onToggleCollapse}
          pressed={collapsed}
        >
          <ChevronLeft />
        </RailButton>

        {activeView && onSelectView && (
          <>
            <RailButton
              label="Board view"
              onClick={() => onSelectView("board")}
              active={activeView === "board"}
              pressed={activeView === "board"}
            >
              <Columns3 />
            </RailButton>
            <RailButton
              label="Chat view"
              onClick={() => onSelectView("chat")}
              active={activeView === "chat"}
              pressed={activeView === "chat"}
            >
              <MessageSquare />
            </RailButton>
            <RailButton
              label="Files view"
              onClick={() => onSelectView("files")}
              active={activeView === "files"}
              pressed={activeView === "files"}
            >
              <FolderOpen />
            </RailButton>
          </>
        )}

        <RailButton
          label="Workspace"
          onClick={onToggleCollapse}
          active={!boardScopeAll}
        >
          <ListFilter />
        </RailButton>

        {showBoardCluster && (
          <>
            <RailButton label="Search automations" onClick={onToggleCollapse}>
              <Search />
            </RailButton>

            <RailButton
              label="Reset columns to auto show/hide and fit widths to card titles"
              onClick={onResetLayout}
            >
              <LayoutGrid />
            </RailButton>

            <RailButton
              label="New automation"
              onClick={onNewAutomation}
              variant="default"
            >
              <Plus />
            </RailButton>
          </>
        )}

        {onImplementFully && (
          <RailButton
            label="Run feature pipeline"
            onClick={onImplementFully}
          >
            <Rocket />
          </RailButton>
        )}

        <div className="mt-auto flex flex-col items-center gap-2">
          {showBoardCluster && (
            <>
              <RailButton
                label="Export run history as CSV"
                onClick={() => onExport("csv")}
              >
                <Download />
              </RailButton>

              <RailButton
                label="Export run history as JSON"
                onClick={() => onExport("json")}
              >
                <Braces />
              </RailButton>
            </>
          )}

          {activeView && onSelectView && (
            <RailButton
              label="Settings view"
              onClick={() => onSelectView("settings")}
              active={activeView === "settings"}
              pressed={activeView === "settings"}
            >
              <Settings />
            </RailButton>
          )}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[260px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-2">
        <h1 className="m-0 min-w-0 flex-1 text-base font-semibold tracking-[0.2px]">
          Max
        </h1>
        <StatusDot
          status={connected ? "live" : "offline"}
          title={connLabel}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={onToggleCollapse}
          title="Collapse control bar"
          aria-label="Collapse control bar"
          aria-pressed={collapsed}
        >
          <ChevronUp />
        </Button>
      </div>

      {activeView && onSelectView && (
        <ViewToggle activeView={activeView} onSelectView={onSelectView} />
      )}

      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.5px] text-muted-foreground">
          WORKSPACE
        </p>
        <WorkspacePicker
          workspaces={workspaces}
          pickerWorkspaces={pickerWorkspaces}
          automationCountByWs={automationCountByWs}
          boardScopeAll={boardScopeAll}
          activeWorkspaceId={activeWorkspaceId}
          onSelectAllWorkspaces={onSelectAllWorkspaces}
          onSelectWorkspace={onSelectWorkspace}
          showAllOption={showBoardCluster}
        />
      </div>

      {controls}
    </aside>
  );
}
