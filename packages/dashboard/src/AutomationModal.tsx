import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { X } from "lucide-react";
import {
  automationCreateSchema,
  automationUpdateSchema,
  type Automation,
  type ChainConfig,
  type CreateAutomationRequest,
  type ModelSelection,
  type TriggerConfig,
  type UpdateAutomationRequest,
  type Workspace,
} from "@lca/shared";
import { api } from "./api";
import { workspaceLabel } from "./helpers";
import { ModelSelect } from "./ModelSelect";
import { PromptArtifactSuggestions } from "./PromptArtifactSuggestions";
import { usePromptTypeahead } from "./usePromptTypeahead";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PromptReferenceTextarea } from "./PromptReferenceTextarea";
import { useIsNarrowViewport } from "./useIsNarrowViewport";
import { cn } from "@/lib/utils";

const MOBILE_MODAL_CLASS =
  "inset-0 flex h-dvh w-full min-h-0 min-w-0 max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 resize-none";

const DESKTOP_MODAL_CLASS =
  "flex max-h-[82vh] w-[560px] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0";

const TRIGGER_TYPES: TriggerConfig["type"][] = [
  "cron",
  "git",
  "file-watch",
  "command",
  "manual",
];

const GIT_EVENTS = ["post-commit", "pre-push", "post-merge"] as const;

const NONE_CHAIN_OPTION = "__none__";

type ChainWhen = "completed" | "failed" | "always";

type GitEvent = (typeof GIT_EVENTS)[number];

type FormState = {
  workspaceId: string;
  name: string;
  triggerType: TriggerConfig["type"];
  cronExpression: string;
  gitEvents: GitEvent[];
  fileWatchGlobs: string;
  fileWatchDebounce: string;
  command: string;
  commandCwd: string;
  prompt: string;
  modelSelection: ModelSelection | null;
  enabled: boolean;
  chainNext: string;
  chainWhen: ChainWhen;
  chainPassResult: boolean;
};

function defaultFormState(
  workspaces: Workspace[],
  initial?: Automation
): FormState {
  if (initial) {
    return automationToFormState(initial);
  }
  return {
    workspaceId: workspaces[0]?.id ?? "",
    name: "",
    triggerType: "manual",
    cronExpression: "",
    gitEvents: [],
    fileWatchGlobs: "",
    fileWatchDebounce: "",
    command: "",
    commandCwd: "",
    prompt: "",
    modelSelection: null,
    enabled: false,
    chainNext: "",
    chainWhen: "completed",
    chainPassResult: false,
  };
}

function automationToFormState(a: Automation): FormState {
  return {
    workspaceId: a.workspaceId,
    name: a.name,
    triggerType: a.trigger.type,
    cronExpression: a.trigger.type === "cron" ? a.trigger.expression : "",
    gitEvents: a.trigger.type === "git" ? [...a.trigger.events] : [],
    fileWatchGlobs:
      a.trigger.type === "file-watch" ? a.trigger.globs.join("\n") : "",
    fileWatchDebounce:
      a.trigger.type === "file-watch" && a.trigger.debounceMs
        ? String(a.trigger.debounceMs)
        : "",
    command: a.trigger.type === "command" ? a.trigger.command : "",
    commandCwd:
      a.trigger.type === "command" && a.trigger.cwd ? a.trigger.cwd : "",
    prompt: a.prompt,
    modelSelection: a.modelSelection ?? null,
    enabled: a.enabled,
    chainNext: a.chain?.next ?? "",
    chainWhen: a.chain?.when ?? "completed",
    chainPassResult: a.chain?.passResult ?? false,
  };
}

function buildChain(form: FormState): ChainConfig | undefined {
  if (form.chainNext === "") {
    return undefined;
  }
  return {
    next: form.chainNext,
    when: form.chainWhen,
    passResult: form.chainPassResult || undefined,
  };
}

