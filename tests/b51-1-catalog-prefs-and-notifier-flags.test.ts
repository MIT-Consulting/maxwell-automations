import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_NOTIFY_EVENTS,
  DEFAULT_NOTIFY_EVENT_PREFS,
  mergeNotifyEventPrefs,
  notifySettingsSchema,
  ntfyNotifySettingsSchema,
  settingsSchema,
  type AlertNotifyEvent,
  type NotifyEventPrefsMap,
  type NtfyNotifySettings,
  type ResolvedNotifyEventPrefs,
} from "@lca/shared";

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

const { Notifier } = await import("../packages/daemon/src/notify/notifier.ts");

const FAKE_TOPIC = "b51-fake-topic-never-real";
const FAKE_TOKEN = "tk_b51_fake_token_never_real";
const FAKE_SERVER = "https://ntfy.example.invalid";

function connectionOnly(): NtfyNotifySettings {
  return {
    topic: FAKE_TOPIC,
    server: FAKE_SERVER,
    token: FAKE_TOKEN,
  };
}

function prefsWithNtfy(...enabled: AlertNotifyEvent[]): ResolvedNotifyEventPrefs {
  const partial: NotifyEventPrefsMap = {};
  for (const id of ALERT_NOTIFY_EVENTS) {
    partial[id] = {
      toast: DEFAULT_NOTIFY_EVENT_PREFS[id].toast,
      ntfy: enabled.includes(id),
    };
  }
  return mergeNotifyEventPrefs(partial);
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("../packages/daemon/src/config/parse.ts");
  notifyMock.mockReset();
});

describe("DEFAULT_NOTIFY_EVENT_PREFS and mergeNotifyEventPrefs", () => {
  it("matches the smart-defaults table for all thirteen ids", () => {
    expect(ALERT_NOTIFY_EVENTS).toHaveLength(13);
    const expected: ResolvedNotifyEventPrefs = {
      needs_input: { toast: true, ntfy: true },
      run_failed: { toast: true, ntfy: true },
      auth_expired: { toast: true, ntfy: true },
      run_completed: { toast: false, ntfy: false },
      pipeline_complete: { toast: true, ntfy: true },
      queue_batch_complete: { toast: true, ntfy: true },
      plan_approval_required: { toast: true, ntfy: true },
      ux_approval_required: { toast: true, ntfy: true },
      pipeline_halt_recovered: { toast: false, ntfy: false },
      pipeline_halt_unrecovered: { toast: true, ntfy: true },
      halt_discovery_ready: { toast: true, ntfy: true },
      halt_discovery_failed: { toast: true, ntfy: true },
      halt_discovery_action: { toast: false, ntfy: false },
    };
    expect(DEFAULT_NOTIFY_EVENT_PREFS).toEqual(expected);
    expect(mergeNotifyEventPrefs()).toEqual(expected);
    for (const id of ALERT_NOTIFY_EVENTS) {
      expect(DEFAULT_NOTIFY_EVENT_PREFS[id]).toEqual(expected[id]);
    }
  });

  it("overlays partial map and migrates legacy allowlist to ntfy true", () => {
    const merged = mergeNotifyEventPrefs(
      { run_completed: { toast: true, ntfy: false } },
      ["needs_input", "run_failed"]
    );
    expect(merged.run_completed).toEqual({ toast: true, ntfy: false });
    expect(merged.needs_input.ntfy).toBe(true);
    expect(merged.run_failed.ntfy).toBe(true);
    expect(merged.run_completed.ntfy).toBe(false);
  });
});

