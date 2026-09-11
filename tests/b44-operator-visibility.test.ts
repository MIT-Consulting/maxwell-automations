import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  HALT_DISCOVERY_INPUT_KIND,
  mergeNotifyEventPrefs,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import {
  dispatchHaltDiscoveryRunEvent,
  notifyHaltDiscoveryBriefingIfApplicable,
  subscribeHaltDiscoveryNotifications,
} from "../packages/daemon/src/notify/halt-discovery-notifications.ts";
import {
  buildRunDeepLink,
  Notifier,
} from "../packages/daemon/src/notify/notifier.ts";
import {
  HALT_DISCOVERY_TRIGGER_KIND,
  HALT_DISCOVERY_WORKER_KEY,
} from "../packages/daemon/src/pipelines/halt-discovery.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import type { RunSnapshot } from "../packages/cli/src/client.ts";
import {
  diagnoseRun,
  summarizeDiscoveryEvent,
  summarizeEvent,
  summarizePipelineHealth,
} from "../packages/cli/src/doctor.ts";
import type { Run } from "@lca/shared";

/** Toast content asserts for discovery action events that default quiet under b51. */
const discoveryToastPrefs = mergeNotifyEventPrefs({
  halt_discovery_action: { toast: true, ntfy: false },
});

type NotifyCall = {
  title?: string;
  message?: string;
  open?: string;
};

const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));

vi.mock("node-notifier", () => ({
  default: {
    notify: (
      opts: NotifyCall,
      cb?: (err: Error | null, response: string) => void
    ) => {
      notifyMock(opts, cb);
    },
  },
}));

afterEach(() => {
  notifyMock.mockReset();
});

function runEvent(
  seq: number,
  event_type: string,
  payload: Record<string, unknown> = {}
): RunSnapshot["events"][number] {
  return { seq, event_type, payload: JSON.stringify(payload) };
}

function advisorySnapshot(
  overrides: Partial<RunSnapshot["run"]> = {},
  events: RunSnapshot["events"] = []
): RunSnapshot {
  return {
    run: {
      id: "advisory-aaaaaaaa",
      status: "needs_input",
      automation_id: "ws::generated:halt-discovery",
      workspace_id: "ws-1",
      trigger_kind: HALT_DISCOVERY_TRIGGER_KIND,
      agent_id: null,
      sdk_run_id: null,
      prompt: null,
      title: null,
      summary: null,
      started_at: "2026-07-10 12:00:00",
      ended_at: null,
      created_at: "2026-07-10 12:00:00",
      parent_run_id: "source-bbbbbbbb",
      ...overrides,
    },
    events,
    inputRequests: [],
  };
}

function sourceSnapshot(
  events: RunSnapshot["events"]
): RunSnapshot {
  return {
    run: {
      id: "source-bbbbbbbb",
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
      chain_root_run_id: "root-cccccccc",
      chain_depth: 2,
      chain_max_depth: 9,
      chain_handled_at: null,
    },
    events,
    inputRequests: [],
  };
}

function listRun(
  id: string,
  opts: Partial<Run> & { depth?: number } = {}
): Run {
  const depth = opts.depth ?? 0;
  return {
    id,
    automationId: opts.automationId ?? "ws::generated:implement",
    workspaceId: "ws-1",
    status: opts.status ?? "completed",
    agentId: null,
    sdkRunId: null,
    triggerKind: opts.triggerKind ?? "chain",
    parentRunId: opts.parentRunId ?? null,
    title: null,
    summary: null,
    model: null,
    modelSelection: null,
    chainRootRunId: opts.chainRootRunId ?? "root-cccccccc",
    chainDepth: depth,
    chainMaxDepth: 9,
    chainHandledAt: opts.chainHandledAt ?? null,
    pipeline: opts.pipeline ?? {
      pipelineId: "implement-fully",
      featureId: "b44",
      featureSlug: "b44-halt-discovery-agent",
    },
    startedAt: opts.startedAt ?? null,
    endedAt: null,
    createdAt: opts.createdAt ?? `2026-07-10 12:0${depth}:00`,
    updatedAt: `2026-07-10 12:0${depth}:00`,
  };
}