function buildTrigger(form: FormState): TriggerConfig {
  switch (form.triggerType) {
    case "cron":
      return { type: "cron", expression: form.cronExpression.trim() };
    case "git":
      return { type: "git", events: form.gitEvents };
    case "file-watch": {
      const globs = form.fileWatchGlobs
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const trigger: TriggerConfig = { type: "file-watch", globs };
      const debounce = Number.parseInt(form.fileWatchDebounce, 10);
      if (!Number.isNaN(debounce) && debounce > 0) {
        (trigger as Extract<TriggerConfig, { type: "file-watch" }>).debounceMs =
          debounce;
      }
      return trigger;
    }
    case "command": {
      const trigger: TriggerConfig = {
        type: "command",
        command: form.command.trim(),
      };
      if (form.commandCwd.trim()) {
        (trigger as Extract<TriggerConfig, { type: "command" }>).cwd =
          form.commandCwd.trim();
      }
      return trigger;
    }
    case "manual":
      return { type: "manual" };
  }
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

type AutomationModalProps =
  | {
      mode: "create";
      initial?: Automation;
      workspaces: Workspace[];
      automations: Automation[];
      onClose: () => void;
      onSubmit: (payload: CreateAutomationRequest) => Promise<void>;
      onWorkspacesRefresh?: () => void;
    }
  | {
      mode: "edit";
      initial: Automation;
      workspaces: Workspace[];
      automations: Automation[];
      onClose: () => void;
      onSubmit: (payload: UpdateAutomationRequest) => Promise<void>;
    };

export function AutomationModal(props: AutomationModalProps) {
  const { mode, workspaces, automations, onClose, onSubmit } = props;
  const onWorkspacesRefresh =
    mode === "create" ? props.onWorkspacesRefresh : undefined;
  const initial = props.initial;
  const isNarrow = useIsNarrowViewport();

  const [localWorkspaces, setLocalWorkspaces] = useState(workspaces);
  const [showAddWorkspace, setShowAddWorkspace] = useState(
    mode === "create" && workspaces.length === 0
  );
  const [newWorkspacePath, setNewWorkspacePath] = useState("");
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [form, setForm] = useState<FormState>(() =>
    defaultFormState(workspaces, initial)
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const promptTypeahead = usePromptTypeahead({
    workspaceId: form.workspaceId,
    value: form.prompt,
    setValue: (next) => setField("prompt", next),
    textareaRef: promptTextareaRef,
  });

  const chainTargetOptions = useMemo(() => {
    const excludeId = mode === "edit" ? initial?.id : undefined;
    return automations.filter(
      (a) => a.workspaceId === form.workspaceId && a.id !== excludeId
    );
  }, [automations, form.workspaceId, mode, initial?.id]);

  useEffect(() => {
    setLocalWorkspaces(workspaces);
  }, [workspaces]);

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setValidationError(null);
    setSubmitError(null);
  };

  const handlePromptKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    promptTypeahead.handleKeyDown(e);
  };

  const toggleGitEvent = (event: GitEvent) => {
    setForm((prev) => {
      const next = prev.gitEvents.includes(event)
        ? prev.gitEvents.filter((e) => e !== event)
        : [...prev.gitEvents, event];
      return { ...prev, gitEvents: next };
    });
    setValidationError(null);
    setSubmitError(null);
  };

  const handleAddWorkspace = async () => {
    setValidationError(null);
    setSubmitError(null);
    const path = newWorkspacePath.trim();
    if (!path) {
      setValidationError("Workspace path is required");
      return;
    }

    setAddingWorkspace(true);
    try {
      const name = newWorkspaceName.trim();
      const created = await api.createWorkspace({
        path,
        ...(name ? { name } : {}),
      });
      const updated = await api.listWorkspaces();
      setLocalWorkspaces(updated);
      setField("workspaceId", created.id);
      setShowAddWorkspace(false);
      setNewWorkspacePath("");
      setNewWorkspaceName("");
      onWorkspacesRefresh?.();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingWorkspace(false);
    }
  };

  const handleBrowseWorkspace = async () => {
    setSubmitError(null);
    setPickingWorkspace(true);
    try {
      // Seed the dialog at an existing workspace folder (the selected one if
      // any, otherwise the first registered) so it opens somewhere useful.
      const base =
        localWorkspaces.find((w) => w.id === form.workspaceId)?.path ??
        localWorkspaces[0]?.path;
      const result = await api.pickWorkspaceFolder(base);
      if (!result.supported) {
        setSubmitError("Folder picker is Windows-only — type the path.");
        return;
      }
      if (result.path) {
        setNewWorkspacePath(result.path);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingWorkspace(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSubmitError(null);

    const trigger = buildTrigger(form);

    if (mode === "create") {
      const payload: CreateAutomationRequest = {
        workspaceId: form.workspaceId,
        name: form.name,
        trigger,
        prompt: form.prompt,
        enabled: form.enabled,
        chain: buildChain(form),
        ...(form.modelSelection
          ? { modelSelection: form.modelSelection }
          : {}),
      };
      const result = automationCreateSchema.safeParse(payload);
      if (!result.success) {
        setValidationError(formatZodIssues(result.error.issues));
        return;
      }
      setSubmitting(true);
      try {
        await onSubmit(result.data);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const payload: UpdateAutomationRequest = {
      name: form.name,
      trigger,
      prompt: form.prompt,
      modelSelection: form.modelSelection,
      enabled: form.enabled,
      chain: buildChain(form) ?? null,
    };
    const result = automationUpdateSchema.safeParse(payload);
    if (!result.success) {
      setValidationError(formatZodIssues(result.error.issues));
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(result.data);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    mode === "create"
      ? initial
        ? "Duplicate automation"
        : "New automation"
      : "Edit automation";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Keep Escape closing the typeahead first; only let it close the dialog
        // once no suggestion popup is open.
        onEscapeKeyDown={(e) => {
          if (promptTypeahead.promptToken) e.preventDefault();
        }}
        // Fullscreen on mobile; Select open sets content pointer-events:none
        // so "click off" hits the overlay. Never dismiss from outside — use X.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className={cn(isNarrow ? MOBILE_MODAL_CLASS : DESKTOP_MODAL_CLASS)}
      >
        <DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-4 py-3 text-left">
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
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
        </DialogHeader>

        <form
          className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-4"
          onSubmit={(e) => void handleSubmit(e)}
        >
          {(validationError || submitError) && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              {validationError ?? submitError}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              type="text"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="My automation"
            />
          </div>

          {mode === "create" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="automation-workspace">Workspace</Label>
              {localWorkspaces.length > 0 && !showAddWorkspace && (
                <>
                  <Select
                    value={form.workspaceId}
                    onValueChange={(value) => setField("workspaceId", value)}
                  >
                    <SelectTrigger id="automation-workspace" className="w-full">
                      <SelectValue placeholder="Select a workspace" />
                    </SelectTrigger>
                    <SelectContent>
                      {localWorkspaces.map((w) => (
                        <SelectItem key={w.id} value={w.id}>
                          {workspaceLabel(w.id, localWorkspaces)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto justify-start self-start p-0 text-sm"
                    onClick={() => setShowAddWorkspace(true)}
                  >
                    Add workspace…
                  </Button>
                </>
              )}
              {(showAddWorkspace || localWorkspaces.length === 0) && (
                <div className="flex flex-col gap-2">
                  {localWorkspaces.length === 0 && (
                    <p className="m-0 text-sm text-muted-foreground">
                      No workspaces registered yet. Add a path to continue.
                    </p>
                  )}
                  <div className="flex items-stretch gap-2">
                    <Input
                      id="automation-workspace-path"
                      className="min-w-0 flex-1"
                      type="text"
                      value={newWorkspacePath}
                      onChange={(e) => setNewWorkspacePath(e.target.value)}
                      placeholder="C:\path\to\repo"
                      disabled={addingWorkspace || pickingWorkspace}
                    />
                    <Button
                      type="button"
                      variant="surface"
                      className="shrink-0"
                      onClick={() => void handleBrowseWorkspace()}
                      disabled={addingWorkspace || pickingWorkspace}
                    >
                      {pickingWorkspace ? "Opening…" : "Browse…"}
                    </Button>
                  </div>
                  <Input
                    id="automation-workspace-name"
                    type="text"
                    value={newWorkspaceName}
                    onChange={(e) => setNewWorkspaceName(e.target.value)}
                    placeholder="Name (optional)"
                    disabled={addingWorkspace}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() => void handleAddWorkspace()}
                      disabled={addingWorkspace || !newWorkspacePath.trim()}
                    >
                      {addingWorkspace ? "Registering…" : "Register workspace"}
                    </Button>
                    {localWorkspaces.length > 0 && (
                      <Button
                        type="button"
                        variant="surface"
                        onClick={() => {
                          setShowAddWorkspace(false);
                          setNewWorkspacePath("");
                          setNewWorkspaceName("");
                          setSubmitError(null);
                        }}
                        disabled={addingWorkspace}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label>Workspace</Label>
              <div className="rounded-md border border-border bg-muted px-2.5 py-2 text-sm text-muted-foreground">
                {workspaceLabel(form.workspaceId, workspaces)}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-trigger-type">Trigger type</Label>
            <Select
              value={form.triggerType}
              onValueChange={(value) =>
                setField("triggerType", value as TriggerConfig["type"])
              }
            >
              <SelectTrigger id="automation-trigger-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {form.triggerType === "cron" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="automation-cron">Cron expression</Label>
              <Input
                id="automation-cron"
                type="text"
                value={form.cronExpression}
                onChange={(e) => setField("cronExpression", e.target.value)}
                placeholder="0 9 * * 1-5"
              />
            </div>
          )}

          {form.triggerType === "git" && (
            <fieldset className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
              <legend className="px-1 text-xs font-semibold text-muted-foreground">
                Git events
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-2.5">
                {GIT_EVENTS.map((event) => (
                  <label
                    key={event}
                    className="inline-flex cursor-pointer items-center gap-1.5 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={form.gitEvents.includes(event)}
                      onChange={() => toggleGitEvent(event)}
                    />
                    {event}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {form.triggerType === "file-watch" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="automation-globs">Globs (one per line)</Label>
                <Textarea
                  id="automation-globs"
                  rows={3}
                  value={form.fileWatchGlobs}
                  onChange={(e) => setField("fileWatchGlobs", e.target.value)}
                  placeholder="src/**/*.ts"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="automation-debounce">
                  Debounce (ms, optional)
                </Label>
                <Input
                  id="automation-debounce"
                  type="number"
                  min={1}
                  value={form.fileWatchDebounce}
                  onChange={(e) => setField("fileWatchDebounce", e.target.value)}
                  placeholder="500"
                />
              </div>
            </>
          )}

          {form.triggerType === "command" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="automation-command">Command</Label>
                <Input
                  id="automation-command"
                  type="text"
                  value={form.command}
                  onChange={(e) => setField("command", e.target.value)}
                  placeholder="npm test"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="automation-cwd">
                  Working directory (optional)
                </Label>
                <Input
                  id="automation-cwd"
                  type="text"
                  value={form.commandCwd}
                  onChange={(e) => setField("commandCwd", e.target.value)}
                  placeholder="."
                />
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-prompt">Prompt</Label>
            <div className="relative">
              <PromptReferenceTextarea
                id="automation-prompt"
                ref={promptTextareaRef}
                rows={5}
                value={form.prompt}
                onChange={(e) => {
                  setField("prompt", e.target.value);
                  promptTypeahead.updatePromptToken(e.target.value);
                }}
                onKeyDown={handlePromptKeyDown}
                onSelect={() => promptTypeahead.updatePromptToken()}
                onClick={() => promptTypeahead.updatePromptToken()}
                onFocus={() => promptTypeahead.updatePromptToken()}
                onBlur={promptTypeahead.clearToken}
                aria-autocomplete="list"
                aria-expanded={promptTypeahead.showTypeahead}
                aria-controls={
                  promptTypeahead.showTypeahead
                    ? "automation-prompt-suggestions"
                    : undefined
                }
                placeholder="What should the agent do when this automation runs?"
              />
              {promptTypeahead.showTypeahead && promptTypeahead.promptToken && (
                <PromptArtifactSuggestions
                  id="automation-prompt-suggestions"
                  open={promptTypeahead.showTypeahead}
                  artifacts={promptTypeahead.suggestions}
                  loading={promptTypeahead.artifacts.loading}
                  error={promptTypeahead.artifacts.error}
                  highlightedIndex={promptTypeahead.highlightedIndex}
                  onHighlight={promptTypeahead.setHighlightedIndex}
                  onSelect={promptTypeahead.insertArtifact}
                  kind={promptTypeahead.promptToken.kind}
                />
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-model">Model (optional)</Label>
            <ModelSelect
              id="automation-model"
              value={form.modelSelection}
              onChange={(next) => setField("modelSelection", next)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="automation-chain-next">Next automation (chain)</Label>
            {chainTargetOptions.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                No other automations in this workspace to chain to.
              </p>
            ) : (
              <Select
                value={form.chainNext === "" ? NONE_CHAIN_OPTION : form.chainNext}
                onValueChange={(v) =>
                  setField("chainNext", v === NONE_CHAIN_OPTION ? "" : v)
                }
              >
                <SelectTrigger id="automation-chain-next" className="w-full">
                  <SelectValue placeholder="None (no chain)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_CHAIN_OPTION}>None (no chain)</SelectItem>
                  {form.chainNext &&
                    !chainTargetOptions.some((a) => a.configKey === form.chainNext) ? (
                    <SelectItem value={form.chainNext}>
                      {form.chainNext} (current)
                    </SelectItem>
                  ) : null}
                  {chainTargetOptions.map((a) => (
                    <SelectItem key={a.id} value={a.configKey}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {form.chainNext !== "" && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="automation-chain-when">When to chain</Label>
                  <Select
                    value={form.chainWhen}
                    onValueChange={(v) =>
                      setField("chainWhen", v as ChainWhen)
                    }
                  >
                    <SelectTrigger id="automation-chain-when" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="completed">completed</SelectItem>
                      <SelectItem value="failed">failed</SelectItem>
                      <SelectItem value="always">always</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={form.chainPassResult}
                    onChange={(e) => setField("chainPassResult", e.target.checked)}
                  />
                  Append previous step&apos;s result to the prompt
                </label>
              </>
            )}
          </div>

          <div className="flex flex-row items-center gap-1.5">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="accent-primary"
                checked={form.enabled}
                onChange={(e) => setField("enabled", e.target.checked)}
              />
              Enabled
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="surface"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || (mode === "create" && !form.workspaceId)}
            >
              {submitting
                ? "Saving…"
                : mode === "create"
                  ? "Create"
                  : "Save changes"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
