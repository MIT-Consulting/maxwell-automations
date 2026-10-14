import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriggerConfig, WebhookTriggerConfig } from "@lca/shared";
import { triggerConfigSchema } from "../packages/shared/src/schemas/config.ts";
import { workspaceIdFromPath } from "../packages/daemon/src/config/reconcile.ts";
import { DEFAULT_SETTINGS } from "../packages/daemon/src/config/settings.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { SCHEMA_VERSION } from "../packages/daemon/src/db/schema.ts";
import { DaemonEventBus } from "../packages/daemon/src/events.ts";
import { DashboardStore } from "../packages/daemon/src/http/dashboard-store.ts";
import { startHttpServer } from "../packages/daemon/src/http/server.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import type { Executor } from "../packages/daemon/src/executor/types.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { TriggerManager } from "../packages/daemon/src/triggers/manager.ts";
import {
  isWebhookTriggerPost,
  WEBHOOK_MAX_PAYLOAD_BYTES,
  webhookStatusStore,
} from "../packages/daemon/src/triggers/webhook.ts";
import { formatWebhookTriggerLines } from "../packages/cli/src/doctor.ts";
import { checkControlToken } from "../packages/daemon/src/http/server.ts";
import { ChatEngine } from "../packages/daemon/src/chats/engine.ts";
import { freeListenPort } from "./helpers/free-port.ts";

const SECRET_ENV = "LCA_TEST_WEBHOOK_SECRET";
const WEBHOOK_SECRET = "test-webhook-secret-value";

type Db = ReturnType<typeof openDatabase>;

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

function signBody(body: Buffer | string, secret = WEBHOOK_SECRET): string {
  const raw = typeof body === "string" ? Buffer.from(body) : body;
  const hex = createHmac("sha256", secret).update(raw).digest("hex");
  return `sha256=${hex}`;
}

function flipLastSignatureByte(signature: string): string {
  const hex = signature.slice("sha256=".length);
  const last = hex.slice(-2);
  const flipped = (parseInt(last, 16) ^ 0xff).toString(16).padStart(2, "0");
  return `sha256=${hex.slice(0, -2)}${flipped}`;
}

function seedWorkspace(db: Db, workspacePath: string, id?: string): string {
  mkdirSync(workspacePath, { recursive: true });
  const workspaceId = id ?? workspaceIdFromPath(workspacePath);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(workspaceId, workspacePath, "Webhook WS");
  return workspaceId;
}

function seedAutomation(
  db: Db,
  workspaceId: string,
  args: {
    id: string;
    trigger: TriggerConfig;
    prompt?: string;
    enabled?: number;
    configKey?: string;
  }
): void {
  db.prepare(
    `INSERT INTO automations (
       id, workspace_id, name, enabled, status, trigger_json, prompt,
       config_path, config_key
     ) VALUES (?, ?, ?, ?, 'enabled', ?, ?, 'hook.yaml', ?)`
  ).run(
    args.id,
    workspaceId,
    args.configKey ?? args.id,
    args.enabled ?? 1,
    JSON.stringify(args.trigger),
    args.prompt ?? "Stored automation prompt.",
    args.configKey ?? args.id
  );
}

function webhookTrigger(
  name: string,
  fields?: string[]
): WebhookTriggerConfig {
  return {
    type: "webhook",
    name,
    secretEnv: SECRET_ENV,
    ...(fields ? { fields } : {}),
  };
}

