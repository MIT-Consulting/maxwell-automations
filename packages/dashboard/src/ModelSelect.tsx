import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Check, ChevronDown, RotateCcw, Search } from "lucide-react";
import { RemoveScroll } from "react-remove-scroll";
import type { ModelParameterValue, ModelSelection } from "@lca/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  baseModelOptions,
  buildSelection,
  controlsForSelection,
  modelRowSuffixes,
  selectionDisplayParts,
  selectionForBaseModel,
  selectionLabel,
  withParamValue,
  type ModelControl,
} from "./modelControls";
import { useAvailableModels } from "./useAvailableModels";
import { useCanHover } from "./useCanHover";
import { useIsNarrowViewport } from "./useIsNarrowViewport";

/** Sentinel for the inherit / recipe-default option. */
const DEFAULT_MODEL_OPTION = "__default__";

/** Fullscreen surface — same chrome as kickoff / logs / automation modals. */
const MOBILE_PICKER_CLASS =
  "inset-0 flex h-dvh w-full min-h-0 min-w-0 max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 resize-none";

export type ModelSelectProps = {
  /** null means "inherit" (no override). */
  value: ModelSelection | null;
  onChange: (next: ModelSelection | null) => void;
  /** Label for the inherit option; defaults to `Default (${defaultModel})`. */
  defaultLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  variant?: "default" | "ghost";
  /** Free-text fallback commits on blur instead of per keystroke. */
  commitOnBlur?: boolean;
};

type DraftParam = { key: string; value: string };

function selectionToDraftParams(selection: ModelSelection | null): DraftParam[] {
  if (!selection?.params?.length) return [];
  return selection.params.map((param) => ({
    key: param.id,
    value: param.value,
  }));
}

function orphanParams(
  selection: ModelSelection | null,
  catalogParamIds: Set<string>
): ModelParameterValue[] {
  if (!selection?.params?.length) return [];
  return selection.params.filter((param) => !catalogParamIds.has(param.id));
}

function Suffixes({ suffixes }: { suffixes: string[] }): ReactElement | null {
  if (suffixes.length === 0) return null;
  return (
    <span className="truncate text-muted-foreground">
      {" "}
      {suffixes.join(" ")}
    </span>
  );
}

