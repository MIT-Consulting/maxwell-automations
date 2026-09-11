import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NtfyNotifySettings } from "@lca/shared";
import { NtfyTransport } from "../packages/daemon/src/notify/ntfy-transport.ts";

const FAKE_TOPIC = "b48-fake-topic-never-real";
const FAKE_TOKEN = "tk_b48_fake_token_never_real";
const FAKE_SERVER = "https://ntfy.example.invalid";

const baseSettings = (): NtfyNotifySettings => ({
  topic: FAKE_TOPIC,
  events: ["needs_input"],
});

function assertLogsSecretSafe(logs: string[]): void {
  const joined = logs.join("\n");
  expect(joined).not.toContain(FAKE_TOPIC);
  expect(joined).not.toContain(FAKE_TOKEN);
  expect(joined).not.toContain(FAKE_SERVER);
  expect(joined).not.toContain("Authorization");
  expect(joined).not.toContain("Bearer ");
  expect(joined).not.toMatch(/"topic"\s*:/);
}

async function flushAsyncWork(): Promise<void> {
  // setImmediate lands in the check phase, so the microtask queue (fetch settle
  // plus follow-on handlers) has drained and Node has already reported any
  // unhandled rejection by the time this resolves.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("NtfyTransport", () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot = {
    LCA_NO_NTFY: process.env.LCA_NO_NTFY,
    LCA_NO_TOAST: process.env.LCA_NO_TOAST,
  };
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    delete process.env.LCA_NO_NTFY;
    delete process.env.LCA_NO_TOAST;
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    globalThis.fetch = originalFetch;
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

  it("POSTs JSON to the default ntfy.sh base with topic/title/message/click", async () => {
    const calls: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new NtfyTransport({ settings: baseSettings() });
    expect(() =>
      transport.publish({
        title: "Max needs your input",
        message: "Please answer",
        click: "http://127.0.0.1:3747/?run=abc",
      })
    ).not.toThrow();

    await flushAsyncWork();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://ntfy.sh");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      topic: FAKE_TOPIC,
      title: "Max needs your input",
      message: "Please answer",
      click: "http://127.0.0.1:3747/?run=abc",
    });
  });

  it("normalizes trailing slashes on an explicit self-hosted server", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input) => {
      calls.push(String(input));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new NtfyTransport({
      settings: {
        ...baseSettings(),
        server: `${FAKE_SERVER}/`,
      },
    });
    transport.publish({ title: "t", message: "m" });
    await flushAsyncWork();

    expect(calls).toEqual([FAKE_SERVER]);
  });

  it("omits click from the body when not supplied and sends Bearer when token set", async () => {
    let bodyText = "";
    let auth: string | null = null;
    globalThis.fetch = vi.fn(async (_input, init) => {
      bodyText = String(init?.body);
      auth = new Headers(init?.headers).get("Authorization");
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const transport = new NtfyTransport({
      settings: {
        ...baseSettings(),
        token: FAKE_TOKEN,
      },
    });
    transport.publish({ title: "Auth", message: "expired" });
    await flushAsyncWork();

    expect(auth).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(JSON.parse(bodyText)).toEqual({
      topic: FAKE_TOPIC,
      title: "Auth",
      message: "expired",
    });
    expect(bodyText).not.toContain("click");
  });

  it("no-ops with zero fetch when settings are absent or LCA_NO_NTFY=1", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    expect(() =>
      new NtfyTransport({}).publish({ title: "t", message: "m" })
    ).not.toThrow();

    process.env.LCA_NO_NTFY = "1";
    expect(() =>
      new NtfyTransport({ settings: baseSettings() }).publish({
        title: "t",
        message: "m",
      })
    ).not.toThrow();

    await flushAsyncWork();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still publishes when only LCA_NO_TOAST=1 is set", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    process.env.LCA_NO_TOAST = "1";

    new NtfyTransport({ settings: baseSettings() }).publish({
      title: "t",
      message: "m",
    });
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isolates sync throw, rejected fetch, and non-2xx without unhandled rejections", async () => {
    const logs: string[] = [];
    const onLog = (m: string) => logs.push(m);
    const settings = {
      ...baseSettings(),
      server: FAKE_SERVER,
      token: FAKE_TOKEN,
    };
    const publish = (): void => {
      new NtfyTransport({ settings, onLog }).publish({
        title: "t",
        message: "m",
      });
    };
    // Logs accumulate across stages: every stage's diagnostics stay under the
    // secret-safety assertion, since the thrown and rejected error text below
    // deliberately embeds the fake server, topic, and bearer token.
    const expectDiagnostic = (from: number, pattern: RegExp): void => {
      expect(logs.slice(from).some((l) => pattern.test(l))).toBe(true);
      assertLogsSecretSafe(logs);
    };

    globalThis.fetch = vi.fn(() => {
      throw new Error(`boom contacting ${FAKE_SERVER} topic=${FAKE_TOPIC}`);
    }) as typeof fetch;
    expect(publish).not.toThrow();
    await flushAsyncWork();
    expectDiagnostic(0, /ntfy publish failed/i);

    const afterSyncThrow = logs.length;
    globalThis.fetch = vi.fn(async () => {
      throw new Error(
        `rejected ${FAKE_SERVER} Authorization: Bearer ${FAKE_TOKEN}`
      );
    }) as typeof fetch;
    expect(publish).not.toThrow();
    await flushAsyncWork();
    expectDiagnostic(afterSyncThrow, /ntfy publish failed/i);

    const afterRejection = logs.length;
    globalThis.fetch = vi.fn(async () => {
      return new Response("nope", { status: 503 });
    }) as typeof fetch;
    expect(publish).not.toThrow();
    await flushAsyncWork();
    expectDiagnostic(afterRejection, /HTTP 503/);

    expect(unhandled).toEqual([]);
  });
});
