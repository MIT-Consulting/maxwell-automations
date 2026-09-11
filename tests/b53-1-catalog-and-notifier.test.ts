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

const FAKE_TOPIC = "b53-fake-topic-never-real";
const FAKE_TOKEN = "tk_b53_fake_token_never_real";
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

function parseBody(init: RequestInit | undefined): Record<string, string> {
  return JSON.parse(String(init?.body)) as Record<string, string>;
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("b53 phase 1 — catalog and approval notifier methods", () => {
  describe("shared catalog", () => {
    it("includes b48/b52 ids plus plan and UX approval events in order", () => {
      expect(NTFY_NOTIFY_EVENTS).toContain("needs_input");
      expect(NTFY_NOTIFY_EVENTS).toContain("run_failed");
      expect(NTFY_NOTIFY_EVENTS).toContain("auth_expired");
      expect(NTFY_NOTIFY_EVENTS).toContain("run_completed");
      expect(NTFY_NOTIFY_EVENTS).toContain("pipeline_complete");
      expect(NTFY_NOTIFY_EVENTS).toContain("plan_approval_required");
      expect(NTFY_NOTIFY_EVENTS).toContain("ux_approval_required");
      expect(NTFY_NOTIFY_EVENTS.indexOf("pipeline_complete")).toBe(4);
      expect(NTFY_NOTIFY_EVENTS.indexOf("plan_approval_required")).toBe(6);
      expect(NTFY_NOTIFY_EVENTS.indexOf("ux_approval_required")).toBe(7);
    });

    it("accepts settings whose events include both approval ids", () => {
      const parsed = ntfyNotifySettingsSchema.parse({
        topic: "phone-topic",
        events: ["plan_approval_required", "ux_approval_required"],
      });
      expect(parsed.events).toEqual([
        "plan_approval_required",
        "ux_approval_required",
      ]);
    });
  });

  describe.each([
    {
      method: "planApprovalRequired" as const,
      event: "plan_approval_required" as const,
      title: "Max plan approval required",
    },
    {
      method: "uxApprovalRequired" as const,
      event: "ux_approval_required" as const,
      title: "Max UX approval required",
    },
  ])("$method", ({ method, event, title }) => {
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

    it("fires toast and allowlisted ntfy with matching copy", async () => {
      const runId = "approval-run-1";
      const question = "Review the implementation plan before continuing.";
      const ntfyBase = "http://100.64.1.2:3747";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        ntfyDashboardUrl: ntfyBase,
        eventPrefs: eventPrefsForNtfy(event),
        ntfy: connectionOnly(),
      });

      notifier[method](runId, question);
      await flushAsyncWork();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
        title,
        message: question,
        open: buildRunDeepLink("http://127.0.0.1:3747", runId),
      });

      expect(fetchCalls).toHaveLength(1);
      expect(parseBody(fetchCalls[0]?.init)).toEqual({
        topic: FAKE_TOPIC,
        title,
        message: question,
        click: `${ntfyBase}/?run=${encodeURIComponent(runId)}`,
      });
    });

    it("still toasts when event is not allowlisted", async () => {
      const runId = "approval-no-ntfy";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy("needs_input"),
        ntfy: connectionOnly(),
      });

      notifier[method](runId, "Approve?");
      await flushAsyncWork();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toHaveLength(0);
    });

    it("still publishes ntfy when toast is disabled", async () => {
      const runId = "approval-disabled-toast";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy(event),
        ntfy: connectionOnly(),
        disabled: true,
      });

      notifier[method](runId, "Sign off on the design.");
      await flushAsyncWork();

      expect(notifyMock).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(1);
      expect(parseBody(fetchCalls[0]?.init).title).toBe(title);
    });

    it("truncates long question bodies at 220 characters", async () => {
      const runId = "approval-truncate";
      const longQuestion = "x".repeat(221);
      const expectedMessage = `${"x".repeat(219)}…`;
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        eventPrefs: eventPrefsForNtfy(event),
        ntfy: connectionOnly(),
      });

      notifier[method](runId, longQuestion);
      await flushAsyncWork();

      expect(notifyMock.mock.calls[0]?.[0].message).toBe(expectedMessage);
      expect(parseBody(fetchCalls[0]?.init).message).toBe(expectedMessage);
    });
  });
});
