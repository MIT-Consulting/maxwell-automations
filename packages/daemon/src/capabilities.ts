import {
  compareRoadmapFindings,
  countFindingsByImpact,
  findActivePipelineBlocker,
  IMPLEMENT_FULLY_BUDGET_FORMULA,
  IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA,
  IMPLEMENT_FULLY_PLANNING_PROFILES,
  PIPELINE_MODEL_ROLES,
  summarizeFeatureQueueForCapabilities,
  type CapabilitiesActivePipelineSummary,
  type CapabilitiesDocument,
  type CapabilitiesReadinessSummary,
  type CapabilitiesWorkspaceContext,
  type CapabilityAvailability,
  type CapabilityPlanningEntry,
  type CapabilityProfile,
  type CapabilityStatusEntry,
  type CapabilitySurface,
  type FeatureQueueEntryState,
  type ModelSelection,
  type PipelineModelRole,
  type PipelineOutcome,
  type RoadmapReadinessReport,
  type RunStatus,
  type VersionIdentity,
} from "@lca/shared";
import type { DashboardStore } from "./http/dashboard-store.js";
import {
  analyzeWorkspaceRoadmapReadiness,
  type RoadmapReadinessGatherBounds,
} from "./roadmap/readiness.js";
import {
  buildRoleModelProfiles,
  pipelineWorkerAutomationIds,
  type RoleModelIntrospectionSettings,
} from "./pipelines/implement-fully.js";
import { toFeatureQueueEntry, type FeatureQueueStore } from "./runs/feature-queue-store.js";
import { hydratePipelineSnapshot } from "./runs/pipeline-projection.js";
import type { RunStore } from "./runs/store.js";

export type BuildCapabilitiesInput = {
  daemonVersion: VersionIdentity;
  roleModelSettings: RoleModelIntrospectionSettings;
};

function copyRoleModels(
  roleModels: Partial<Record<PipelineModelRole, ModelSelection>>
): Partial<Record<PipelineModelRole, ModelSelection>> {
  const out: Partial<Record<PipelineModelRole, ModelSelection>> = {};
  for (const role of PIPELINE_MODEL_ROLES) {
    const selection = roleModels[role];
    if (!selection) continue;
    out[role] = {
      id: selection.id,
      ...(selection.params
        ? { params: selection.params.map((p) => ({ id: p.id, value: p.value })) }
        : {}),
    };
  }
  return out;
}