describe("b44 notifier discovery outcomes", () => {
  const dashboardUrl = "http://127.0.0.1:3747";

  it("emits ready/failed/acted/refused/internal-failure with correct deep links", () => {
    const notifier = new Notifier({
      dashboardUrl,
      eventPrefs: discoveryToastPrefs,
    });
    const advisoryId = "advisory-aaaaaaaa";
    const sourceId = "source-bbbbbbbb";
    const childId = "child-cccccccc";

    notifier.haltDiscoveryRecommendationReady(advisoryId, sourceId);
    notifier.haltDiscoveryFailed(
      sourceId,
      "briefing",
      "invalid-packet",
      "missing fence"
    );
    notifier.haltDiscoveryActionResult({
      advisoryRunId: advisoryId,
      sourceRunId: sourceId,
      action: "retry",
      outcome: "acted",
      childRunId: childId,
    });
    notifier.haltDiscoveryActionResult({
      advisoryRunId: advisoryId,
      sourceRunId: sourceId,
      action: "skip",
      outcome: "refused",
      code: "already-escalated",
    });
    notifier.haltDiscoveryActionResult({
      advisoryRunId: advisoryId,
      sourceRunId: sourceId,
      action: "abort",
      outcome: "internal-failure",
      code: "effect-stage-error",
    });

    expect(notifyMock).toHaveBeenCalledTimes(5);
    const ready = notifyMock.mock.calls[0]![0] as NotifyCall;
    const failed = notifyMock.mock.calls[1]![0] as NotifyCall;
    const acted = notifyMock.mock.calls[2]![0] as NotifyCall;
    const refused = notifyMock.mock.calls[3]![0] as NotifyCall;
    const internal = notifyMock.mock.calls[4]![0] as NotifyCall;

    expect(ready.title).toMatch(/briefing ready/i);
    expect(ready.message).toMatch(/no timeout/i);
    expect(ready.message).toContain(sourceId.slice(0, 8));
    expect(ready.open).toBe(buildRunDeepLink(dashboardUrl, advisoryId));

    expect(failed.title).toMatch(/discovery failed/i);
    expect(failed.message).toMatch(/briefing\/invalid-packet/);
    expect(failed.open).toBe(buildRunDeepLink(dashboardUrl, sourceId));

    expect(acted.title).toMatch(/action applied/i);
    expect(acted.message).toMatch(/retry/i);
    expect(acted.message).toContain(childId.slice(0, 8));
    expect(acted.open).toBe(buildRunDeepLink(dashboardUrl, advisoryId));

    expect(refused.title).toMatch(/refused/i);
    expect(refused.message).toMatch(/already-escalated/);
    expect(refused.message).not.toMatch(/applied/i);

    expect(internal.title).toMatch(/action failed/i);
    expect(internal.message).toMatch(/internal failure/i);
    expect(internal.message).toMatch(/not confirmed/i);
  });

  it("honors disabled and isolates notify sink errors", () => {
    const disabled = new Notifier({
      dashboardUrl,
      disabled: true,
      eventPrefs: discoveryToastPrefs,
    });
    disabled.haltDiscoveryRecommendationReady("a", "s");
    disabled.haltDiscoveryFailed("s", "spawn", "enqueue-failed", "boom");
    disabled.haltDiscoveryActionResult({
      advisoryRunId: "a",
      sourceRunId: "s",
      action: "retry",
      outcome: "acted",
    });
    expect(notifyMock).not.toHaveBeenCalled();

    notifyMock.mockImplementation(() => {
      throw new Error("toast boom");
    });
    const logs: string[] = [];
    const live = new Notifier({
      dashboardUrl,
      onLog: (m) => logs.push(m),
      eventPrefs: discoveryToastPrefs,
    });
    expect(() =>
      live.haltDiscoveryRecommendationReady("adv-1", "src-1")
    ).not.toThrow();
    expect(logs.some((l) => /Notifier error/i.test(l))).toBe(true);
  });
});

