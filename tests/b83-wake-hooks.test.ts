import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { buildWakeHooksPublic } from "../packages/daemon/src/config/wake-hooks-public.ts";
import { resolveWakeHooks } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { formatWakeHookLines } from "../packages/cli/src/doctor.ts";
import { settingsSchema } from "../packages/shared/src/schemas/config.ts";
import { Notifier } from "../packages/daemon/src/notify/notifier.ts";
import { ChatMessageError } from "../packages/daemon/src/chats/engine.ts";
import {
  WakeHookDispatcher,
  createWakeHookDispatcher,
} from "../packages/daemon/src/notify/wake-hooks.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { freeListenPort } from "./helpers/free-port.ts";

const FAKE_TOKEN = "wh_b83_fake_token_never_real";
const FAKE_TOKEN_ENV = "B83_WAKE_HOOK_TOKEN";

vi.mock("node-notifier", () => ({
  default: { notify: () => {} },
}));

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:os");
  vi.doUnmock("../packages/daemon/src/config/parse.ts");
});

async function flushAsyncWork(delayMs = 50): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function flushWakeDelivery(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type StubRequest = {
  method?: string;
  headers: Record<string, string | undefined>;
  body: string;
};

async function startStubServer(
  handler: (req: StubRequest, attempt: number) => { status: number; body?: string }
): Promise<{ url: string; port: number; requests: StubRequest[]; close: () => Promise<void> }> {
  const requests: StubRequest[] = [];
  let attempt = 0;
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const headers: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          headers[key.toLowerCase()] =
            value == null ? undefined : Array.isArray(value) ? value[0] : value;
        }
        const captured: StubRequest = {
          method: req.method,
          headers,
          body,
        };
        requests.push(captured);
        const result = handler(captured, attempt++);
        res.statusCode = result.status;
        if (result.body != null) {
          res.end(result.body);
        } else {
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr != null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        port,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function chainContextJson(featureId: string): string {
  return JSON.stringify({
    variables: {
      pipelineId: "implement-fully",
      featureId,
    },
    roleModels: {},
  });
}

function insertRun(
  db: ReturnType<typeof openDatabase>,
  args: {
    id: string;
    workspaceId: string;
    featureId: string;
    status?: string;
    chainStopReason?: string | null;
  }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO runs (
       id, automation_id, workspace_id, status, trigger_kind, prompt,
       chain_root_run_id, chain_depth, chain_max_depth, chain_context_json,
       chain_stop_reason, created_at, updated_at, started_at
     ) VALUES (?, 'auto-1', ?, ?, 'manual', 'prompt', ?, 0, 9, ?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.workspaceId,
    args.status ?? "running",
    args.id,
    chainContextJson(args.featureId),
    args.chainStopReason ?? null,
    now,
    now,
    now
  );
}

function seedWorkspace(db: ReturnType<typeof openDatabase>, path: string): string {
  mkdirSync(path, { recursive: true });
  const id = "ws-b83";
  db.prepare(`INSERT INTO workspaces (id, path, name) VALUES (?, ?, 'b83')`).run(
    id,
    path
  );
  db.prepare(
    `INSERT INTO automations (
       id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
     ) VALUES ('auto-1', ?, 'Auto', 1, 'enabled', '{"type":"manual"}', 'p', 'c.yaml', 'auto')`
  ).run(id);
  return id;
}

function hookConfig(
  stubUrl: string,
  overrides: Record<string, unknown> = {}
): ReturnType<typeof resolveWakeHooks>[number] {
  return resolveWakeHooks([
    {
      id: "grok-bot",
      sink: "http",
      url: stubUrl,
      tokenEnv: FAKE_TOKEN_ENV,
      events: ["needs_input", "halted", "blocked", "green", "queue_batch_complete"],
      ...overrides,
    },
  ])[0]!;
}

function insertRunEvent(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>
): void {
  db.prepare(
    `INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, 1, ?, ?)`
  ).run(runId, eventType, JSON.stringify(payload));
}

describe("b83 wake hooks", () => {
  const envSnapshot = {
    [FAKE_TOKEN_ENV]: process.env[FAKE_TOKEN_ENV],
  };
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    process.env[FAKE_TOKEN_ENV] = FAKE_TOKEN;
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    if (envSnapshot[FAKE_TOKEN_ENV] === undefined) {
      delete process.env[FAKE_TOKEN_ENV];
    } else {
      process.env[FAKE_TOKEN_ENV] = envSnapshot[FAKE_TOKEN_ENV];
    }
  });

  it("POSTs JSON with Bearer header and records success on 2xx without retry", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-green", workspaceId, featureId: "b83", status: "completed", chainStopReason: "complete:done" });
    const events = new DaemonEventBus();
    const store = new RunStore(db, events);
    db.prepare(
      `INSERT INTO run_events (run_id, seq, event_type, payload) VALUES ('run-green', 1, 'run.completed', '{}')`
    ).run();

    let fetchCalls = 0;
    const requests: StubRequest[] = [];
    const dispatcher = createWakeHookDispatcher(store, undefined, async (_url, init) => {
      fetchCalls++;
      requests.push({
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      });
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([hookConfig(stub.url, { events: ["green"], featureIds: ["b83"] })]);
    dispatcher.dispatchRunEvent("run-green", "green");
    await flushAsyncWork();

    expect(fetchCalls).toBe(1);
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const posted = JSON.parse(requests[0]?.body ?? "{}") as {
      kind: string;
      cursor: number;
      transcript?: unknown;
      source: string;
    };
    expect(posted.kind).toBe("pipeline.green");
    expect(posted.source).toBe("max");
    expect(posted.cursor).toBeGreaterThan(0);
    expect(posted.transcript).toBeUndefined();
    expect(requests[0]?.body).not.toContain(FAKE_TOKEN);
    const publicSnap = buildWakeHooksPublic(
      [hookConfig(stub.url, { events: ["green"], featureIds: ["b83"] })],
      dispatcher.getDeliveryRings()
    );
    expect(publicSnap.hooks[0]?.lastDeliveries.at(-1)?.status).toBe("success");
    const doctorText = formatWakeHookLines(publicSnap.hooks).join("\n");
    expect(doctorText).not.toContain(FAKE_TOKEN);
    expect(doctorText).not.toContain(stub.url);
    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("retries on 500 then records success after 200", async () => {
    let attempt = 0;
    const stub = await startStubServer((_req, n) => ({
      status: n === 0 ? 500 : 200,
    }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-retry-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-halt", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      attempt++;
      return new Response(null, { status: attempt === 1 ? 500 : 200 });
    });
    dispatcher.reconfigure([hookConfig(stub.url, { events: ["halted"] })]);
    dispatcher.dispatchRunEvent("run-halt", "halted");
    await flushAsyncWork(1500);

    expect(attempt).toBe(2);
    const last = dispatcher.getDeliveryRings().get("grok-bot")?.at(-1);
    expect(last?.status).toBe("success");
    expect(last?.attempt).toBe(2);
    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("drops wakes filtered by featureIds without POST", async () => {
    let fetchCalls = 0;
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-filter-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-b84", workspaceId, featureId: "b84" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([
      hookConfig(stub.url, { events: ["green"], featureIds: ["b83"] }),
    ]);
    dispatcher.dispatchRunEvent("run-b84", "green");
    await flushAsyncWork();

    expect(fetchCalls).toBe(0);
    expect(dispatcher.getDeliveryRings().get("grok-bot") ?? []).toHaveLength(0);
    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stores certificate errors without the host and absent token in public output", async () => {
    const fakeHost = "127.0.0.1:59999";
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-cert-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-cert", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(
      store,
      undefined,
      async () => {
        throw new TypeError(`certificate has expired for ${fakeHost}`);
      }
    );
    dispatcher.reconfigure([hookConfig(stub.url, { events: ["blocked"] })]);
    dispatcher.dispatchRunEvent("run-cert", "blocked");
    await flushAsyncWork(3500);

    const last = dispatcher.getDeliveryRings().get("grok-bot")?.at(-1);
    expect(last?.error).toBe("certificate");
    const publicJson = JSON.stringify(
      buildWakeHooksPublic(
        [hookConfig(stub.url, { events: ["blocked"] })],
        dispatcher.getDeliveryRings()
      )
    );
    expect(publicJson).not.toContain(FAKE_TOKEN);
    expect(publicJson).not.toContain(fakeHost);
    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not reject callers when fetch throws", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-throw-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-throw", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());
    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      throw new Error("network down");
    });
    dispatcher.reconfigure([hookConfig(stub.url, { events: ["green"] })]);

    expect(() => dispatcher.dispatchRunEvent("run-throw", "green")).not.toThrow();
    await flushAsyncWork();
    expect(unhandled).toHaveLength(0);
    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("needsInput with chat id and no run row does not POST", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    let fetchCalls = 0;
    const dispatcher = new WakeHookDispatcher({
      getRun: () => undefined,
      parseChainContext: () => null,
      getMaxGlobalEventId: () => 1,
      classifyOutcome: () => "running",
      fetchImpl: async () => {
        fetchCalls++;
        return new Response(null, { status: 200 });
      },
    });
    dispatcher.reconfigure([hookConfig(stub.url, { events: ["needs_input"] })]);
    const notifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      eventPrefs: {
        needs_input: { toast: false, ntfy: false },
      } as never,
    });
    notifier.setWakeHookDispatcher(dispatcher);
    notifier.needsInput("chat-id-no-run", "question?");
    await flushAsyncWork();
    expect(fetchCalls).toBe(0);
    await stub.close();
  });

  it("planApprovalRequired POSTs pipeline.needs_input", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    const requests: StubRequest[] = [];
    const root = mkdtempSync(join(tmpdir(), "lca-b83-plan-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-plan", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async (_url, init) => {
      requests.push({
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      });
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([hookConfig(stub.url, { events: ["needs_input"] })]);
    const notifier = new Notifier({
      dashboardUrl: "http://127.0.0.1:3747",
      eventPrefs: {
        plan_approval_required: { toast: false, ntfy: false },
        needs_input: { toast: false, ntfy: false },
      } as never,
    });
    notifier.setWakeHookDispatcher(dispatcher);
    notifier.planApprovalRequired("run-plan", "approve?");
    await flushAsyncWork();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const body = JSON.parse(requests[0]?.body ?? "{}") as { kind: string };
    expect(body.kind).toBe("pipeline.needs_input");
    expect(JSON.stringify(body)).not.toContain(FAKE_TOKEN);
    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("hot-reloads a new hook id from YAML without reconstructing the stub server", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b83-reload-"));
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    vi.resetModules();

    const { GLOBAL_CONFIG_PATH } = await import(
      "../packages/daemon/src/paths.ts"
    );
    const { loadWakeHooksSettings: reloadWakeHooks } = await import(
      "../packages/daemon/src/config/settings.ts"
    );
    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });

    const stub = await startStubServer(() => ({ status: 200 }));
    let fetchCalls = 0;

    const root = mkdtempSync(join(testHome, "runtime"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-reload", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    writeFileSync(
      GLOBAL_CONFIG_PATH,
      [
        "settings:",
        "  wakeHooks:",
        "    - id: first-hook",
        "      sink: http",
        `      url: ${stub.url}`,
        `      tokenEnv: ${FAKE_TOKEN_ENV}`,
        "      coalesceMs: 0",
        "      events:",
        "        - green",
        "",
      ].join("\n"),
      "utf8"
    );

    let hooks = reloadWakeHooks();
    expect(hooks).toHaveLength(1);
    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure(hooks);
    dispatcher.dispatchRunEvent("run-reload", "green");
    await flushAsyncWork();
    expect(fetchCalls).toBe(1);

    writeFileSync(
      GLOBAL_CONFIG_PATH,
      readFileSync(GLOBAL_CONFIG_PATH, "utf8") +
        [
          "    - id: second-hook",
          "      sink: http",
          `      url: ${stub.url}`,
          `      tokenEnv: ${FAKE_TOKEN_ENV}`,
          "      coalesceMs: 0",
          "      events:",
          "        - green",
          "",
        ].join("\n"),
      "utf8"
    );

    hooks = reloadWakeHooks({ fallback: hooks });
    expect(hooks.map((h) => h.id)).toEqual(["first-hook", "second-hook"]);
    dispatcher.reconfigure(hooks);
    dispatcher.dispatchRunEvent("run-reload", "green");
    await flushAsyncWork();
    expect(fetchCalls).toBe(3);

    db.close();
    await stub.close();
    rmSync(testHome, { recursive: true, force: true });
    vi.doUnmock("node:os");
  });

  it("coalesces bursts then sends a summary wake with suppressed count", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    const bodies: unknown[] = [];
    const root = mkdtempSync(join(tmpdir(), "lca-b83-coalesce-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-coalesce", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(
      store,
      undefined,
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }
    );
    dispatcher.reconfigure([
      hookConfig(stub.url, { events: ["needs_input"], coalesceMs: 100 }),
    ]);
    dispatcher.dispatchRunEvent("run-coalesce", "needs_input");
    await flushWakeDelivery();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    dispatcher.dispatchRunEvent("run-coalesce", "needs_input");
    await flushWakeDelivery();

    expect(bodies).toHaveLength(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    await flushWakeDelivery();

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const summary = bodies.at(-1) as { suppressed?: number };
    expect(summary.suppressed).toBeGreaterThanOrEqual(1);
    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("holds wakes at maxPerHour until the rolling hour moves", async () => {
    let nowMs = 1_000_000;
    const stub = await startStubServer(() => ({ status: 200 }));
    const bodies: unknown[] = [];
    const root = mkdtempSync(join(tmpdir(), "lca-b83-cap-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-cap", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(
      store,
      undefined,
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      },
      () => nowMs
    );
    dispatcher.reconfigure([
      hookConfig(stub.url, { events: ["green"], maxPerHour: 1, coalesceMs: 0 }),
    ]);

    dispatcher.dispatchRunEvent("run-cap", "green");
    await flushWakeDelivery();
    dispatcher.dispatchRunEvent("run-cap", "green");
    await flushWakeDelivery();
    expect(bodies).toHaveLength(1);

    nowMs += 3_600_001;
    dispatcher.dispatchRunEvent("run-cap", "green");
    await flushWakeDelivery();
    expect(bodies).toHaveLength(2);
    const afterCap = bodies.at(-1) as { suppressed?: number };
    expect(afterCap.suppressed).toBeGreaterThanOrEqual(1);

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("still rings the first wake when a prior actor stamp exists", async () => {
    let fetchCalls = 0;
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-actor-first-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-first", workspaceId, featureId: "b83" });
    insertRunEvent(db, "run-first", "run.message", {
      text: "kickoff",
      actorId: "grok-bot",
    });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([
      hookConfig(stub.url, {
        events: ["needs_input"],
        actorId: "grok-bot",
        coalesceMs: 0,
      }),
    ]);
    dispatcher.dispatchRunEvent("run-first", "needs_input");
    await flushWakeDelivery();
    expect(fetchCalls).toBe(1);

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("suppresses green for the hook actor after a newer actor escalation", async () => {
    let fetchCalls = 0;
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-actor-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-actor", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([
      hookConfig(stub.url, {
        events: ["green"],
        actorId: "grok-bot",
        coalesceMs: 0,
      }),
    ]);
    dispatcher.dispatchRunEvent("run-actor", "green");
    await flushWakeDelivery();
    expect(fetchCalls).toBe(1);

    insertRunEvent(db, "run-actor", "run.pipeline-escalated", {
      action: "retry",
      actorId: "grok-bot",
    });
    dispatcher.dispatchRunEvent("run-actor", "green");
    await flushWakeDelivery();

    expect(fetchCalls).toBe(1);
    const last = dispatcher.getDeliveryRings().get("grok-bot")?.at(-1);
    expect(last?.error).toBe("suppressed-actor");

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("still delivers green to a hook with a different actorId", async () => {
    let fetchCalls = 0;
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-actor-other-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-actor-other", workspaceId, featureId: "b83" });
    insertRunEvent(db, "run-actor-other", "run.pipeline-escalated", {
      action: "retry",
      actorId: "grok-bot",
    });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([
      hookConfig(stub.url, {
        events: ["green"],
        actorId: "other-bot",
        coalesceMs: 0,
      }),
    ]);
    dispatcher.dispatchRunEvent("run-actor-other", "green");
    await flushWakeDelivery();
    expect(fetchCalls).toBe(1);

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("still sends queue_batch_complete despite actor escalation", async () => {
    let fetchCalls = 0;
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-queue-actor-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-queue", workspaceId, featureId: "b83" });
    insertRunEvent(db, "run-queue", "run.pipeline-escalated", {
      action: "retry",
      actorId: "grok-bot",
    });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([
      hookConfig(stub.url, {
        events: ["queue_batch_complete"],
        actorId: "grok-bot",
        coalesceMs: 0,
      }),
    ]);
    dispatcher.dispatchQueueEvent({ workspaceId });
    await flushWakeDelivery();
    expect(fetchCalls).toBe(1);

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("chat sink posts Max wake text and does not HTTP", async () => {
    let fetchCalls = 0;
    const chatBodies: string[] = [];
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-chat-ok-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-chat-ok", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.setSendChatMessage(async (_chatId, text) => {
      chatBodies.push(text);
    });
    dispatcher.reconfigure([
      resolveWakeHooks([
        {
          id: "chat-hook",
          sink: "chat",
          chatId: "chat-1",
          events: ["green"],
          coalesceMs: 0,
        },
      ])[0]!,
    ]);
    dispatcher.dispatchRunEvent("run-chat-ok", "green");
    await flushWakeDelivery();

    expect(fetchCalls).toBe(0);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatch(/^Max wake\n/);
    expect(chatBodies[0]).toContain("pipeline.green");
    expect(chatBodies[0]).toContain("max watch");
    expect(chatBodies[0]).not.toContain(FAKE_TOKEN);
    expect(dispatcher.getDeliveryRings().get("chat-hook")?.at(-1)?.status).toBe(
      "success"
    );

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("records chat busy without calling fetch", async () => {
    let fetchCalls = 0;
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-chat-busy-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-chat", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      fetchCalls++;
      return new Response(null, { status: 200 });
    });
    dispatcher.setSendChatMessage(async () => {
      throw new ChatMessageError("busy", "chat is running");
    });
    dispatcher.reconfigure([
      resolveWakeHooks([
        {
          id: "chat-hook",
          sink: "chat",
          chatId: "chat-1",
          events: ["green"],
          coalesceMs: 0,
        },
      ])[0]!,
    ]);
    dispatcher.dispatchRunEvent("run-chat", "green");
    await flushWakeDelivery();

    expect(fetchCalls).toBe(0);
    const last = dispatcher.getDeliveryRings().get("chat-hook")?.at(-1);
    expect(last?.error).toBe("chat busy");

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("formatWakeHookLines shows no actor activity since when flagged", () => {
    const lines = formatWakeHookLines([
      {
        id: "grok-bot",
        sink: "http",
        events: ["green"],
        actorId: "grok-bot",
        noActorActivitySince: true,
        lastDeliveries: [
          {
            at: new Date().toISOString(),
            kind: "pipeline.green",
            status: "success",
            attempt: 1,
          },
        ],
      },
    ]);
    expect(lines[0]).toContain("delivered, no actor activity since");
  });

  it("settingsSchema rejects wakeHook singular as an unknown key", () => {
    const result = settingsSchema.safeParse({ wakeHook: [] });
    expect(result.success).toBe(false);
  });

  it("classifies nested TLS cause as certificate without leaking the host", async () => {
    const fakeHost = "hooks.internal.example";
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-cert-cause-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-cert-cause", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(
      store,
      undefined,
      async () => {
        const cause = new Error(`unable to verify the first certificate for ${fakeHost}`);
        (cause as Error & { code: string }).code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
        throw new TypeError("fetch failed", { cause });
      }
    );
    dispatcher.reconfigure([
      hookConfig(stub.url, { events: ["blocked"], coalesceMs: 0 }),
    ]);
    dispatcher.dispatchRunEvent("run-cert-cause", "blocked");
    await flushAsyncWork(3500);

    const last = dispatcher.getDeliveryRings().get("grok-bot")?.at(-1);
    expect(last?.error).toBe("certificate");
    expect(JSON.stringify(last)).not.toContain(fakeHost);

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /api/settings/wake-hooks redacts token and full URL path", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b83-get-"));
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    vi.resetModules();

    const { GLOBAL_CONFIG_PATH } = await import("../packages/daemon/src/paths.ts");
    const { DEFAULT_SETTINGS, loadWakeHooksSettings: reloadWakeHooks } =
      await import("../packages/daemon/src/config/settings.ts");
    const { startHttpServer } = await import(
      "../packages/daemon/src/http/server.ts"
    );
    const { ChatEngine } = await import("../packages/daemon/src/chats/engine.ts");
    const { RunEngine } = await import("../packages/daemon/src/runs/engine.ts");
    const { InputHub } = await import("../packages/daemon/src/input/hub.ts");
    const { InputStore } = await import("../packages/daemon/src/input/store.ts");
    const { DashboardStore } = await import(
      "../packages/daemon/src/http/dashboard-store.ts"
    );

    mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    writeFileSync(
      GLOBAL_CONFIG_PATH,
      [
        "settings:",
        "  wakeHooks:",
        "    - id: grok-bot",
        "      sink: http",
        "      url: https://hooks.example/secret/path",
        `      tokenEnv: ${FAKE_TOKEN_ENV}`,
        "      events:",
        "        - green",
        "",
      ].join("\n"),
      "utf8"
    );

    const root = mkdtempSync(join(testHome, "runtime"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const port = await freeListenPort();
    const hooks = reloadWakeHooks();
    expect(hooks).toHaveLength(1);
    const dispatcher = createWakeHookDispatcher(new RunStore(db, events));
    dispatcher.reconfigure(hooks);

    const http = await startHttpServer({
      engine: new RunEngine(db, {
        apiKey: "test",
        executor: {
          kind: "sdk-local",
          spawn: async () => {
            throw new Error("no spawn");
          },
          resume: async () => {
            throw new Error("no resume");
          },
        },
        inputHub: new InputHub(new InputStore(db), {
          onNeedsInput: () => {},
          onAnswered: () => {},
        }),
        maxConcurrentRuns: 1,
        events,
      }),
      chatEngine: new ChatEngine(db, {
        apiKey: "test",
        executor: {
          kind: "sdk-local",
          spawn: async () => {
            throw new Error("no spawn");
          },
          resume: async () => {
            throw new Error("no resume");
          },
        },
        events,
      }),
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      wakeHooks: {
        getPublic: () =>
          buildWakeHooksPublic(hooks, dispatcher.getDeliveryRings()),
      },
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/wake-hooks`);
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain(FAKE_TOKEN);
      expect(raw).not.toContain("/secret/path");
      const body = JSON.parse(raw) as {
        hooks: Array<{ urlHost?: string; tokenEnv?: string }>;
      };
      expect(body.hooks[0]?.urlHost).toBe("https://hooks.example");
      expect(body.hooks[0]?.tokenEnv).toBe(FAKE_TOKEN_ENV);
    } finally {
      await http.close();
      db.close();
      rmSync(testHome, { recursive: true, force: true });
      vi.doUnmock("node:os");
    }
  });

  it("dispatchTest emits wake.test and skips coalesce", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    const bodies: unknown[] = [];
    const root = mkdtempSync(join(tmpdir(), "lca-b83-test-dispatch-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-test-coalesce", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());

    const dispatcher = createWakeHookDispatcher(
      store,
      undefined,
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      }
    );
    dispatcher.reconfigure([
      hookConfig(stub.url, { events: ["green"], coalesceMs: 60_000 }),
    ]);

    dispatcher.dispatchRunEvent("run-test-coalesce", "green");
    await flushWakeDelivery();
    expect(bodies).toHaveLength(1);

    const result = await dispatcher.dispatchTest("grok-bot");
    await flushWakeDelivery();
    expect(result).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    const testBody = bodies.at(-1) as { kind: string; outcome: string; next: string };
    expect(testBody.kind).toBe("wake.test");
    expect(testBody.outcome).toBe("test");
    expect(testBody.next).toBe("max doctor");

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("dispatchTest does not report prior success when the hourly cap holds the send", async () => {
    let nowMs = 2_000_000;
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-test-cap-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const store = new RunStore(db, new DaemonEventBus());
    const dispatcher = createWakeHookDispatcher(
      store,
      undefined,
      async () => new Response(null, { status: 200 }),
      () => nowMs
    );
    dispatcher.reconfigure([
      hookConfig(stub.url, { events: ["halted"], maxPerHour: 1, coalesceMs: 0 }),
    ]);

    expect(await dispatcher.dispatchTest("grok-bot")).toEqual({ ok: true });
    expect(await dispatcher.dispatchTest("grok-bot")).toEqual({
      ok: false,
      error: "request",
    });

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("getDoctorContext flags delivered with no later actor activity", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    const root = mkdtempSync(join(tmpdir(), "lca-b83-doctor-actor-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, join(root, "ws"));
    insertRun(db, { id: "run-doctor", workspaceId, featureId: "b83" });
    const store = new RunStore(db, new DaemonEventBus());
    const hook = hookConfig(stub.url, {
      events: ["green"],
      actorId: "grok-bot",
      coalesceMs: 0,
    });
    const dispatcher = createWakeHookDispatcher(store, undefined, async () => {
      return new Response(null, { status: 200 });
    });
    dispatcher.reconfigure([hook]);
    dispatcher.dispatchRunEvent("run-doctor", "green");
    await flushWakeDelivery();

    const ctx = dispatcher.getDoctorContext(hook);
    expect(ctx.noActorActivitySince).toBe(true);
    const lines = formatWakeHookLines(
      buildWakeHooksPublic([hook], dispatcher.getDeliveryRings(), () => ctx).hooks
    );
    expect(lines[0]).toContain("delivered, no actor activity since");

    db.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("POST /api/settings/wake-hooks/:id/test returns 404 for unknown id", async () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b83-test-404-"));
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    vi.resetModules();

    const { startHttpServer } = await import(
      "../packages/daemon/src/http/server.ts"
    );
    const { ChatEngine } = await import("../packages/daemon/src/chats/engine.ts");
    const { RunEngine } = await import("../packages/daemon/src/runs/engine.ts");
    const { InputHub } = await import("../packages/daemon/src/input/hub.ts");
    const { InputStore } = await import("../packages/daemon/src/input/store.ts");
    const { DashboardStore } = await import(
      "../packages/daemon/src/http/dashboard-store.ts"
    );
    const { DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    const root = mkdtempSync(join(testHome, "runtime"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const port = await freeListenPort();
    const dispatcher = createWakeHookDispatcher(new RunStore(db, events));

    const http = await startHttpServer({
      engine: new RunEngine(db, {
        apiKey: "test",
        executor: {
          kind: "sdk-local",
          spawn: async () => {
            throw new Error("no spawn");
          },
          resume: async () => {
            throw new Error("no resume");
          },
        },
        inputHub: new InputHub(new InputStore(db), {
          onNeedsInput: () => {},
          onAnswered: () => {},
        }),
        maxConcurrentRuns: 1,
        events,
      }),
      chatEngine: new ChatEngine(db, {
        apiKey: "test",
        executor: {
          kind: "sdk-local",
          spawn: async () => {
            throw new Error("no spawn");
          },
          resume: async () => {
            throw new Error("no resume");
          },
        },
        events,
      }),
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      wakeHooks: {
        getPublic: () => buildWakeHooksPublic([], dispatcher.getDeliveryRings()),
        testSend: (id) => dispatcher.dispatchTest(id),
      },
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/settings/wake-hooks/missing/test`,
        { method: "POST" }
      );
      expect(res.status).toBe(404);
    } finally {
      await http.close();
      db.close();
      rmSync(testHome, { recursive: true, force: true });
      vi.doUnmock("node:os");
    }
  });

  it("POST test route records failure and returns ok:false when token is missing", async () => {
    const stub = await startStubServer(() => ({ status: 200 }));
    const testHome = mkdtempSync(join(tmpdir(), "lca-b83-test-token-"));
    vi.doMock("node:os", () => ({ homedir: () => testHome }));
    vi.resetModules();

    const { startHttpServer } = await import(
      "../packages/daemon/src/http/server.ts"
    );
    const { ChatEngine } = await import("../packages/daemon/src/chats/engine.ts");
    const { RunEngine } = await import("../packages/daemon/src/runs/engine.ts");
    const { InputHub } = await import("../packages/daemon/src/input/hub.ts");
    const { InputStore } = await import("../packages/daemon/src/input/store.ts");
    const { DashboardStore } = await import(
      "../packages/daemon/src/http/dashboard-store.ts"
    );
    const { DEFAULT_SETTINGS } = await import(
      "../packages/daemon/src/config/settings.ts"
    );

    delete process.env[FAKE_TOKEN_ENV];

    const root = mkdtempSync(join(testHome, "runtime"));
    const db = openDatabase(join(root, "state.sqlite"));
    const events = new DaemonEventBus();
    const port = await freeListenPort();
    const hooks = [hookConfig(stub.url, { events: ["green"], coalesceMs: 0 })];
    const dispatcher = createWakeHookDispatcher(new RunStore(db, events));
    dispatcher.reconfigure(hooks);

    const http = await startHttpServer({
      engine: new RunEngine(db, {
        apiKey: "test",
        executor: {
          kind: "sdk-local",
          spawn: async () => {
            throw new Error("no spawn");
          },
          resume: async () => {
            throw new Error("no resume");
          },
        },
        inputHub: new InputHub(new InputStore(db), {
          onNeedsInput: () => {},
          onAnswered: () => {},
        }),
        maxConcurrentRuns: 1,
        events,
      }),
      chatEngine: new ChatEngine(db, {
        apiKey: "test",
        executor: {
          kind: "sdk-local",
          spawn: async () => {
            throw new Error("no spawn");
          },
          resume: async () => {
            throw new Error("no resume");
          },
        },
        events,
      }),
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings: DEFAULT_SETTINGS,
      wakeHooks: {
        getPublic: () =>
          buildWakeHooksPublic(hooks, dispatcher.getDeliveryRings()),
        testSend: (id) => dispatcher.dispatchTest(id),
      },
    });

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/api/settings/wake-hooks/grok-bot/test`,
        { method: "POST" }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body).toEqual({ ok: false, error: "token" });
      const publicSnap = buildWakeHooksPublic(
        hooks,
        dispatcher.getDeliveryRings()
      );
      expect(JSON.stringify(publicSnap)).not.toContain(FAKE_TOKEN);
    } finally {
      process.env[FAKE_TOKEN_ENV] = FAKE_TOKEN;
      await http.close();
      db.close();
      rmSync(testHome, { recursive: true, force: true });
      vi.doUnmock("node:os");
    }
  });

  it("buildWakeHooksPublic never includes token value or URL path", () => {
    const publicSnap = buildWakeHooksPublic(
      [
        hookConfig("https://hooks.example/secret/path", {
          events: ["green"],
        }),
      ],
      new Map([
        [
          "grok-bot",
          [
            {
              at: new Date().toISOString(),
              kind: "wake.test",
              status: "success",
              attempt: 1,
            },
          ],
        ],
      ])
    );
    const json = JSON.stringify(publicSnap);
    expect(json).not.toContain(FAKE_TOKEN);
    expect(json).not.toContain("/secret/path");
    expect(publicSnap.hooks[0]?.urlHost).toBe("https://hooks.example");
  });

  it("WakeHooksSettingsPanel fetches wake-hooks API", () => {
    const panel = readFileSync(
      join(import.meta.dirname, "../packages/dashboard/src/WakeHooksSettingsPanel.tsx"),
      "utf8"
    );
    expect(panel).toMatch(/getWakeHooks\(\)/);
    expect(panel).toMatch(/testWakeHook\(/);
    expect(panel).toMatch(/settings\.wakeHooks/);
    expect(panel).not.toMatch(/process\.env/);
  });

  it("api client exposes wake hook helpers on expected routes", () => {
    const apiSrc = readFileSync(
      join(import.meta.dirname, "../packages/dashboard/src/api.ts"),
      "utf8"
    );
    expect(apiSrc).toMatch(/getWakeHooks\(\): Promise<WakeHooksPublic>/);
    expect(apiSrc).toMatch(/\/api\/settings\/wake-hooks/);
    expect(apiSrc).toMatch(/testWakeHook\([\s\S]*?\/test/);
  });
});
