import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  FolderOpen,
  MessageSquare,
  Plus,
  Rocket,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import type {
  Automation,
  ChatSession,
  Run,
  RunEscalationAction,
} from "@lca/shared";
import { cn } from "@/lib/utils";
import { api, EscalationError, onAuthRequired } from "./api";
import { AutomationModal } from "./AutomationModal";
import { TokenGate } from "./TokenGate";
import { AutomationCard, RunCard } from "./cards";
import { MobileCreateFab } from "./MobileCreateFab";
import { MobileFilterSheet } from "./MobileFilterSheet";
import { OverlayScrollArea } from "./OverlayScrollArea";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import {
  buildColumnMeta,
  buildGridTemplateColumns,
  COLUMN_KEYS,
  fitColumnWidthForContent,
  loadColumnPrefs,
  loadColumnWidths,
  mobilePagerColumnKeys,
  pickInitialMobileColumn,
  RECENT_WINDOW_MS,
  saveColumnWidths,
  smartOpenColumnWidths,
  type ColumnFitContent,
  type ColumnKey,
  type ColumnMeta,
  type ColumnPref,
  COLUMN_PREFS_KEY,
} from "./columnLayout";
import { ColumnResizeHandle } from "./ColumnResizeHandle";
import { ConfirmButton } from "./ConfirmButton";
import { ControlBar, WorkspacePicker } from "./ControlBar";
import { ChatView } from "./ChatView";
import { FilesView, type FilesLocation } from "./FilesView";
import {
  clearFilesViewUrlParams,
  onFilesDeepLink,
  parseFilesDeepLinkBoot,
  syncFilesViewUrl,
  type FilesDeepLinkTarget,
} from "./filesDeepLink";
import {
  canGoBack,
  canGoForward,
  createFilesNavState,
  currentFilesNavEntry,
  goBackFilesNav,
  goForwardFilesNav,
  pushFilesNav,
  replaceFilesNav,
  type DashboardNavView,
  type FilesNavEntry,
  type FilesNavState,
} from "./filesNavigation";
import { SettingsView } from "./SettingsView";
import { LogsModal } from "./LogsModal";
import { PipelineKickoffModal } from "./PipelineKickoffModal";
import {
  buildSuccessorMap,
  defaultExpandedPipelineRootId,
  effectiveChainBudget,
  formatPipelineGroupStatus,
  formatWaveTrackProgress,
  indexRunsByPipelineRoot,
  layoutColumnRuns,
  pipelineGroupAggregateElapsed,
  pipelineGroupStatus,
  waveOperatorActionGates,
  type PipelineGroup,
} from "./pipelineGrouping";
import { FeatureLabelLink, PipelineDocsMenu } from "./PipelineDocsMenu";
import { useAvailableModels } from "./useAvailableModels";
import { useNow, workspaceLabel } from "./helpers";
import { useDashboardData } from "./useDashboardData";
import { NARROW_VIEWPORT_QUERY } from "./useIsNarrowViewport";

type EditorState =
  | { mode: "create" }
  | { mode: "duplicate"; source: Automation }
  | { mode: "edit"; automation: Automation }
  | null;

type DragState = { id: string; enabled: boolean } | null;

const COLUMNS: Array<{ key: ColumnKey; title: string; droppable: boolean }> = [
  { key: "backlog", title: "Backlog", droppable: true },
  { key: "enabled", title: "Enabled", droppable: true },
  { key: "running", title: "Running", droppable: true },
  { key: "needs_input", title: "Needs Input", droppable: false },
  { key: "completed", title: "Completed", droppable: false },
  { key: "failed", title: "Failed", droppable: false },
];

function runColumn(status: Run["status"]): ColumnKey {
  switch (status) {
    case "queued":
    case "running":
    case "paused":
      return "running";
    case "needs_input":
      return "needs_input";
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
  }
}

/** Board card title — matches RunCard displayTitle. */
function runCardTitle(run: Run, automationName: string): string {
  const generated = run.title?.trim() || "";
  return generated || automationName;
}

