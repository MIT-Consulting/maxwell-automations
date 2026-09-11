import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFY_EVENT_PREFS,
  updateNotifySettingsSchema,
} from "@lca/shared";
import { freeListenPort } from "./helpers/free-port.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

const FAKE_TOPIC = "b51-2-fake-topic-never-real";
const FAKE_TOKEN = "tk_b51_2_fake_token_never_real";
const FAKE_SERVER = "https://ntfy.example.invalid";

vi.mock("node-notifier", () => ({
  default: {
    notify: () => {},
  },
}));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("../packages/daemon/src/config/parse.ts");
});

function assertNoTokenInResponse(text: string): void {
  expect(text).not.toContain(FAKE_TOKEN);
}

function stubExecutor(): Executor {
  return {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("spawn should not be called");
    },
    resume: async () => {
      throw new Error("resume should not be called");
    },
  };
}

async function bootstrapNotifyHttp(
  initialYaml: string,
  run: (ctx: {
    port: number;
    configPath: string;
    notifier: import("../packages/daemon/src/notify/notifier.ts").Notifier;
    fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  }) => Promise<void>
): Promise<void> {
  const testHome = mkdtempSync(join(tmpdir(), "lca-b51-2-http-"));
  vi.resetModules();
  vi.doMock("node:os", () => ({ homedir: () => testHome }));

  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;

  const port = await freeListenPort();

  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    if (/^https?:\/\/127\.0\.0\.1:\d+\/api\//.test(url)) {
      return originalFetch(input, init);
    }
    fetchCalls.push({ url, init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const { GLOBAL_CONFIG_PATH } = await import(
    "../packages/daemon/src/paths.ts"
  );
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, initialYaml, "utf8");

  const { loadNotifySettings } = await import(
    "../packages/daemon/src/config/settings.ts"
  );
  const { buildNotifySettingsPublic } = await import(
    "../packages/daemon/src/config/notify-public.ts"
  );
  const { writeNotifySettings } = await import(
    "../packages/daemon/src/config/write.ts"
  );
  const { Notifier } = await import(
    "../packages/daemon/src/notify/notifier.ts"
  );
  const { startHttpServer } = await import(
    "../packages/daemon/src/http/server.ts"
  );

  const root = join(testHome, "runtime");
  mkdirSync(root, { recursive: true });
  const db = openDatabase(join(root, "state.sqlite"));
  const events = new DaemonEventBus();
  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    inputHub: new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    }),
    maxConcurrentRuns: 1,
    events,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor: stubExecutor(),
    events,
  });

  let currentNotify = loadNotifySettings();
  const notifier = new Notifier({
    dashboardUrl: "http://127.0.0.1:3747",
    eventPrefs: currentNotify.events,
    ntfy: currentNotify.ntfy,
    onLog: () => {},
  });

  const reloadAndApply = () => {
    currentNotify = loadNotifySettings();
    notifier.reconfigureNotify({
      eventPrefs: currentNotify.events,
      ntfy: currentNotify.ntfy,
    });
    return currentNotify;
  };

  const http = await startHttpServer({
    engine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "test",
    port,
    settings: DEFAULT_SETTINGS,
    notify: {
      getPublic: () => buildNotifySettingsPublic(currentNotify),
      patch: (body) => {
        const parsed = updateNotifySettingsSchema.parse(body);
        writeNotifySettings(GLOBAL_CONFIG_PATH, parsed);
        return buildNotifySettingsPublic(reloadAndApply());
      },
      testSend: () => notifier.testNtfy(),
    },
  });

  try {
    await run({ port, configPath: GLOBAL_CONFIG_PATH, notifier, fetchCalls });
  } finally {
    await http.close();
    db.close();
    globalThis.fetch = originalFetch;
    rmSync(testHome, { recursive: true, force: true });
  }
}

