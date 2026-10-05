import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ACTOR_ID_HEADER,
  isRoadmapIdCandidate,
  parseActorIdFromRequest,
  sanitizeActorId,
} from "@lca/shared";
import { projectPipelineFeedPayload } from "../packages/shared/src/pipeline-feed.ts";
import {
  FEATURE_ID_RE,
  parseOperatorTargetFlags,
  resolveFeaturePipeline,
  resolveFeatureTargetRunId,
  UsageError,
  type FeatureTargetVerb,
} from "../packages/cli/src/operator-target.ts";
import { DaemonClient, DaemonError } from "../packages/cli/src/client.ts";
import { parseWatchArgs } from "../packages/cli/src/watch.ts";
import { summarizeEvent } from "../packages/cli/src/doctor.ts";
import { normalizeEvent } from "../packages/dashboard/src/normalizeEvent.ts";
import { checkControlToken } from "../packages/daemon/src/http/server.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { RunEngine } from "../packages/daemon/src/runs/engine.ts";

const OPERATOR_VERBS: FeatureTargetVerb[] = [
  "watch",
  "doctor",
  "pause",
  "resume",
  "message",
  "interrupt",
  "answer",
  "cancel",
  "escalate",
];

function snapshotFor(overrides: Record<string, unknown> = {}) {
  return {
    featureId: "b81",
    rootRunId: "root-abc",
    waiting: null,
    halt: null,
    current: null,
    ...overrides,
  };
}

function mockClient(opts: {
  workspaceId?: string;
  rootRunId?: string;
  snapshot?: Record<string, unknown>;
  runs?: Array<Record<string, unknown>>;
} = {}): DaemonClient {
  return {
    listWorkspaces: vi.fn(async () => [
      { id: "ws-1", path: "/tmp/ws-one", name: "one" },
      { id: "ws-2", path: "/tmp/ws-two", name: "two" },
    ]),
    resolvePipelineSnapshot: vi.fn(async (wsId: string, featureId: string) => ({
      rootRunId: opts.rootRunId ?? `root-${wsId}-${featureId}`,
      snapshot: snapshotFor({
        featureId,
        rootRunId: opts.rootRunId ?? `root-${wsId}-${featureId}`,
        ...(opts.snapshot ?? {}),
      }),
    })),
    listRuns: vi.fn(async () => opts.runs ?? []),
  } as unknown as DaemonClient;
}