function EditPanel({
  controls,
  value,
  disabled,
  orphanDrafts,
  showFallbackParams,
  fallbackError,
  stacked,
  onChange,
  onOrphanRowsChange,
  onOrphanCommit,
}: {
  controls: ModelControl[];
  value: ModelSelection;
  disabled: boolean;
  orphanDrafts: DraftParam[];
  showFallbackParams: boolean;
  fallbackError: string | null;
  /** Stack under the model list (narrow viewports) instead of a side panel. */
  stacked?: boolean;
  onChange: (next: ModelSelection) => void;
  onOrphanRowsChange: (rows: DraftParam[]) => void;
  onOrphanCommit: (rows: DraftParam[]) => void;
}): ReactElement {
  const enums = controls.filter((c) => c.kind === "enum");
  const switches = controls.filter((c) => c.kind === "switch");

  return (
    <div
      className={cn(
        "column-scrollbar flex flex-col gap-3 overflow-y-auto overscroll-contain border-border p-3",
        stacked
          ? "min-h-0 w-full flex-1 border-t"
          : "max-h-[20.5rem] w-52 shrink-0 border-l"
      )}
    >
      {enums.map((control) => (
        <div key={control.paramId} className="flex flex-col gap-1">
          <p className="m-0 text-[11px] font-medium text-muted-foreground">
            {control.label}
          </p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {control.values.map((entry) => {
              const selected = control.current === entry.value;
              const label = entry.displayName || entry.value;
              return (
                <li key={entry.value}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      onChange(withParamValue(value, control.paramId, entry.value))
                    }
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs outline-none",
                      "hover:bg-accent hover:text-accent-foreground",
                      "focus-visible:ring-2 focus-visible:ring-ring",
                      selected && "bg-accent/80 font-medium"
                    )}
                  >
                    <span>{label}</span>
                    {selected ? (
                      <Check className="size-3.5 shrink-0 text-foreground" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {switches.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-[11px] font-medium text-muted-foreground">
            Options
          </p>
          {switches.map((control) => {
            const checked = control.current === control.onValue;
            return (
              <div
                key={control.paramId}
                className="flex items-center justify-between gap-2 px-2 py-1"
              >
                <span className="text-xs">{control.label}</span>
                <Switch
                  aria-label={control.label}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(nextChecked) => {
                    const nextValue = nextChecked
                      ? (control.onValue ?? "true")
                      : (control.offValue ?? "false");
                    onChange(withParamValue(value, control.paramId, nextValue));
                  }}
                />
              </div>
            );
          })}
        </div>
      ) : null}

      {showFallbackParams ? (
        <KeyValueRows
          rows={orphanDrafts}
          disabled={disabled}
          error={fallbackError}
          onRowsChange={onOrphanRowsChange}
          onCommit={onOrphanCommit}
        />
      ) : null}

      {controls.length === 0 && !showFallbackParams ? (
        <p className="m-0 text-xs text-muted-foreground">
          No tunable parameters for this model.
        </p>
      ) : null}
    </div>
  );
}

function KeyValueRows({
  rows,
  disabled,
  onRowsChange,
  onCommit,
  error,
}: {
  rows: DraftParam[];
  disabled: boolean;
  onRowsChange: (rows: DraftParam[]) => void;
  onCommit?: (rows: DraftParam[]) => void;
  error: string | null;
}): ReactElement {
  return (
    <div
      className="flex flex-col gap-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          onCommit?.(rows);
        }
      }}
    >
      <p className="m-0 text-[11px] font-medium text-muted-foreground">
        Custom params
      </p>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            aria-label={`Parameter ${index + 1} id`}
            placeholder="id"
            value={row.key}
            disabled={disabled}
            className="h-7 px-2 text-xs"
            onChange={(e) => {
              const next = rows.slice();
              next[index] = { ...row, key: e.target.value };
              onRowsChange(next);
            }}
          />
          <Input
            aria-label={`Parameter ${index + 1} value`}
            placeholder="value"
            value={row.value}
            disabled={disabled}
            className="h-7 px-2 text-xs"
            onChange={(e) => {
              const next = rows.slice();
              next[index] = { ...row, value: e.target.value };
              onRowsChange(next);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={`Remove parameter ${index + 1}`}
            onClick={() => onRowsChange(rows.filter((_, i) => i !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={disabled}
        className="self-start"
        onClick={() => onRowsChange([...rows, { key: "", value: "" }])}
      >
        Add parameter
      </Button>
      {error ? (
        <p className="m-0 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ModelRow({
  name,
  suffixes,
  selected,
  disabled,
  actionsPinned = false,
  onSelect,
  onEdit,
  onReset,
}: {
  name: string;
  suffixes: string[];
  selected: boolean;
  disabled: boolean;
  /** Keep Edit/Reset visible (edit panel open, or coarse pointer on selected). */
  actionsPinned?: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onReset?: () => void;
}): ReactElement {
  const showActions = Boolean(onEdit || onReset);
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-sm px-2 py-1.5",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/70"
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-baseline gap-0 truncate text-left text-xs outline-none"
      >
        <span className="truncate font-medium">{name}</span>
        <Suffixes suffixes={suffixes} />
      </button>
      {showActions ? (
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity",
            "group-hover:opacity-100 group-focus-within:opacity-100",
            actionsPinned && "opacity-100"
          )}
        >
          {onReset ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label="Reset model parameters"
              title="Reset to defaults"
              onClick={(e) => {
                e.stopPropagation();
                onReset();
              }}
            >
              <RotateCcw className="size-3" />
            </Button>
          ) : null}
          {onEdit ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={disabled}
              className="h-6 px-1.5 text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              Edit
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ModelSelect({
  value,
  onChange,
  defaultLabel,
  id,
  disabled = false,
  className,
  variant = "default",
  commitOnBlur = false,
}: ModelSelectProps): ReactElement {
  const canHover = useCanHover();
  const isNarrow = useIsNarrowViewport();
  const {
    models: availableModels,
    defaultModel,
    loading: modelsLoading,
    failed: modelsFailed,
  } = useAvailableModels();

  const resolvedDefaultLabel =
    defaultLabel ?? `Default (${defaultModel})`;

  const catalogModel = useMemo(
    () =>
      value ? availableModels.find((model) => model.id === value.id) : undefined,
    [availableModels, value]
  );

  const options = useMemo(
    () => baseModelOptions(availableModels, value),
    [availableModels, value]
  );

  const controls = useMemo(
    () => controlsForSelection(catalogModel, value),
    [catalogModel, value]
  );

  const catalogParamIds = useMemo(
    () => new Set(catalogModel?.parameters?.map((param) => param.id) ?? []),
    [catalogModel]
  );

  const orphans = useMemo(
    () => orphanParams(value, catalogParamIds),
    [value, catalogParamIds]
  );

  const [open, setOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [draftId, setDraftId] = useState(value?.id ?? "");
  const [draftParams, setDraftParams] = useState<DraftParam[]>(() =>
    selectionToDraftParams(value)
  );
  const [orphanDrafts, setOrphanDrafts] = useState<DraftParam[]>(() => []);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  useEffect(() => {
    setDraftId(value?.id ?? "");
    setDraftParams(selectionToDraftParams(value));
    setFallbackError(null);
  }, [value]);

  useEffect(() => {
    setOrphanDrafts(
      orphanParams(value, catalogParamIds).map((param) => ({
        key: param.id,
        value: param.value,
      }))
    );
  }, [value, catalogParamIds]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setEditOpen(false);
      return;
    }
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Dialog scroll-lock swallows wheel on portaled content; apply delta ourselves.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (el.scrollHeight <= el.clientHeight) return;
      event.preventDefault();
      event.stopPropagation();
      el.scrollTop += event.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  const commitFallback = (nextId: string, rows: DraftParam[]): void => {
    const trimmedId = nextId.trim();
    if (!trimmedId) {
      setFallbackError(null);
      onChange(null);
      return;
    }
    const params: ModelParameterValue[] = rows
      .map((row) => ({ id: row.key.trim(), value: row.value.trim() }))
      .filter((row) => row.id.length > 0 || row.value.length > 0);
    const result = buildSelection(trimmedId, params);
    if (!result.ok) {
      setFallbackError(result.error);
      return;
    }
    setFallbackError(null);
    onChange(result.selection);
  };

  /**
   * Pick a model (keep existing params if re-selecting the same id).
   * Desktop fine-pointer popover: close after select. Narrow fullscreen /
   * coarse pointer: stay open so Edit is reachable; second tap on the
   * already-selected row closes (Done). Narrow also has an explicit Done.
   */
  const selectById = (modelId: string): void => {
    const alreadySelected =
      modelId === DEFAULT_MODEL_OPTION
        ? value === null
        : value?.id === modelId;

    if (modelId === DEFAULT_MODEL_OPTION) {
      if (value !== null) onChange(null);
    } else if (value?.id !== modelId) {
      const model = availableModels.find((entry) => entry.id === modelId);
      onChange(model ? selectionForBaseModel(model) : { id: modelId });
    }
    setEditOpen(false);
    const stayOpenForEdit = isNarrow || !canHover;
    if (!stayOpenForEdit || alreadySelected) {
      setOpen(false);
    }
  };

  const showFallbackParams =
    Boolean(value) && (!catalogModel || orphans.length > 0);

  const rowCanEdit = (modelId: string): boolean => {
    const model = availableModels.find((entry) => entry.id === modelId);
    if (model?.parameters && model.parameters.length > 0) return true;
    return value?.id === modelId && showFallbackParams;
  };

  const openEditFor = (modelId: string): void => {
    if (value?.id !== modelId) {
      const model = availableModels.find((entry) => entry.id === modelId);
      onChange(model ? selectionForBaseModel(model) : { id: modelId });
    }
    setEditOpen(true);
  };

  /** Row primary action: retarget edit when the panel is open, else select. */
  const handleRowSelect = (modelId: string): void => {
    if (
      editOpen &&
      modelId !== DEFAULT_MODEL_OPTION &&
      value?.id !== modelId &&
      rowCanEdit(modelId)
    ) {
      openEditFor(modelId);
      return;
    }
    selectById(modelId);
  };

  const commitOrphanRows = (rows: DraftParam[]): void => {
    if (!value) return;
    const kept =
      value.params?.filter((param) => catalogParamIds.has(param.id)) ?? [];
    const nextOrphans: ModelParameterValue[] = rows
      .map((row) => ({
        id: row.key.trim(),
        value: row.value.trim(),
      }))
      .filter((row) => row.id.length > 0 || row.value.length > 0);
    const result = buildSelection(value.id, [...kept, ...nextOrphans]);
    if (!result.ok) {
      setFallbackError(result.error);
      return;
    }
    setFallbackError(null);
    onChange(result.selection);
  };

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.id.toLowerCase().includes(q) ||
        option.label.toLowerCase().includes(q)
    );
  }, [options, query]);

  const triggerParts = selectionDisplayParts(value, availableModels);
  const triggerText = value
    ? selectionLabel(value, availableModels)
    : resolvedDefaultLabel;

  if (modelsFailed) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        <Input
          id={id}
          type="text"
          value={draftId}
          disabled={disabled}
          className={cn(
            variant === "ghost" &&
              "h-7 max-w-[16rem] border-0 bg-transparent px-2 text-xs shadow-none"
          )}
          placeholder="composer-2.5-fast"
          onChange={(e) => {
            const next = e.target.value;
            setDraftId(next);
            if (!commitOnBlur) commitFallback(next, draftParams);
          }}
          onBlur={() => {
            if (commitOnBlur) {
              commitFallback(draftId, draftParams);
            }
          }}
        />
        <KeyValueRows
          rows={draftParams}
          disabled={disabled}
          error={fallbackError}
          onCommit={(nextRows) => commitFallback(draftId, nextRows)}
          onRowsChange={(nextRows) => {
            setDraftParams(nextRows);
            if (!commitOnBlur) {
              const hasIncompleteRow = nextRows.some(
                (row) => !row.key.trim() || !row.value.trim()
              );
              if (!hasIncompleteRow) commitFallback(draftId, nextRows);
            }
          }}
        />
      </div>
    );
  }

  const setPickerOpen = (next: boolean): void => {
    if (disabled || modelsLoading) return;
    setOpen(next);
  };

  const triggerButton = (
    <Button
      id={id}
      type="button"
      variant={variant === "ghost" ? "ghost" : "outline"}
      size="sm"
      disabled={disabled || modelsLoading}
      aria-label={triggerText}
      aria-expanded={open}
      className={cn(
        "h-8 justify-between gap-1 px-2 font-normal",
        variant === "default" && "w-full",
        variant === "ghost" &&
          "h-7 max-w-[18rem] border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-muted/70 hover:text-foreground",
        className
      )}
      onClick={isNarrow ? () => setPickerOpen(true) : undefined}
    >
      <span className="min-w-0 flex-1 truncate text-left text-xs">
        {value ? (
          <>
            <span className="text-foreground">{triggerParts.name}</span>
            <Suffixes suffixes={triggerParts.suffixes} />
          </>
        ) : (
          <span>{modelsLoading ? "Loading models…" : resolvedDefaultLabel}</span>
        )}
      </span>
      <ChevronDown className="size-3.5 shrink-0 opacity-60" />
    </Button>
  );

  const pinActions = isNarrow || !canHover;

  const modelList = (
    <>
      {!query.trim() ? (
        <ModelRow
          name={resolvedDefaultLabel}
          suffixes={[]}
          selected={value === null}
          disabled={disabled}
          onSelect={() => handleRowSelect(DEFAULT_MODEL_OPTION)}
        />
      ) : null}
      {filteredOptions.map((option) => {
        const model = availableModels.find((m) => m.id === option.id);
        const selected = value?.id === option.id;
        const suffixes = model ? modelRowSuffixes(model, value) : [];
        return (
          <ModelRow
            key={option.id}
            name={option.label}
            suffixes={suffixes}
            selected={selected}
            disabled={disabled}
            actionsPinned={selected && (editOpen || pinActions)}
            onSelect={() => handleRowSelect(option.id)}
            onEdit={
              rowCanEdit(option.id)
                ? () => {
                    if (selected && editOpen) {
                      setEditOpen(false);
                      return;
                    }
                    openEditFor(option.id);
                  }
                : undefined
            }
            onReset={
              selected && catalogModel
                ? () => onChange(selectionForBaseModel(catalogModel))
                : undefined
            }
          />
        );
      })}
      {filteredOptions.length === 0 ? (
        <p className="m-0 px-2 py-3 text-xs text-muted-foreground">
          No models match.
        </p>
      ) : null}
    </>
  );

  const editPanel =
    editOpen && value ? (
      <EditPanel
        controls={controls}
        value={value}
        disabled={disabled || modelsLoading}
        orphanDrafts={orphanDrafts}
        showFallbackParams={showFallbackParams}
        fallbackError={fallbackError}
        stacked
        onChange={onChange}
        onOrphanRowsChange={setOrphanDrafts}
        onOrphanCommit={commitOrphanRows}
      />
    ) : null;

  if (isNarrow) {
    return (
      <>
        {triggerButton}
        <Dialog open={open} onOpenChange={setPickerOpen}>
          <DialogContent
            showCloseButton={false}
            aria-describedby={undefined}
            className={MOBILE_PICKER_CLASS}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onPointerDownOutside={(e) => e.preventDefault()}
            onInteractOutside={(e) => e.preventDefault()}
          >
            <DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-4 py-3 text-left">
              <DialogTitle className="text-sm font-semibold">Model</DialogTitle>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 px-2.5 text-xs font-medium"
                onClick={() => setPickerOpen(false)}
              >
                Done
              </Button>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search models"
                    className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <div
                  ref={listRef}
                  className="column-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
                >
                  {modelList}
                </div>
              </div>
              {editPanel}
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setPickerOpen} modal={false}>
      <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto max-w-[min(100vw-2rem,36rem)] overflow-hidden p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Nested RemoveScroll so wheel works inside a Dialog (parent scroll lock). */}
        <RemoveScroll
          allowPinchZoom
          className="flex max-w-[min(100vw-2rem,36rem)] overflow-hidden"
        >
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                className="h-7 w-64 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div
              ref={listRef}
              className="column-scrollbar max-h-72 w-72 overflow-y-auto overscroll-contain p-1"
            >
              {modelList}
            </div>
          </div>
          {editOpen && value ? (
            <EditPanel
              controls={controls}
              value={value}
              disabled={disabled || modelsLoading}
              orphanDrafts={orphanDrafts}
              showFallbackParams={showFallbackParams}
              fallbackError={fallbackError}
              stacked={false}
              onChange={onChange}
              onOrphanRowsChange={setOrphanDrafts}
              onOrphanCommit={commitOrphanRows}
            />
          ) : null}
        </RemoveScroll>
      </PopoverContent>
    </Popover>
  );
}