const SURFACES: CapabilitySurface[] = [
  {
    id: "implement-fully-feature",
    verb: "max implement-fully --feature <id>",
    bestFor:
      "A documented roadmap row, feature-sized work you can walk away from.",
    notFor: "Half-formed ideas, one-file fixes, or epics.",
    needs: [
      "Row resolves in the feature index",
      "No active pipeline in the workspace",
      "Green bare max doctor",
    ],
    produces: [
      "Feature folder under docs/roadmap/",
      "Pipeline runs visible in max watch / dashboard",
    ],
    effect: "start",
  },
  {
    id: "implement-fully-idea",
    verb: 'max implement-fully --idea "…"',
    bestFor: "Crisp idea with no row when you accept Max writing the row.",
    notFor: "Anything you want to review as a plan first.",
    needs: [
      "Green bare max doctor",
      "Index next: marker for new id allocation",
    ],
    produces: ["New roadmap row", "Pipeline runs"],
    effect: "start",
  },
  {
    id: "queue-add",
    verb: "max queue add … [--after]",
    bestFor: "Two or more items serially, overnight, with dependencies.",
    notFor: "Parallel work in one workspace (b49 not shipped).",
    needs: ["Same preconditions as kickoff per entry"],
    produces: ["Queue entries", "queue_batch_complete when drained"],
    effect: "start",
  },
  {
    id: "planning-quick",
    verb: "max implement-fully … --profile quick",
    bestFor: "Small, well-specified, mechanical items.",
    notFor: "Items whose phases should run as parallel tracks.",
    needs: [],
    produces: ["JIT planning per phase"],
    effect: "start",
  },
  {
    id: "planning-deep",
    verb: "max implement-fully … --profile deep",
    bestFor: "Large surface or phases that split into waves.",
    notFor: "Trivial items where full planning cost is wasteful.",
    needs: [],
    produces: ["Full upfront phase contracts"],
    effect: "start",
  },
  {
    id: "planning-guided",
    verb: "max implement-fully … --profile guided",
    bestFor: "Operator wants to approve the plan before implementation.",
    notFor: "Unattended runs.",
    needs: ["Someone to max answer plan approval needs_input"],
    produces: ["Plan approval pause before implement waves"],
    effect: "start",
  },
  {
    id: "execute-mode",
    verb: "max implement-fully … --execute",
    bestFor: "Phases already written; implement + docs-commit only.",
    notFor: "Unphased items or jit planning.",
    needs: ["deep or guided planning profile"],
    produces: ["Per-phase implement without review worker"],
    effect: "start",
  },
  {
    id: "research-approval",
    verb: "max implement-fully … --research-approval before-planning",
    bestFor:
      "Corpus or domain the planner cannot infer; adoption-style work.",
    notFor: "Routine code changes.",
    needs: ["Profile with a researcher seat configured"],
    produces: ["Research pause before planning"],
    effect: "start",
  },
  {
    id: "plain-automation",
    verb: "max run <automation> (cron / git hook / watch / command / manual)",
    bestFor:
      "Recurring hygiene, post-commit checks, single-prompt jobs.",
    notFor: "Multi-phase feature work.",
    needs: ["YAML in .cursor/automations/"],
    produces: ["Single automation run"],
    effect: "start",
  },
  {
    id: "chain-next",
    verb: "chain.next (automation chain)",
    bestFor: "Fixed multi-step job with repo-as-state handoff.",
    notFor: "Dynamic planning pipelines.",
    needs: ["Chained automation YAML"],
    produces: ["Sequential chained runs"],
    effect: "start",
  },
  {
    id: "workspace-chat",
    verb: "Dashboard chat / max message",
    bestFor:
      "Exploration, Q&A, small fix with a human in the loop.",
    notFor: "Unattended multi-phase work.",
    needs: ["Dashboard or an active run to message"],
    produces: ["Chat transcript", "Optional steer on paused run"],
    effect: "steer",
  },
  {
    id: "watch",
    verb: "max watch <feature-id|runId> [--until …] [--json]",
    bestFor:
      "Supervising an active pipeline without polling status/list.",
    notFor: "Starting work.",
    needs: ["rootRunId from kickoff or max doctor"],
    produces: ["Pipeline snapshot", "outcome: green when done"],
    effect: "read",
  },
  {
    id: "doctor",
    verb: "max doctor [runId|workspace] [--json]",
    bestFor: "Pre-kickoff readiness, run diagnosis, halt recovery.",
    notFor: "Starting pipelines.",
    needs: [],
    produces: ["Readiness report", "Halt recovery commands"],
    effect: "read",
  },
  {
    id: "status-list",
    verb: "max status | max list [-w workspace]",
    bestFor: "Fallback when max watch is unavailable.",
    notFor: "Primary supervision loop (prefer max watch).",
    needs: [],
    produces: ["Daemon health", "Recent runs / automations"],
    effect: "read",
  },
  {
    id: "queue-list",
    verb: "max queue list [--json]",
    bestFor: "Inspect serial queue before or during batch drain.",
    notFor: "Starting parallel pipelines.",
    needs: [],
    produces: ["{ entries } JSON or text table"],
    effect: "read",
  },
  {
    id: "steer-pause-message-resume",
    verb: "max pause | max message | max resume | max answer",
    bestFor: "Supervising something already running.",
    notFor: "Starting work.",
    needs: ["Run id from max list or max doctor"],
    produces: ["Steered or resumed run"],
    effect: "steer",
  },
  {
    id: "escalate",
    verb: "max escalate <runId|feature> retry|skip|abort",
    bestFor: "Recovering from a halted pipeline step.",
    notFor: "Starting a second pipeline (--force not shipped for parallel).",
    needs: ["Halted run from max watch or max doctor"],
    produces: ["Retried, skipped, or aborted step"],
    effect: "steer",
  },
  {
    id: "capabilities",
    verb: "max capabilities [--json]",
    bestFor: "Discovering surfaces, playbooks, and statuses for this tag.",
    notFor: "Mutating daemon state.",
    needs: ["Daemon running"],
    produces: ["Capability catalog JSON or human map"],
    effect: "read",
  },
];