describe("b51 phase 2 — hot-reload notify API", () => {
  const envSnapshot = { LCA_NO_NTFY: process.env.LCA_NO_NTFY };

  beforeEach(() => {
    delete process.env.LCA_NO_NTFY;
  });

  afterEach(() => {
    if (envSnapshot.LCA_NO_NTFY === undefined) {
      delete process.env.LCA_NO_NTFY;
    } else {
      process.env.LCA_NO_NTFY = envSnapshot.LCA_NO_NTFY;
    }
  });

  it("GET masks token and returns materialized thirteen-event prefs", async () => {
    await bootstrapNotifyHttp(
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        `      server: ${FAKE_SERVER}`,
        `      token: ${FAKE_TOKEN}`,
        "    events:",
        "      needs_input:",
        "        toast: true",
        "        ntfy: false",
        "",
      ].join("\n"),
      async ({ port }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/settings/notify`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          events: Record<string, { toast: boolean; ntfy: boolean }>;
          ntfy: { topic: string; tokenPresent: boolean; server?: string } | null;
          defaults: Record<string, unknown>;
          usable: { ntfy: boolean };
        };
        expect(Object.keys(body.events)).toHaveLength(13);
        expect(body.events.needs_input).toEqual({ toast: true, ntfy: false });
        expect(body.ntfy).toEqual({
          topic: FAKE_TOPIC,
          server: FAKE_SERVER,
          tokenPresent: true,
        });
        expect(body.usable.ntfy).toBe(true);
        expect(body.defaults).toEqual(DEFAULT_NOTIFY_EVENT_PREFS);
        const raw = JSON.stringify(body);
        assertNoTokenInResponse(raw);
        expect(raw).toContain("tokenPresent");
        expect(raw).not.toContain(FAKE_TOKEN);
      }
    );
  });

  it("PATCH updates events, persists YAML, and reconfigures the live notifier", async () => {
    await bootstrapNotifyHttp(
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        "",
      ].join("\n"),
      async ({ port, configPath, notifier, fetchCalls }) => {
        const patchRes = await fetch(
          `http://127.0.0.1:${port}/api/settings/notify`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              events: {
                run_completed: { toast: true, ntfy: true },
              },
            }),
          }
        );
        expect(patchRes.status).toBe(200);
        const patched = (await patchRes.json()) as {
          events: { run_completed: { toast: boolean; ntfy: boolean } };
        };
        expect(patched.events.run_completed).toEqual({
          toast: true,
          ntfy: true,
        });

        const yaml = readFileSync(configPath, "utf8");
        expect(yaml).toContain("run_completed:");
        expect(yaml).toContain("ntfy: true");

        notifier.runCompleted("run-1", "done");
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(fetchCalls.length).toBeGreaterThan(0);
      }
    );
  });

  it("PATCH omitting token preserves the prior YAML token", async () => {
    await bootstrapNotifyHttp(
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        `      token: ${FAKE_TOKEN}`,
        "",
      ].join("\n"),
      async ({ port, configPath }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/settings/notify`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ntfy: { topic: "updated-topic-only" },
          }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ntfy.tokenPresent).toBe(true);
        assertNoTokenInResponse(JSON.stringify(body));

        const yaml = readFileSync(configPath, "utf8");
        expect(yaml).toContain(FAKE_TOKEN);
        expect(yaml).toContain("updated-topic-only");
      }
    );
  });

  it("PATCH token null clears the YAML token", async () => {
    await bootstrapNotifyHttp(
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        `      token: ${FAKE_TOKEN}`,
        "",
      ].join("\n"),
      async ({ port, configPath }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/settings/notify`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ntfy: { topic: FAKE_TOPIC, token: null },
          }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ntfy.tokenPresent).toBe(false);
        assertNoTokenInResponse(JSON.stringify(body));

        const yaml = readFileSync(configPath, "utf8");
        expect(yaml).not.toContain(FAKE_TOKEN);
        expect(yaml).not.toMatch(/^\s+token:/m);
      }
    );
  });

  it("PATCH ntfy null clears connection and marks ntfy unusable", async () => {
    await bootstrapNotifyHttp(
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        "",
      ].join("\n"),
      async ({ port, configPath }) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/settings/notify`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ntfy: null }),
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ntfy).toBeNull();
        expect(body.usable.ntfy).toBe(false);

        const yaml = readFileSync(configPath, "utf8");
        expect(yaml).not.toMatch(/^\s+ntfy:/m);
      }
    );
  });

  it("POST test returns 400 when ntfy is not configured", async () => {
    await bootstrapNotifyHttp("settings: {}\n", async ({ port }) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/settings/notify/test`,
        { method: "POST" }
      );
      expect(res.status).toBe(400);
      assertNoTokenInResponse(await res.text());
    });
  });

  it("POST test awaits transport and returns 200 on success", async () => {
    await bootstrapNotifyHttp(
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        `      server: ${FAKE_SERVER}`,
        "",
      ].join("\n"),
      async ({ port, fetchCalls }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/settings/notify/test`,
          { method: "POST" }
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(fetchCalls).toHaveLength(1);
        const body = JSON.parse(String(fetchCalls[0]?.init?.body)) as Record<
          string,
          string
        >;
        expect(body.title).toBe("Max");
        expect(body.message).toBe("Test notification from Max");
        expect(body.topic).toBe(FAKE_TOPIC);
        expect(JSON.stringify(body)).not.toContain(FAKE_TOKEN);
      }
    );
  });

  it("POST test returns 502 without leaking secrets when transport fails", async () => {
    await bootstrapNotifyHttp(
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        `      server: ${FAKE_SERVER}`,
        "",
      ].join("\n"),
      async ({ port }) => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (input, init) => {
          const url = String(input);
          if (/^https?:\/\/127\.0\.0\.1:\d+\/api\//.test(url)) {
            return originalFetch(input, init);
          }
          return Response.error();
        }) as typeof fetch;

        const res = await fetch(
          `http://127.0.0.1:${port}/api/settings/notify/test`,
          { method: "POST" }
        );
        expect(res.status).toBe(502);
        const body = await res.json();
        expect(body.ok).toBe(false);
        assertNoTokenInResponse(JSON.stringify(body));
      }
    );
  });

  it("strips legacy ntfy.events from YAML when connection is patched", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b51-2-write-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    const { writeNotifySettings } = await import(
      "../packages/daemon/src/config/write.ts"
    );

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      [
        "settings:",
        "  notify:",
        "    ntfy:",
        `      topic: ${FAKE_TOPIC}`,
        "      events:",
        "        - needs_input",
        "",
      ].join("\n"),
      "utf8"
    );

    try {
      writeNotifySettings(GLOBAL_CONFIG_PATH, {
        ntfy: { topic: "rewritten-topic" },
      });
      const yaml = readFileSync(GLOBAL_CONFIG_PATH, "utf8");
      expect(yaml).toContain("rewritten-topic");
      expect(yaml).not.toContain("needs_input");
      expect(yaml).not.toMatch(/^\s+events:\s*$/m);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("loadNotifySettings reloads notify slice from disk", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b51-2-load-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({ homedir: () => testHome }));

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    const { loadNotifySettings } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      [
        "settings:",
        "  notify:",
        "    events:",
        "      halt_discovery_action:",
        "        toast: true",
        "        ntfy: true",
        "",
      ].join("\n"),
      "utf8"
    );

    try {
      const resolved = loadNotifySettings();
      expect(resolved.events.halt_discovery_action).toEqual({
        toast: true,
        ntfy: true,
      });
      expect(resolved.ntfy).toBeUndefined();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});

describe("updateNotifySettingsSchema", () => {
  it("requires at least one of events or ntfy", () => {
    const result = updateNotifySettingsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects unknown event ids", () => {
    const result = updateNotifySettingsSchema.safeParse({
      events: { not_real: { toast: true, ntfy: true } },
    });
    expect(result.success).toBe(false);
  });
});
