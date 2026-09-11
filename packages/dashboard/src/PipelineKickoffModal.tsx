import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { RemoveScroll } from "react-remove-scroll";
import { Info, RotateCcw, X } from "lucide-react";
import {
  DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID,
  DEFAULT_ROLE_MODEL_PROFILE_ID,
  IMPLEMENT_FULLY_PIPELINE_ID,
  KickoffError,
  assertVariablesMatchRequired,
  buildKickoffVariables,
  findActivePipelineBlocker,
  modelSelectionKey,
  resolvePlanningControls,
  resolvePlanningProfile,
  resolveRoleModelProfileDefaults,
  resolveRoleRecipe,
  validateFeatureSlugIdea,
  type ImplementFullyPlanningProfileId,
  type ImplementFullyResearchApprovalPolicy,
  type ModelSelection,
  type PipelineIntrospectionResponse,
  type PipelineModelRole,
  type ProvisionPipelineWorkersResponse,
  type ResolveImplementFullyKickoffResponse,
  type TriggerRunRequest,
  type Workspace,
  type Run,
} from "@lca/shared";
import { api, ProvisionConflictError } from "./api";
import {
  assembleKickoffPayload,
  buildResolveImplementFullyKickoffRequest,
  describeKickoffReviewFacts,
  describeLoopModeControlState,
  describeResearchApprovalControlState,
  type KickoffReviewFacts,
  type ResolveKickoffInputKind,
} from "./pipelineKickoff";
import {
  filterRoadmapFeatures,
  parseRoadmapFeatures,
  type RoadmapFeatureSummary,
} from "./roadmapFeatures";
import { ModelSelect } from "./ModelSelect";
import { useAvailableModels } from "./useAvailableModels";
import { useIsNarrowViewport } from "./useIsNarrowViewport";
import { workspaceLabel } from "./helpers";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MOBILE_MODAL_CLASS =
  "inset-0 flex h-dvh w-full min-h-0 min-w-0 max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 resize-none";

const DESKTOP_MODAL_CLASS =
  "flex max-h-[92vh] w-full max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg";

export type PipelineKickoffModalProps = {
  workspaces: Workspace[];
  runs: Run[];
  /** The sidebar's currently focused workspace, preselected here. */
  defaultWorkspaceId?: string | null;
  onClose: () => void;
  onStarted: (runId: string) => void;
};

/** Wizard steps: what to build → how hands-on → who does it → confirm & start. */
type Phase = "what" | "how" | "models" | "review";

const STEPS: ReadonlyArray<{ id: Phase; label: string }> = [
  { id: "what", label: "What" },
  { id: "how", label: "How hands-on" },
  { id: "models", label: "Models" },
  { id: "review", label: "Confirm" },
];

/** Plain, user-facing description of what each pipeline role actually does —
 *  shown in a tooltip next to its picker so "role name" isn't the only signal. */
const ROLE_DESCRIPTIONS: Partial<Record<PipelineModelRole, string>> = {
  researcher: "Runs a one-time research pass before planning starts.",
  architect: "Writes the initial feature skeleton, before planning.",
  planner: "Writes the plan for each phase before implementation starts.",
  implementer: "Writes the code for each phase.",
  reviewer: "Reviews each phase before it's marked done.",
  docs: "Updates docs and commits at the end of each phase.",
  gatekeeper: "Owns the final review gate, after every phase is done.",
};

/** Pipeline execution order — research runs first, the terminal gate last.
 *  The Models step lists roles in this order so it reads top-to-bottom the
 *  same way the pipeline actually runs. */
const ROLE_DISPLAY_ORDER: readonly PipelineModelRole[] = [
  "researcher",
  "architect",
  "planner",
  "implementer",
  "reviewer",
  "docs",
  "gatekeeper",
];

/**
 * Collapse a recipe's per-role models into "which roles share a model"
 * groups (pipeline order), so the recipe dropdown reads as a summary instead
 * of a flat role:model listing that repeats the same model over and over.
 */
function summarizeRoleModelGroups(
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>
): Array<{ modelId: string; roles: PipelineModelRole[] }> {
  const byModel = new Map<string, PipelineModelRole[]>();
  for (const role of ROLE_DISPLAY_ORDER) {
    const id = roleModels[role]?.id;
    if (!id) continue;
    const list = byModel.get(id) ?? [];
    list.push(role);
    byModel.set(id, list);
  }
  return [...byModel.entries()]
    .map(([modelId, roles]) => ({ modelId, roles }))
    .sort(
      (a, b) =>
        ROLE_DISPLAY_ORDER.indexOf(a.roles[0]!) -
        ROLE_DISPLAY_ORDER.indexOf(b.roles[0]!)
    );
}

/**
 * Always-present reset affordance for a value that may deviate from its
 * default — enabled (colored, clickable) only when there's an actual
 * deviation to revert. A control that's always there but visibly disabled
 * reads faster than one that pops in/out of existence, and its enabled state
 * doubles as the "this was changed" signal.
 */
