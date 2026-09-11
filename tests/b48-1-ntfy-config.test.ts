import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFY_EVENT_PREFS,
  NTFY_NOTIFY_EVENTS,
  ntfyNotifySettingsSchema,
  settingsSchema,
} from "@lca/shared";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("../packages/daemon/src/config/parse.ts");
});

describe("ntfyNotifySettingsSchema", () => {
  it("accepts topic, HTTP(S) server, token, and optional legacy events", () => {
    const parsed = ntfyNotifySettingsSchema.parse({
      topic: "  my-private-topic  ",
      server: "https://ntfy.sh",
      token: "  tk_example  ",
      events: ["needs_input", "run_failed", "auth_expired"],
    });
    expect(parsed).toEqual({
      topic: "my-private-topic",
      server: "https://ntfy.sh",
      token: "tk_example",
      events: ["needs_input", "run_failed", "auth_expired"],
    });
    expect([...NTFY_NOTIFY_EVENTS]).toEqual([
      "needs_input",
      "run_failed",
      "auth_expired",
      "run_completed",
      "pipeline_complete",
      "queue_batch_complete",
      "plan_approval_required",
      "ux_approval_required",
    ]);
  });

  it("accepts connection-only ntfy without events", () => {
    const parsed = ntfyNotifySettingsSchema.parse({
      topic: "topic-only",
      server: "https://ntfy.sh",
    });
    expect(parsed).toEqual({
      topic: "topic-only",
      server: "https://ntfy.sh",
    });
    expect(parsed.events).toBeUndefined();
  });

  it("rejects empty topic, unsupported event, unknown key, and non-HTTP(S) server", () => {
    const cases: Array<{ label: string; value: unknown }> = [
      { label: "empty topic", value: { topic: "  " } },
      {
        label: "unsupported event",
        value: { topic: "topic", events: ["not_a_real_event"] },
      },
      {
        label: "unknown nested key",
        value: {
          topic: "topic",
          events: ["needs_input"],
          toppic: "typo",
        },
      },
      {
        label: "non-HTTP(S) server",
        value: {
          topic: "topic",
          server: "ftp://ntfy.example",
          events: ["needs_input"],
        },
      },
    ];

    for (const { label, value } of cases) {
      const result = ntfyNotifySettingsSchema.safeParse(value);
      expect(result.success, label).toBe(false);
    }
  });
});

describe("settingsSchema + notify", () => {
  it("accepts nested notify.events map and connection-only ntfy", () => {
    const parsed = settingsSchema.parse({
      maxConcurrentRuns: 4,
      controlToken: "secret-token",
      notify: {
        events: {
          needs_input: { toast: true, ntfy: true },
          run_completed: { toast: false, ntfy: false },
        },
        ntfy: {
          topic: "phone-topic",
          server: "http://127.0.0.1:2586",
          token: "tk_secret",
        },
      },
    });
    expect(parsed.maxConcurrentRuns).toBe(4);
    expect(parsed.controlToken).toBe("secret-token");
    expect(parsed.notify?.events?.needs_input).toEqual({
      toast: true,
      ntfy: true,
    });
    expect(parsed.notify?.ntfy).toEqual({
      topic: "phone-topic",
      server: "http://127.0.0.1:2586",
      token: "tk_secret",
    });
  });

  it("accepts legacy ntfy.events allowlist beside connection fields", () => {
    const parsed = settingsSchema.parse({
      notify: {
        ntfy: {
          topic: "phone-topic",
          events: ["needs_input", "run_failed", "auth_expired"],
        },
      },
    });
    expect(parsed.notify?.ntfy?.events).toEqual([
      "needs_input",
      "run_failed",
      "auth_expired",
    ]);
  });

  it("treats omitted notify as disabled configuration", () => {
    const parsed = settingsSchema.parse({ maxConcurrentRuns: 2 });
    expect(parsed.notify).toBeUndefined();
    expect(parsed.maxConcurrentRuns).toBe(2);
  });

  it("treats notify without ntfy as prefs-only configuration", () => {
    const parsed = settingsSchema.parse({
      notify: { events: { needs_input: { toast: true, ntfy: false } } },
    });
    expect(parsed.notify?.events?.needs_input).toEqual({
      toast: true,
      ntfy: false,
    });
    expect(parsed.notify?.ntfy).toBeUndefined();
  });

  it("rejects unknown keys under settings.notify", () => {
    const result = settingsSchema.safeParse({
      notify: {
        ntfy: {
          topic: "phone-topic",
          events: ["needs_input"],
        },
        sms: {},
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("loadSettings notify resolution", () => {
  it("round-trips validated ntfy settings without logging topic/token", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b48-1-ntfy-"));
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
        "  maxConcurrentRuns: 3",
        "  notify:",
        "    ntfy:",
        "      topic: soak-private-topic",
        "      server: https://ntfy.sh",
        "      token: tk_soak_token",
        "      events:",
        "        - needs_input",
        "        - run_failed",
        "        - auth_expired",
        "",
      ].join("\n"),
      "utf8"
    );

    const logs: string[] = [];
    const { loadSettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings({
        onLog: (message) => logs.push(message),
      });
      expect(resolved.maxConcurrentRuns).toBe(3);
      expect(resolved.notify.ntfy).toEqual({
        topic: "soak-private-topic",
        server: "https://ntfy.sh",
        token: "tk_soak_token",
      });
      expect(resolved.notify.events.needs_input.ntfy).toBe(true);
      expect(resolved.notify.events.run_failed.ntfy).toBe(true);
      expect(resolved.notify.events.auth_expired.ntfy).toBe(true);
      expect(resolved.notify.ntfy).not.toHaveProperty("events");
      expect(logs.join("\n")).not.toMatch(/soak-private-topic|tk_soak_token/);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("resolves omitted notify to materialized default events without ntfy", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b48-1-omit-"));
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

    const { loadSettings, DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    try {
      const resolved = loadSettings();
      expect(resolved.notify.events).toEqual(DEFAULT_NOTIFY_EVENT_PREFS);
      expect(resolved.notify.ntfy).toBeUndefined();
      expect(DEFAULT_SETTINGS.notify.events).toEqual(DEFAULT_NOTIFY_EVENT_PREFS);
      expect(resolved.maxConcurrentRuns).toBe(2);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
