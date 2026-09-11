import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_NOTIFY_EVENTS,
  DEFAULT_NOTIFY_EVENT_PREFS,
  mergeNotifyEventPrefs,
  NTFY_NOTIFY_EVENTS,
  ntfyNotifySettingsSchema,
  type AlertNotifyEvent,
  type NotifyEventPrefsMap,
  type NtfyNotifySettings,
  type ResolvedNotifyEventPrefs,
} from "@lca/shared";

const FAKE_TOPIC = "b52-fake-topic-never-real";
const FAKE_TOKEN = "tk_b52_fake_token_never_real";
const FAKE_SERVER = "https://ntfy.example.invalid";

const { notifyMock } = vi.hoisted(() => ({
  notifyMock: vi.fn(),
}));

vi.mock("node-notifier", () => ({
  default: {
    notify: (
      opts: { title?: string; message?: string; open?: string },
      cb?: (err: Error | null, response: string) => void
    ) => {
      notifyMock(opts, cb);
    },
  },
}));

const { Notifier, buildRunDeepLink } = await import(
  "../packages/daemon/src/notify/notifier.ts"
);

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function connectionOnly(): NtfyNotifySettings {
  return {
    topic: FAKE_TOPIC,
    server: FAKE_SERVER,
    token: FAKE_TOKEN,
  };
}

function eventPrefsForNtfy(
  ...enabled: AlertNotifyEvent[]
): ResolvedNotifyEventPrefs {
  const partial: NotifyEventPrefsMap = {};
  for (const id of ALERT_NOTIFY_EVENTS) {
    partial[id] = {
      toast: DEFAULT_NOTIFY_EVENT_PREFS[id].toast,
      ntfy: enabled.includes(id),
    };
  }
  return mergeNotifyEventPrefs(partial);
}

function eventPrefsForToastAndNtfy(
  ...enabled: AlertNotifyEvent[]
): ResolvedNotifyEventPrefs {
  const partial: NotifyEventPrefsMap = {};
  for (const id of ALERT_NOTIFY_EVENTS) {
    partial[id] = {
      toast: enabled.includes(id),
      ntfy: enabled.includes(id),
    };
  }
  return mergeNotifyEventPrefs(partial);
}