const PLAYBOOKS: CapabilitiesDocument["playbooks"] = [
  {
    id: "backlog-unattended",
    when: "Documented row exists; operator can walk away.",
    steps: [
      "Confirm the row exists in docs/roadmap/",
      "Bare max doctor green",
      "max implement-fully --feature <id> --profile <quick|deep> --role-profile <id> --dry-run",
      "Same command without --dry-run",
      "max watch <id> --until needs_input,halted,blocked,green --json",
      "On needs_input: max doctor <runId> then max answer",
      "On halt: max doctor <runId> then max escalate retry|skip|abort",
    ],
    doneSignal:
      "outcome: green in watch JSON, or final-gate stop reason complete: from doctor",
    dontStopEarlyBecause:
      "A quiet board between phases is normal; pipeline_complete alert alone is not green.",
  },
  {
    id: "dependent-batch",
    when: "Two or more features with ordering constraints.",
    steps: [
      "max queue add --feature <first>",
      "max queue add --feature <second> --after <first>",
      "max queue list --json",
      "Wait for queue_batch_complete wake hook or notification",
    ],
    doneSignal: "queue_batch_complete event or notification",
    dontStopEarlyBecause:
      "Do not kick off directly while the queue is draining.",
  },
  {
    id: "new-idea-traceable",
    when: "Orchestrator wants a reviewable row before kickoff.",
    steps: [
      "Add roadmap row (id from index next: marker)",
      "Commit the row",
      "Follow backlog-unattended playbook by feature id",
    ],
    doneSignal: "Same as backlog-unattended",
    dontStopEarlyBecause: "Prefer this over --idea when the plan should be reviewable.",
  },
  {
    id: "attended-plan-approval",
    when: "Operator must approve the plan before implementation.",
    steps: [
      "max implement-fully --feature <id> --profile guided …",
      "Wait for approve-plan needs_input",
      "max answer <runId>",
      "Continue backlog-unattended supervision",
    ],
    doneSignal: "Same as backlog-unattended",
    dontStopEarlyBecause: "Guided profile pauses once for plan approval.",
  },
  {
    id: "stuck-or-asking",
    when: "Run appears stuck or waiting on the operator.",
    steps: [
      "max doctor <runId> first",
      "needs_input → max answer",
      "halt → max escalate retry|skip|abort (optionally --role swap)",
      "drifting → max pause, max message, max resume",
    ],
    doneSignal: "Resolved needs_input or green/halt terminal state",
    dontStopEarlyBecause: "Never re-kick; diagnose with doctor first.",
  },
  {
    id: "review-on-push",
    when: "Verify review automation on every push.",
    steps: [
      "Configure git-hook-triggered automation in workspace YAML",
      "max enable <automation>",
      "Verify with one max run",
    ],
    doneSignal: "Automation run completes successfully once",
    dontStopEarlyBecause: "Hook must fire on real push, not manual run only.",
  },
  {
    id: "green-then-ship",
    when: "Post-gate automation after feature completes.",
    steps: [
      "max implement-fully --feature <id> … --then <ship-automation> (or max queue add … --then <ship-automation>)",
      "Wait for final-gate complete: stop reason; --then chains <ship-automation> automatically",
      "Hold checkout until the --then tail chain is terminal",
    ],
    doneSignal: "Ship automation tail chain completes",
    dontStopEarlyBecause:
      "The checkout stays held until the --then tail chain reaches a terminal state.",
  },
];