function isTerminalRun(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const DELETABLE_COLUMNS = new Set<ColumnKey>(["completed", "failed"]);

const MOVE_DESTINATION_KEYS: ColumnKey[] = ["backlog", "enabled", "running"];

function isSelectableColumn(key: ColumnKey): boolean {
  return (
    key === "backlog" ||
    key === "enabled" ||
    key === "completed" ||
    key === "failed"
  );
}

function selectionTargetsAutomations(key: ColumnKey): boolean {
  return key === "backlog" || key === "enabled";
}

function moveDestinations(from: ColumnKey): ColumnKey[] {
  return MOVE_DESTINATION_KEYS.filter((k) => k !== from);
}

const BOARD_SCOPE_ALL_KEY = "lca.boardScopeAll";
const CONTROL_BAR_COLLAPSED_KEY = "lca.controlBarCollapsed";
const ACTIVE_VIEW_KEY = "lca.activeView";
const ACTIVE_WORKSPACE_KEY = "lca.activeWorkspaceId";

type ActiveView = "board" | "chat" | "files" | "settings";

/** Sidebar workspace picker is single-select: "All" (board aggregate) or one
 *  focused workspace (`activeWorkspaceId`) that also drives Chat/Files/Settings. */
function loadBoardScopeAll(): boolean {
  try {
    const raw = localStorage.getItem(BOARD_SCOPE_ALL_KEY);
    if (raw === "false") return false;
  } catch {
    /* ignore malformed persisted flag */
  }
  return true;
}

function loadControlBarCollapsed(): boolean {
  try {
    return localStorage.getItem(CONTROL_BAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function loadActiveView(): ActiveView {
  try {
    const raw = localStorage.getItem(ACTIVE_VIEW_KEY);
    if (
      raw === "board" ||
      raw === "chat" ||
      raw === "files" ||
      raw === "settings"
    ) {
      return raw;
    }
  } catch {
    /* ignore malformed persisted view */
  }
  return "board";
}

function loadActiveWorkspaceId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

const ROOT_FILES_LOCATION: FilesLocation = { dir: "", path: null };

function isDashboardNavView(view: ActiveView): view is DashboardNavView {
  return view === "board" || view === "chat" || view === "settings";
}

function bootFilesNavEntry(
  boot: ReturnType<typeof parseFilesDeepLinkBoot>,
  view: ActiveView,
  workspaceId: string | null,
  locations: Record<string, FilesLocation>
): FilesNavEntry {
  if (view === "files") {
    const location =
      (workspaceId ? locations[workspaceId] : undefined) ??
      boot.location ??
      ROOT_FILES_LOCATION;
    return { kind: "files", workspaceId, location };
  }
  return { kind: "view", view };
}

/** Trigger a browser download of the run-history export for the current filter. */
function downloadExport(format: "csv" | "json", workspaceId: string | null): void {
  const params = new URLSearchParams({ format });
  if (workspaceId) {
    params.set("workspaceId", workspaceId);
  }
  const a = document.createElement("a");
  a.href = `/api/runs/export?${params.toString()}`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function App() {
  const data = useDashboardData();
  const {
    automations,
    runs,
    workspaces,
    lastEventByRun,
    modelByRun,
    pendingInputByRun,
    connected,
    error,
    refresh,
    applyRun,
  } = data;
  const { models: availableModels } = useAvailableModels();

  const [authRequired, setAuthRequired] = useState(false);
  const [boardScopeAll, setBoardScopeAll] = useState<boolean>(loadBoardScopeAll);
  const [search, setSearch] = useState("");
  const [drag, setDrag] = useState<DragState>(null);
  const [logsRunId, setLogsRunId] = useState<string | null>(null);
  const [escalationErrorByRun, setEscalationErrorByRun] = useState<
    Record<string, string>
  >({});
  const [kickoffOpen, setKickoffOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [selectedAutomationIds, setSelectedAutomationIds] = useState<Set<string>>(
    new Set()
  );
  const [selectionMode, setSelectionMode] = useState(false);

  useEffect(() => {
    onAuthRequired(() => setAuthRequired(true));
  }, []);
  const [moveSheetOpen, setMoveSheetOpen] = useState(false);
  const [columnPrefs, setColumnPrefs] = useState(loadColumnPrefs);
  const [columnWidths, setColumnWidths] = useState(loadColumnWidths);
  const [controlBarCollapsed, setControlBarCollapsed] = useState(loadControlBarCollapsed);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(NARROW_VIEWPORT_QUERY).matches;
  });
  const [activeColumn, setActiveColumn] = useState<ColumnKey>("running");
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [recentFailureTick, setRecentFailureTick] = useState(0);
  const [filesDeepLink] = useState(parseFilesDeepLinkBoot);
  const [activeView, setActiveView] = useState<ActiveView>(
    () => filesDeepLink.viewOverride ?? loadActiveView()
  );
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    () => filesDeepLink.workspaceId ?? loadActiveWorkspaceId()
  );
  const [filesLocationByWorkspace, setFilesLocationByWorkspace] = useState<
    Record<string, FilesLocation>
  >(() => {
    if (filesDeepLink.workspaceId && filesDeepLink.location) {
      return { [filesDeepLink.workspaceId]: filesDeepLink.location };
    }
    return {};
  });
  const [filesNav, setFilesNav] = useState<FilesNavState>(() => {
    const view = filesDeepLink.viewOverride ?? loadActiveView();
    const workspaceId = filesDeepLink.workspaceId ?? loadActiveWorkspaceId();
    const locations =
      filesDeepLink.workspaceId && filesDeepLink.location
        ? { [filesDeepLink.workspaceId]: filesDeepLink.location }
        : {};
    return createFilesNavState(
      bootFilesNavEntry(filesDeepLink, view, workspaceId, locations)
    );
  });
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  /** Explicit expand/collapse overrides; unset roots follow the default (current only). */
  const [pipelineGroupExpandOverrides, setPipelineGroupExpandOverrides] =
    useState<Record<string, boolean>>({});
  const bootLocationWithoutWorkspaceApplied = useRef(false);
  const activeViewRef = useRef(activeView);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const filesLocationByWorkspaceRef = useRef(filesLocationByWorkspace);
  const filesNavRef = useRef(filesNav);
  activeViewRef.current = activeView;
  activeWorkspaceIdRef.current = activeWorkspaceId;
  filesLocationByWorkspaceRef.current = filesLocationByWorkspace;
  filesNavRef.current = filesNav;
  const pipelineNow = useNow(activeView === "board");

  const lastFailureAtRef = useRef(0);
  const prevFailedRunIdsRef = useRef<Set<string>>(new Set());
  const failureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstFailedCheckRef = useRef(true);
  const mobilePagerRef = useRef<HTMLDivElement>(null);
  const mobileTabStripRef = useRef<HTMLDivElement>(null);
  const tabScrollInFlightRef = useRef(false);
  const didPickInitialColumnRef = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(BOARD_SCOPE_ALL_KEY, String(boardScopeAll));
    } catch {
      /* storage unavailable (private mode) — selection is session-only */
    }
  }, [boardScopeAll]);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(columnPrefs));
    } catch {
      /* storage unavailable (private mode) — prefs are session-only */
    }
  }, [columnPrefs]);

  useEffect(() => {
    saveColumnWidths(columnWidths);
  }, [columnWidths]);

  useEffect(() => {
    try {
      localStorage.setItem(CONTROL_BAR_COLLAPSED_KEY, String(controlBarCollapsed));
    } catch {
      /* storage unavailable (private mode) — selection is session-only */
    }
  }, [controlBarCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_VIEW_KEY, activeView);
    } catch {
      /* storage unavailable (private mode) — view is session-only */
    }
  }, [activeView]);

  useEffect(() => {
    try {
      if (activeWorkspaceId) {
        localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspaceId);
      } else {
        localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
      }
    } catch {
      /* storage unavailable (private mode) — workspace focus is session-only */
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(NARROW_VIEWPORT_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setIsNarrowViewport(event.matches);
    };
    setIsNarrowViewport(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    setSelectedRunIds(new Set());
  }, [boardScopeAll, activeWorkspaceId, search]);

  const syncActiveColumnFromPagerScroll = useCallback(
    (pagerKeys: ColumnKey[]): void => {
      const pager = mobilePagerRef.current;
      if (!pager || tabScrollInFlightRef.current) return;
      const paneWidth = pager.clientWidth;
      if (paneWidth <= 0) return;
      const index = Math.min(
        pagerKeys.length - 1,
        Math.max(0, Math.round(pager.scrollLeft / paneWidth))
      );
      const key = pagerKeys[index];
      if (!key) return;
      setActiveColumn((prev) => (prev === key ? prev : key));
    },
    []
  );

  const scrollMobilePagerToColumn = useCallback(
    (
      key: ColumnKey,
      meta: Record<ColumnKey, ColumnMeta>,
      behavior: ScrollBehavior = "smooth"
    ): void => {
      const pager = mobilePagerRef.current;
      if (!pager) return;
      const pagerKeys = mobilePagerColumnKeys(meta, key);
      const index = pagerKeys.indexOf(key);
      if (index < 0) return;
      if (behavior === "smooth") tabScrollInFlightRef.current = true;
      pager.scrollTo({ left: index * pager.clientWidth, behavior });
      if (behavior !== "smooth") return;
      const release = (): void => {
        tabScrollInFlightRef.current = false;
      };
      pager.addEventListener("scrollend", release, { once: true });
      setTimeout(release, 600);
    },
    []
  );

  // Keep the highlighted tab visible in the (scrollable) tab strip as the active
  // column changes via swipe or tap. Independent of the pager → no scroll loop.
  useEffect(() => {
    if (!isNarrowViewport) return;
    const strip = mobileTabStripRef.current;
    if (!strip) return;
    const tab = strip.querySelector<HTMLElement>(`#mobile-tab-${activeColumn}`);
    if (!tab) return;
    const stripRect = strip.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    if (tabRect.left < stripRect.left) {
      strip.scrollBy({ left: tabRect.left - stripRect.left - 12, behavior: "smooth" });
    } else if (tabRect.right > stripRect.right) {
      strip.scrollBy({ left: tabRect.right - stripRect.right + 12, behavior: "smooth" });
    }
  }, [activeColumn, isNarrowViewport]);

  const setColumnPref = useCallback((key: ColumnKey, pref: ColumnPref): void => {
    setColumnPrefs((prev) => ({ ...prev, [key]: pref }));
  }, []);

  const setColumnWidth = useCallback((key: ColumnKey, width: number): void => {
    setColumnWidths((prev) =>
      prev[key] === width ? prev : { ...prev, [key]: width }
    );
  }, []);

  const toggleColumnPin = useCallback(
    (key: ColumnKey, collapsed: boolean): void => {
      setColumnPref(key, collapsed ? "open" : "collapsed");
    },
    [setColumnPref]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deepLinkRun = params.get("run");
    if (deepLinkRun) {
      setLogsRunId(deepLinkRun);
      params.delete("run");
      const query = params.toString();
      const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
      window.history.replaceState(null, "", url);
    }
  }, []);

  // Boot deep link with path/dir but no workspace → seed once the active workspace resolves.
  useEffect(() => {
    if (bootLocationWithoutWorkspaceApplied.current) return;
    if (!filesDeepLink.location || filesDeepLink.workspaceId) {
      bootLocationWithoutWorkspaceApplied.current = true;
      return;
    }
    if (!activeWorkspaceId) return;
    const loc = filesDeepLink.location;
    setFilesLocationByWorkspace((prev) => {
      if (prev[activeWorkspaceId]) return prev;
      return { ...prev, [activeWorkspaceId]: loc };
    });
    setFilesNav((prev) => {
      const current = currentFilesNavEntry(prev);
      if (current.kind !== "files") return prev;
      return replaceFilesNav(prev, {
        kind: "files",
        workspaceId: activeWorkspaceId,
        location: loc,
      });
    });
    bootLocationWithoutWorkspaceApplied.current = true;
  }, [activeWorkspaceId, filesDeepLink]);

  const activeFilesLocation = useMemo((): FilesLocation => {
    if (!activeWorkspaceId) return ROOT_FILES_LOCATION;
    return filesLocationByWorkspace[activeWorkspaceId] ?? ROOT_FILES_LOCATION;
  }, [activeWorkspaceId, filesLocationByWorkspace]);

  // Keep the address bar aligned with Files UI; clear params when leaving.
  useEffect(() => {
    if (activeView !== "files") {
      clearFilesViewUrlParams();
      return;
    }
    syncFilesViewUrl(activeWorkspaceId, activeFilesLocation);
  }, [activeView, activeWorkspaceId, activeFilesLocation]);

  const applyFilesNavEntry = useCallback((entry: FilesNavEntry): void => {
    if (entry.kind === "view") {
      setActiveView(entry.view);
      return;
    }
    setActiveView("files");
    if (entry.workspaceId !== null) {
      setActiveWorkspaceId(entry.workspaceId);
      setFilesLocationByWorkspace((prev) => {
        const cur = prev[entry.workspaceId!];
        if (
          cur &&
          cur.dir === entry.location.dir &&
          cur.path === entry.location.path
        ) {
          return prev;
        }
        return { ...prev, [entry.workspaceId!]: entry.location };
      });
      return;
    }
    setFilesLocationByWorkspace((prev) => {
      const id = activeWorkspaceIdRef.current;
      if (!id) return prev;
      const cur = prev[id];
      if (
        cur &&
        cur.dir === entry.location.dir &&
        cur.path === entry.location.path
      ) {
        return prev;
      }
      return { ...prev, [id]: entry.location };
    });
  }, []);

  const pushToFilesDestination = useCallback(
    (workspaceId: string | null, location: FilesLocation): void => {
      const origin = activeViewRef.current;
      setFilesNav((prev) => {
        let next = prev;
        if (isDashboardNavView(origin)) {
          next = pushFilesNav(next, { kind: "view", view: origin });
        }
        return pushFilesNav(next, {
          kind: "files",
          workspaceId,
          location,
        });
      });
      if (workspaceId !== null) {
        setActiveWorkspaceId(workspaceId);
        setFilesLocationByWorkspace((prev) => {
          const cur = prev[workspaceId];
          if (
            cur &&
            cur.dir === location.dir &&
            cur.path === location.path
          ) {
            return prev;
          }
          return { ...prev, [workspaceId]: location };
        });
      } else {
        const id = activeWorkspaceIdRef.current;
        if (id) {
          setFilesLocationByWorkspace((prev) => {
            const cur = prev[id];
            if (
              cur &&
              cur.dir === location.dir &&
              cur.path === location.path
            ) {
              return prev;
            }
            return { ...prev, [id]: location };
          });
        }
      }
      setActiveView("files");
    },
    []
  );

  const selectView = useCallback(
    (next: ActiveView): void => {
      if (next === "files") {
        const workspaceId = activeWorkspaceIdRef.current;
        const location = workspaceId
          ? (filesLocationByWorkspaceRef.current[workspaceId] ??
            ROOT_FILES_LOCATION)
          : ROOT_FILES_LOCATION;
        pushToFilesDestination(workspaceId, location);
        return;
      }
      setActiveView(next);
    },
    [pushToFilesDestination]
  );

  const onFilesLocationChange = useCallback((loc: FilesLocation): void => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId) return;
    setFilesNav((prev) =>
      pushFilesNav(prev, {
        kind: "files",
        workspaceId,
        location: loc,
      })
    );
    setFilesLocationByWorkspace((prev) => {
      const cur = prev[workspaceId];
      if (cur && cur.dir === loc.dir && cur.path === loc.path) return prev;
      return { ...prev, [workspaceId]: loc };
    });
  }, []);

  const onSelectFilesWorkspace = useCallback((id: string): void => {
    const location =
      filesLocationByWorkspaceRef.current[id] ?? ROOT_FILES_LOCATION;
    setFilesNav((prev) =>
      pushFilesNav(prev, {
        kind: "files",
        workspaceId: id,
        location,
      })
    );
    setActiveWorkspaceId(id);
  }, []);

  /** Sidebar's single workspace picker — routes through Files-nav-aware
   *  selection when on Files so back/forward history stays consistent. */
  const selectWorkspace = useCallback(
    (id: string): void => {
      setBoardScopeAll(false);
      if (activeViewRef.current === "files") {
        onSelectFilesWorkspace(id);
      } else {
        setActiveWorkspaceId(id);
      }
    },
    [onSelectFilesWorkspace]
  );

  const selectAllWorkspaces = useCallback((): void => {
    setBoardScopeAll(true);
  }, []);

  const openFilesDeepLink = useCallback(
    (target: FilesDeepLinkTarget): void => {
      const workspaceId =
        target.workspaceId ?? activeWorkspaceIdRef.current;
      pushToFilesDestination(workspaceId, target.location);
    },
    [pushToFilesDestination]
  );

  const onFilesGoBack = useCallback((): void => {
    const { state, entry } = goBackFilesNav(filesNavRef.current);
    if (state === filesNavRef.current) return;
    setFilesNav(state);
    applyFilesNavEntry(entry);
  }, [applyFilesNavEntry]);

  const onFilesGoForward = useCallback((): void => {
    const { state, entry } = goForwardFilesNav(filesNavRef.current);
    if (state === filesNavRef.current) return;
    setFilesNav(state);
    applyFilesNavEntry(entry);
  }, [applyFilesNavEntry]);

  useEffect(() => {
    onFilesDeepLink(openFilesDeepLink);
    return () => onFilesDeepLink(null);
  }, [openFilesDeepLink]);

  const automationById = useMemo(() => {
    const map = new Map<string, Automation>();
    for (const a of automations) map.set(a.id, a);
    return map;
  }, [automations]);

  const runById = useMemo(() => {
    const map = new Map<string, Run>();
    for (const run of runs) map.set(run.id, run);
    return map;
  }, [runs]);

  const successorByParentRunId = useMemo(
    () => buildSuccessorMap(runs),
    [runs]
  );

  const logsRun = useMemo(
    () => (logsRunId ? runById.get(logsRunId) ?? null : null),
    [logsRunId, runById]
  );

  const lastRunStatusByAutomation = useMemo(() => {
    const map = new Map<string, Run["status"]>();
    for (const run of runs) {
      if (!map.has(run.automationId)) map.set(run.automationId, run.status);
    }
    return map;
  }, [runs]);

  const matchesFilters = (workspaceId: string, name: string): boolean => {
    if (!boardScopeAll && workspaceId !== activeWorkspaceId) return false;
    if (search && !name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  };

  const automationCountByWs = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of automations) {
      map.set(a.workspaceId, (map.get(a.workspaceId) ?? 0) + 1);
    }
    return map;
  }, [automations]);

  const chatWorkspaces = useMemo(
    () => workspaces.filter((w) => w.id !== "__global__"),
    [workspaces]
  );

  useEffect(() => {
    if (chatWorkspaces.length === 0) return;
    if (
      activeWorkspaceId !== null &&
      chatWorkspaces.some((w) => w.id === activeWorkspaceId)
    ) {
      return;
    }
    const nextId = chatWorkspaces[0]!.id;
    setActiveWorkspaceId(nextId);
    setFilesNav((prev) => {
      const current = currentFilesNavEntry(prev);
      if (current.kind !== "files") return prev;
      // Mirror activeFilesLocation for the normalized workspace; the displaced
      // workspace's location must not leak into the reconciled entry.
      const location =
        filesLocationByWorkspaceRef.current[nextId] ?? ROOT_FILES_LOCATION;
      return replaceFilesNav(prev, {
        kind: "files",
        workspaceId: nextId,
        location,
      });
    });
  }, [chatWorkspaces, activeWorkspaceId]);

  const visibleAutomations = automations.filter((a) =>
    matchesFilters(a.workspaceId, a.name)
  );
  const visibleRuns = runs.filter((r) => {
    const name = automationById.get(r.automationId)?.name ?? "";
    return matchesFilters(r.workspaceId, name);
  });

  /** Whole-pipeline members by root — board columns only see a status slice. */
  const runsByPipelineRoot = useMemo(
    () => indexRunsByPipelineRoot(visibleRuns),
    [visibleRuns]
  );

  const contentForColumn = useCallback(
    (key: ColumnKey): ColumnFitContent => {
      if (key === "backlog" || key === "enabled") {
        return {
          cardTitles: visibleAutomations
            .filter((a) => (key === "enabled" ? a.enabled : !a.enabled))
            .map((a) => a.name),
        };
      }
      const colRuns = visibleRuns.filter((r) => runColumn(r.status) === key);
      const cardTitles = colRuns.map((r) => {
        const auto = automationById.get(r.automationId);
        return runCardTitle(r, auto?.name ?? r.automationId.slice(0, 8));
      });
      const { groups } = layoutColumnRuns(colRuns);
      const now = Date.now();
      const headerSegments = groups.map((group) => {
        const featureLabel =
          group.summary?.featureId ?? group.rootRunId.slice(0, 8);
        const pipelineLabel =
          group.summary?.pipelineId ?? group.rootRunId.slice(0, 8);
        const pipelineRuns =
          runsByPipelineRoot.get(group.rootRunId) ?? group.runs;
        let maxDepthSeen: number | null = null;
        let budgetNum: number | null = null;
        let deepestDepth = Number.NEGATIVE_INFINITY;
        const phaseRefs = new Set<string>();
        for (const run of pipelineRuns) {
          const d = run.chainDepth;
          if (typeof d === "number") {
            if (maxDepthSeen == null || d > maxDepthSeen) maxDepthSeen = d;
            if (d >= deepestDepth) {
              deepestDepth = d;
              budgetNum = effectiveChainBudget(run);
            }
          }
          const phaseRef = run.pipelineTrack?.phaseRef?.trim();
          if (phaseRef) phaseRefs.add(phaseRef);
        }
        const wave = group.waveSummary;
        const status = pipelineGroupStatus(pipelineRuns);
        const hasDocs = Boolean(
          group.summary?.featureSlug && pipelineRuns[0]?.workspaceId
        );
        return {
          status: status ? formatPipelineGroupStatus(status) : null,
          featureLabel,
          pipelineLabel,
          depthBudget: `${maxDepthSeen != null ? String(maxDepthSeen) : "?"}/${budgetNum != null ? String(budgetNum) : "?"}`,
          runsLabel: `${pipelineRuns.length} run${pipelineRuns.length === 1 ? "" : "s"}`,
          elapsedLabel: `⏲ ${pipelineGroupAggregateElapsed(pipelineRuns, now)}`,
          docsCount: hasDocs ? 2 + phaseRefs.size : null,
          waveProgress: wave ? formatWaveTrackProgress(wave) : null,
          cleanupRequired: Boolean(wave?.cleanupRequired),
        };
      });
      return { cardTitles, headerSegments };
    },
    [automationById, runsByPipelineRoot, visibleAutomations, visibleRuns]
  );

  const resetColumnLayout = useCallback((): void => {
    setColumnPrefs({
      backlog: "auto",
      enabled: "auto",
      running: "auto",
      needs_input: "auto",
      completed: "auto",
      failed: "auto",
    });
    const contentByColumn = {} as Record<
      ColumnKey,
      ReturnType<typeof contentForColumn>
    >;
    for (const key of COLUMN_KEYS) {
      contentByColumn[key] = contentForColumn(key);
    }
    setColumnWidths(smartOpenColumnWidths(contentByColumn));
  }, [contentForColumn]);

  const autoFitColumnWidth = useCallback(
    (key: ColumnKey): void => {
      setColumnWidth(key, fitColumnWidthForContent(contentForColumn(key)));
    },
    [contentForColumn, setColumnWidth]
  );

  // Track failures across the full run set (not the filtered view) so changing
  // the workspace/search filter never registers old failures as "new".
  const failedRunIds = useMemo(
    () =>
      new Set(runs.filter((r) => r.status === "failed").map((r) => r.id)),
    [runs]
  );

  useEffect(() => {
    if (isFirstFailedCheckRef.current) {
      isFirstFailedCheckRef.current = false;
      prevFailedRunIdsRef.current = failedRunIds;
      return;
    }

    const prev = prevFailedRunIdsRef.current;
    let hasNewFailure = false;
    for (const id of failedRunIds) {
      if (!prev.has(id)) {
        hasNewFailure = true;
        break;
      }
    }

    if (hasNewFailure) {
      lastFailureAtRef.current = Date.now();
      setRecentFailureTick(Date.now());
    }

    prevFailedRunIdsRef.current = failedRunIds;
  }, [failedRunIds]);

  const recentlyActiveFailed =
    Date.now() - lastFailureAtRef.current < RECENT_WINDOW_MS;

  useEffect(() => {
    if (failureTimerRef.current) {
      clearTimeout(failureTimerRef.current);
      failureTimerRef.current = null;
    }

    if (!recentlyActiveFailed) return;

    const remaining = RECENT_WINDOW_MS - (Date.now() - lastFailureAtRef.current);
    if (remaining <= 0) return;

    failureTimerRef.current = setTimeout(() => {
      setRecentFailureTick(Date.now());
    }, remaining + 50);

    return () => {
      if (failureTimerRef.current) {
        clearTimeout(failureTimerRef.current);
        failureTimerRef.current = null;
      }
    };
  }, [recentlyActiveFailed, recentFailureTick, failedRunIds]);

  const columnMeta = useMemo(
    () =>
      buildColumnMeta({
        columnPrefs,
        visibleAutomations,
        visibleRuns,
        pendingInputByRun,
        recentlyActiveFailed,
        runColumn,
      }),
    [
      columnPrefs,
      visibleAutomations,
      visibleRuns,
      pendingInputByRun,
      recentlyActiveFailed,
    ]
  );

  const gridTemplateColumns = useMemo(
    () => buildGridTemplateColumns(columnMeta, columnWidths),
    [columnMeta, columnWidths]
  );

  const mobilePagerColumnKeysList = useMemo(
    () => mobilePagerColumnKeys(columnMeta, activeColumn),
    [columnMeta, activeColumn]
  );

  const mobilePagerColumns = useMemo(
    () => COLUMNS.filter((col) => mobilePagerColumnKeysList.includes(col.key)),
    [mobilePagerColumnKeysList]
  );

  useLayoutEffect(() => {
    if (!isNarrowViewport) return;
    const pager = mobilePagerRef.current;
    if (!pager) return;
    const index = mobilePagerColumnKeysList.indexOf(activeColumn);
    const idx = index >= 0 ? index : 0;
    pager.scrollLeft = idx * pager.clientWidth;
  }, [isNarrowViewport, activeColumn, mobilePagerColumnKeysList]);

  useEffect(() => {
    if (!isNarrowViewport) return;
    const pager = mobilePagerRef.current;
    if (!pager) return;

    let scrollEndTimer: ReturnType<typeof setTimeout> | null = null;

    const onScrollEnd = (): void => {
      syncActiveColumnFromPagerScroll(mobilePagerColumnKeysList);
    };

    const onScroll = (): void => {
      if (tabScrollInFlightRef.current) return;
      if (scrollEndTimer) clearTimeout(scrollEndTimer);
      scrollEndTimer = setTimeout(() => {
        scrollEndTimer = null;
        onScrollEnd();
      }, 120);
    };

    pager.addEventListener("scroll", onScroll, { passive: true });
    pager.addEventListener("scrollend", onScrollEnd);

    return () => {
      pager.removeEventListener("scroll", onScroll);
      pager.removeEventListener("scrollend", onScrollEnd);
      if (scrollEndTimer) clearTimeout(scrollEndTimer);
    };
  }, [isNarrowViewport, syncActiveColumnFromPagerScroll, mobilePagerColumnKeysList]);

  // True when the most recent failure ended after the most recent completion, so
  // the mobile board only prefers Failed over Completed for a fresh failure.
  const failureNewerThanCompletion = useMemo(() => {
    const latestEnd = (status: Run["status"]): number => {
      let max = 0;
      for (const r of visibleRuns) {
        if (r.status !== status) continue;
        const t = Date.parse(r.endedAt ?? r.updatedAt ?? r.createdAt);
        if (!Number.isNaN(t) && t > max) max = t;
      }
      return max;
    };
    return latestEnd("failed") > latestEnd("completed");
  }, [visibleRuns]);

  // Land the mobile board on the most relevant column the first time real data
  // arrives. Runs once so it never fights a tab the user has tapped/swiped to.
  const hasLoadedData = automations.length > 0 || runs.length > 0;
  useEffect(() => {
    if (didPickInitialColumnRef.current || !hasLoadedData) return;
    didPickInitialColumnRef.current = true;
    const initial = pickInitialMobileColumn(columnMeta, failureNewerThanCompletion);
    setActiveColumn(initial);
    if (isNarrowViewport) {
      requestAnimationFrame(() =>
        scrollMobilePagerToColumn(initial, columnMeta, "auto")
      );
    }
  }, [
    hasLoadedData,
    columnMeta,
    failureNewerThanCompletion,
    isNarrowViewport,
    scrollMobilePagerToColumn,
  ]);

  const action = (fn: () => Promise<unknown>) => {
    fn()
      .then(() => refresh())
      .catch((err) => console.error(err));
  };

  const runAutomation = (automationId: string): void => {
    api
      .triggerRun(automationId)
      .then(() => {
        if (isNarrowViewport) {
          setActiveColumn("running");
          requestAnimationFrame(() =>
            scrollMobilePagerToColumn("running", columnMeta, "smooth")
          );
        } else {
          setColumnPref("running", "open");
        }
        refresh();
      })
      .catch((err) => console.error(err));
  };

  const handleDrop = async (column: ColumnKey) => {
    if (!drag) return;
    const current = drag;
    setDrag(null);
    try {
      if (column === "running") {
        runAutomation(current.id);
        return;
      } else if (column === "enabled" && !current.enabled) {
        await api.setEnabled(current.id, true);
      } else if (column === "backlog" && current.enabled) {
        await api.setEnabled(current.id, false);
      }
      refresh();
    } catch (err) {
      console.error("Drop action failed:", err);
      refresh();
    }
  };

  const exitSelection = useCallback((): void => {
    setSelectionMode(false);
    setSelectedRunIds(new Set());
    setSelectedAutomationIds(new Set());
    setMoveSheetOpen(false);
  }, []);

  const prevActiveColumnRef = useRef(activeColumn);

  useEffect(() => {
    if (!isNarrowViewport) return;
    if (prevActiveColumnRef.current !== activeColumn) {
      exitSelection();
    }
    prevActiveColumnRef.current = activeColumn;
  }, [activeColumn, isNarrowViewport, exitSelection]);

  const enterAutomationSelection = useCallback((id: string): void => {
    setSelectionMode(true);
    setSelectedAutomationIds(new Set([id]));
    setSelectedRunIds(new Set());
  }, []);

  const enterRunSelection = useCallback((id: string): void => {
    setSelectionMode(true);
    setSelectedRunIds(new Set([id]));
    setSelectedAutomationIds(new Set());
  }, []);

  /** Shared navigation + refresh after durable promote-to-chat succeeds. */
  const handlePromoteSuccess = useCallback(
    (chat: ChatSession): void => {
      setActiveWorkspaceId(chat.workspaceId);
      setActiveChatId(chat.id);
      setActiveView("chat");
      void refresh();
    },
    [refresh]
  );

  const toggleAutomationSelection = (id: string): void => {
    setSelectedAutomationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleRunSelection = (runId: string): void => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const selectedCountInActiveColumn = useMemo((): number => {
    if (selectionTargetsAutomations(activeColumn)) {
      return visibleAutomations.filter(
        (a) =>
          selectedAutomationIds.has(a.id) &&
          (activeColumn === "enabled" ? a.enabled : !a.enabled)
      ).length;
    }
    if (isSelectableColumn(activeColumn) && !selectionTargetsAutomations(activeColumn)) {
      return visibleRuns.filter(
        (r) =>
          selectedRunIds.has(r.id) && runColumn(r.status) === activeColumn
      ).length;
    }
    return 0;
  }, [
    activeColumn,
    visibleAutomations,
    visibleRuns,
    selectedAutomationIds,
    selectedRunIds,
  ]);

  const hasConfigOriginSelected = useMemo((): boolean => {
    for (const id of selectedAutomationIds) {
      if (automationById.get(id)?.origin === "config") return true;
    }
    return false;
  }, [selectedAutomationIds, automationById]);

  useEffect(() => {
    if (!isNarrowViewport || !selectionMode) return;
    if (selectedCountInActiveColumn === 0) {
      exitSelection();
    }
  }, [
    isNarrowViewport,
    selectionMode,
    selectedCountInActiveColumn,
    exitSelection,
  ]);

  const deleteAutomations = (ids: string[]): void => {
    if (ids.length === 0) return;
    action(async () => {
      await Promise.all(ids.map((id) => api.deleteAutomation(id)));
      exitSelection();
    });
  };

  const moveAutomationsTo = (dest: ColumnKey, ids: string[]): void => {
    if (ids.length === 0) return;
    action(async () => {
      for (const id of ids) {
        const auto = automationById.get(id);
        if (!auto) continue;
        if (dest === "running") {
          await api.triggerRun(id);
        } else if (dest === "enabled" && !auto.enabled) {
          await api.setEnabled(id, true);
        } else if (dest === "backlog" && auto.enabled) {
          await api.setEnabled(id, false);
        }
      }
      exitSelection();
    });
  };

  const deleteRuns = (runIds: string[]): void => {
    if (runIds.length === 0) return;
    action(async () => {
      await api.deleteRuns(runIds);
      setSelectedRunIds((prev) => {
        const next = new Set(prev);
        for (const id of runIds) next.delete(id);
        return next;
      });
      if (logsRunId && runIds.includes(logsRunId)) {
        setLogsRunId(null);
      }
    });
  };

  const effectiveCollapsed = controlBarCollapsed || isNarrowViewport;

  const runsForColumn = (key: ColumnKey): Run[] =>
    key !== "backlog" && key !== "enabled"
      ? visibleRuns.filter((r) => runColumn(r.status) === key)
      : [];

  const escalateRun = (runId: string) =>
    (escAction: RunEscalationAction, reason?: string) => {
      setEscalationErrorByRun((previous) => {
        const next = { ...previous };
        delete next[runId];
        return next;
      });
      void (async () => {
        try {
          await api.escalate(runId, {
            action: escAction,
            ...(reason ? { reason } : {}),
          });
          refresh();
        } catch (err) {
          const message =
            err instanceof EscalationError
              ? `${err.code}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err);
          setEscalationErrorByRun((previous) => ({
            ...previous,
            [runId]: message,
          }));
        }
      })();
    };

  const renderRunCard = (r: Run): ReactNode => {
    const auto = automationById.get(r.automationId);
    return (
      <RunCard
        key={r.id}
        run={r}
        automationName={auto?.name ?? r.automationId.slice(0, 8)}
        workspaceName={workspaceLabel(r.workspaceId, workspaces)}
        showWorkspace={boardScopeAll}
        configKey={auto?.configKey ?? null}
        hasSuccessor={Boolean(auto?.chain?.next)}
        selection={
          r.modelSelection ??
          modelByRun[r.id] ??
          auto?.modelSelection ??
          null
        }
        models={availableModels}
        triggerKind={r.triggerKind ?? auto?.trigger.type ?? null}
        lastEvent={lastEventByRun[r.id]}
        pendingInput={pendingInputByRun[r.id]}
        selectable={isTerminalRun(r.status)}
        selected={selectedRunIds.has(r.id)}
        onToggleSelect={() => toggleRunSelection(r.id)}
        onDelete={() => deleteRuns([r.id])}
        onViewLogs={() => setLogsRunId(r.id)}
        onOpenRun={(id) => {
          if (runById.has(id)) setLogsRunId(id);
        }}
        parentRunLoaded={!r.parentRunId || runById.has(r.parentRunId)}
        rootRunLoaded={!r.chainRootRunId || runById.has(r.chainRootRunId)}
        successorRunIds={
          successorByParentRunId.get(r.id)?.map((child) => child.id) ?? []
        }
        onEscalate={escalateRun(r.id)}
        escalationError={escalationErrorByRun[r.id]}
        onCancel={() => action(() => api.cancel(r.id))}
        onAnswer={(answer) =>
          api.answer(r.id, answer).then(() => {
            refresh();
          })
        }
        onPromoteToChat={async () => {
          const chat = await api.promoteRunToChat(r.id);
          handlePromoteSuccess(chat);
        }}
        selectionMode={
          isNarrowViewport && selectionMode && isTerminalRun(r.status)
        }
        onLongPress={
          isNarrowViewport && isTerminalRun(r.status)
            ? () => enterRunSelection(r.id)
            : undefined
        }
        tapExpands={isNarrowViewport}
      />
    );
  };

  const renderPipelineGroup = (
    group: PipelineGroup,
    defaultExpandedRootId: string | null
  ): ReactNode => {
    const featureLabel =
      group.summary?.featureId ?? group.rootRunId.slice(0, 8);
    const pipelineLabel =
      group.summary?.pipelineId ?? group.rootRunId.slice(0, 8);
    const featureSlug = group.summary?.featureSlug ?? null;
    // Status/elapsed/depth are for the whole implement-fully pipeline, not the
    // column slice (e.g. completed column would otherwise always say completed).
    const pipelineRuns =
      runsByPipelineRoot.get(group.rootRunId) ?? group.runs;
    const workspaceId = pipelineRuns[0]?.workspaceId ?? null;
    const canLinkDocs = Boolean(featureSlug && workspaceId);
    let maxDepthSeen: number | null = null;
    let budgetNum: number | null = null;
    let deepestDepth = Number.NEGATIVE_INFINITY;
    for (const run of pipelineRuns) {
      const d = run.chainDepth;
      if (typeof d !== "number") continue;
      if (maxDepthSeen == null || d > maxDepthSeen) maxDepthSeen = d;
      if (d >= deepestDepth) {
        deepestDepth = d;
        budgetNum = effectiveChainBudget(run);
      }
    }
    const depth = maxDepthSeen != null ? String(maxDepthSeen) : "?";
    const budget = budgetNum != null ? String(budgetNum) : "?";
    const wave = group.waveSummary;
    const waveGates = waveOperatorActionGates(wave);
    const waveId = wave?.id;
    const groupStatus = pipelineGroupStatus(pipelineRuns);
    const groupElapsed = pipelineGroupAggregateElapsed(
      pipelineRuns,
      pipelineNow
    );
    const expanded =
      pipelineGroupExpandOverrides[group.rootRunId] ??
      group.rootRunId === defaultExpandedRootId;
    const toggleExpanded = (): void => {
      setPipelineGroupExpandOverrides((prev) => ({
        ...prev,
        [group.rootRunId]: !expanded,
      }));
    };
    return (
      <div
        key={`group-${group.rootRunId}`}
        className="flex flex-col gap-1.5 rounded-md border-l-2 border-border pl-2"
      >
        <div
          className="sticky top-0 z-[1] flex cursor-pointer flex-wrap items-center gap-x-0 gap-y-0.5 bg-card/95 px-0.5 py-1 text-[11px] text-muted-foreground backdrop-blur-sm"
          title={`root ${group.rootRunId}`}
          onClick={(e) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest("a, button")) return;
            toggleExpanded();
          }}
        >
          <button
            type="button"
            className="mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `Collapse ${featureLabel} pipeline`
                : `Expand ${featureLabel} pipeline`
            }
            onClick={toggleExpanded}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden="true" />
            )}
          </button>
          {groupStatus && (
            <>
              <StatusDot
                status={groupStatus}
                pulse={
                  groupStatus === "running" || groupStatus === "needs_input"
                }
                title={formatPipelineGroupStatus(groupStatus)}
                className="mr-1"
              />
              <span className="font-medium text-foreground">
                {formatPipelineGroupStatus(groupStatus)}
              </span>
              <span className="mx-1">·</span>
            </>
          )}
          {canLinkDocs && featureSlug && workspaceId ? (
            <FeatureLabelLink
              workspaceId={workspaceId}
              featureSlug={featureSlug}
              label={featureLabel}
            />
          ) : (
            <span className="font-semibold text-foreground">{featureLabel}</span>
          )}
          <span className="mx-1">·</span>
          <span className="font-mono">{pipelineLabel}</span>
          <span className="mx-1">·</span>
          <span>
            {depth}/{budget}
          </span>
          <span className="mx-1">·</span>
          <span>
            {pipelineRuns.length} run{pipelineRuns.length === 1 ? "" : "s"}
          </span>
          <span className="mx-1">·</span>
          <span title="Pipeline wall-clock time">⏲ {groupElapsed}</span>
          {canLinkDocs && featureSlug && workspaceId && (
            <>
              <span className="mx-1">·</span>
              <PipelineDocsMenu
                workspaceId={workspaceId}
                featureSlug={featureSlug}
                runs={pipelineRuns}
              />
            </>
          )}
          {wave && (
            <>
              <span className="mx-1">·</span>
              <span title={`wave ${wave.id}`}>{formatWaveTrackProgress(wave)}</span>
              {wave.cleanupRequired && (
                <>
                  <span className="mx-1">·</span>
                  <span className="text-amber-600 dark:text-amber-400">
                    cleanup required
                  </span>
                </>
              )}
            </>
          )}
          {wave && (waveGates.retry.enabled || waveGates.abort.enabled) && waveId && (
            <span className="ml-2 inline-flex gap-1">
              {waveGates.retry.enabled && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-5 px-1.5 text-[10px]"
                  onClick={() =>
                    action(async () => {
                      await api.waveAction(waveId, {
                        action: "retry-integration",
                      });
                    })
                  }
                >
                  Retry integration
                </Button>
              )}
              {waveGates.abort.enabled && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
                  onClick={() =>
                    action(async () => {
                      await api.waveAction(waveId, { action: "abort" });
                    })
                  }
                >
                  Abort wave
                </Button>
              )}
            </span>
          )}
        </div>
        {expanded && (
          <div className="flex flex-col gap-2.5">
            {group.runs.map(renderRunCard)}
          </div>
        )}
      </div>
    );
  };

  const renderColumnBody = (colKey: ColumnKey): ReactNode => {
    const colRuns = runsForColumn(colKey);
    const layout =
      colKey !== "backlog" && colKey !== "enabled"
        ? layoutColumnRuns(colRuns)
        : null;
    const defaultExpandedRootId = layout
      ? defaultExpandedPipelineRootId(layout.groups, runsByPipelineRoot)
      : null;
    return (
      // Top padding lives on an inner wrapper (not the scroller) so sticky
      // pipeline headers can scroll through that gap, then pin flush at top:0.
      <OverlayScrollArea contentClassName="px-2.5 pb-2.5">
        <div className="flex flex-col gap-2.5 pt-2.5">
          {(colKey === "backlog" || colKey === "enabled") &&
            visibleAutomations
              .filter((a) => (colKey === "enabled" ? a.enabled : !a.enabled))
              .map((a) => (
                <AutomationCard
                  key={a.id}
                  automation={a}
                  workspaceName={workspaceLabel(a.workspaceId, workspaces)}
                  showWorkspace={boardScopeAll}
                  lastRunStatus={lastRunStatusByAutomation.get(a.id) ?? null}
                  models={availableModels}
                  onDragStart={() => setDrag({ id: a.id, enabled: a.enabled })}
                  onDragEnd={() => setDrag(null)}
                  onRun={() => runAutomation(a.id)}
                  onToggleEnabled={() =>
                    action(() => api.setEnabled(a.id, !a.enabled))
                  }
                  onEdit={() => setEditor({ mode: "edit", automation: a })}
                  onDuplicate={() =>
                    setEditor({ mode: "duplicate", source: a })
                  }
                  onDelete={() => action(() => api.deleteAutomation(a.id))}
                  selectionMode={
                    isNarrowViewport &&
                    selectionMode &&
                    selectionTargetsAutomations(colKey)
                  }
                  selected={selectedAutomationIds.has(a.id)}
                  onToggleSelect={() => toggleAutomationSelection(a.id)}
                  onLongPress={
                    isNarrowViewport
                      ? () => enterAutomationSelection(a.id)
                      : undefined
                  }
                  tapExpands={isNarrowViewport}
                />
              ))}

          {layout && (
            <>
              {layout.groups.map((group) =>
                renderPipelineGroup(group, defaultExpandedRootId)
              )}
              {layout.ungrouped.map(renderRunCard)}
            </>
          )}
        </div>
      </OverlayScrollArea>
    );
  };

  // The sidebar always keeps one focused workspace regardless of board scope,
  // so kickoff can default to it without asking again.
  const kickoffDefaultWorkspaceId = activeWorkspaceId;

  const logsLineageRuns = useMemo(() => {
    if (!logsRunId) return undefined;
    const current = runs.find((r) => r.id === logsRunId);
    const root = current?.chainRootRunId;
    if (!root) return undefined;
    return runs.filter((r) => r.chainRootRunId === root);
  }, [logsRunId, runs]);

  const renderColumnHeaderActions = (
    colKey: ColumnKey,
    colRuns: Run[],
    selectedInCol: Run[]
  ): ReactNode =>
    DELETABLE_COLUMNS.has(colKey) && colRuns.length > 0 ? (
      <div className="flex items-center gap-2">
        {selectedInCol.length > 0 ? (
          <ConfirmButton
            label={`Delete (${selectedInCol.length})`}
            confirmLabel={`Delete ${selectedInCol.length}`}
            onConfirm={() => deleteRuns(selectedInCol.map((r) => r.id))}
          />
        ) : (
          <ConfirmButton
            label="Clear"
            confirmLabel={`Clear ${colRuns.length}`}
            onConfirm={() => deleteRuns(colRuns.map((r) => r.id))}
          />
        )}
      </div>
    ) : null;

  return (
    <div className="flex h-dvh flex-col">
      {authRequired && (
        <TokenGate
          onSubmit={() => {
            setAuthRequired(false);
            refresh();
          }}
        />
      )}
      {error && (
        <div className="border-b border-destructive/40 bg-destructive/15 px-[18px] py-2 text-destructive">
          Cannot reach daemon: {error}
        </div>
      )}

      {isNarrowViewport && !(activeView === "board" && selectionMode) && (
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <h1 className="m-0 min-w-0 truncate text-base font-semibold tracking-[0.2px]">
              Max
            </h1>
            <StatusDot
              status={connected ? "live" : "offline"}
              title={connected ? "Daemon connected" : "Daemon offline"}
            />
          </div>
          <div className="ml-auto flex min-w-0 max-w-[65%] shrink items-center gap-1.5">
            <WorkspacePicker
              className="h-9"
              workspaces={workspaces}
              pickerWorkspaces={chatWorkspaces}
              automationCountByWs={automationCountByWs}
              boardScopeAll={boardScopeAll}
              activeWorkspaceId={activeWorkspaceId}
              onSelectAllWorkspaces={selectAllWorkspaces}
              onSelectWorkspace={selectWorkspace}
              showAllOption={activeView === "board"}
            />
            {activeView === "board" && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Search automations"
                onClick={() => setFilterSheetOpen(true)}
              >
                <Search />
              </Button>
            )}
          </div>
        </header>
      )}

      <div className="flex min-h-0 flex-1">
        {!isNarrowViewport && (
          <ControlBar
            connected={connected}
            collapsed={effectiveCollapsed}
            onToggleCollapse={() => setControlBarCollapsed((c) => !c)}
            workspaces={workspaces}
            pickerWorkspaces={chatWorkspaces}
            automationCountByWs={automationCountByWs}
            boardScopeAll={boardScopeAll}
            activeWorkspaceId={activeWorkspaceId}
            onSelectAllWorkspaces={selectAllWorkspaces}
            onSelectWorkspace={selectWorkspace}
            search={search}
            onSearchChange={setSearch}
            onResetLayout={resetColumnLayout}
            onNewAutomation={() => setEditor({ mode: "create" })}
            onImplementFully={() => setKickoffOpen(true)}
            onExport={(format) =>
              downloadExport(format, boardScopeAll ? null : activeWorkspaceId)
            }
            activeView={activeView}
            onSelectView={selectView}
          />
        )}

        {activeView === "chat" ? (
          <ChatView
            workspaces={chatWorkspaces}
            activeWorkspaceId={activeWorkspaceId}
            activeChatId={activeChatId}
            onSelectChat={setActiveChatId}
            isNarrow={isNarrowViewport}
          />
        ) : activeView === "files" ? (
          <FilesView
            workspaces={chatWorkspaces}
            activeWorkspaceId={activeWorkspaceId}
            isNarrow={isNarrowViewport}
            location={activeFilesLocation}
            onLocationChange={onFilesLocationChange}
            canGoBack={canGoBack(filesNav)}
            canGoForward={canGoForward(filesNav)}
            onGoBack={onFilesGoBack}
            onGoForward={onFilesGoForward}
          />
        ) : activeView === "settings" ? (
          <SettingsView
            workspaces={chatWorkspaces}
            activeWorkspaceId={activeWorkspaceId}
            isNarrow={isNarrowViewport}
          />
        ) : search.trim() === "" &&
          visibleAutomations.length === 0 &&
          visibleRuns.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 border border-border bg-card p-6 text-center">
            <p className="m-0 text-sm text-muted-foreground">
              Create something to see it on the board.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                type="button"
                onClick={() => setEditor({ mode: "create" })}
              >
                <Plus />
                Automation
              </Button>
              <Button
                type="button"
                variant="surface"
                onClick={() => setKickoffOpen(true)}
              >
                <Rocket />
                Feature
              </Button>
            </div>
          </div>
        ) : isNarrowViewport ? (
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col pb-16">
            {selectionMode && (
              <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label="Cancel selection"
                  onClick={exitSelection}
                >
                  <X />
                </Button>
                <span className="min-w-0 flex-1 text-center text-sm font-semibold">
                  {selectedCountInActiveColumn} selected
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  {selectionTargetsAutomations(activeColumn) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11 text-muted-foreground hover:text-foreground"
                      aria-label="Move selected"
                      disabled={selectedCountInActiveColumn === 0}
                      onClick={() => setMoveSheetOpen(true)}
                    >
                      <ArrowRightLeft />
                    </Button>
                  )}
                  <div
                    className={cn(
                      (selectedCountInActiveColumn === 0 ||
                        (selectionTargetsAutomations(activeColumn) &&
                          hasConfigOriginSelected)) &&
                        "pointer-events-none opacity-40"
                    )}
                  >
                    <ConfirmButton
                      label={<Trash2 className="size-5" />}
                      confirmLabel={`Delete ${selectedCountInActiveColumn}`}
                      className="size-11 min-h-11 min-w-11 p-0"
                      title="Delete selected"
                      onConfirm={() => {
                        if (selectionTargetsAutomations(activeColumn)) {
                          deleteAutomations([...selectedAutomationIds]);
                        } else {
                          const ids = visibleRuns
                            .filter(
                              (r) =>
                                selectedRunIds.has(r.id) &&
                                runColumn(r.status) === activeColumn
                            )
                            .map((r) => r.id);
                          action(async () => {
                            await api.deleteRuns(ids);
                            if (logsRunId && ids.includes(logsRunId)) {
                              setLogsRunId(null);
                            }
                            exitSelection();
                          });
                        }
                      }}
                    />
                  </div>
                </div>
              </header>
            )}

            <div
              ref={mobileTabStripRef}
              className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3"
              role="tablist"
              aria-label="Board columns"
            >
              {COLUMNS.map((col) => {
                const active = col.key === activeColumn;
                const count = columnMeta[col.key].count;
                return (
                  <button
                    key={col.key}
                    id={`mobile-tab-${col.key}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`mobile-column-${col.key}`}
                    className={cn(
                      "flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      active
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => {
                      setActiveColumn(col.key);
                      scrollMobilePagerToColumn(col.key, columnMeta, "smooth");
                    }}
                  >
                    {col.title}
                    {count > 0 ? (
                      <span className="shrink-0 text-[10px] font-normal opacity-45">
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div
              ref={mobilePagerRef}
              className="no-scrollbar flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
            >
              {mobilePagerColumns.map((col) => {
                const meta = columnMeta[col.key];
                const colRuns = runsForColumn(col.key);
                const selectedInCol = colRuns.filter((r) =>
                  selectedRunIds.has(r.id)
                );

                return (
                  <section
                    key={col.key}
                    data-col={col.key}
                    id={`mobile-column-${col.key}`}
                    role="tabpanel"
                    aria-labelledby={`mobile-tab-${col.key}`}
                    className="flex w-full shrink-0 snap-start flex-col min-h-0 box-border"
                  >
                    <div className="flex min-h-0 flex-1 flex-col bg-card">
                      <div className="flex items-center justify-between border-b border-border px-3 py-2.5 text-[13px] font-semibold uppercase tracking-[0.4px]">
                        <span>{col.title}</span>
                        <div className="flex items-center gap-2">
                          {renderColumnHeaderActions(
                            col.key,
                            colRuns,
                            selectedInCol
                          )}
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal normal-case tracking-normal text-muted-foreground">
                            {meta.count}
                          </span>
                        </div>
                      </div>
                      {renderColumnBody(col.key)}
                    </div>
                  </section>
                );
              })}
            </div>

            {!selectionMode && (
              <MobileCreateFab
                onNewAutomation={() => setEditor({ mode: "create" })}
                onRunFeaturePipeline={() => setKickoffOpen(true)}
              />
            )}

            <MobileFilterSheet
              open={moveSheetOpen}
              onOpenChange={setMoveSheetOpen}
              title="Move to"
            >
              <div className="flex flex-col gap-2">
                {moveDestinations(activeColumn).map((dest) => {
                  const title =
                    COLUMNS.find((c) => c.key === dest)?.title ?? dest;
                  return (
                    <Button
                      key={dest}
                      type="button"
                      variant="surface"
                      className="h-11 w-full justify-start"
                      onClick={() =>
                        moveAutomationsTo(dest, [...selectedAutomationIds])
                      }
                    >
                      {title}
                    </Button>
                  );
                })}
              </div>
            </MobileFilterSheet>

            <MobileFilterSheet
              open={filterSheetOpen}
              onOpenChange={setFilterSheetOpen}
            >
              <ControlBar
                asSheet
                connected={connected}
                collapsed={false}
                onToggleCollapse={() => {}}
                workspaces={workspaces}
                pickerWorkspaces={chatWorkspaces}
                automationCountByWs={automationCountByWs}
                boardScopeAll={boardScopeAll}
                activeWorkspaceId={activeWorkspaceId}
                onSelectAllWorkspaces={selectAllWorkspaces}
                onSelectWorkspace={selectWorkspace}
                search={search}
                onSearchChange={setSearch}
                onResetLayout={resetColumnLayout}
                onNewAutomation={() => {
                  setFilterSheetOpen(false);
                  setEditor({ mode: "create" });
                }}
                onImplementFully={() => {
                  setFilterSheetOpen(false);
                  setKickoffOpen(true);
                }}
                onExport={(format) =>
                  downloadExport(format, boardScopeAll ? null : activeWorkspaceId)
                }
              />
            </MobileFilterSheet>
          </div>
        ) : (
          <div
            className="grid min-w-0 flex-1 justify-start gap-3 overflow-x-auto p-3.5"
            style={{ gridTemplateColumns }}
          >
            {COLUMNS.map((col) => {
              const meta = columnMeta[col.key];
              const collapsed = meta.collapsed;
              const acceptsDrag = Boolean(drag) && col.droppable;
              const colRuns = runsForColumn(col.key);
              const selectedInCol = colRuns.filter((r) =>
                selectedRunIds.has(r.id)
              );

              return (
                <section
                  key={col.key}
                  className={cn(
                    "relative flex min-h-0 flex-col rounded-lg border border-border bg-card",
                    collapsed && "min-w-[40px]",
                    acceptsDrag &&
                      "border-ring shadow-[inset_0_0_0_1px_var(--ring)]"
                  )}
                  onDragOver={(e) => {
                    if (acceptsDrag) e.preventDefault();
                  }}
                  onDrop={() => void handleDrop(col.key)}
                >
                  {collapsed ? (
                    <button
                      type="button"
                      className="flex min-h-[120px] w-full flex-1 cursor-pointer flex-col items-center justify-start gap-2 rounded-lg border-none bg-transparent px-1 py-2.5 text-foreground hover:bg-muted"
                      title={`Expand ${col.title}`}
                      onClick={() => toggleColumnPin(col.key, true)}
                    >
                      <span className="max-h-full overflow-hidden text-ellipsis text-[11px] font-semibold uppercase leading-tight tracking-[0.4px] [writing-mode:vertical-rl] [text-orientation:mixed] rotate-180">
                        {col.title}
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
                        {meta.count}
                      </span>
                    </button>
                  ) : (
                    <>
                      <div className="flex items-center justify-between border-b border-border px-3 py-2.5 text-[13px] font-semibold uppercase tracking-[0.4px]">
                        <span>{col.title}</span>
                        <div className="flex items-center gap-2">
                          {renderColumnHeaderActions(
                            col.key,
                            colRuns,
                            selectedInCol
                          )}
                          <button
                            type="button"
                            className="flex size-6 items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:border-ring hover:text-ring"
                            title={`Collapse ${col.title}`}
                            aria-label={`Collapse ${col.title}`}
                            onClick={() => toggleColumnPin(col.key, false)}
                          >
                            <ChevronLeft className="size-4" />
                          </button>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal normal-case tracking-normal text-muted-foreground">
                            {meta.count}
                          </span>
                        </div>
                      </div>

                      {renderColumnBody(col.key)}
                      <ColumnResizeHandle
                        columnTitle={col.title}
                        width={columnWidths[col.key]}
                        onWidthChange={(next) => setColumnWidth(col.key, next)}
                        onAutoFit={() => autoFitColumnWidth(col.key)}
                      />
                    </>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {isNarrowViewport && (
        <nav
          className="fixed inset-x-0 bottom-0 z-50 flex border-t border-border bg-card"
          aria-label="Main navigation"
        >
          <button
            type="button"
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-2 text-[11px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              activeView === "board"
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-current={activeView === "board" ? "page" : undefined}
            onClick={() => selectView("board")}
          >
            <Columns3 className="size-5" aria-hidden="true" />
            Board
          </button>
          <button
            type="button"
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-2 text-[11px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              activeView === "chat"
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-current={activeView === "chat" ? "page" : undefined}
            onClick={() => selectView("chat")}
          >
            <MessageSquare className="size-5" aria-hidden="true" />
            Chat
          </button>
          <button
            type="button"
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-2 text-[11px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              activeView === "files"
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-current={activeView === "files" ? "page" : undefined}
            onClick={() => selectView("files")}
          >
            <FolderOpen className="size-5" aria-hidden="true" />
            Files
          </button>
          <button
            type="button"
            className={cn(
              "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-2 py-2 text-[11px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              activeView === "settings"
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
            aria-current={activeView === "settings" ? "page" : undefined}
            onClick={() => selectView("settings")}
          >
            <Settings className="size-5" aria-hidden="true" />
            Settings
          </button>
        </nav>
      )}

      {logsRunId && (
        <LogsModal
          runId={logsRunId}
          workspaceId={logsRun?.workspaceId}
          workspaceName={
            logsRun ? workspaceLabel(logsRun.workspaceId, workspaces) : undefined
          }
          automationName={
            logsRun
              ? automationById.get(logsRun.automationId)?.name
              : undefined
          }
          configKey={
            logsRun
              ? automationById.get(logsRun.automationId)?.configKey ?? null
              : null
          }
          hasSuccessor={Boolean(
            logsRun
              ? automationById.get(logsRun.automationId)?.chain?.next
              : false
          )}
          modelOverride={logsRun?.modelSelection ?? null}
          automationSelection={
            logsRun
              ? automationById.get(logsRun.automationId)?.modelSelection ?? null
              : null
          }
          startedAt={logsRun?.startedAt}
          createdAt={logsRun?.createdAt}
          lineageRuns={logsLineageRuns}
          onOpenRun={(id) => {
            if (runById.has(id)) setLogsRunId(id);
          }}
          onEscalate={escalateRun(logsRunId)}
          escalationError={escalationErrorByRun[logsRunId]}
          onClose={() => setLogsRunId(null)}
          onRunUpdated={applyRun}
          onPromoteSuccess={handlePromoteSuccess}
        />
      )}

      {kickoffOpen && (
        <PipelineKickoffModal
          workspaces={workspaces}
          runs={runs}
          defaultWorkspaceId={kickoffDefaultWorkspaceId}
          onClose={() => setKickoffOpen(false)}
          onStarted={(runId) => {
            setKickoffOpen(false);
            refresh();
            setLogsRunId(runId);
          }}
        />
      )}

      {editor?.mode === "create" && (
        <AutomationModal
          mode="create"
          workspaces={workspaces}
          automations={automations}
          onClose={() => setEditor(null)}
          onWorkspacesRefresh={refresh}
          onSubmit={async (payload) => {
            await api.createAutomation(payload);
            refresh();
            setEditor(null);
          }}
        />
      )}

      {editor?.mode === "duplicate" && (
        <AutomationModal
          key={editor.source.id}
          mode="create"
          initial={{
            ...editor.source,
            name: `Copy of ${editor.source.name}`,
            enabled: false,
          }}
          workspaces={workspaces}
          automations={automations}
          onClose={() => setEditor(null)}
          onWorkspacesRefresh={refresh}
          onSubmit={async (payload) => {
            await api.createAutomation(payload);
            refresh();
            setEditor(null);
          }}
        />
      )}

      {editor?.mode === "edit" && (
        <AutomationModal
          key={editor.automation.id}
          mode="edit"
          initial={editor.automation}
          workspaces={workspaces}
          automations={automations}
          onClose={() => setEditor(null)}
          onSubmit={async (payload) => {
            await api.updateAutomation(editor.automation.id, payload);
            refresh();
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}