describe("b44 discovery notification dispatch", () => {
  it("routes briefing cards to recommendation-ready and preserves generic needsInput", () => {
    const ready = vi.fn();
    const needsInput = vi.fn();
    const logs: string[] = [];

    const discoveryHandled = notifyHaltDiscoveryBriefingIfApplicable({
      runId: "advisory-1",
      question: "Choose retry/skip/abort",
      getPending: () => ({
        id: "req-1",
        run_id: "advisory-1",
        question: "Choose retry/skip/abort",
        answer: null,
        status: "pending",
        created_at: "2026-07-10 12:00:00",
        answered_at: null,
        metadata_json: JSON.stringify({
          kind: HALT_DISCOVERY_INPUT_KIND,
          choices: [{ id: "retry", label: "Retry" }],
        }),
      }),
      getParentRunId: () => "source-1",
      notifier: {
        haltDiscoveryRecommendationReady: ready,
        haltDiscoveryFailed: vi.fn(),
        haltDiscoveryActionResult: vi.fn(),
      },
      onLog: (m) => logs.push(m),
    });
    expect(discoveryHandled).toBe(true);
    expect(ready).toHaveBeenCalledWith("advisory-1", "source-1");
    expect(logs.some((l) => /briefing ready/i.test(l))).toBe(true);

    const generic = notifyHaltDiscoveryBriefingIfApplicable({
      runId: "run-generic",
      question: "What next?",
      getPending: () => ({
        id: "req-2",
        run_id: "run-generic",
        question: "What next?",
        answer: null,
        status: "pending",
        created_at: "2026-07-10 12:00:00",
        answered_at: null,
        metadata_json: null,
      }),
      getParentRunId: () => null,
      notifier: {
        haltDiscoveryRecommendationReady: ready,
        haltDiscoveryFailed: vi.fn(),
        haltDiscoveryActionResult: vi.fn(),
      },
    });
    expect(generic).toBe(false);
    expect(ready).toHaveBeenCalledTimes(1);
    needsInput("run-generic", "What next?");
    expect(needsInput).toHaveBeenCalled();
  });

  it("dispatches failed and action-result; silences requested/skipped/malformed", () => {
    const failed = vi.fn();
    const action = vi.fn();
    const sink = {
      haltDiscoveryRecommendationReady: vi.fn(),
      haltDiscoveryFailed: failed,
      haltDiscoveryActionResult: action,
    };

    expect(
      dispatchHaltDiscoveryRunEvent({
        runId: "source-1",
        eventType: "run.pipeline-halt-discovery-requested",
        payload: JSON.stringify({
          code: "unrecovered-halt",
          recoveryCode: "not-safe-class",
          recoveryDetail: "x",
        }),
        notifier: sink,
      })
    ).toBe(false);
    expect(
      dispatchHaltDiscoveryRunEvent({
        runId: "source-1",
        eventType: "run.pipeline-halt-discovery-skipped",
        payload: JSON.stringify({ code: "disabled", detail: "off" }),
        notifier: sink,
      })
    ).toBe(false);
    expect(
      dispatchHaltDiscoveryRunEvent({
        runId: "source-1",
        eventType: "run.pipeline-halt-discovery-failed",
        payload: "{not-json",
        notifier: sink,
      })
    ).toBe(false);
    expect(
      dispatchHaltDiscoveryRunEvent({
        runId: "source-1",
        eventType: "run.pipeline-halt-discovery-failed",
        payload: JSON.stringify({ stage: "spawn", code: "x" }),
        notifier: sink,
      })
    ).toBe(false);

    expect(
      dispatchHaltDiscoveryRunEvent({
        runId: "source-1",
        eventType: "run.pipeline-halt-discovery-failed",
        payload: JSON.stringify({
          stage: "diagnosis",
          code: "worker-failed",
          detail: "exit 1",
          advisoryRunId: "adv-1",
        }),
        notifier: sink,
      })
    ).toBe(true);
    expect(failed).toHaveBeenCalledWith(
      "source-1",
      "diagnosis",
      "worker-failed",
      "exit 1"
    );

    expect(
      dispatchHaltDiscoveryRunEvent({
        runId: "adv-1",
        eventType: "run.pipeline-halt-discovery-action-result",
        payload: JSON.stringify({
          sourceRunId: "source-1",
          advisoryRunId: "adv-1",
          action: "retry",
          outcome: "acted",
          childRunId: "child-1",
        }),
        notifier: sink,
      })
    ).toBe(true);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "acted",
        action: "retry",
        sourceRunId: "source-1",
      })
    );
  });

  it("bus subscription notifies only fresh events and isolates sink errors", () => {
    const events = new DaemonEventBus();
    const action = vi.fn(() => {
      throw new Error("toast exploded");
    });
    const logs: string[] = [];
    const unsubscribe = subscribeHaltDiscoveryNotifications({
      events,
      notifier: {
        haltDiscoveryRecommendationReady: vi.fn(),
        haltDiscoveryFailed: vi.fn(),
        haltDiscoveryActionResult: action,
      },
      onLog: (m) => logs.push(m),
    });

    try {
      events.emitRunEvent("adv-1", {
        id: 1,
        runId: "adv-1",
        seq: 1,
        eventType: "run.pipeline-halt-discovery-action-result",
        payload: JSON.stringify({
          sourceRunId: "source-1",
          advisoryRunId: "adv-1",
          action: "skip",
          outcome: "refused",
          code: "claim-lost",
        }),
        createdAt: new Date().toISOString(),
      });
      expect(action).toHaveBeenCalledTimes(1);
      expect(logs.some((l) => /notify failed/i.test(l))).toBe(true);

      // Historical replay is out of band: unsubscribed bus means silence.
      unsubscribe();
      action.mockClear();
      events.emitRunEvent("adv-1", {
        id: 2,
        runId: "adv-1",
        seq: 2,
        eventType: "run.pipeline-halt-discovery-action-result",
        payload: JSON.stringify({
          sourceRunId: "source-1",
          advisoryRunId: "adv-1",
          action: "abort",
          outcome: "acted",
        }),
        createdAt: new Date().toISOString(),
      });
      expect(action).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("InputHub presentWithoutWait fires recommendation-ready for discovery cards", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b44-vis-"));
    const db = openDatabase(join(root, "state.sqlite"));
    mkdirSync(join(root, "ws"), { recursive: true });
    db.prepare(
      `INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)`
    ).run("ws", join(root, "ws"), "Workspace");
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, model,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, 'ws', ?, 1, 'enabled', ?, ?, NULL, 'test.yaml', ?, NULL, NULL)`
    ).run(
      "ws::generated:halt-discovery",
      "Halt discovery",
      JSON.stringify({ type: "manual" }),
      "Diagnose",
      GENERATED_CONFIG_KEY_PREFIX + HALT_DISCOVERY_WORKER_KEY
    );

    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    store.insertRun({
      id: "source-1",
      automationId: "ws::generated:halt-discovery",
      workspaceId: "ws",
      triggerKind: "chain",
      prompt: "source",
    });
    store.insertRun({
      id: "advisory-1",
      automationId: "ws::generated:halt-discovery",
      workspaceId: "ws",
      triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
      prompt: "advisory",
      parentRunId: "source-1",
    });
    store.setStatus("advisory-1", "completed");

    const ready = vi.fn();
    const generic = vi.fn();
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
      onNotify: (runId, question) => {
        const handled = notifyHaltDiscoveryBriefingIfApplicable({
          runId,
          question,
          getPending: (id) => inputHub.getPendingQuestion(id),
          getParentRunId: (id) => store.getRun(id)?.parent_run_id,
          notifier: {
            haltDiscoveryRecommendationReady: ready,
            haltDiscoveryFailed: vi.fn(),
            haltDiscoveryActionResult: vi.fn(),
          },
        });
        if (!handled) generic(runId, question);
      },
    });

    try {
      const result = inputHub.presentWithoutWait(
        "advisory-1",
        "Briefing: recommend retry",
        {
          kind: HALT_DISCOVERY_INPUT_KIND,
          choices: [
            { id: "retry", label: "Retry" },
            { id: "skip", label: "Skip" },
            { id: "abort", label: "Abort" },
          ],
        }
      );
      expect(result.status).toBe("created");
      expect(ready).toHaveBeenCalledWith("advisory-1", "source-1");
      expect(generic).not.toHaveBeenCalled();

      // Replay / existing card does not toast again.
      ready.mockClear();
      const again = inputHub.presentWithoutWait(
        "advisory-1",
        "Briefing: recommend retry",
        {
          kind: HALT_DISCOVERY_INPUT_KIND,
          choices: [{ id: "retry", label: "Retry" }],
        }
      );
      expect(again.status).toBe("existing");
      expect(ready).not.toHaveBeenCalled();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b44 doctor discovery visibility", () => {
  it("summarizes all discovery lifecycle payloads and degrades malformed", () => {
    expect(
      summarizeDiscoveryEvent(
        "run.pipeline-halt-discovery-requested",
        JSON.stringify({
          code: "unrecovered-halt",
          recoveryCode: "not-safe-class",
          recoveryDetail: "spawn_error",
        })
      )
    ).toMatch(/unrecovered-halt.*not-safe-class/);

    for (const code of [
      "disabled",
      "wave-scoped",
      "source-resolved",
      "ineligible-source",
      "invalid-trigger",
    ]) {
      expect(
        summarizeDiscoveryEvent(
          "run.pipeline-halt-discovery-skipped",
          JSON.stringify({ code, detail: `${code} detail` })
        )
      ).toContain(code);
    }

    const failedSummary = summarizeDiscoveryEvent(
      "run.pipeline-halt-discovery-failed",
      JSON.stringify({
        stage: "spawn",
        code: "enqueue-failed",
        detail: "boom",
        advisoryRunId: "advisory-zzzzzzzz",
      })
    );
    expect(failedSummary).toMatch(/spawn\/enqueue-failed/);
    expect(failedSummary).toContain("advisory-zzzzzzzz".slice(0, 8));

    expect(
      summarizeEvent(
        "run.pipeline-halt-discovery-action-result",
        JSON.stringify({
          sourceRunId: "source-bbbbbbbb",
          advisoryRunId: "advisory-aaaaaaaa",
          action: "retry",
          outcome: "acted",
          childRunId: "child-cccccccc",
        })
      )
    ).toContain("acted retry → child-c");

    expect(
      summarizeDiscoveryEvent(
        "run.pipeline-halt-discovery-action-result",
        JSON.stringify({
          sourceRunId: "source-bbbbbbbb",
          advisoryRunId: "advisory-aaaaaaaa",
          action: "skip",
          outcome: "refused",
          code: "already-escalated",
        })
      )
    ).toMatch(/refused skip already-escalated/);

    expect(
      summarizeDiscoveryEvent(
        "run.pipeline-halt-discovery-failed",
        JSON.stringify({ stage: "spawn", code: 1 })
      )
    ).toBeUndefined();
    expect(
      summarizeEvent(
        "run.pipeline-halt-discovery-failed",
        JSON.stringify({ stage: "spawn", code: 1 })
      )
    ).toBe("run.pipeline-halt-discovery-failed");
  });

  it("augments unrecovered source verdicts and keeps escalate fallback", () => {
    const requested = diagnoseRun(
      sourceSnapshot([
        runEvent(1, "run.error", { reason: "spawn_error" }),
        runEvent(2, "run.pipeline-halt-unrecovered", {
          action: "none",
          code: "not-safe-class",
          detail: "Failure reason is not in the safe allowlist",
        }),
        runEvent(3, "run.pipeline-halt-discovery-requested", {
          code: "unrecovered-halt",
          recoveryCode: "not-safe-class",
          recoveryDetail: "Failure reason is not in the safe allowlist",
        }),
      ]),
      []
    );
    expect(requested).toMatch(/unrecovered/i);
    expect(requested).toMatch(/discovery requested/i);
    expect(requested).toContain(
      "lca escalate source-bbbbbbbb retry|skip|abort [--reason <text>]"
    );

    const skipped = diagnoseRun(
      sourceSnapshot([
        runEvent(1, "run.pipeline-halt-unrecovered", {
          action: "none",
          code: "lineage-budget-exhausted",
          detail: "at cap",
        }),
        runEvent(2, "run.pipeline-halt-discovery-skipped", {
          code: "ineligible-source",
          detail: "wave-scoped row",
        }),
      ]),
      []
    );
    expect(skipped).toMatch(/discovery skipped/i);
    expect(skipped).toMatch(/ineligible-source/);
    expect(skipped).toMatch(/best-effort/i);
    expect(skipped).toContain("lca escalate source-bbbbbbbb");

    const failed = diagnoseRun(
      sourceSnapshot([
        runEvent(1, "run.pipeline-halt-unrecovered", {
          action: "none",
          code: "not-safe-class",
          detail: "spawn_error",
        }),
        runEvent(2, "run.pipeline-halt-discovery-failed", {
          stage: "briefing",
          code: "invalid-packet",
          detail: "missing fence",
          advisoryRunId: "advisory-aaaaaaaa",
        }),
      ]),
      []
    );
    expect(failed).toMatch(/discovery failed/i);
    expect(failed).toMatch(/briefing\/invalid-packet/);
    expect(failed).toContain("lca escalate source-bbbbbbbb");
  });

  it("diagnoses advisory pending briefing and action outcomes", () => {
    const pending = diagnoseRun(advisorySnapshot(), []);
    expect(pending).toMatch(/briefing awaiting/i);
    expect(pending).toMatch(/no timeout/i);
    expect(pending).toContain("source-bbbbbbbb".slice(0, 8));
    expect(pending).toContain("lca escalate source-bbbbbbbb");

    const acted = diagnoseRun(
      advisorySnapshot({ status: "completed" }, [
        runEvent(1, "run.pipeline-halt-discovery-action-result", {
          sourceRunId: "source-bbbbbbbb",
          advisoryRunId: "advisory-aaaaaaaa",
          action: "retry",
          outcome: "acted",
          childRunId: "child-cccccccc",
        }),
      ]),
      []
    );
    expect(acted).toMatch(/acted retry/i);
    expect(acted).toContain("child-cccccccc".slice(0, 8));
    expect(acted).toMatch(/do not infer/i);

    const refused = diagnoseRun(
      advisorySnapshot({ status: "completed" }, [
        runEvent(1, "run.pipeline-halt-discovery-action-result", {
          sourceRunId: "source-bbbbbbbb",
          advisoryRunId: "advisory-aaaaaaaa",
          action: "skip",
          outcome: "refused",
          code: "claim-lost",
        }),
      ]),
      []
    );
    expect(refused).toMatch(/refused skip/i);
    expect(refused).toMatch(/claim-lost/);

    const internal = diagnoseRun(
      advisorySnapshot({ status: "completed" }, [
        runEvent(1, "run.pipeline-halt-discovery-action-result", {
          sourceRunId: "source-bbbbbbbb",
          advisoryRunId: "advisory-aaaaaaaa",
          action: "abort",
          outcome: "internal-failure",
          code: "effect-stage-error",
        }),
      ]),
      []
    );
    expect(internal).toMatch(/internal-failure/i);
    expect(internal).toContain("lca escalate source-bbbbbbbb");
  });

  it("keeps the advisory's own failure reason over generic advisory context", () => {
    const authFailed = diagnoseRun(
      advisorySnapshot({ status: "failed", ended_at: "2026-07-10 12:05:00" }, [
        runEvent(1, "run.error", {
          reason: "auth_expired",
          message: "ERROR_NOT_LOGGED_IN",
        }),
      ]),
      []
    );
    expect(authFailed).toMatch(/auth expired/i);

    const noEvidence = diagnoseRun(
      advisorySnapshot({ status: "cancelled", ended_at: "2026-07-10 12:05:00" }),
      []
    );
    expect(noEvidence).toMatch(/advisory for source source-b/i);
    expect(noEvidence).toContain("lca escalate source-bbbbbbbb");
  });

  it("excludes halt-discovery needs_input from stale health only", () => {
    const now = Date.parse("2026-07-10T14:00:00Z");
    const runs: Run[] = [
      {
        ...listRun("ask-pipeline", {
          depth: 3,
          status: "needs_input",
          chainRootRunId: "root-1",
          pipeline: {
            pipelineId: "implement-fully",
            featureId: "b77",
            featureSlug: "b77-x",
          },
        }),
        startedAt: "2026-07-10 12:00:00",
        createdAt: "2026-07-10 12:00:00",
      },
      {
        ...listRun("ask-discovery", {
          depth: 1,
          status: "needs_input",
          triggerKind: HALT_DISCOVERY_TRIGGER_KIND,
          parentRunId: "source-1",
          chainRootRunId: "root-2",
          pipeline: {
            pipelineId: "implement-fully",
            featureId: "b44",
            featureSlug: "b44-x",
          },
        }),
        startedAt: "2026-07-10 12:00:00",
        createdAt: "2026-07-10 12:00:00",
      },
      listRun("running-1", {
        depth: 1,
        status: "running",
        chainRootRunId: "root-3",
      }),
    ];
    const summary = summarizePipelineHealth(runs, now, 30 * 60 * 1000);
    expect(summary.activeCount).toBe(3);
    expect(summary.staleNeedsInput).toHaveLength(1);
    expect(summary.staleNeedsInput[0]!.runId).toBe("ask-pipeline");
  });

  it("keeps b43 unrecovered/escalated verdicts unchanged without discovery", () => {
    const unrecovered = diagnoseRun(
      sourceSnapshot([
        runEvent(1, "run.error", { reason: "spawn_error" }),
        runEvent(2, "run.pipeline-halt-unrecovered", {
          action: "none",
          code: "not-safe-class",
          detail: "Failure reason is not in the safe allowlist",
        }),
      ]),
      []
    );
    expect(unrecovered).toMatch(/unrecovered/i);
    expect(unrecovered).not.toMatch(/discovery/i);
    expect(unrecovered).toContain(
      "lca escalate source-bbbbbbbb retry|skip|abort [--reason <text>]"
    );

    const escalated = diagnoseRun(
      sourceSnapshot([
        runEvent(1, "run.error", { reason: "sdk_error" }),
        runEvent(2, "run.pipeline-escalated", {
          action: "retry",
          actor: "operator",
          childRunId: "child-eeeeeeee",
        }),
      ]),
      []
    );
    expect(escalated).toMatch(/operator escalated/i);
    expect(escalated).not.toMatch(/discovery/i);
  });
});