async function postWebhook(args: {
  port: number;
  name: string;
  body?: string | Buffer;
  deliveryId?: string;
  signature?: string;
  controlToken?: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = args.body ?? "{}";
  const deliveryId = args.deliveryId ?? `del-${Date.now()}-${Math.random()}`;
  const raw = typeof body === "string" ? Buffer.from(body) : body;
  const signature = args.signature ?? signBody(raw);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-LCA-Delivery-Id": deliveryId,
    "X-LCA-Signature": signature,
  };
  if (args.controlToken) {
    headers["X-LCA-Control-Token"] = args.controlToken;
  }
  const res = await fetch(
    `http://127.0.0.1:${args.port}/api/triggers/webhook/${args.name}`,
    { method: "POST", headers, body: raw }
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

describe("b84 webhook trigger", () => {
  beforeEach(() => {
    process.env[SECRET_ENV] = WEBHOOK_SECRET;
    webhookStatusStore.clear();
  });

  afterEach(() => {
    delete process.env[SECRET_ENV];
    webhookStatusStore.clear();
  });

  async function withServer(
    setup: (db: Db, workspaceId: string) => void,
    run: (args: {
      port: number;
      db: Db;
      engine: RunEngine;
      workspaceId: string;
    }) => Promise<void>,
    settings: typeof DEFAULT_SETTINGS = DEFAULT_SETTINGS
  ): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "lca-b84-http-"));
    const workspacePath = join(root, "workspace");
    const db = openDatabase(join(root, "state.sqlite"));
    const workspaceId = seedWorkspace(db, workspacePath);
    setup(db, workspaceId);
    const events = new DaemonEventBus();
    const inputHub = new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    });
    const engine = new RunEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      inputHub,
      maxConcurrentRuns: 1,
      events,
    });
    const chatEngine = new ChatEngine(db, {
      apiKey: "test",
      executor: stubExecutor(),
      events,
    });
    const port = await freeListenPort();
    const triggers = new TriggerManager(db, engine, { port });
    const http = await startHttpServer({
      engine,
      chatEngine,
      store: new DashboardStore(db),
      db,
      events,
      apiKey: "test",
      port,
      settings,
      triggers,
      webhookTriggers: {
        getPublic: () => webhookStatusStore.getPublic(db),
      },
    });
    try {
      await run({ port, db, engine, workspaceId });
    } finally {
      await http.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("migrates fresh databases with webhook_deliveries at SCHEMA_VERSION", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b84-migrate-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(25);
      const row = db
        .prepare("SELECT MAX(version) AS v FROM schema_migrations")
        .get() as { v: number };
      expect(row.v).toBe(SCHEMA_VERSION);
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_deliveries'"
        )
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("webhook_deliveries");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isWebhookTriggerPost matches only POST webhook paths", () => {
    expect(isWebhookTriggerPost("POST", "/api/runs")).toBe(false);
    expect(isWebhookTriggerPost("GET", "/api/triggers/webhook/x")).toBe(false);
    expect(isWebhookTriggerPost("POST", "/api/triggers/webhooks")).toBe(false);
    expect(isWebhookTriggerPost("POST", "/api/triggers/webhook/ship-hook")).toBe(
      true
    );
    expect(isWebhookTriggerPost("POST", "/api/triggers/webhook/Ship-Hook")).toBe(
      true
    );
  });

  it("rejects YAML secret field via triggerConfigSchema", () => {
    const parsed = triggerConfigSchema.safeParse({
      type: "webhook",
      name: "ship-hook",
      secret: "inline-secret",
      secretEnv: SECRET_ENV,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a signed POST and starts one webhook run with promptOverride preface", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook", ["title"]),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi
          .spyOn(engine, "triggerRun")
          .mockResolvedValue("run-b84-1");
        const body = JSON.stringify({ title: "hello", ignore: "x" });
        const res = await postWebhook({
          port,
          name: "ship-hook",
          body,
          deliveryId: "delivery-001",
        });
        expect(res.status).toBe(202);
        expect(res.json).toEqual({ ok: true, runId: "run-b84-1" });
        expect(triggerRun).toHaveBeenCalledTimes(1);
        expect(triggerRun).toHaveBeenCalledWith("auto-webhook", "webhook", {
          promptOverride: expect.stringContaining(
            "Untrusted webhook input follows"
          ),
        });
        const prompt = triggerRun.mock.calls[0]![2]!.promptOverride!;
        expect(prompt).toContain("webhook_delivery_id: delivery-001");
        expect(prompt).toContain("webhook_title: hello");
        expect(prompt).not.toContain("webhook_ignore");
        expect(prompt.endsWith("Stored automation prompt.")).toBe(true);
      }
    );
  });

  it("returns 409 on duplicate delivery id without a second triggerRun", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi
          .spyOn(engine, "triggerRun")
          .mockResolvedValue("run-b84-1");
        const first = await postWebhook({
          port,
          name: "ship-hook",
          deliveryId: "delivery-dup",
        });
        expect(first.status).toBe(202);
        const second = await postWebhook({
          port,
          name: "ship-hook",
          deliveryId: "delivery-dup",
        });
        expect(second.status).toBe(409);
        expect(second.json.error).toBe("duplicate delivery");
        expect(triggerRun).toHaveBeenCalledTimes(1);
      }
    );
  });

  it("returns 401 on bad signature and does not triggerRun", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const body = "{}";
        const badSig = flipLastSignatureByte(signBody(body));
        const res = await postWebhook({
          port,
          name: "ship-hook",
          body,
          signature: badSig,
        });
        expect(res.status).toBe(401);
        expect(res.json.error).toBe("invalid signature");
        expect(triggerRun).not.toHaveBeenCalled();
      }
    );
  });

  it("returns 413 when body exceeds the payload cap", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const oversized = "x".repeat(WEBHOOK_MAX_PAYLOAD_BYTES + 1);
        const res = await postWebhook({
          port,
          name: "ship-hook",
          body: oversized,
        });
        expect(res.status).toBe(413);
        expect(res.json.error).toBe("payload too large");
        expect(triggerRun).not.toHaveBeenCalled();
      }
    );
  });

  it("truncates allowlisted string fields to 500 characters", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook", ["title"]),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi
          .spyOn(engine, "triggerRun")
          .mockResolvedValue("run-b84-trunc");
        const long = "a".repeat(600);
        await postWebhook({
          port,
          name: "ship-hook",
          body: JSON.stringify({ title: long }),
          deliveryId: "delivery-trunc",
        });
        const prompt = triggerRun.mock.calls[0]![2]!.promptOverride!;
        const line = prompt
          .split("\n")
          .find((l) => l.startsWith("webhook_title:"))!;
        expect(line).toBe(`webhook_title: ${"a".repeat(500)}`);
      }
    );
  });

  it("returns 401 when control token is present but signature is bad", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const body = "{}";
        const res = await postWebhook({
          port,
          name: "ship-hook",
          body,
          signature: flipLastSignatureByte(signBody(body)),
          controlToken: "fake-control-token",
        });
        expect(res.status).toBe(401);
        expect(triggerRun).not.toHaveBeenCalled();
      },
      { ...DEFAULT_SETTINGS, controlToken: "configured-control-token" }
    );
  });

  it("does not start a manual automation that shares the webhook name key", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "manual-same-key",
          trigger: { type: "manual" },
          configKey: "ship-hook",
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const res = await postWebhook({ port, name: "ship-hook" });
        expect(res.status).toBe(404);
        expect(res.json.error).toBe("webhook name is not armed");
        expect(triggerRun).not.toHaveBeenCalled();
      }
    );
  });

  it("returns 404 when the webhook name fails the charset regex", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const res = await postWebhook({
          port,
          name: "Ship-Hook",
          controlToken: "configured-control-token",
        });
        expect(res.status).toBe(404);
        expect(res.json.error).toBe("webhook name is not armed");
        expect(triggerRun).not.toHaveBeenCalled();
      },
      { ...DEFAULT_SETTINGS, controlToken: "configured-control-token" }
    );
  });

  it("returns 404 when duplicate webhook names are armed", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "wh-1",
          trigger: webhookTrigger("dup-hook"),
        });
        seedAutomation(db, workspaceId, {
          id: "wh-2",
          trigger: webhookTrigger("dup-hook"),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const res = await postWebhook({ port, name: "dup-hook" });
        expect(res.status).toBe(404);
        expect(res.json.error).toBe("webhook name is not armed");
        expect(triggerRun).not.toHaveBeenCalled();
      }
    );
  });

  it("returns 503 when secretEnv is unset", async () => {
    delete process.env[SECRET_ENV];
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port, engine }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const res = await postWebhook({ port, name: "ship-hook" });
        expect(res.status).toBe(503);
        expect(res.json.error).toBe("webhook secret is not configured");
        expect(triggerRun).not.toHaveBeenCalled();
      }
    );
  });

  it("reports rejected after 401 via getPublic and doctor lines omit the secret", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port }) => {
        const body = "{}";
        await postWebhook({
          port,
          name: "ship-hook",
          body,
          signature: flipLastSignatureByte(signBody(body)),
        });
        const res = await fetch(
          `http://127.0.0.1:${port}/api/triggers/webhooks`
        );
        expect(res.status).toBe(200);
        const snapshot = (await res.json()) as {
          webhooks: Array<{ name: string; lastResult?: string }>;
        };
        const row = snapshot.webhooks.find((w) => w.name === "ship-hook");
        expect(row?.lastResult).toBe("rejected");
        const lines = formatWebhookTriggerLines(snapshot.webhooks);
        const text = lines.join("\n");
        expect(text).toContain("rejected");
        expect(text).not.toContain(WEBHOOK_SECRET);
      }
    );
  });

  it("reports accepted after 202 without delivery id in doctor lines", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port, engine }) => {
        vi.spyOn(engine, "triggerRun").mockResolvedValue("run-b84-doc");
        const deliveryId = "delivery-doctor-202";
        await postWebhook({
          port,
          name: "ship-hook",
          deliveryId,
        });
        const res = await fetch(
          `http://127.0.0.1:${port}/api/triggers/webhooks`
        );
        const snapshot = (await res.json()) as {
          webhooks: Array<{ name: string; lastResult?: string }>;
        };
        const row = snapshot.webhooks.find((w) => w.name === "ship-hook");
        expect(row?.lastResult).toBe("accepted");
        const lines = formatWebhookTriggerLines(snapshot.webhooks);
        expect(lines.join("\n")).toContain("accepted");
        expect(lines.join("\n")).not.toContain(deliveryId);
      }
    );
  });

  it("does not arm a global webhook in getPublic and POSTs 404", async () => {
    await withServer(
      (db) => {
        db.prepare(
          "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
        ).run("__global__", "__global__", "Global");
        seedAutomation(db, "__global__", {
          id: "global-webhook",
          trigger: webhookTrigger("global-hook"),
        });
      },
      async ({ port, engine, db }) => {
        const triggerRun = vi.spyOn(engine, "triggerRun");
        const res = await postWebhook({ port, name: "global-hook" });
        expect(res.status).toBe(404);
        expect(res.json.error).toBe("webhook name is not armed");
        expect(triggerRun).not.toHaveBeenCalled();
        const snapshot = webhookStatusStore.getPublic(db);
        const row = snapshot.webhooks.find((w) => w.name === "global-hook");
        expect(row?.armed).toBe(false);
      }
    );
  });

  it("reports unarmed duplicate names without an HTTP hit", () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b84-dup-"));
    const db = openDatabase(join(root, "state.sqlite"));
    try {
      webhookStatusStore.setDuplicateNames(new Set(["dup-hook"]));
      const snapshot = webhookStatusStore.getPublic(db);
      const row = snapshot.webhooks.find((w) => w.name === "dup-hook");
      expect(row).toEqual(
        expect.objectContaining({
          name: "dup-hook",
          armed: false,
          lastResult: "duplicate",
        })
      );
      const lines = formatWebhookTriggerLines(snapshot.webhooks);
      expect(lines.join("\n")).toMatch(/dup-hook\s+not armed\s+duplicate/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty formatter lines when no webhook automations exist", async () => {
    expect(formatWebhookTriggerLines([])).toEqual([]);
    await withServer(
      () => {},
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/triggers/webhooks`
        );
        const snapshot = (await res.json()) as { webhooks: unknown[] };
        expect(snapshot.webhooks).toEqual([]);
        expect(formatWebhookTriggerLines([])).toEqual([]);
      }
    );
  });

  it("GET /api/triggers/webhooks is not HMAC-exempt but loopback skips control token", async () => {
    expect(
      checkControlToken({
        isLoopbackSource: false,
        controlToken: "configured-token",
      })
    ).toBe("missing");
    expect(
      checkControlToken({
        isLoopbackSource: true,
        controlToken: "configured-token",
      })
    ).toBe("ok");

    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
        });
      },
      async ({ port }) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/api/triggers/webhooks`
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as { webhooks: unknown[] };
        expect(json.webhooks.length).toBeGreaterThan(0);
      },
      { ...DEFAULT_SETTINGS, controlToken: "configured-token" }
    );
  });

  it("leaves the stored automation prompt unchanged after a 202", async () => {
    await withServer(
      (db, workspaceId) => {
        seedAutomation(db, workspaceId, {
          id: "auto-webhook",
          trigger: webhookTrigger("ship-hook"),
          prompt: "Immutable prompt on disk.",
        });
      },
      async ({ port, engine, db }) => {
        vi.spyOn(engine, "triggerRun").mockResolvedValue("run-b84-prompt");
        await postWebhook({
          port,
          name: "ship-hook",
          deliveryId: "delivery-prompt-check",
        });
        const row = db
          .prepare("SELECT prompt FROM automations WHERE id = ?")
          .get("auto-webhook") as { prompt: string };
        expect(row.prompt).toBe("Immutable prompt on disk.");
      }
    );
  });
});
