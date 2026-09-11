import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askDaemon } from "../packages/automations-io/src/server.ts";

/**
 * Regression guard for the `ask_user` bridge.
 *
 * `askDaemon` POSTs to the daemon through a long-lived no-timeout undici
 * `Agent` (so a multi-minute human wait is never aborted). That `Agent` comes
 * from this package's bundled undici, which is a *different* version than the
 * undici backing Node's built-in global `fetch`. Passing a cross-version
 * dispatcher to global `fetch` throws
 * `UND_ERR_INVALID_ARG: invalid onRequestStart method`, which previously
 * surfaced as a bare "fetch failed" and silently broke every `ask_user` call.
 *
 * These tests call the real `askDaemon` against a stub daemon on the live Node
 * runtime, so reverting to an incompatible HTTP-client/dispatcher pairing fails
 * loudly instead of regressing the feature in production.
 */

type Handler = (req: IncomingMessage, body: string) =>
  | { status: number; json: unknown }
  | { status: number; raw: string };

let server: Server;
let baseUrl: string;
let lastRequest: { method?: string; url?: string; headers: NodeJS.Dict<string | string[]>; body: string };
let requestCount = 0;
const savedEnv: Record<string, string | undefined> = {};

function startStubDaemon(handler: Handler): Promise<void> {
  requestCount = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestCount += 1;
      lastRequest = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      };
      const result = handler(req, body);
      res.statusCode = result.status;
      if ("json" in result) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result.json));
      } else {
        res.end(result.raw);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

beforeEach(() => {
  for (const key of ["LCA_RUN_ID", "LCA_DAEMON_URL", "LCA_RUN_TOKEN"]) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(async () => {
  for (const key of ["LCA_RUN_ID", "LCA_DAEMON_URL", "LCA_RUN_TOKEN"]) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("automations-io ask_user bridge", () => {
  it("posts the question and returns the answer over the no-timeout dispatcher", async () => {
    await startStubDaemon(() => ({ status: 200, json: { answer: "/me-agenda" } }));
    process.env.LCA_RUN_ID = "run-123";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok-abc";

    const answer = await askDaemon("Please enter a command to run:");

    expect(answer).toBe("/me-agenda");
    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.url).toBe("/api/runs/run-123/ask");
    expect(lastRequest.headers["x-lca-run-token"]).toBe("tok-abc");
    expect(JSON.parse(lastRequest.body)).toEqual({
      question: "Please enter a command to run:",
    });
  });

  it("url-encodes the run id and omits the token header when unset", async () => {
    await startStubDaemon(() => ({ status: 200, json: { answer: "ok" } }));
    process.env.LCA_RUN_ID = "run/with spaces";
    process.env.LCA_DAEMON_URL = baseUrl;
    delete process.env.LCA_RUN_TOKEN;

    await askDaemon("hi");

    expect(lastRequest.url).toBe("/api/runs/run%2Fwith%20spaces/ask");
    expect(lastRequest.headers["x-lca-run-token"]).toBeUndefined();
  });

  it("throws with the status and body on a non-2xx daemon response", async () => {
    await startStubDaemon(() => ({ status: 403, raw: "invalid or missing run token" }));
    process.env.LCA_RUN_ID = "run-123";
    process.env.LCA_DAEMON_URL = baseUrl;

    await expect(askDaemon("hi")).rejects.toThrow(
      /daemon ask failed \(403\): invalid or missing run token/
    );
  });

  it("throws when the daemon returns no answer", async () => {
    await startStubDaemon(() => ({ status: 200, json: {} }));
    process.env.LCA_RUN_ID = "run-123";
    process.env.LCA_DAEMON_URL = baseUrl;

    await expect(askDaemon("hi")).rejects.toThrow(/no answer/);
  });

  it("requires LCA_RUN_ID", async () => {
    delete process.env.LCA_RUN_ID;
    process.env.LCA_DAEMON_URL = "http://127.0.0.1:1";

    await expect(askDaemon("hi")).rejects.toThrow(/LCA_RUN_ID is required/);
  });

  it("posts validated metadata with the run token over the no-timeout path", async () => {
    await startStubDaemon(() => ({ status: 200, json: { answer: "approve" } }));
    process.env.LCA_RUN_ID = "run-meta";
    process.env.LCA_DAEMON_URL = baseUrl;
    process.env.LCA_RUN_TOKEN = "tok-meta";

    const metadata = {
      kind: "approval",
      choices: [
        { id: "approve", label: "Approve" },
        { id: "revise", label: "Revise" },
        { id: "abort", label: "Abort" },
      ],
      recommendedChoiceId: "approve",
      artifacts: [
        {
          label: "Index",
          path: "docs/roadmap/feature/00-index.md",
        },
      ],
    };

    const answer = await askDaemon("Approve the plan?", metadata);
    expect(answer).toBe("approve");
    expect(lastRequest.headers["x-lca-run-token"]).toBe("tok-meta");
    expect(JSON.parse(lastRequest.body)).toEqual({
      question: "Approve the plan?",
      metadata,
    });
  });

  it("rejects invalid metadata before calling the daemon", async () => {
    await startStubDaemon(() => ({ status: 200, json: { answer: "ok" } }));
    process.env.LCA_RUN_ID = "run-bad";
    process.env.LCA_DAEMON_URL = baseUrl;

    await expect(
      askDaemon("Approve?", {
        kind: "approval",
        choices: [{ id: "approve", label: "Approve" }],
        recommendedChoiceId: "missing",
      })
    ).rejects.toThrow();
    expect(requestCount).toBe(0);
  });
});
