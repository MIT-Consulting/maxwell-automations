import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_NOTIFY_EVENTS,
  DEFAULT_NOTIFY_EVENT_PREFS,
  mergeNotifyEventPrefs,
  type AlertNotifyEvent,
  type NtfyNotifySettings,
  type NotifyEventPrefsMap,
  type ResolvedNotifyEventPrefs,
} from "@lca/shared";

const FAKE_TOPIC = "b48-fake-topic-never-real";
const FAKE_TOKEN = "tk_b48_fake_token_never_real";
const FAKE_SERVER = "https://ntfy.example.invalid";
const CONTROL_TOKEN = "ctl_b48_fake_control_token_never_real";

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

const {
  Notifier,
  buildNtfyDashboardUrl,
  buildRunDeepLink,
} = await import("../packages/daemon/src/notify/notifier.ts");

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

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(FAKE_TOPIC);
  expect(text).not.toContain(FAKE_TOKEN);
  expect(text).not.toContain(CONTROL_TOKEN);
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("b48 phase 3 — Notifier ntfy integration", () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot = {
    LCA_NO_NTFY: process.env.LCA_NO_NTFY,
    LCA_NO_TOAST: process.env.LCA_NO_TOAST,
  };
  let fetchCalls: FetchCall[] = [];

  beforeEach(() => {
    delete process.env.LCA_NO_NTFY;
    delete process.env.LCA_NO_TOAST;
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
    if (envSnapshot.LCA_NO_NTFY === undefined) {
      delete process.env.LCA_NO_NTFY;
    } else {
      process.env.LCA_NO_NTFY = envSnapshot.LCA_NO_NTFY;
    }
    if (envSnapshot.LCA_NO_TOAST === undefined) {
      delete process.env.LCA_NO_TOAST;
    } else {
      process.env.LCA_NO_TOAST = envSnapshot.LCA_NO_TOAST;
    }
  });

  it.each([
    {
      event: "needs_input" as const,
      call: (n: InstanceType<typeof Notifier>) =>
        n.needsInput("run-needs", "Please answer the question"),
      title: "Max needs your input",
      message: "Please answer the question",
      runId: "run-needs",
    },
    {
      event: "run_failed" as const,
      call: (n: InstanceType<typeof Notifier>) =>
        n.runFailed("run-fail", "spawn timed out"),
      title: "Max run failed",
      message: "Reason: spawn timed out",
      runId: "run-fail",
    },
    {
      event: "auth_expired" as const,
      call: (n: InstanceType<typeof Notifier>) =>
        n.authExpired("run-auth", "session expired"),
      title: "Cursor auth expired",
      message:
        "session expired — refresh CURSOR_API_KEY in ~/.cursor-local-automations/.env or run cursor-agent login",
      runId: "run-auth",
    },
  ])(
    "publishes prefs-enabled $event once with matching toast copy and encoded click",
    async ({ event, call, title, message, runId }) => {
      const logs: string[] = [];
      const ntfyBase = "http://100.64.1.2:3747";
      const notifier = new Notifier({
        dashboardUrl: "http://127.0.0.1:3747",
        ntfyDashboardUrl: ntfyBase,
        eventPrefs: eventPrefsForNtfy(event),
        ntfy: connectionOnly(),
        onLog: (m) => logs.push(m),
      });

      call(notifier);
      await flushAsyncWork();

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0]?.[0]).toMatchObject({
        title,
        message,
        open: buildRunDeepLink("http://127.0.0.1:3747", runId),
      });

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe(FAKE_SERVER);
      expect(parseBody(fetchCalls[0]?.init)).toEqual({
        topic: FAKE_TOPIC,
        title,
        message,
        click: `${ntfyBase}/?run=${encodeURIComponent(runId)}`,
      });
      for (const log of logs) {
        assertNoSecrets(log);
      }
      const click = parseBody(fetchCalls[0]?.init).click ?? "";
      assertNoSecrets(click);
      expect(click).not.toContain("token=");
      expect(click).not.toContain("topic=");
    }
  );

  it("ntfy-off prefs skip publish while toast still fires", async () => {
    const notifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      eventPrefs: mergeNotifyEventPrefs({
        needs_input: { toast: true, ntfy: true },
        run_failed: { toast: true, ntfy: false },
        auth_expired: { toast: true, ntfy: false },
      }),
      ntfy: connectionOnly(),
    });

    notifier.runFailed("run-x", "boom");
    notifier.authExpired("run-y", "gone");
    await flushAsyncWork();

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(fetchCalls).toHaveLength(0);

    notifier.needsInput("run-z", "ok?");
    await flushAsyncWork();

    expect(notifyMock).toHaveBeenCalledTimes(3);
    expect(fetchCalls).toHaveLength(1);
    expect(parseBody(fetchCalls[0]?.init).title).toBe("Max needs your input");
  });

  it("disabled toast still publishes ntfy when prefs allow", async () => {
    const notifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      ntfyDashboardUrl: "http://100.64.1.2:3747",
      eventPrefs: eventPrefsForNtfy("run_failed"),
      ntfy: connectionOnly(),
      disabled: true,
    });

    notifier.runFailed("run-disabled-toast", "oops");
    await flushAsyncWork();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
    expect(parseBody(fetchCalls[0]?.init)).toMatchObject({
      title: "Max run failed",
      message: "Reason: oops",
      click: "http://100.64.1.2:3747/?run=run-disabled-toast",
    });
  });

  it("halt-recovery and halt-discovery publish ntfy only when prefs enable them", async () => {
    const offNotifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      eventPrefs: mergeNotifyEventPrefs({
        pipeline_halt_recovered: { toast: true, ntfy: false },
        pipeline_halt_unrecovered: { toast: true, ntfy: false },
        halt_discovery_ready: { toast: true, ntfy: false },
        halt_discovery_failed: { toast: true, ntfy: false },
        halt_discovery_action: { toast: true, ntfy: false },
      }),
      ntfy: connectionOnly(),
    });

    offNotifier.pipelineHaltRecovered("halt-src", "retry", "child-1");
    offNotifier.pipelineHaltUnrecovered("halt-src", "CODE", "detail");
    offNotifier.haltDiscoveryRecommendationReady("adv-1", "halt-src");
    offNotifier.haltDiscoveryFailed("halt-src", "spawn", "ERR", "nope");
    offNotifier.haltDiscoveryActionResult({
      advisoryRunId: "adv-1",
      sourceRunId: "halt-src",
      action: "retry",
      outcome: "acted",
    });
    await flushAsyncWork();

    expect(notifyMock).toHaveBeenCalledTimes(5);
    expect(fetchCalls).toHaveLength(0);

    const onNotifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      eventPrefs: eventPrefsForNtfy(
        "pipeline_halt_unrecovered",
        "halt_discovery_ready"
      ),
      ntfy: connectionOnly(),
    });

    onNotifier.pipelineHaltUnrecovered("halt-src", "CODE", "detail");
    onNotifier.haltDiscoveryRecommendationReady("adv-2", "halt-src");
    await flushAsyncWork();

    expect(fetchCalls).toHaveLength(2);
  });

  describe("buildNtfyDashboardUrl", () => {
    it("uses a specific Tailscale-style IPv4 host", () => {
      expect(buildNtfyDashboardUrl("100.64.1.2", 3747)).toBe(
        "http://100.64.1.2:3747"
      );
    });

    it("brackets IPv6 authorities", () => {
      expect(buildNtfyDashboardUrl("2001:db8::1", 3747)).toBe(
        "http://[2001:db8::1]:3747"
      );
    });

    it("falls back to loopback for loopback and wildcard binds", () => {
      expect(buildNtfyDashboardUrl("127.0.0.1", 3747)).toBe(
        "http://127.0.0.1:3747"
      );
      expect(buildNtfyDashboardUrl("::1", 3747)).toBe("http://127.0.0.1:3747");
      expect(buildNtfyDashboardUrl("0.0.0.0", 3747)).toBe(
        "http://127.0.0.1:3747"
      );
      expect(buildNtfyDashboardUrl("::", 3747)).toBe("http://127.0.0.1:3747");
      expect(buildNtfyDashboardUrl("localhost", 3747)).toBe(
        "http://127.0.0.1:3747"
      );
    });

    it("never embeds secrets in derived click URLs", () => {
      const base = buildNtfyDashboardUrl("100.64.1.2", 3747);
      const click = buildRunDeepLink(base, "run-secret-check");
      expect(click).toBe("http://100.64.1.2:3747/?run=run-secret-check");
      assertNoSecrets(click);
      expect(click).not.toContain("token=");
      expect(click).not.toContain("topic=");
    });
  });
});