describe("notify Zod schemas", () => {
  it("accepts events map and connection-only ntfy", () => {
    const parsed = notifySettingsSchema.parse({
      events: {
        needs_input: { toast: true, ntfy: true },
        run_completed: { toast: false, ntfy: false },
      },
      ntfy: { topic: "phone-topic", server: "https://ntfy.sh" },
    });
    expect(parsed.events?.needs_input).toEqual({ toast: true, ntfy: true });
    expect(parsed.ntfy?.topic).toBe("phone-topic");
    expect(parsed.ntfy?.events).toBeUndefined();
  });

  it("accepts legacy ntfy.events allowlist", () => {
    const parsed = ntfyNotifySettingsSchema.parse({
      topic: "legacy-topic",
      events: ["needs_input", "run_failed"],
    });
    expect(parsed.events).toEqual(["needs_input", "run_failed"]);
  });

  it("rejects unknown event keys and unknown channel keys", () => {
    expect(
      notifySettingsSchema.safeParse({
        events: { not_a_real_event: { toast: true, ntfy: true } },
      }).success
    ).toBe(false);
    expect(
      notifySettingsSchema.safeParse({
        events: { needs_input: { toast: true, ntfy: true, sms: true } },
      }).success
    ).toBe(false);
    expect(
      settingsSchema.safeParse({
        notify: { ntfy: { topic: "t", events: ["pipeline_halt_recovered"] } },
      }).success
    ).toBe(false);
  });
});

describe("loadSettings notify resolution", () => {
  it("omitted notify yields full default events and no ntfy", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b51-omit-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      "settings:\n  maxConcurrentRuns: 2\n",
      "utf8"
    );

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.notify.events).toEqual(DEFAULT_NOTIFY_EVENT_PREFS);
      expect(resolved.notify.ntfy).toBeUndefined();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("legacy allowlist migrates ntfy flags and strips events from resolved ntfy", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b51-legacy-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        "      topic: legacy-topic",
        "      events:",
        "        - needs_input",
        "        - run_failed",
        "",
      ].join("\n"),
      "utf8"
    );

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.notify.events.needs_input.ntfy).toBe(true);
      expect(resolved.notify.events.run_failed.ntfy).toBe(true);
      expect(resolved.notify.events.auth_expired.ntfy).toBe(true);
      expect(resolved.notify.events.needs_input.toast).toBe(true);
      expect(resolved.notify.ntfy).toEqual({ topic: "legacy-topic" });
      expect(resolved.notify.ntfy).not.toHaveProperty("events");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("partial notify.events overlays defaults", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b51-partial-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      [
        "settings:",
        "  notify:",
        "    events:",
        "      run_completed:",
        "        toast: true",
        "        ntfy: true",
        "",
      ].join("\n"),
      "utf8"
    );

    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.notify.events.run_completed).toEqual({
        toast: true,
        ntfy: true,
      });
      expect(resolved.notify.events.needs_input).toEqual(
        DEFAULT_NOTIFY_EVENT_PREFS.needs_input
      );
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("Notifier event prefs gating", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("toast off skips toast; ntfy off skips publish", async () => {
    const prefs = mergeNotifyEventPrefs({
      halt_discovery_ready: { toast: false, ntfy: false },
    });
    const notifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      eventPrefs: prefs,
      ntfy: connectionOnly(),
    });

    notifier.haltDiscoveryRecommendationReady("adv-1", "src-1");
    await flushAsyncWork();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
  });

  it("publishes halt/discovery ntfy when prefs and connection allow", async () => {
    const prefs = prefsWithNtfy("halt_discovery_ready");
    const notifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      ntfyDashboardUrl: "http://100.64.1.2:3747",
      eventPrefs: prefs,
      ntfy: connectionOnly(),
    });

    notifier.haltDiscoveryRecommendationReady("adv-1", "src-1");
    await flushAsyncWork();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(1);
  });

  it("disabled skips toast but not ntfy when prefs allow", async () => {
    const prefs = prefsWithNtfy("run_failed");
    const notifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      eventPrefs: prefs,
      ntfy: connectionOnly(),
      disabled: true,
    });

    notifier.runFailed("run-x", "boom");
    await flushAsyncWork();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(1);
  });
});