type StatusBody = Pick<CapabilityStatusEntry, "terminal" | "meaning" | "verb">;

const RUN_STATUS_CATALOG: Record<RunStatus, StatusBody> = {
  queued: {
    terminal: false,
    meaning: "Run waiting for a concurrency slot.",
    verb: "max watch or max list",
  },
  running: {
    terminal: false,
    meaning: "Agent actively executing.",
    verb: "max watch",
  },
  paused: {
    terminal: false,
    meaning: "Run parked for operator steering.",
    verb: "max message / max resume",
  },
  needs_input: {
    terminal: false,
    meaning: "Agent waiting on operator answer.",
    verb: "max answer",
  },
  completed: {
    terminal: true,
    meaning: "Run finished successfully.",
    verb: "max doctor (context only)",
  },
  failed: {
    terminal: true,
    meaning: "Run failed (not error — use failed).",
    verb: "max doctor then max escalate if in pipeline",
  },
  cancelled: {
    terminal: true,
    meaning: "Run cancelled by operator.",
    verb: "max doctor",
  },
};

const PIPELINE_OUTCOME_CATALOG: Record<PipelineOutcome, StatusBody> = {
  running: {
    terminal: false,
    meaning: "Pipeline in progress; supervise with watch.",
    verb: "max watch",
  },
  green: {
    terminal: true,
    meaning: "Final gate reported complete: or watch outcome green.",
    verb: "Stop supervising; feature done",
  },
  blocked: {
    terminal: false,
    meaning: "Pipeline waiting on external dependency or wave.",
    verb: "max watch / max wave",
  },
  deadlock: {
    terminal: false,
    meaning: "Parallel tracks cannot proceed.",
    verb: "max wave abort or operator intervention",
  },
  aborted: {
    terminal: true,
    meaning: "Operator or daemon aborted the pipeline.",
    verb: "max doctor",
  },
  failed: {
    terminal: true,
    meaning: "Pipeline ended in failure.",
    verb: "max doctor / max escalate",
  },
};

const QUEUE_STATE_CATALOG: Record<FeatureQueueEntryState, StatusBody> = {
  queued: {
    terminal: false,
    meaning: "Queue entry waiting to start.",
    verb: "max queue list --json",
  },
  blocked: {
    terminal: false,
    meaning: "Queue entry blocked on --after dependency.",
    verb: "max queue list --json",
  },
  running: {
    terminal: false,
    meaning: "Queue entry actively draining.",
    verb: "max watch on active feature",
  },
  done: {
    terminal: true,
    meaning: "Queue entry finished successfully.",
    verb: "max queue list --json",
  },
  failed: {
    terminal: true,
    meaning: "Queue entry failed.",
    verb: "max doctor",
  },
  cancelled: {
    terminal: true,
    meaning: "Queue entry cancelled by operator.",
    verb: "max queue list --json",
  },
};

function statusesFromCatalog<K extends string>(
  domain: CapabilityStatusEntry["domain"],
  catalog: Record<K, StatusBody>
): CapabilityStatusEntry[] {
  return (Object.entries(catalog) as Array<[K, StatusBody]>).map(
    ([id, body]) => ({
      domain,
      id,
      ...body,
    })
  );
}

const STATUSES: CapabilitiesDocument["statuses"] = [
  ...statusesFromCatalog("run", RUN_STATUS_CATALOG),
  ...statusesFromCatalog("pipeline", PIPELINE_OUTCOME_CATALOG),
  {
    domain: "halt",
    id: "halted",
    terminal: false,
    meaning: "Step halted safely; awaits escalate decision.",
    verb: "max escalate retry|skip|abort",
  },
  ...statusesFromCatalog("queue", QUEUE_STATE_CATALOG),
  {
    domain: "input",
    id: "needs_input",
    terminal: false,
    meaning: "Same as run needs_input within pipeline context.",
    verb: "max answer",
  },
];