describe("sanitizeActorId", () => {
  it("accepts trimmed printable ids up to 64 chars", () => {
    expect(sanitizeActorId("  orchestrator-a  ")).toBe("orchestrator-a");
    expect(sanitizeActorId("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects control chars, empty, and over-limit values", () => {
    expect(sanitizeActorId("")).toBeUndefined();
    expect(sanitizeActorId("   ")).toBeUndefined();
    expect(sanitizeActorId("bad\nid")).toBeUndefined();
    expect(sanitizeActorId("a".repeat(65))).toBeUndefined();
    expect(sanitizeActorId(12)).toBeUndefined();
  });
});

describe("parseActorIdFromRequest", () => {
  it("accepts header-only, body-only, or agreeing pair", () => {
    expect(parseActorIdFromRequest({})).toEqual({
      ok: true,
      actorId: undefined,
    });
    expect(parseActorIdFromRequest({ header: "bot-a" })).toEqual({
      ok: true,
      actorId: "bot-a",
    });
    expect(parseActorIdFromRequest({ bodyActorId: "bot-a" })).toEqual({
      ok: true,
      actorId: "bot-a",
    });
    expect(
      parseActorIdFromRequest({ header: "bot-a", bodyActorId: "bot-a" })
    ).toEqual({ ok: true, actorId: "bot-a" });
  });

  it("rejects header/body disagreement and invalid values", () => {
    expect(
      parseActorIdFromRequest({ header: "bot-a", bodyActorId: "bot-b" })
    ).toEqual({
      ok: false,
      error: "X-LCA-Actor header and body actorId disagree",
    });
    expect(parseActorIdFromRequest({ header: "a".repeat(65) })).toEqual({
      ok: false,
      error: "Invalid X-LCA-Actor header",
    });
    expect(parseActorIdFromRequest({ bodyActorId: "bad\tid" })).toEqual({
      ok: false,
      error: "Invalid actorId in request body",
    });
  });
});

describe("parseOperatorTargetFlags", () => {
  it("rejects positional target combined with --feature", () => {
    const parsed = parseOperatorTargetFlags(["b81", "--feature", "b81"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("Cannot combine");
    }
  });

  it("parses --feature and -w without a positional", () => {
    const parsed = parseOperatorTargetFlags([
      "--feature",
      "b81",
      "-w",
      "my-workspace",
    ]);
    expect(parsed).toEqual({
      ok: true,
      positional: undefined,
      feature: "b81",
      workspaceQuery: "my-workspace",
      rest: [],
    });
  });

  it("keeps verb rest after --feature (escalate/answer/message)", () => {
    expect(parseOperatorTargetFlags(["--feature", "b81", "retry"])).toEqual({
      ok: true,
      positional: undefined,
      feature: "b81",
      workspaceQuery: undefined,
      rest: ["retry"],
    });
    expect(
      parseOperatorTargetFlags(["--feature", "b81", "yes", "please"])
    ).toEqual({
      ok: true,
      positional: undefined,
      feature: "b81",
      workspaceQuery: undefined,
      rest: ["yes", "please"],
    });
  });

  it("parses every listed verb's typical target forms", () => {
    for (const verb of OPERATOR_VERBS) {
      const byFlag = parseOperatorTargetFlags(["--feature", "b81", "-w", "ws"]);
      expect(byFlag.ok, verb).toBe(true);
      const byPositional = parseOperatorTargetFlags(["b81"]);
      expect(byPositional.ok, verb).toBe(true);
      if (byPositional.ok) {
        expect(isRoadmapIdCandidate(byPositional.positional ?? "")).toBe(true);
      }
    }
  });
});

describe("per-person feature id targeting", () => {
  it("accepts b42 via --feature and positional", () => {
    const byFlag = parseOperatorTargetFlags(["--feature", "b42"]);
    expect(byFlag.ok).toBe(true);
    const byPositional = parseOperatorTargetFlags(["b42"]);
    expect(byPositional.ok).toBe(true);
    if (byPositional.ok) {
      expect(isRoadmapIdCandidate(byPositional.positional ?? "")).toBe(true);
    }
  });

  it("accepts b-xy58 via --feature and positional for every operator verb", () => {
    for (const verb of OPERATOR_VERBS) {
      void verb;
      const byFlag = parseOperatorTargetFlags(["--feature", "b-xy58"]);
      expect(byFlag.ok).toBe(true);
      const byPositional = parseOperatorTargetFlags(["b-xy58"]);
      expect(byPositional.ok).toBe(true);
      if (byPositional.ok) {
        expect(isRoadmapIdCandidate(byPositional.positional ?? "")).toBe(true);
      }
    }
  });

  it("resolveFeaturePipeline accepts b-xy58 and rejects non-candidates", async () => {
    const client = mockClient();
    await resolveFeaturePipeline(client, "b-xy58", "ws-1");
    expect(client.resolvePipelineSnapshot).toHaveBeenCalledWith("ws-1", "b-xy58");
    await expect(resolveFeaturePipeline(client, "not-a-feature-id")).rejects.toThrow(
      DaemonError
    );
    await expect(resolveFeaturePipeline(client, "not-a-feature-id")).rejects.toThrow(
      /Invalid feature id "not-a-feature-id"; expected a feature id \(e\.g\. b42, b-dm58\)\./
    );
  });

  it("resolveFeatureTargetRunId routes b-xy58 through feature resolution", async () => {
    const client = mockClient();
    const resolved = await resolveFeatureTargetRunId(
      client,
      "watch",
      "b-xy58",
      "ws-1"
    );
    expect(resolved.rootRunId).toBe("root-ws-1-b-xy58");
    expect(client.resolvePipelineSnapshot).toHaveBeenCalledWith("ws-1", "b-xy58");
  });

  it("leaves run-id prefixes outside the candidate shape on the run-id path", () => {
    expect(isRoadmapIdCandidate("a1b2c3d4")).toBe(false);
    expect(FEATURE_ID_RE.test("a1b2c3d4")).toBe(false);
  });
});

describe("parseWatchArgs --feature", () => {
  it("accepts --feature without positional target", () => {
    const parsed = parseWatchArgs(["--feature", "b81", "-w", "ws"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.target).toBe("b81");
      expect(parsed.feature).toBe("b81");
    }
  });

  it("rejects positional bN combined with --feature", () => {
    const parsed = parseWatchArgs(["b81", "--feature", "b81"]);
    expect(parsed.ok).toBe(false);
  });
});

describe("help path --feature", () => {
  it("documents --feature on every operator verb", () => {
    const src = readFileSync(
      new URL("../packages/cli/src/cli.ts", import.meta.url),
      "utf8"
    );
    for (const verb of [
      "doctor",
      "watch",
      "answer",
      "cancel",
      "pause",
      "resume",
      "escalate",
      "message",
      "interrupt",
    ]) {
      expect(src).toMatch(new RegExp(`max ${verb}[\\s\\S]{0,240}--feature`));
    }
    expect(src).toContain("LCA_ACTOR");
    expect(src).toContain("b42");
    expect(src).toContain("b-dm58");
    expect(src).not.toMatch(/max run <id\|name>[\s\S]{0,80}--feature <feature-id>/);
  });
});

describe("resolveFeatureTargetRunId", () => {
  it("resolves watch/doctor to the workspace-scoped root", async () => {
    const client = mockClient({ workspaceId: "ws-2" });
    const resolved = await resolveFeatureTargetRunId(
      client,
      "watch",
      "b81",
      "ws-2"
    );
    expect(resolved.rootRunId).toBe("root-ws-2-b81");
    expect(resolved.runId).toBe("root-ws-2-b81");
    expect(client.resolvePipelineSnapshot).toHaveBeenCalledWith("ws-2", "b81");
  });

  it("does not silently reuse another workspace's same feature id", async () => {
    const client = mockClient();
    const one = await resolveFeaturePipeline(client, "b81", "ws-1");
    const two = await resolveFeaturePipeline(client, "b81", "ws-2");
    expect(one.rootRunId).toBe("root-ws-1-b81");
    expect(two.rootRunId).toBe("root-ws-2-b81");
    expect(one.rootRunId).not.toBe(two.rootRunId);
  });

  it("resolves answer to waiting run id", async () => {
    const client = mockClient({
      snapshot: {
        waiting: {
          runId: "child-needs-input",
          inputRequestId: "ir-1",
          kind: null,
          question: "q",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const resolved = await resolveFeatureTargetRunId(
      client,
      "answer",
      "b81",
      "ws-1"
    );
    expect(resolved.runId).toBe("child-needs-input");
  });

  it("resolves pause to the steerable frontier and reports ambiguity", async () => {
    const unique = mockClient({
      rootRunId: "root-abc",
      runs: [
        {
          id: "leaf-1",
          status: "running",
          parentRunId: "root-abc",
          chainRootRunId: "root-abc",
        },
        {
          id: "root-abc",
          status: "completed",
          parentRunId: null,
          chainRootRunId: "root-abc",
        },
      ],
    });
    const resolved = await resolveFeatureTargetRunId(
      unique,
      "pause",
      "b81",
      "ws-1"
    );
    expect(resolved.runId).toBe("leaf-1");

    const ambiguous = mockClient({
      rootRunId: "root-abc",
      runs: [
        {
          id: "leaf-a",
          status: "running",
          parentRunId: "root-abc",
          chainRootRunId: "root-abc",
        },
        {
          id: "leaf-b",
          status: "running",
          parentRunId: "root-abc",
          chainRootRunId: "root-abc",
        },
      ],
    });
    await expect(
      resolveFeatureTargetRunId(ambiguous, "pause", "b81", "ws-1")
    ).rejects.toThrow(/leaf-a|leaf-b/);
  });

  it("resolves resume to a unique paused worker", async () => {
    const client = mockClient({
      rootRunId: "root-abc",
      snapshot: {
        current: { runId: "paused-1", status: "paused" },
      },
      runs: [
        {
          id: "paused-1",
          status: "paused",
          parentRunId: "root-abc",
          chainRootRunId: "root-abc",
        },
      ],
    });
    const resolved = await resolveFeatureTargetRunId(
      client,
      "resume",
      "b81",
      "ws-1"
    );
    expect(resolved.runId).toBe("paused-1");
  });

  it("resolves message to the paused current when no running frontier", async () => {
    const client = mockClient({
      rootRunId: "root-abc",
      snapshot: {
        current: { runId: "paused-1", status: "paused" },
      },
      runs: [
        {
          id: "paused-1",
          status: "paused",
          parentRunId: "root-abc",
          chainRootRunId: "root-abc",
        },
      ],
    });
    const resolved = await resolveFeatureTargetRunId(
      client,
      "message",
      "b81",
      "ws-1"
    );
    expect(resolved.runId).toBe("paused-1");
  });
});

describe("projectPipelineFeedPayload actorId allowlist", () => {
  it("includes actorId on escalation, generic lifecycle, and input.delivered", () => {
    const escalated = projectPipelineFeedPayload(
      "run.pipeline-escalated",
      JSON.stringify({ action: "retry", actor: "operator", actorId: "bot-a" })
    );
    expect(escalated.actorId).toBe("bot-a");

    const paused = projectPipelineFeedPayload(
      "run.paused",
      JSON.stringify({ reason: "operator", actorId: "bot-a" })
    );
    expect(paused.actorId).toBe("bot-a");

    const delivered = projectPipelineFeedPayload(
      "input.delivered",
      JSON.stringify({ kind: "choice", actorId: "bot-a" })
    );
    expect(delivered.actorId).toBe("bot-a");
  });
});

describe("display surfaces", () => {
  it("doctor summarizeEvent appends actor id when present and omits when absent", () => {
    expect(
      summarizeEvent(
        "run.message.queued",
        JSON.stringify({ text: "hello", actorId: "bot-a" })
      )
    ).toContain("(actor: bot-a)");
    expect(
      summarizeEvent("run.message.queued", JSON.stringify({ text: "hello" }))
    ).not.toContain("(actor:");
  });

  it("dashboard cards render actor id on attributed events", () => {
    const queued = normalizeEvent({
      seq: 1,
      eventType: "run.message.queued",
      payload: JSON.stringify({ text: "hello", actorId: "bot-a" }),
    });
    expect(queued.body).toContain("(actor: bot-a)");

    const message = normalizeEvent({
      seq: 2,
      eventType: "run.message",
      payload: JSON.stringify({ text: "steer", actorId: "bot-a" }),
    });
    expect(message.body).toContain("(actor: bot-a)");

    const paused = normalizeEvent({
      seq: 3,
      eventType: "run.paused",
      payload: JSON.stringify({ reason: "operator", actorId: "bot-a" }),
    });
    expect(paused.body).toContain("(actor: bot-a)");

    const cancelled = normalizeEvent({
      seq: 4,
      eventType: "run.cancelled",
      payload: JSON.stringify({ reason: "operator" }),
    });
    expect(cancelled.body).not.toContain("(actor:");
  });
});

describe("DaemonClient actor header", () => {
  it("does not send actor header as control token substitute", () => {
    vi.stubEnv("LCA_ACTOR", "orchestrator-a");
    vi.stubEnv("LCA_CONTROL_TOKEN", "secret-token");
    const client = new DaemonClient("http://127.0.0.1:59999");
    const requestSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));

    void client.pause("run-id").catch(() => undefined);

    expect(requestSpy).toHaveBeenCalled();
    const init = requestSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers[ACTOR_ID_HEADER]).toBe("orchestrator-a");
    expect(headers["X-LCA-Control-Token"]).toBe("secret-token");
    expect(headers[ACTOR_ID_HEADER]).not.toBe(headers["X-LCA-Control-Token"]);
    expect(JSON.parse(String(init.body))).toEqual({ actorId: "orchestrator-a" });

    vi.unstubAllEnvs();
    requestSpy.mockRestore();
  });

  it("omits actor fields when LCA_ACTOR is absent", () => {
    vi.stubEnv("LCA_ACTOR", "");
    const client = new DaemonClient("http://127.0.0.1:59999");
    const requestSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));

    void client.pause("run-id").catch(() => undefined);
    const init = requestSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers[ACTOR_ID_HEADER]).toBeUndefined();
    expect(JSON.parse(String(init.body ?? "{}"))).toEqual({});

    vi.unstubAllEnvs();
    requestSpy.mockRestore();
  });
});

describe("actorId is not a control token", () => {
  it("rejects an actor label presented as the remote control token", () => {
    expect(
      checkControlToken({
        isLoopbackSource: false,
        controlToken: "secret-token",
        presented: "orchestrator-a",
      })
    ).toBe("mismatch");
  });
});

describe("UsageError", () => {
  it("is distinguishable for exit code 2 handling", () => {
    expect(new UsageError("bad usage").name).toBe("UsageError");
  });
});

describe("engine persists actorId on operator lifecycle events", () => {
  function seedRun(
    db: ReturnType<typeof openDatabase>,
    workspace: string,
    runId: string,
    status: string
  ): void {
    mkdirSync(workspace, { recursive: true });
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
    ).run(workspace);
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
      ) VALUES (
        'auto', 'ws', 'Automation', 1, 'enabled', '{"type":"manual"}', 'prompt',
        'config.yaml', 'auto'
      )`
    ).run();
    db.prepare(
      `INSERT INTO runs (
        id, automation_id, workspace_id, status, trigger_kind, prompt
      ) VALUES (?, 'auto', 'ws', ?, 'manual', 'prompt')`
    ).run(runId, status);
  }

  function payloads(
    db: ReturnType<typeof openDatabase>,
    runId: string,
    eventType: string
  ): Array<Record<string, unknown>> {
    return (
      db
        .prepare(
          "SELECT payload FROM run_events WHERE run_id = ? AND event_type = ?"
        )
        .all(runId, eventType) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  }

  it("records actorId on pause and cancel, and omits it when absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b81-actor-persist-"));
    const db = openDatabase(join(root, "state.sqlite"));
    const engine = new RunEngine(db, {
      apiKey: "test-key",
      executor: {
        kind: "sdk-local",
        spawn: async () => {
          throw new Error("spawn should not be called");
        },
        resume: async () => {
          throw new Error("resume should not be called");
        },
      },
      inputHub: new InputHub(new InputStore(db), {
        onNeedsInput: () => undefined,
        onAnswered: () => undefined,
      }),
    });

    try {
      seedRun(db, join(root, "workspace"), "run", "running");
      await engine.pauseRun("run", "orchestrator-a");
      expect(payloads(db, "run", "run.paused")[0]?.actorId).toBe(
        "orchestrator-a"
      );

      db.prepare("UPDATE runs SET status = 'queued' WHERE id = 'run'").run();
      await engine.cancelRun("run");
      expect(payloads(db, "run", "run.cancelled")[0]?.actorId).toBeUndefined();
    } finally {
      await engine.shutdown();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
