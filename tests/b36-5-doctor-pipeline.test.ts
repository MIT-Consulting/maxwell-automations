import { describe, expect, it } from "vitest";
import type { Automation, Run } from "@lca/shared";
import { IMPLEMENT_FULLY_LOOP_WORKER_KEYS } from "@lca/shared";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  buildPipelineLineage,
  collectPipelineDoctorFacts,
  diagnoseRun,
  DOCTOR_KEY_EVENTS,
  DOCTOR_LINEAGE_CAP,
  formatLineageBlockLines,
  formatPipelineBlockLines,
  summarizeEvent,
  summarizePipelineHealth,
  summarizeRecoveryEvent,
} from "../packages/cli/src/doctor.ts";

const SECRET_IDEA = "SECRET_IDEA_TEXT_MUST_NOT_LEAK";

const PIPELINE_CONTEXT = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b42",
    featureSlug: "b42-doctor-pipe",
    featureDir: "docs/roadmap/b42-doctor-pipe",
    featureIndex: "docs/roadmap/b42-doctor-pipe/00-index.md",
    idea: SECRET_IDEA,
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

function runEvent(
  seq: number,
  event_type: string,
  payload: Record<string, unknown> = {}
): RunSnapshot["events"][number] {
  return { seq, event_type, payload: JSON.stringify(payload) };
}

function baseRun(
  overrides: Partial<RunSnapshot["run"]> = {}
): RunSnapshot["run"] {
  return {
    id: "run-aaaaaaaa",
    status: "failed",
    automation_id: "ws::generated:implement",
    workspace_id: "ws-1",
    trigger_kind: "chain",
    agent_id: null,
    sdk_run_id: null,
    prompt: null,
    title: null,
    summary: null,
    started_at: "2026-07-10 12:00:00",
    ended_at: "2026-07-10 12:01:00",
    created_at: "2026-07-10 12:00:00",
    ...overrides,
  };
}

function pipelineRun(
  overrides: Partial<RunSnapshot["run"]> = {}
): RunSnapshot["run"] {
  return baseRun({
    chain_root_run_id: "root-bbbbbbbb",
    chain_depth: 2,
    chain_max_depth: 9,
    chain_context_json: JSON.stringify(PIPELINE_CONTEXT),
    chain_handled_at: null,
    ...overrides,
  });
}

function automation(configKey: string): Automation {
  return {
    id: "ws::generated:implement",
    workspaceId: "ws-1",
    name: "implement",
    enabled: true,
    status: "enabled",
    origin: "generated",
    trigger: { type: "manual" },
    prompt: "x",
    model: null,
    modelSelection: null,
    modelRole: "implementer",
    chain: { next: "generated:review", when: "completed" },
    configPath: "generated.yaml",
    configKey,
    archivedAt: null,
    createdAt: "2026-07-10 12:00:00",
    updatedAt: "2026-07-10 12:00:00",
  };
}

function listRun(
  id: string,
  opts: Partial<Run> & { depth?: number; configKey?: string } = {}
): Run {
  const depth = opts.depth ?? 0;
  return {
    id,
    automationId: opts.automationId ?? `ws::${opts.configKey ?? "generated:plan-skeleton"}`,
    workspaceId: "ws-1",
    status: opts.status ?? "completed",
    agentId: null,
    sdkRunId: null,
    triggerKind: "chain",
    parentRunId: opts.parentRunId ?? null,
    title: null,
    summary: null,
    model: null,
    modelSelection: null,
    chainRootRunId: opts.chainRootRunId ?? "root-bbbbbbbb",
    chainDepth: depth,
    chainMaxDepth: opts.chainMaxDepth ?? 9,
    chainHandledAt: opts.chainHandledAt ?? null,
    pipeline: opts.pipeline ?? {
      pipelineId: "implement-fully",
      featureId: "b42",
      featureSlug: "b42-doctor-pipe",
    },
    startedAt: null,
    endedAt: null,
    createdAt: opts.createdAt ?? `2026-07-10 12:0${depth}:00`,
    updatedAt: `2026-07-10 12:0${depth}:00`,
  };
}