const ANTI_PATTERNS: string[] = [
  "max down / restart / POST /api/shutdown from an agent — kills the run and remote access.",
  "Probing state.sqlite or grepping transcripts — use max watch, status, list, doctor.",
  "--force a second pipeline in one workspace — b49 concurrent pipelines not shipped.",
  "Re-kicking because the board looked quiet — use max watch, then doctor.",
  "Inventing a feature id or kicking an epic id — check the index; epics are refused.",
  "Declaring done on judgment — only outcome: green or final-gate complete: is done.",
  "Expecting the worker to push — generated workers never push.",
  "Driving a remote daemon without LCA_DAEMON_URL and control token.",
  "Starting a pipeline with max run <generated worker> — pipeline flags are dropped; use max implement-fully.",
  "Treating pipeline_complete notification alone as green — wait for watch outcome: green.",
  "Passing a generated worker to --then — --then must name an ordinary workspace automation (b66).",
  "Expecting profile hot reload — b74 not shipped; lca restart picks up profile YAML changes.",
];

const POINTERS: CapabilitiesDocument["pointers"] = [
  {
    id: "operating-model",
    path: "docs/operating-model.md",
    note: "Model routing rationale and profile calibration why.",
  },
  {
    id: "configuration",
    path: "docs/configuration.md",
    note: "Settings, notify, remote access, pipelineRoleModelProfiles description field.",
  },
  {
    id: "troubleshooting",
    path: "docs/troubleshooting.md",
    note: "Runtime failures, halts, and recovery.",
  },
  {
    id: "implement-fully-protocol",
    path: "docs/implement-fully-protocol.md",
    note: "Pipeline worker contracts and handoff packets.",
  },
  {
    id: "roadmap-format",
    path: "docs/roadmap-format.md",
    note: "Feature id and slug rules.",
  },
];

function buildPlanningEntries(): CapabilityPlanningEntry[] {
  return IMPLEMENT_FULLY_PLANNING_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    description: profile.description,
    planningDepth: profile.planningDepth,
    approvalPolicy: profile.approvalPolicy,
    budgetFormula: IMPLEMENT_FULLY_BUDGET_FORMULA,
    executeBudgetFormula: IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA,
  }));
}

function buildProfiles(
  roleModelSettings: RoleModelIntrospectionSettings
): CapabilityProfile[] {
  const introspectionProfiles = buildRoleModelProfiles(roleModelSettings);
  return introspectionProfiles.map((profile) => ({
    id: profile.id,
    label: profile.label,
    roleModels: copyRoleModels(profile.roleModels),
    ...(profile.description ? { bestFor: profile.description } : {}),
  }));
}

const KICKOFF_SURFACE_IDS = new Set([
  "implement-fully-feature",
  "implement-fully-idea",
  "queue-add",
  "planning-quick",
  "planning-deep",
  "planning-guided",
  "execute-mode",
  "research-approval",
]);

const KICKOFF_PLAYBOOK_IDS = new Set([
  "backlog-unattended",
  "dependent-batch",
  "new-idea-traceable",
  "attended-plan-approval",
  "green-then-ship",
]);

function projectReadinessSummary(
  report: RoadmapReadinessReport
): CapabilitiesReadinessSummary {
  const blockers = report.findings
    .filter(
      (finding) =>
        finding.impact === "blocks-all" || finding.impact === "blocks-some"
    )
    .sort(compareRoadmapFindings)
    .map((finding) => ({
      code: finding.code,
      message: finding.message,
    }));
  return {
    state: report.state,
    counts: countFindingsByImpact(report.findings),
    blockers,
  };
}