function parseBody(init: RequestInit | undefined): Record<string, string> {
  return JSON.parse(String(init?.body)) as Record<string, string>;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("b52 phase 1 — catalog and notifier methods", () => {
  describe("shared catalog", () => {
    it("includes b48 ids plus run_completed and pipeline_complete", () => {
      expect(NTFY_NOTIFY_EVENTS).toContain("needs_input");
      expect(NTFY_NOTIFY_EVENTS).toContain("run_failed");
      expect(NTFY_NOTIFY_EVENTS).toContain("auth_expired");
      expect(NTFY_NOTIFY_EVENTS).toContain("run_completed");
      expect(NTFY_NOTIFY_EVENTS).toContain("pipeline_complete");
      expect(NTFY_NOTIFY_EVENTS.indexOf("run_completed")).toBe(3);
      expect(NTFY_NOTIFY_EVENTS.indexOf("pipeline_complete")).toBe(4);
    });

    it("accepts settings whose events include both new ids", () => {
      const parsed = ntfyNotifySettingsSchema.parse({
        topic: "phone-topic",
        events: ["run_completed", "pipeline_complete"],
      });
      expect(parsed.events).toEqual(["run_completed", "pipeline_complete"]);
    });
  });

  describe("runCompleted", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls: FetchCall[] = [];

    beforeEach(() => {
      notifyMock.mockReset();
      fetchCalls = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      notifyMock.mockReset();
    });

    it("publishes allowlisted ntfy without toast (unlabeled)", async () => {
      const runId = "abcdef1234567890";
      const ntfyBase = "http://100.64.1.2:3747";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        ntfyDashboardUrl: ntfyBase,
        eventPrefs: eventPrefsForNtfy("run_completed"),
        ntfy: connectionOnly(),
      });

      notifier.runCompleted(runId);
      await flushAsyncWork();

      expect(notifyMock).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(1);
      expect(parseBody(fetchCalls[0]?.init)).toEqual({
        topic: FAKE_TOPIC,
        title: "Max run completed",
        message: "Run abcdef12 completed",
        click: `${ntfyBase}/?run=${encodeURIComponent(runId)}`,
      });
    });

    it("uses labeled message when label is non-empty", async () => {
      const runId = "run-labeled-1";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        ntfy: connectionOnly(),
        eventPrefs: eventPrefsForNtfy("run_completed"),
      });

      notifier.runCompleted(runId, "  nightly sync  ");
      await flushAsyncWork();

      expect(notifyMock).not.toHaveBeenCalled();
      expect(parseBody(fetchCalls[0]?.init).message).toBe(
        "nightly sync completed (run-labe)"
      );
    });

    it("treats blank label as absent", async () => {
      const runId = "run-blank-label";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        ntfy: connectionOnly(),
        eventPrefs: eventPrefsForNtfy("run_completed"),
      });

      notifier.runCompleted(runId, "   ");
      await flushAsyncWork();

      expect(parseBody(fetchCalls[0]?.init).message).toBe(
        "Run run-blan completed"
      );
    });

    it("skips ntfy when event is not allowlisted", async () => {
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy("needs_input"),
        ntfy: connectionOnly(),
      });

      notifier.runCompleted("run-quiet");
      await flushAsyncWork();

      expect(notifyMock).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
    });

    it("still publishes ntfy when toast is disabled", async () => {
      const runId = "run-disabled-toast";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        ntfy: connectionOnly(),
        eventPrefs: eventPrefsForNtfy("run_completed"),
        disabled: true,
      });

      notifier.runCompleted(runId);
      await flushAsyncWork();

      expect(notifyMock).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(1);
      expect(parseBody(fetchCalls[0]?.init).title).toBe("Max run completed");
    });
  });

  describe("phaseCompleted", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls: FetchCall[] = [];

    beforeEach(() => {
      notifyMock.mockReset();
      fetchCalls = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      notifyMock.mockReset();
    });

    it("renders backlog id, phase type, timer, and description", async () => {
      const runId = "phase-run-1";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForToastAndNtfy("run_completed"),
        ntfy: connectionOnly(),
      });

      notifier.phaseCompleted(runId, {
        featureId: "b60",
        workerKey: "plan-phase",
        description: "Added recipe grouping config schema and loader",
        elapsedMs: 4 * 60_000 + 12_000,
      });
      await flushAsyncWork();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
        title: "Max phase completed — Plan Phase",
        message:
          "b60 · 4m 12s\nAdded recipe grouping config schema and loader",
      });
      expect(parseBody(fetchCalls[0]?.init).message).toBe(
        "b60 · 4m 12s\nAdded recipe grouping config schema and loader"
      );
    });

    it("omits the timer segment when elapsedMs is unavailable", async () => {
      const runId = "phase-run-2";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForToastAndNtfy("run_completed"),
        ntfy: connectionOnly(),
      });

      notifier.phaseCompleted(runId, {
        featureId: "b60",
        workerKey: "final-gate",
        description: "Final gate closed the feature",
        elapsedMs: null,
      });
      await flushAsyncWork();

      expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
        title: "Max phase completed — Final Gate",
        message: "b60\nFinal gate closed the feature",
      });
    });

    it("respects the run_completed toast/ntfy prefs", async () => {
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy("needs_input"),
        ntfy: connectionOnly(),
      });

      notifier.phaseCompleted("phase-quiet", {
        featureId: "b60",
        workerKey: "review",
        description: "Reviewed the implementation",
        elapsedMs: 5000,
      });
      await flushAsyncWork();

      expect(notifyMock).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe("pipelineComplete", () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls: FetchCall[] = [];

    beforeEach(() => {
      notifyMock.mockReset();
      fetchCalls = [];
      globalThis.fetch = vi.fn(async (input, init) => {
        fetchCalls.push({ url: String(input), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      notifyMock.mockReset();
    });

    it("fires toast and allowlisted ntfy with matching copy (unlabeled)", async () => {
      const runId = "pipeline-run-1";
      const ntfyBase = "http://100.64.1.2:3747";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        ntfyDashboardUrl: ntfyBase,
        eventPrefs: eventPrefsForNtfy("pipeline_complete"),
        ntfy: connectionOnly(),
      });

      notifier.pipelineComplete(runId);
      await flushAsyncWork();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
        title: "Max pipeline complete",
        message: "Pipeline finished (pipeline)",
        open: buildRunDeepLink("http://127.0.0.1:3747", runId),
      });

      expect(fetchCalls).toHaveLength(1);
      expect(parseBody(fetchCalls[0]?.init)).toEqual({
        topic: FAKE_TOPIC,
        title: "Max pipeline complete",
        message: "Pipeline finished (pipeline)",
        click: `${ntfyBase}/?run=${encodeURIComponent(runId)}`,
      });
    });

    it("uses labeled message when label is non-empty", async () => {
      const runId = "pipeline-labeled";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy("pipeline_complete"),
        ntfy: connectionOnly(),
      });

      notifier.pipelineComplete(runId, "implement-fully");
      await flushAsyncWork();

      const expected = "implement-fully finished (pipeline)";
      expect(notifyMock.mock.calls[0]?.[0].message).toBe(expected);
      expect(parseBody(fetchCalls[0]?.init).message).toBe(expected);
    });

    it("treats blank label as absent", async () => {
      const runId = "pipeline-blank";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy("pipeline_complete"),
        ntfy: connectionOnly(),
      });

      notifier.pipelineComplete(runId, "  \t  ");
      await flushAsyncWork();

      const expected = "Pipeline finished (pipeline)";
      expect(notifyMock.mock.calls[0]?.[0].message).toBe(expected);
      expect(parseBody(fetchCalls[0]?.init).message).toBe(expected);
    });

    it("still toasts when pipeline_complete is not allowlisted", async () => {
      const runId = "pipeline-no-ntfy";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy("needs_input"),
        ntfy: connectionOnly(),
      });

      notifier.pipelineComplete(runId);
      await flushAsyncWork();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toHaveLength(0);
    });
  });
});