describe("DOCTOR_KEY_EVENTS pipeline vocabulary", () => {
  it("includes the five chain/pipeline events", () => {
    for (const ev of [
      "run.chained",
      "run.chain-skipped",
      "run.chain-control",
      "run.pipeline-escalated",
      "run.pipeline-halt-unrecovered",
      "run.pipeline-halt-discovery-requested",
      "run.pipeline-halt-discovery-skipped",
      "run.pipeline-halt-discovery-failed",
      "run.pipeline-halt-discovery-action-result",
      "run.pipeline-resumed",
      "run.pipeline-final-gate-enqueued",
    ]) {
      expect(DOCTOR_KEY_EVENTS.has(ev)).toBe(true);
    }
  });
});

describe("diagnoseRun pipeline halts", () => {
  it("names status-mismatch halt and escalate remedy", () => {
    const snapshot: RunSnapshot = {
      run: pipelineRun(),
      events: [
        runEvent(1, "run.error", { reason: "sdk_error", message: "boom" }),
        runEvent(2, "run.chain-skipped", {
          reason: "status-mismatch",
          next: "generated:review",
          status: "failed",
          when: "completed",
        }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/status-mismatch/i);
    expect(verdict).toMatch(/lca escalate/);
    expect(verdict).toMatch(/retry/);
    expect(verdict).toMatch(/skip/);
    expect(verdict).toMatch(/abort/);
    expect(verdict).not.toContain(SECRET_IDEA);
  });

  it("reports max-depth with planner re-budget guidance", () => {
    const snapshot: RunSnapshot = {
      run: pipelineRun({ status: "completed", chain_depth: 9 }),
      events: [
        runEvent(1, "run.finished", { sdkStatus: "finished" }),
        runEvent(2, "run.chain-skipped", {
          reason: "max-depth",
          depth: 9,
          maxDepth: 9,
        }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/max-depth/i);
    expect(verdict).toMatch(/re-budget|planner|plan-skeleton/i);
    expect(verdict).not.toContain(SECRET_IDEA);
  });

  it("distinguishes agent complete: stop from operator abort", () => {
    const agentStop: RunSnapshot = {
      run: pipelineRun({
        status: "completed",
        chain_stop_reason: "complete: tracker dry",
      }),
      events: [
        runEvent(1, "run.chain-skipped", {
          reason: "stopped",
          detail: "complete: tracker dry",
        }),
      ],
      inputRequests: [],
    };
    expect(diagnoseRun(agentStop, [])).toMatch(/agent/i);
    expect(diagnoseRun(agentStop, [])).toMatch(/complete:/);
    expect(diagnoseRun(agentStop, [])).toMatch(/final-gate/);

    const abort: RunSnapshot = {
      run: pipelineRun({
        status: "cancelled",
        chain_stop_reason: "operator gave up",
      }),
      events: [
        runEvent(1, "run.chain-skipped", {
          reason: "stopped",
          detail: "operator gave up",
        }),
      ],
      inputRequests: [],
    };
    expect(diagnoseRun(abort, [])).toMatch(/operator/i);
    expect(diagnoseRun(abort, [])).not.toMatch(/complete:/);
  });

  it("keeps auth_expired ahead of pipeline skip", () => {
    const snapshot: RunSnapshot = {
      run: pipelineRun(),
      events: [
        runEvent(1, "run.error", {
          reason: "auth_expired",
          message: "ERROR_NOT_LOGGED_IN",
        }),
        runEvent(2, "run.chain-skipped", { reason: "status-mismatch" }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/auth expired/i);
    expect(verdict).not.toMatch(/status-mismatch/);
  });

  it("keeps stale/revive and retries_exhausted wording", () => {
    const revive: RunSnapshot = {
      run: baseRun(),
      events: [
        runEvent(1, "run.error", {
          message: "spawn failed",
          stale: true,
          reviveFailed: true,
        }),
      ],
      inputRequests: [],
    };
    expect(diagnoseRun(revive, [])).toMatch(/revive spawn failed/i);

    const retries: RunSnapshot = {
      run: baseRun(),
      events: [
        runEvent(1, "run.error", {
          reason: "retries_exhausted",
          attempts: 3,
        }),
      ],
      inputRequests: [],
    };
    expect(diagnoseRun(retries, [])).toMatch(/retries_exhausted/);

    const sdk: RunSnapshot = {
      run: baseRun(),
      events: [runEvent(1, "run.error", { reason: "sdk_error" })],
      inputRequests: [],
    };
    expect(diagnoseRun(sdk, [])).toMatch(/sdk_error/);
  });

  it("reports daemon retry/skip recovery with child id and no action needed", () => {
    const retry: RunSnapshot = {
      run: pipelineRun({ chain_handled_at: "2026-07-10 12:02:00" }),
      events: [
        runEvent(1, "run.error", { reason: "sdk_error" }),
        runEvent(2, "run.chain-skipped", { reason: "status-mismatch" }),
        runEvent(3, "run.pipeline-escalated", {
          action: "retry",
          actor: "daemon",
          childRunId: "child-cccccccc",
          recoveryCode: "safe-class",
          recoveryDetail: "Late sdk_error after substantive activity",
        }),
      ],
      inputRequests: [],
    };
    const retryVerdict = diagnoseRun(retry, []);
    expect(retryVerdict).toMatch(/automatically recovered/i);
    expect(retryVerdict).toMatch(/retry/i);
    expect(retryVerdict).toMatch(/child-cc/);
    expect(retryVerdict).toMatch(/no operator action needed/i);
    expect(retryVerdict).not.toMatch(/status-mismatch/);
    expect(retryVerdict).not.toContain(SECRET_IDEA);

    const skip: RunSnapshot = {
      run: pipelineRun({ chain_handled_at: "2026-07-10 12:02:00" }),
      events: [
        runEvent(1, "run.error", { reason: "sdk_error" }),
        runEvent(2, "run.pipeline-escalated", {
          action: "skip",
          actor: "daemon",
          childRunId: "child-dddddddd",
          recoveryCode: "safe-class",
          recoveryDetail: "docs-commit skip once",
        }),
      ],
      inputRequests: [],
    };
    const skipVerdict = diagnoseRun(skip, []);
    expect(skipVerdict).toMatch(/automatically recovered/i);
    expect(skipVerdict).toMatch(/skip/i);
    expect(skipVerdict).toMatch(/child-dd/);
    expect(skipVerdict).toMatch(/no operator action needed/i);
  });

  it("labels operator escalation and never treats it as daemon recovery", () => {
    const snapshot: RunSnapshot = {
      run: pipelineRun({ chain_handled_at: "2026-07-10 12:02:00" }),
      events: [
        runEvent(1, "run.error", { reason: "sdk_error" }),
        runEvent(2, "run.chain-skipped", { reason: "status-mismatch" }),
        runEvent(3, "run.pipeline-escalated", {
          action: "retry",
          actor: "operator",
          childRunId: "child-eeeeeeee",
          reason: "manual retry",
        }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/operator escalated/i);
    expect(verdict).toMatch(/retry/i);
    expect(verdict).toMatch(/child-ee/);
    expect(verdict).not.toMatch(/automatically recovered/i);
    expect(verdict).not.toMatch(/no operator action needed/i);
  });

  it("reports unrecovered code/detail with exact escalate remedy", () => {
    const snapshot: RunSnapshot = {
      run: pipelineRun(),
      events: [
        runEvent(1, "run.error", { reason: "spawn_error" }),
        runEvent(2, "run.chain-skipped", { reason: "status-mismatch" }),
        runEvent(3, "run.pipeline-halt-unrecovered", {
          action: "none",
          code: "not-safe-class",
          detail: "Failure reason is not in the safe allowlist",
          observedReason: "spawn_error",
        }),
      ],
      inputRequests: [],
    };
    const verdict = diagnoseRun(snapshot, []);
    expect(verdict).toMatch(/unrecovered/i);
    expect(verdict).toMatch(/not-safe-class/);
    expect(verdict).toMatch(/safe allowlist/i);
    expect(verdict).toContain(
      "lca escalate run-aaaaaaaa retry|skip|abort [--reason <text>]"
    );
    expect(verdict).not.toMatch(/automatically recovered/i);
    expect(verdict).not.toContain(SECRET_IDEA);
  });

  it("falls back for malformed recovery payloads", () => {
    const badEscalation: RunSnapshot = {
      run: pipelineRun(),
      events: [
        runEvent(1, "run.error", { reason: "sdk_error" }),
        runEvent(2, "run.chain-skipped", { reason: "status-mismatch" }),
        runEvent(3, "run.pipeline-escalated", {
          actor: "daemon",
          // missing action
          childRunId: "child-ffffffff",
        }),
      ],
      inputRequests: [],
    };
    expect(diagnoseRun(badEscalation, [])).toMatch(/status-mismatch/i);

    const badUnrecovered: RunSnapshot = {
      run: pipelineRun(),
      events: [
        runEvent(1, "run.error", { reason: "sdk_error" }),
        runEvent(2, "run.chain-skipped", { reason: "status-mismatch" }),
        runEvent(3, "run.pipeline-halt-unrecovered", {
          action: "none",
          code: 123,
        }),
      ],
      inputRequests: [],
    };
    expect(diagnoseRun(badUnrecovered, [])).toMatch(/status-mismatch/i);

    const legacyNoActor: RunSnapshot = {
      run: pipelineRun({ chain_handled_at: "2026-07-10 12:02:00" }),
      events: [
        runEvent(1, "run.error", { reason: "sdk_error" }),
        runEvent(2, "run.pipeline-escalated", {
          action: "retry",
          childRunId: "child-gggggggg",
        }),
      ],
      inputRequests: [],
    };
    const legacyVerdict = diagnoseRun(legacyNoActor, []);
    expect(legacyVerdict).toMatch(/operator escalated/i);
    expect(legacyVerdict).not.toMatch(/automatically recovered/i);
  });

  it("formats recovery key events without idea text", () => {
    expect(
      summarizeEvent(
        "run.pipeline-escalated",
        JSON.stringify({
          action: "retry",
          actor: "daemon",
          childRunId: "child-hhhhhhhh",
        })
      )
    ).toMatch(/daemon retry → child-hh/);
    expect(
      summarizeEvent(
        "run.pipeline-escalated",
        JSON.stringify({
          action: "skip",
          actor: "operator",
          childRunId: "child-iiiiiiii",
        })
      )
    ).toMatch(/operator skip → child-ii/);
    expect(
      summarizeEvent(
        "run.pipeline-halt-unrecovered",
        JSON.stringify({
          code: "lineage-budget-exhausted",
          detail: "cap reached",
        })
      )
    ).toMatch(/lineage-budget-exhausted — cap reached/);
    expect(
      summarizeEvent(
        "run.pipeline-escalated",
        JSON.stringify({
          action: "retry",
          actor: "daemon",
          childRunId: "child-jjjjjjjj",
          idea: SECRET_IDEA,
        })
      )
    ).not.toContain(SECRET_IDEA);
  });

  it("leaves malformed recovery events to generic key-event rendering", () => {
    expect(
      summarizeRecoveryEvent(
        "run.pipeline-escalated",
        JSON.stringify({ actor: "daemon", childRunId: "child-kkkkkkkk" })
      )
    ).toBeUndefined();
    expect(
      summarizeRecoveryEvent("run.pipeline-halt-unrecovered", "not json")
    ).toBeUndefined();
    expect(summarizeRecoveryEvent("run.chained", "{}")).toBeUndefined();
    expect(
      summarizeRecoveryEvent(
        "run.pipeline-halt-unrecovered",
        JSON.stringify({ code: "budget-spent", detail: "cap reached" })
      )
    ).toMatch(/budget-spent — cap reached/);
  });
});

describe("collectPipelineDoctorFacts", () => {
  it("returns null for ordinary non-pipeline runs", () => {
    const snapshot: RunSnapshot = {
      run: baseRun(),
      events: [],
      inputRequests: [],
    };
    expect(collectPipelineDoctorFacts(snapshot, undefined)).toBeNull();
  });

  it("reports feature/step/budget and never includes idea text", () => {
    const snapshot: RunSnapshot = {
      run: pipelineRun({
        chain_max_depth_override: 17,
        id: "root-bbbbbbbb",
      }),
      events: [],
      inputRequests: [],
    };
    const facts = collectPipelineDoctorFacts(
      snapshot,
      automation("generated:implement")
    );
    expect(facts).not.toBeNull();
    expect(facts!.featureId).toBe("b42");
    expect(facts!.featureSlug).toBe("b42-doctor-pipe");
    expect(facts!.pipelineId).toBe("implement-fully");
    expect(facts!.workerKey).toBe("implement");
    expect(facts!.effectiveBudget).toBe(17);
    expect(facts!.budgetOverrideInForce).toBe(true);
    expect(facts!.isRoot).toBe(true);
    const block = formatPipelineBlockLines(facts!).join("\n");
    expect(block).not.toContain(SECRET_IDEA);
    expect(block).toMatch(/override in force/);
    expect(block).toMatch(/planner=planner-model/);
  });

  it("survives corrupt context, null depth, and missing automation", () => {
    const snapshot: RunSnapshot = {
      run: pipelineRun({
        chain_context_json: "{not-json",
        chain_depth: null,
      }),
      events: [],
      inputRequests: [],
    };
    const facts = collectPipelineDoctorFacts(snapshot, undefined);
    expect(facts).not.toBeNull();
    expect(facts!.contextUnavailable).toBe(true);
    expect(facts!.depthUnavailable).toBe(true);
    expect(facts!.automationUnavailable).toBe(true);
    const block = formatPipelineBlockLines(facts!).join("\n");
    expect(block).toMatch(/unavailable/i);
    expect(block).not.toContain(SECRET_IDEA);
  });
});

describe("buildPipelineLineage", () => {
  it("orders by depth, marks current, and states truncation", () => {
    const root = "root-bbbbbbbb";
    const listed: Run[] = [];
    const autoById = new Map<string, Automation>();
    for (let d = 0; d < DOCTOR_LINEAGE_CAP + 3; d++) {
      const id = d === 0 ? root : `run-depth-${d}`;
      const key =
        d === 0
          ? "generated:plan-skeleton"
          : `generated:${IMPLEMENT_FULLY_LOOP_WORKER_KEYS[(d - 1) % IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length]}`;
      listed.push(
        listRun(id, {
          depth: d,
          configKey: key,
          automationId: `ws::${key}`,
          status: d === 2 ? "failed" : "completed",
        })
      );
      autoById.set(`ws::${key}`, {
        ...automation(key),
        id: `ws::${key}`,
        name: key,
      });
    }
    const lineage = buildPipelineLineage("run-depth-2", root, listed, autoById);
    expect(lineage.truncated).toBe(true);
    expect(lineage.entries).toHaveLength(DOCTOR_LINEAGE_CAP);
    expect(lineage.entries[0].depth).toBe(0);
    expect(lineage.entries[0].isCurrent).toBe(false);
    const current = lineage.entries.find((e) => e.isCurrent);
    expect(current?.id).toBe("run-depth-2");
    const text = formatLineageBlockLines(lineage).join("\n");
    expect(text).toMatch(/showing/);
    expect(text).toMatch(/←/);
    expect(text).not.toContain(SECRET_IDEA);
  });
});

describe("summarizePipelineHealth", () => {
  it("counts active pipelines and flags halted / aged needs_input", () => {
    const now = Date.parse("2026-07-10T14:00:00Z");
    const runs: Run[] = [
      listRun("root-1", {
        depth: 0,
        status: "completed",
        chainRootRunId: "root-1",
      }),
      listRun("halt-1", {
        depth: 2,
        status: "failed",
        chainRootRunId: "root-1",
        chainHandledAt: null,
        automationId: "ws::generated:implement",
      }),
      listRun("active-1", {
        depth: 1,
        status: "running",
        chainRootRunId: "root-2",
        pipeline: {
          pipelineId: "implement-fully",
          featureId: "b99",
          featureSlug: "b99-x",
        },
      }),
      {
        ...listRun("ask-1", {
          depth: 3,
          status: "needs_input",
          chainRootRunId: "root-3",
          pipeline: {
            pipelineId: "implement-fully",
            featureId: "b77",
            featureSlug: "b77-x",
          },
        }),
        startedAt: "2026-07-10 12:00:00",
        createdAt: "2026-07-10 12:00:00",
      },
    ];
    const summary = summarizePipelineHealth(runs, now, 30 * 60 * 1000);
    expect(summary.activeCount).toBe(2); // running + needs_input
    expect(summary.halted).toHaveLength(1);
    expect(summary.halted[0].featureId).toBe("b42");
    expect(summary.staleNeedsInput).toHaveLength(1);
    expect(summary.staleNeedsInput[0].featureId).toBe("b77");
    expect(summary.runningTracks).toEqual([]);
    expect(summary.barrierWaits).toEqual([]);
    expect(summary.blockedWaves).toEqual([]);
    expect(summary.cleanupRequired).toEqual([]);
  });
});