function findRootRunId(store: RunStore, runId: string): string | null {
  let current = store.getRun(runId);
  while (current) {
    if (!current.parent_run_id) {
      return current.id;
    }
    current = store.getRun(current.parent_run_id);
  }
  return null;
}

function collectActiveRunsWithAncestors(
  store: RunStore,
  workspaceId: string
): Array<{ id: string; automationId: string; status: string }> {
  const activeRuns = store.listActiveRunsForWorkspace(workspaceId);
  const byId = new Map<string, { id: string; automationId: string; status: string }>();

  for (const active of activeRuns) {
    let current = store.getRun(active.id);
    while (current) {
      if (!byId.has(current.id)) {
        byId.set(current.id, {
          id: current.id,
          automationId: current.automation_id,
          status: current.status,
        });
      }
      if (!current.parent_run_id) {
        break;
      }
      current = store.getRun(current.parent_run_id);
    }
  }

  return [...byId.values()];
}

function projectActivePipelineSummary(
  store: RunStore,
  dashboardStore: DashboardStore,
  workspaceId: string,
  now: number
): CapabilitiesActivePipelineSummary {
  const inactive: CapabilitiesActivePipelineSummary = {
    active: false,
    rootRunId: null,
    featureId: null,
    outcome: null,
    waiting: false,
    halt: false,
  };
  const runsForWalk = collectActiveRunsWithAncestors(store, workspaceId);
  const pipelineAutomationIds = pipelineWorkerAutomationIds(workspaceId);
  const blocker = findActivePipelineBlocker(runsForWalk, pipelineAutomationIds);
  if (!blocker) {
    return inactive;
  }
  const rootRunId = findRootRunId(store, blocker.id);
  if (!rootRunId) {
    return inactive;
  }
  const snapshot = hydratePipelineSnapshot(
    store,
    dashboardStore,
    rootRunId,
    now
  );
  if (!snapshot) {
    return {
      active: true,
      rootRunId,
      featureId: null,
      outcome: null,
      waiting: false,
      halt: false,
    };
  }
  const featureId = snapshot.featureId.trim();
  return {
    active: true,
    rootRunId,
    featureId: featureId.length > 0 ? featureId : null,
    outcome: snapshot.outcome,
    waiting: snapshot.waiting != null,
    halt: snapshot.halt != null,
  };
}

function ideaKickoffBlockReason(
  report: RoadmapReadinessReport
): string | null {
  const sorted = [...report.findings].sort(compareRoadmapFindings);
  const blocksAll = sorted.find((finding) => finding.impact === "blocks-all");
  if (blocksAll) {
    return `${blocksAll.code}: ${blocksAll.message}`;
  }
  const ideaOnly = sorted.find((finding) => finding.impact === "idea-only");
  if (ideaOnly) {
    return `${ideaOnly.code}: ${ideaOnly.message}`;
  }
  return null;
}

function featureKickoffBlockReason(
  readiness: CapabilitiesReadinessSummary
): string | null {
  if (readiness.state === "ready" && readiness.blockers.length === 0) {
    return null;
  }
  const top = readiness.blockers[0];
  if (top) {
    return `${top.code}: ${top.message}`;
  }
  if (readiness.state === "empty") {
    return "Roadmap index missing; adopt or init before feature kickoff.";
  }
  if (readiness.state === "adoptable") {
    return "Roadmap adoptable; resolve blockers before feature kickoff.";
  }
  return "Roadmap not ready for feature kickoff.";
}

function activePipelineBlockReason(
  pipeline: CapabilitiesActivePipelineSummary
): string | null {
  if (!pipeline.active) {
    return null;
  }
  const feature = pipeline.featureId?.trim() || "pipeline";
  const runHint = pipeline.rootRunId?.slice(0, 8) ?? "unknown";
  return `Active pipeline for ${feature} (${runHint}); use max watch or max doctor instead of a second kickoff.`;
}