function InlineResetButton({
  enabled,
  label,
  onReset,
}: {
  enabled: boolean;
  label: string;
  onReset: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={onReset}
      title={enabled ? `Reset ${label} to default` : `${label} is default`}
      aria-label={`Reset ${label} to default`}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
        enabled
          ? "text-primary hover:bg-primary/10"
          : "cursor-not-allowed text-muted-foreground/30"
      )}
    >
      <RotateCcw className="size-3.5" />
    </button>
  );
}

export function PipelineKickoffModal({
  workspaces,
  runs,
  defaultWorkspaceId,
  onClose,
  onStarted,
}: PipelineKickoffModalProps) {
  const isNarrow = useIsNarrowViewport();
  const { models } = useAvailableModels();
  const selectable = workspaces.filter((w) => w.id !== "__global__");

  const [workspaceId, setWorkspaceId] = useState(
    () =>
      defaultWorkspaceId &&
      selectable.some((w) => w.id === defaultWorkspaceId)
        ? defaultWorkspaceId
        : (selectable[0]?.id ?? "")
  );
  const [inputKind, setInputKind] =
    useState<ResolveKickoffInputKind>("feature-id");
  const [featureId, setFeatureId] = useState("");
  const [idea, setIdea] = useState("");
  const [featureQueryOpen, setFeatureQueryOpen] = useState(false);
  const featureFieldRef = useRef<HTMLDivElement>(null);
  const featureListRef = useRef<HTMLDivElement>(null);
  const [featureDropdownRect, setFeatureDropdownRect] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const [roadmapFeatures, setRoadmapFeatures] = useState<
    RoadmapFeatureSummary[]
  >([]);
  const [resolved, setResolved] =
    useState<ResolveImplementFullyKickoffResponse | null>(null);
  const [roleOverrides, setRoleOverrides] = useState<
    Partial<Record<PipelineModelRole, ModelSelection>>
  >({});
  const [profileId, setProfileId] =
    useState<ImplementFullyPlanningProfileId>(
      DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID
    );
  const [roleProfileId, setRoleProfileId] = useState(
    DEFAULT_ROLE_MODEL_PROFILE_ID
  );
  const [researchApprovalPolicy, setResearchApprovalPolicy] =
    useState<ImplementFullyResearchApprovalPolicy>("none");
  const [execute, setExecute] = useState(false);
  const [force, setForce] = useState(false);
  const [phase, setPhase] = useState<Phase>("what");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [introspection, setIntrospection] =
    useState<PipelineIntrospectionResponse | null>(null);
  const [dryPlan, setDryPlan] =
    useState<ProvisionPipelineWorkersResponse | null>(null);
  const [kickoff, setKickoff] = useState<TriggerRunRequest | null>(null);
  const [blockerNote, setBlockerNote] = useState<string | null>(null);
  const [reviewFacts, setReviewFacts] = useState<KickoffReviewFacts | null>(
    null
  );

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setValidationError(null);
    setIntrospection(null);
    setResolved(null);
    setKickoff(null);
    setDryPlan(null);
    setBlockerNote(null);
    setReviewFacts(null);
    setPhase("what");
    setProfileId(DEFAULT_IMPLEMENT_FULLY_PLANNING_PROFILE_ID);
    setRoleProfileId(DEFAULT_ROLE_MODEL_PROFILE_ID);
    setResearchApprovalPolicy("none");
    void (async () => {
      try {
        const data = await api.getPipeline(
          IMPLEMENT_FULLY_PIPELINE_ID,
          workspaceId
        );
        if (!cancelled) {
          setIntrospection(data);
          setProfileId(data.defaultPlanningProfileId);
          setRoleProfileId(data.defaultRoleModelProfileId);
        }
      } catch (err) {
        if (!cancelled) {
          setValidationError(
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Best-effort feature list for the searchable picker — a fetch/parse miss
  // just means no suggestions; typing a raw id still works either way.
  useEffect(() => {
    if (!workspaceId) {
      setRoadmapFeatures([]);
      return;
    }
    let cancelled = false;
    void api
      .getWorkspaceFileContent(workspaceId, "docs/roadmap/00-index.md")
      .then((res) => {
        if (!cancelled && res.content) {
          setRoadmapFeatures(parseRoadmapFeatures(res.content));
        }
      })
      .catch(() => {
        if (!cancelled) setRoadmapFeatures([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const modelOptions = useMemo(
    () => models.map((m) => m.id).filter(Boolean),
    [models]
  );

  const featureMatches = useMemo(
    () => filterRoadmapFeatures(roadmapFeatures, featureId),
    [roadmapFeatures, featureId]
  );

  // Positioned via a portal (see render) so the suggestion list escapes the
  // dialog's `overflow-hidden` instead of getting clipped at its edge.
  useLayoutEffect(() => {
    if (!featureQueryOpen) {
      setFeatureDropdownRect(null);
      return;
    }
    const el = featureFieldRef.current;
    if (!el) return;
    const update = (): void => {
      const rect = el.getBoundingClientRect();
      setFeatureDropdownRect({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [featureQueryOpen, featureMatches.length]);

  // Close on outside pointer — not input blur. Blur closes mid-scroll on
  // mobile when the touch leaves the field for the portaled list.
  useEffect(() => {
    if (!featureQueryOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (featureFieldRef.current?.contains(target)) return;
      if (featureListRef.current?.contains(target)) return;
      setFeatureQueryOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [featureQueryOpen]);

  const pickedFeature = useMemo(
    () => roadmapFeatures.find((f) => f.id === featureId.trim()) ?? null,
    [roadmapFeatures, featureId]
  );

  const selectedRoleProfileDefaults = useMemo(() => {
    if (!introspection) return null;
    try {
      return resolveRoleModelProfileDefaults(roleProfileId, introspection);
    } catch {
      return null;
    }
  }, [introspection, roleProfileId]);

  const researchApprovalControl = useMemo(
    () =>
      describeResearchApprovalControlState({
        roleOverrides,
        roleDefaults: selectedRoleProfileDefaults,
        researchApprovalPolicy,
      }),
    [roleOverrides, selectedRoleProfileDefaults, researchApprovalPolicy]
  );

  const loopModeControl = useMemo(
    () => describeLoopModeControlState({ profileId, execute }),
    [profileId, execute]
  );

  useEffect(() => {
    if (
      !researchApprovalControl.enabled &&
      researchApprovalPolicy !== "none"
    ) {
      setResearchApprovalPolicy("none");
      setResolved(null);
      setKickoff(null);
      setDryPlan(null);
      setBlockerNote(null);
      setReviewFacts(null);
    }
  }, [researchApprovalControl.enabled, researchApprovalPolicy]);

  useEffect(() => {
    if (resolvePlanningControls(profileId).planningDepth === "jit" && execute) {
      setExecute(false);
      setResolved(null);
      setKickoff(null);
      setDryPlan(null);
      setBlockerNote(null);
      setReviewFacts(null);
    }
  }, [profileId, execute]);

  const showModelProfilePicker = (introspection?.roleModelProfiles ?? []).some(
    (p) => p.id !== DEFAULT_ROLE_MODEL_PROFILE_ID
  );

  const clearReviewArtifacts = (): void => {
    setResolved(null);
    setKickoff(null);
    setDryPlan(null);
    setBlockerNote(null);
    setReviewFacts(null);
  };

  /** Local validation for the "what" step — no API calls, just presence checks. */
  const validateWhatStep = (): string | null => {
    if (!workspaceId) return "Select a workspace.";
    if (inputKind === "feature-id" && !featureId.trim()) {
      return "Pick an existing feature, or switch to New idea.";
    }
    if (inputKind === "idea" && !idea.trim()) {
      return "Describe what to build, or switch to Existing feature.";
    }
    return null;
  };

  const buildReview = async (): Promise<void> => {
    setValidationError(null);
    setSubmitError(null);
    setBlockerNote(null);

    if (!workspaceId) {
      setValidationError("Select a workspace.");
      return;
    }
    if (!introspection) {
      setValidationError("Still loading pipeline introspection…");
      return;
    }

    const pre = introspection.preconditions;
    if (!pre) {
      setValidationError(
        "Pipeline introspection did not return workspace preconditions. Refuse to kick off."
      );
      return;
    }
    if (!pre.gitRepo) {
      setValidationError(
        "Workspace is not a git repository (missing .git). Refuse to kick off."
      );
      return;
    }
    if (!pre.roadmapIndex) {
      setValidationError(
        "Missing roadmap index (docs/roadmap/00-index.md). Create it before kicking off."
      );
      return;
    }

    let resolveRequest;
    try {
      resolveRequest = buildResolveImplementFullyKickoffRequest({
        workspaceId,
        kind: inputKind,
        featureId,
        idea,
      });
    } catch (err) {
      setValidationError(
        err instanceof KickoffError || err instanceof Error
          ? err.message
          : String(err)
      );
      return;
    }

    setBusy(true);
    let resolvedTriple: ResolveImplementFullyKickoffResponse;
    let effectivePolicy: ImplementFullyResearchApprovalPolicy = "none";
    let facts: KickoffReviewFacts;
    try {
      resolvedTriple = await api.resolveImplementFullyKickoff(resolveRequest);
      validateFeatureSlugIdea(
        resolvedTriple.featureId,
        resolvedTriple.featureSlug,
        resolvedTriple.idea
      );
      const base = resolveRoleModelProfileDefaults(
        roleProfileId,
        introspection
      );
      effectivePolicy = describeResearchApprovalControlState({
        roleOverrides,
        roleDefaults: base,
        researchApprovalPolicy,
      }).effectivePolicy;
      const variables = buildKickoffVariables(
        resolvedTriple.featureId,
        resolvedTriple.featureSlug,
        resolvedTriple.idea,
        profileId,
        effectivePolicy,
        loopModeControl.effectiveLoopMode
      );
      assertVariablesMatchRequired(
        variables,
        introspection.requiredVariables
      );
      const requiredRoles = introspection.roleContract.required;
      const recipe = resolveRoleRecipe(requiredRoles, roleOverrides, base);
      facts = describeKickoffReviewFacts({
        introspection,
        roleModels: recipe.roleModels,
        researchApprovalPolicy: effectivePolicy,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setValidationError(
        msg.includes("settings.pipelineRoleModels")
          ? `${msg} Or pick a model per role below.`
          : msg
      );
      setBusy(false);
      return;
    }

    // Canonical metadata before dry-run / active-run blocker evaluation.
    setResolved(resolvedTriple);

    try {
      const dry = await api.provisionPipelineWorkers(
        IMPLEMENT_FULLY_PIPELINE_ID,
        { workspaceId, dryRun: true }
      );
      const pipelineAutomationIds = new Set(
        dry.plan.items.map((i) => i.automationId)
      );
      const blocker = findActivePipelineBlocker(runs, pipelineAutomationIds);
      if (blocker && !force) {
        setBlockerNote(
          `Active pipeline run ${blocker.id} on automation ${blocker.automationId} (status=${blocker.status}). Enable “Start anyway” to force, or wait for it to finish.`
        );
        setDryPlan(dry);
        setKickoff(null);
        setReviewFacts(facts);
        setPhase("review");
        return;
      }

      const payload = assembleKickoffPayload({
        introspection,
        plan: dry,
        feature: resolvedTriple.featureId,
        slug: resolvedTriple.featureSlug,
        idea: resolvedTriple.idea,
        roleOverrides,
        profileId,
        roleProfileId,
        researchApprovalPolicy: effectivePolicy,
        loopMode: loopModeControl.effectiveLoopMode,
      });
      setDryPlan(dry);
      setKickoff(payload);
      setReviewFacts(facts);
      setPhase("review");
    } catch (err) {
      if (err instanceof ProvisionConflictError) {
        const keys = err.response.plan.items
          .filter((i) => i.action === "conflict")
          .map((i) => i.key);
        setSubmitError(
          `Provisioning conflict for worker(s): ${keys.join(", ")}.`
        );
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (!kickoff || !workspaceId) return;
    setSubmitError(null);
    setBusy(true);
    try {
      await api.provisionPipelineWorkers(IMPLEMENT_FULLY_PIPELINE_ID, {
        workspaceId,
        dryRun: false,
      });
      const runId = await api.triggerRunWithContext(kickoff);
      onStarted(runId);
    } catch (err) {
      if (err instanceof ProvisionConflictError) {
        const keys = err.response.plan.items
          .filter((i) => i.action === "conflict")
          .map((i) => i.key);
        setSubmitError(
          `Provisioning conflict for worker(s): ${keys.join(", ")}. No run created.`
        );
      } else {
        setSubmitError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const phaseIndex = (p: Phase): number => STEPS.findIndex((s) => s.id === p);

  /** Whether the wizard may navigate to `target` from the current form state.
   *  Earlier steps are always allowed (same as Back). Later steps require the
   *  "what" gate; Confirm also kicks off the async review build. */
  const canGoToPhase = (target: Phase): boolean => {
    if (busy) return false;
    if (target === phase) return false;
    if (phaseIndex(target) < phaseIndex(phase)) return true;
    return validateWhatStep() === null;
  };

  const goToPhase = (target: Phase): void => {
    if (!canGoToPhase(target) && target !== phase) {
      // Forward jump with invalid "what" — surface the same error Next would.
      if (phaseIndex(target) > phaseIndex(phase)) {
        const err = validateWhatStep();
        if (err) setValidationError(err);
      }
      return;
    }
    if (target === phase) return;

    if (phase === "review" && target !== "review") {
      clearReviewArtifacts();
    }

    if (target === "review") {
      setValidationError(null);
      void buildReview();
      return;
    }

    setValidationError(null);
    setPhase(target);
  };

  const goBack = (): void => {
    const idx = phaseIndex(phase);
    if (idx <= 0) return;
    goToPhase(STEPS[idx - 1]!.id);
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (phase === "what") {
      const err = validateWhatStep();
      if (err) {
        setValidationError(err);
        return;
      }
      setValidationError(null);
      setPhase("how");
    } else if (phase === "how") {
      setValidationError(null);
      setPhase("models");
    } else if (phase === "models") {
      void buildReview();
    } else if (kickoff) {
      void commit();
    } else if (blockerNote && force) {
      void buildReview();
    }
  };

  const currentStepIndex = phaseIndex(phase);

  // Plain-language summary lines for the confirm step — the raw variable
  // names (planningDepth/approvalPolicy/loopMode) live under "Technical
  // details" below, not here.
  const planningProfile = resolvePlanningProfile(profileId);
  const selectedRoleProfile =
    introspection?.roleModelProfiles.find((p) => p.id === roleProfileId) ??
    null;
  const modelProfileLabel = selectedRoleProfile?.label ?? roleProfileId;
  const usingProfileDefaults =
    Object.keys(roleOverrides).length === 0 &&
    roleProfileId === introspection?.defaultRoleModelProfileId;

  // Models step: whether the recipe itself differs from the pipeline's default.
  const isRecipeOverridden =
    introspection != null &&
    roleProfileId !== introspection.defaultRoleModelProfileId;

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
        className={isNarrow ? MOBILE_MODAL_CLASS : DESKTOP_MODAL_CLASS}
        // Fullscreen on mobile; Select open sets content pointer-events:none
        // so "click off" hits the overlay. Never dismiss from outside — use X.
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-row items-center justify-between gap-2 space-y-0 border-b border-border px-4 py-3 text-left">
          <DialogTitle className="text-sm font-semibold">
            Run feature pipeline
          </DialogTitle>
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

        <nav
          className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-4 py-2 text-[11px] font-medium text-muted-foreground"
          aria-label="Kickoff steps"
        >
          {STEPS.map((step, i) => {
            const isCurrent = i === currentStepIndex;
            const isPast = i < currentStepIndex;
            // Past steps are always reachable (Back). Future steps need a
            // valid "what" gate — same rule as Next through the wizard.
            const reachable =
              !busy &&
              !isCurrent &&
              (isPast || validateWhatStep() === null);
            return (
              <span key={step.id} className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={isCurrent ? "step" : undefined}
                  onClick={() => goToPhase(step.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm outline-none transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    isCurrent && "text-foreground",
                    reachable &&
                      "cursor-pointer hover:text-foreground",
                    !reachable && !isCurrent && "cursor-default opacity-60"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
                      isCurrent
                        ? "border-primary bg-primary text-primary-foreground"
                        : isPast || reachable
                          ? "border-primary text-primary"
                          : "border-border"
                    )}
                  >
                    {i + 1}
                  </span>
                  <span>{step.label}</span>
                </button>
                {i < STEPS.length - 1 && (
                  <span className="text-border" aria-hidden="true">
                    ›
                  </span>
                )}
              </span>
            );
          })}
        </nav>

        <form
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3"
          onSubmit={onSubmit}
        >
          {phase === "what" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="kickoff-ws">Workspace</Label>
                <Select value={workspaceId} onValueChange={setWorkspaceId}>
                  <SelectTrigger id="kickoff-ws" className="w-full">
                    <SelectValue placeholder="Select workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {selectable.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {workspaceLabel(w.id, workspaces)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">
                  What are we building?
                </legend>
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="kickoff-intent"
                      value="feature-id"
                      checked={inputKind === "feature-id"}
                      onChange={() => {
                        setInputKind("feature-id");
                        setValidationError(null);
                      }}
                    />
                    Existing feature
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="kickoff-intent"
                      value="idea"
                      checked={inputKind === "idea"}
                      onChange={() => {
                        setInputKind("idea");
                        setValidationError(null);
                      }}
                    />
                    New idea
                  </label>
                </div>
              </fieldset>

              {inputKind === "feature-id" ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kickoff-feature">Existing feature</Label>
                  <div className="relative" ref={featureFieldRef}>
                    <Input
                      id="kickoff-feature"
                      value={featureId}
                      onChange={(e) => {
                        setFeatureId(e.target.value);
                        setFeatureQueryOpen(true);
                        setValidationError(null);
                      }}
                      onFocus={() => setFeatureQueryOpen(true)}
                      placeholder="Search by title or id (e.g. b64)…"
                      autoComplete="off"
                      className="font-mono text-xs"
                    />
                  </div>
                  {featureQueryOpen &&
                    featureMatches.length > 0 &&
                    featureDropdownRect &&
                    createPortal(
                      // Nested RemoveScroll so touch/wheel scroll works inside
                      // a Dialog (parent scroll lock otherwise eats the gesture).
                      <RemoveScroll
                        allowPinchZoom
                        ref={featureListRef}
                        data-lca-dialog-portal
                        className="pointer-events-auto fixed z-[60] max-h-56 overflow-y-auto overscroll-contain rounded-md border border-border bg-popover shadow-md"
                        style={{
                          top: featureDropdownRect.top,
                          left: featureDropdownRect.left,
                          width: featureDropdownRect.width,
                        }}
                      >
                        {featureMatches.map((f) => (
                          <button
                            key={f.id}
                            type="button"
                            className="flex w-full flex-col items-start gap-0 px-2.5 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setFeatureId(f.id);
                              setFeatureQueryOpen(false);
                              setValidationError(null);
                            }}
                          >
                            <span className="font-medium not-italic">
                              {f.title}
                            </span>
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {f.id}
                            </span>
                          </button>
                        ))}
                      </RemoveScroll>,
                      document.body
                    )}
                  <p className="m-0 text-xs text-muted-foreground">
                    {pickedFeature
                      ? `Picked ${pickedFeature.id} — ${pickedFeature.title}`
                      : "Resolves metadata from the selected workspace roadmap."}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kickoff-idea">Idea</Label>
                  <Textarea
                    id="kickoff-idea"
                    value={idea}
                    onChange={(e) => {
                      setIdea(e.target.value);
                      setValidationError(null);
                    }}
                    rows={4}
                    placeholder="What should the pipeline plan and implement?"
                  />
                  <p className="m-0 text-xs text-muted-foreground">
                    Derives a new feature id and slug before review.
                  </p>
                </div>
              )}
            </>
          )}

          {phase === "how" && (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">How hands-on?</legend>
                <p className="m-0 text-xs text-muted-foreground">
                  Chooses planning depth and whether approval is required
                  before implementation.
                </p>
                {(introspection?.planningProfiles ?? []).map((profile) => (
                  <label
                    key={profile.id}
                    className="flex items-start gap-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="kickoff-profile"
                      value={profile.id}
                      checked={profileId === profile.id}
                      onChange={() => {
                        setProfileId(profile.id);
                        if (resolvePlanningControls(profile.id).planningDepth === "jit") {
                          setExecute(false);
                        }
                        clearReviewArtifacts();
                        setValidationError(null);
                      }}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium">{profile.label}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {profile.description}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <label className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={execute && loopModeControl.enabled}
                  disabled={!loopModeControl.enabled}
                  onChange={(e) => {
                    setExecute(e.target.checked);
                    clearReviewArtifacts();
                    setValidationError(null);
                  }}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">
                    Go hands-off (execute mode)
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Skip per-phase plan/review; implement and commit per
                    phase, then one feature-level review at the end.
                  </span>
                  {!loopModeControl.enabled && loopModeControl.disabledReason && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {loopModeControl.disabledReason}
                    </span>
                  )}
                </span>
              </label>
            </>
          )}

          {phase === "models" && (
            <>
              {showModelProfilePicker && (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-md border-l-2 py-1 pr-1 pl-2 transition-colors",
                    isRecipeOverridden
                      ? "border-l-primary bg-primary/10"
                      : "border-l-transparent"
                  )}
                >
                  <Label
                    htmlFor="kickoff-recipe"
                    className="w-[88px] shrink-0 text-xs"
                  >
                    Recipe
                  </Label>
                  <Select
                    value={roleProfileId}
                    onValueChange={(v) => {
                      setRoleProfileId(v);
                      clearReviewArtifacts();
                      setValidationError(null);
                    }}
                  >
                    <SelectTrigger
                      id="kickoff-recipe"
                      className={cn(
                        "h-8 flex-1 text-xs",
                        isRecipeOverridden && "border-primary/60 font-medium"
                      )}
                    >
                      <SelectValue>
                        {selectedRoleProfile?.label ?? roleProfileId}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(introspection?.roleModelProfiles ?? []).map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          <span className="flex flex-col gap-0.5 py-0.5">
                            <span className="font-medium">{profile.label}</span>
                            <span className="flex flex-col gap-px font-mono text-[10px] text-muted-foreground">
                              {summarizeRoleModelGroups(profile.roleModels).map(
                                (group) => (
                                  <span key={group.modelId}>
                                    {group.roles.join("+")}: {group.modelId}
                                  </span>
                                )
                              )}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <InlineResetButton
                    enabled={isRecipeOverridden}
                    label="recipe"
                    onReset={() => {
                      if (introspection) {
                        setRoleProfileId(introspection.defaultRoleModelProfileId);
                        clearReviewArtifacts();
                      }
                    }}
                  />
                </div>
              )}

              <div className="flex flex-col gap-1 rounded-md border border-border p-2">
                {ROLE_DISPLAY_ORDER.map((typedRole) => {
                  const isRequired = (
                    introspection?.roleContract.required ?? []
                  ).includes(typedRole);
                  const isOptionalRole = (
                    introspection?.roleContract.optional ?? []
                  ).includes(typedRole);
                  if (!isRequired && !isOptionalRole) return null;

                  const profileDefault = selectedRoleProfileDefaults?.[typedRole];
                  const isOverridden = Boolean(roleOverrides[typedRole]);
                  // Optional roles the current recipe already assigns a model
                  // to are structurally "on" — there's no way to force them
                  // off short of picking a different recipe, so the switch
                  // shows on and locked rather than lying about what a click
                  // would do.
                  const isLockedOn = isOptionalRole && Boolean(profileDefault);
                  const isOn = isRequired || isLockedOn || isOverridden;
                  const fallbackLabel =
                    typedRole === "researcher"
                      ? "Disabled"
                      : typedRole === "architect"
                        ? "Planner fallback"
                        : "Reviewer fallback";
                  const defaultLabel = profileDefault
                    ? `Default (${profileDefault.id})`
                    : isRequired
                      ? "Default (unset)"
                      : fallbackLabel;
                  const showApproval =
                    typedRole === "researcher" &&
                    researchApprovalControl.enabled;

                  return (
                    <div
                      key={typedRole}
                      className={cn(
                        "flex items-start gap-2 rounded-md border-l-2 py-1 pr-1 pl-2 transition-colors",
                        isOverridden
                          ? "border-l-primary bg-primary/10"
                          : "border-l-transparent"
                      )}
                      data-pipeline-role={typedRole}
                      data-role-active={isOn}
                    >
                      <span className="flex h-8 w-28 shrink-0 items-center gap-1">
                        <span
                          className={cn(
                            "text-xs font-medium",
                            isOptionalRole && !isOn && "text-muted-foreground"
                          )}
                        >
                          {typedRole}
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex shrink-0 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
                              aria-label={`What does ${typedRole} do?`}
                            >
                              <Info className="size-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {ROLE_DESCRIPTIONS[typedRole]}
                          </TooltipContent>
                        </Tooltip>
                      </span>

                      {isOn ? (
                        <div
                          className={cn(
                            "min-w-0 flex-1",
                            isOverridden &&
                              "[&_[data-slot=select-trigger]]:border-primary/60 [&_[data-slot=select-trigger]]:font-medium"
                          )}
                        >
                          <ModelSelect
                            id={`kickoff-role-${typedRole}`}
                            // Bind the *effective* selection (override or recipe
                            // default). null hides catalog params (thinking/fast),
                            // so "still on Default" must still show the real model.
                            value={
                              roleOverrides[typedRole] ?? profileDefault ?? null
                            }
                            defaultLabel={defaultLabel}
                            commitOnBlur
                            className="h-8 w-full max-w-none"
                            onChange={(next) => {
                              setRoleOverrides((prev) => {
                                const nextOverrides = { ...prev };
                                if (
                                  !next ||
                                  (profileDefault &&
                                    modelSelectionKey(next) ===
                                      modelSelectionKey(profileDefault))
                                ) {
                                  delete nextOverrides[typedRole];
                                } else {
                                  nextOverrides[typedRole] = next;
                                }
                                return nextOverrides;
                              });
                              clearReviewArtifacts();
                            }}
                          />
                        </div>
                      ) : (
                        <span className="flex h-8 flex-1 items-center text-xs text-muted-foreground">
                          {fallbackLabel}
                        </span>
                      )}

                      <div className="flex h-8 shrink-0 items-center gap-1">
                        <InlineResetButton
                          enabled={isOverridden}
                          label={typedRole}
                          onReset={() => {
                            setRoleOverrides((prev) => {
                              const next = { ...prev };
                              delete next[typedRole];
                              return next;
                            });
                            clearReviewArtifacts();
                          }}
                        />

                        {showApproval && (
                          <Select
                            value={researchApprovalControl.effectivePolicy}
                            onValueChange={(v) => {
                              setResearchApprovalPolicy(
                                v as ImplementFullyResearchApprovalPolicy
                              );
                              clearReviewArtifacts();
                            }}
                          >
                            <SelectTrigger
                              className="h-8 w-[150px] shrink-0 text-xs"
                              title="When planning waits for your review of research.md"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Auto-continue</SelectItem>
                              <SelectItem value="before-planning">
                                Review first
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        )}

                        {isOptionalRole && (
                          <Switch
                            checked={isOn}
                            disabled={isLockedOn}
                            title={
                              isLockedOn
                                ? `Included by the ${modelProfileLabel} recipe — pick a different recipe to disable`
                                : undefined
                            }
                            aria-label={`${typedRole} ${isOn ? "enabled" : "disabled"}`}
                            onCheckedChange={(next) => {
                              setRoleOverrides((prev) => {
                                const nextOverrides = { ...prev };
                                if (next) {
                                  if (profileDefault) {
                                    nextOverrides[typedRole] = profileDefault;
                                  } else if (modelOptions[0]) {
                                    nextOverrides[typedRole] = {
                                      id: modelOptions[0],
                                    };
                                  }
                                } else {
                                  delete nextOverrides[typedRole];
                                }
                                return nextOverrides;
                              });
                              clearReviewArtifacts();
                            }}
                            className="ml-1 shrink-0"
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {phase === "review" && (
            <div className="flex flex-col gap-3 text-xs">
              <p className="m-0 font-semibold text-foreground">
                Confirm & start — nothing written yet
              </p>

              {resolved && (
                <div className="flex flex-col gap-2 rounded-md border border-border bg-muted p-2.5 text-foreground">
                  <div>
                    <span className="font-mono font-medium">
                      {resolved.featureId}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      ({resolved.featureSlug})
                    </span>
                  </div>
                  {resolved.idea && (
                    <p className="m-0 whitespace-pre-wrap text-muted-foreground">
                      {resolved.idea}
                    </p>
                  )}
                  <p className="m-0">
                    <span className="font-medium">{planningProfile.label}</span>
                    {" — "}
                    {planningProfile.description}
                  </p>
                  {loopModeControl.effectiveLoopMode === "execute" && (
                    <p className="m-0">
                      Going hands-off: implements and commits each phase
                      automatically, one review at the end.
                    </p>
                  )}
                  {reviewFacts && (
                    <p className="m-0">
                      {usingProfileDefaults ? (
                        <>Using {modelProfileLabel} defaults for all roles.</>
                      ) : (
                        <>Model profile: {modelProfileLabel} (with overrides below).</>
                      )}
                    </p>
                  )}
                  {reviewFacts && (
                    <ul className="m-0 flex list-none flex-col gap-1 pl-0">
                      <li>
                        <span className="text-muted-foreground">Planner: </span>
                        {reviewFacts.architect.id}
                        {reviewFacts.architectSource === "planner-fallback" &&
                          " (planner fallback)"}
                      </li>
                      <li>
                        <span className="text-muted-foreground">
                          Researcher:{" "}
                        </span>
                        {reviewFacts.researcher
                          ? `${reviewFacts.researcher.id} — ${
                              reviewFacts.researchApprovalPolicy === "none"
                                ? "continues automatically"
                                : "reviews before planning"
                            }`
                          : "disabled"}
                      </li>
                      <li>
                        <span className="text-muted-foreground">
                          Gatekeeper:{" "}
                        </span>
                        {reviewFacts.gatekeeper.id}
                        {reviewFacts.gatekeeperSource === "reviewer-fallback" &&
                          " (reviewer fallback)"}
                      </li>
                    </ul>
                  )}
                </div>
              )}

              {blockerNote && (
                <div className="rounded-md border border-status-failed/40 bg-muted p-2 text-destructive">
                  {blockerNote}
                  <label className="mt-2 flex items-center gap-2 text-foreground">
                    <input
                      type="checkbox"
                      checked={force}
                      onChange={(e) => setForce(e.target.checked)}
                    />
                    Start anyway (force)
                  </label>
                </div>
              )}

              {dryPlan && dryPlan.missingSkills.length > 0 && (
                <p className="m-0 text-muted-foreground">
                  Warning: missing skills (non-blocking):{" "}
                  {dryPlan.missingSkills.join(", ")}
                </p>
              )}

              {resolved && (
                <details>
                  <summary className="cursor-pointer text-muted-foreground">
                    Technical details
                  </summary>
                  <dl className="m-0 mt-2 grid gap-1.5 rounded-md border border-border bg-muted p-2">
                    <div>
                      <dt className="text-muted-foreground">Planning profile</dt>
                      <dd className="m-0">
                        {planningProfile.label} ({profileId})
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Model profile</dt>
                      <dd className="m-0">
                        {modelProfileLabel} ({roleProfileId})
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">planningDepth</dt>
                      <dd className="m-0 font-mono">
                        {typeof kickoff?.variables?.planningDepth === "string"
                          ? kickoff.variables.planningDepth
                          : planningProfile.planningDepth}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">approvalPolicy</dt>
                      <dd className="m-0 font-mono">
                        {typeof kickoff?.variables?.approvalPolicy === "string"
                          ? kickoff.variables.approvalPolicy
                          : planningProfile.approvalPolicy}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">loopMode</dt>
                      <dd className="m-0 font-mono">
                        {typeof kickoff?.variables?.loopMode === "string"
                          ? kickoff.variables.loopMode
                          : loopModeControl.effectiveLoopMode}
                      </dd>
                    </div>
                    {reviewFacts && (
                      <>
                        <div data-review-fact="entry-worker">
                          <dt className="text-muted-foreground">Entry worker</dt>
                          <dd className="m-0 font-mono">
                            {reviewFacts.entryWorkerKey}
                          </dd>
                        </div>
                        <div data-review-fact="researcher">
                          <dt className="text-muted-foreground">Researcher</dt>
                          <dd className="m-0 font-mono">
                            {reviewFacts.researcher?.id ?? "Disabled"}
                          </dd>
                        </div>
                        <div data-review-fact="research-approval">
                          <dt className="text-muted-foreground">
                            Research approval
                          </dt>
                          <dd className="m-0 font-mono">
                            {reviewFacts.researchApprovalPolicy}
                          </dd>
                        </div>
                        <div data-review-fact="architect">
                          <dt className="text-muted-foreground">Architect</dt>
                          <dd className="m-0 font-mono">
                            {reviewFacts.architect.id} (
                            {reviewFacts.architectSource === "explicit"
                              ? "explicit"
                              : "planner fallback"}
                            )
                          </dd>
                        </div>
                        <div data-review-fact="gatekeeper">
                          <dt className="text-muted-foreground">Gatekeeper</dt>
                          <dd className="m-0 font-mono">
                            {reviewFacts.gatekeeper.id} (
                            {reviewFacts.gatekeeperSource === "explicit"
                              ? "explicit"
                              : "reviewer fallback"}
                            )
                          </dd>
                        </div>
                      </>
                    )}
                  </dl>
                  {kickoff && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-muted-foreground">
                        Technical kickoff payload
                      </summary>
                      <pre
                        className={cn(
                          "mt-2 max-h-64 overflow-auto rounded-md border border-border bg-muted p-2 font-mono text-[11px]"
                        )}
                      >
                        {JSON.stringify(kickoff, null, 2)}
                      </pre>
                    </details>
                  )}
                </details>
              )}

              <p className="m-0 text-muted-foreground">
                The pipeline sets its own step budget after kickoff.
              </p>
            </div>
          )}

          {validationError && (
            <p className="m-0 text-xs text-destructive">{validationError}</p>
          )}
          {submitError && (
            <p className="m-0 text-xs text-destructive">{submitError}</p>
          )}

          <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
            {isNarrow && (
              <Button
                type="button"
                variant="surface"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
            )}
            {phase !== "what" && (
              <Button
                type="button"
                variant="surface"
                disabled={busy}
                onClick={goBack}
              >
                Back
              </Button>
            )}
            <Button
              type="submit"
              disabled={
                busy ||
                (phase === "review" && !kickoff && !(blockerNote && force))
              }
              className="ml-auto"
            >
              {busy
                ? phase === "models"
                  ? "Checking…"
                  : "Working…"
                : phase === "what" || phase === "how"
                  ? "Next"
                  : phase === "models"
                    ? "Review"
                    : kickoff
                      ? "Start pipeline"
                      : "Re-check"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