function applyWorkspaceAvailability(
  doc: CapabilitiesDocument,
  workspace: CapabilitiesWorkspaceContext,
  readinessReport: RoadmapReadinessReport
): CapabilitiesDocument {
  const pipelineReason = activePipelineBlockReason(workspace.pipeline);
  const featureReadinessReason = featureKickoffBlockReason(workspace.readiness);
  const ideaReadinessReason = ideaKickoffBlockReason(readinessReport);

  const surfaces = doc.surfaces.map((surface) => {
    if (!KICKOFF_SURFACE_IDS.has(surface.id)) {
      return surface;
    }
    let reason: string | null = pipelineReason;
    if (!reason) {
      if (surface.id === "implement-fully-idea") {
        reason = ideaReadinessReason;
      } else {
        reason = featureReadinessReason;
      }
    }
    const availability: CapabilityAvailability = reason
      ? { status: "blocked", reason }
      : { status: "available", reason: "Workspace ready for kickoff." };
    return { ...surface, availability };
  });

  const playbooks = doc.playbooks.map((playbook) => {
    if (!KICKOFF_PLAYBOOK_IDS.has(playbook.id)) {
      return playbook;
    }
    const reason = pipelineReason ?? featureReadinessReason;
    const availability: CapabilityAvailability = reason
      ? { status: "blocked", reason }
      : { status: "available", reason: "Workspace ready for kickoff." };
    return { ...playbook, availability };
  });

  return {
    ...doc,
    surfaces,
    playbooks,
    workspace,
  };
}

export type BuildWorkspaceCapabilityContextInput = {
  workspaceId: string;
  workspacePath: string;
  workspaceName: string;
  readinessBounds: RoadmapReadinessGatherBounds;
  runStore: RunStore;
  dashboardStore: DashboardStore;
  featureQueue: FeatureQueueStore;
  now?: number;
};

export function buildWorkspaceCapabilityContext(
  input: BuildWorkspaceCapabilityContextInput
): {
  workspace: CapabilitiesWorkspaceContext;
  readinessReport: RoadmapReadinessReport;
} {
  const now = input.now ?? Date.now();
  const readinessReport = analyzeWorkspaceRoadmapReadiness(
    input.workspacePath,
    input.readinessBounds
  );
  const readiness = projectReadinessSummary(readinessReport);
  const pipeline = projectActivePipelineSummary(
    input.runStore,
    input.dashboardStore,
    input.workspaceId,
    now
  );
  const queueEntries = input.featureQueue
    .listEntries(input.workspaceId)
    .map((row) => toFeatureQueueEntry(row));
  const queue = summarizeFeatureQueueForCapabilities(queueEntries);

  return {
    readinessReport,
    workspace: {
      id: input.workspaceId,
      name: input.workspaceName,
      readiness,
      pipeline,
      queue,
    },
  };
}

/** Pure catalog builder — daemon semantic authority for b80. */
export function buildCapabilitiesDocument(
  input: BuildCapabilitiesInput,
  workspace?: CapabilitiesWorkspaceContext,
  readinessReport?: RoadmapReadinessReport
): CapabilitiesDocument {
  const base: CapabilitiesDocument = {
    version: {
      daemon: input.daemonVersion,
    },
    surfaces: SURFACES.map((surface) => ({ ...surface })),
    profiles: buildProfiles(input.roleModelSettings),
    planning: buildPlanningEntries(),
    statuses: STATUSES.map((entry) => ({ ...entry })),
    playbooks: PLAYBOOKS.map((playbook) => ({
      ...playbook,
      steps: [...playbook.steps],
    })),
    antiPatterns: [...ANTI_PATTERNS],
    pointers: POINTERS.map((pointer) => ({ ...pointer })),
  };
  if (!workspace || !readinessReport) {
    return base;
  }
  return applyWorkspaceAvailability(base, workspace, readinessReport);
}
