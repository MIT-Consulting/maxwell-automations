import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capEventPayload } from "../packages/daemon/src/events/payload-cap.ts";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { RunStore } from "../packages/daemon/src/runs/store.ts";
import { ChatStore } from "../packages/daemon/src/chats/store.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function toolCallBase(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_call",
    call_id: "call-1",
    name: "edit",
    status: "completed",
    args: { path: "src/example.ts" },
    result: {
      status: "success",
      value: {
        linesAdded: 2,
        linesRemoved: 1,
      },
    },
    ...overrides,
  };
}

function parseCap(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

describe("b38 capEventPayload helper", () => {
  it("returns under-limit payloads byte-identical to the input", () => {
    const payload = JSON.stringify(
      toolCallBase({
        result: {
          status: "success",
          value: { diffString: "@@ -1 +1 @@\n-old\n+new\n" },
        },
      })
    );
    const maxBytes = utf8Bytes(payload) + 64;
    const out = capEventPayload("tool_call", payload, maxBytes);
    expect(out).toBe(payload);
    expect(Buffer.from(out, "utf8").equals(Buffer.from(payload, "utf8"))).toBe(
      true
    );
  });

  it("trims a huge diffString while keeping name/status/args.path and flags", () => {
    const hugeDiff = `@@ -1,1 +1,1 @@\n-${"a".repeat(40_000)}\n+${"b".repeat(40_000)}\n`;
    const payload = JSON.stringify(
      toolCallBase({
        truncated: { args: true },
        result: {
          status: "success",
          value: {
            linesAdded: 1,
            linesRemoved: 1,
            diffString: hugeDiff,
          },
        },
      })
    );
    const maxBytes = 30 * 1024;
    expect(utf8Bytes(payload)).toBeGreaterThan(maxBytes);

    const out = capEventPayload("tool_call", payload, maxBytes);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(maxBytes);
    const parsed = parseCap(out);
    expect(parsed._truncated).toBeUndefined();
    expect(parsed.name).toBe("edit");
    expect(parsed.status).toBe("completed");
    expect(parsed.call_id).toBe("call-1");
    const args = parsed.args as { path: string };
    expect(args.path).toBe("src/example.ts");
    const result = parsed.result as {
      status: string;
      value: { diffString: string };
    };
    expect(result.status).toBe("success");
    expect(typeof result.value.diffString).toBe("string");
    expect(result.value.diffString.length).toBeGreaterThan(0);
    expect(result.value.diffString).toContain("truncated by Max");
    expect(result.value.diffString).toContain("result.value.diffString");
    const truncated = parsed.truncated as { args?: boolean; result?: boolean };
    expect(truncated.args).toBe(true);
    expect(truncated.result).toBe(true);
    const trims = parsed._lcaFieldTrims as Array<{
      path: string;
      originalLength: number;
    }>;
    expect(trims.some((t) => t.path === "result.value.diffString")).toBe(true);
  });

  it("trims a huge stdout the same way", () => {
    const hugeStdout = "line\n".repeat(20_000);
    const payload = JSON.stringify(
      toolCallBase({
        name: "shell",
        args: { command: "npm test" },
        result: {
          status: "success",
          value: {
            stdout: hugeStdout,
            stderr: "",
            exitCode: 0,
          },
        },
      })
    );
    const maxBytes = 28 * 1024;
    expect(utf8Bytes(payload)).toBeGreaterThan(maxBytes);

    const out = capEventPayload("tool_call", payload, maxBytes);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(maxBytes);
    const parsed = parseCap(out);
    expect(parsed.name).toBe("shell");
    expect(parsed.status).toBe("completed");
    const args = parsed.args as { command: string };
    expect(args.command).toBe("npm test");
    const result = parsed.result as {
      status: string;
      value: { stdout: string; exitCode: number };
    };
    expect(result.value.exitCode).toBe(0);
    expect(result.value.stdout).toContain("truncated by Max");
    expect(result.value.stdout).toContain("result.value.stdout");
    const truncated = parsed.truncated as { result?: boolean; args?: boolean };
    expect(truncated.result).toBe(true);
    expect(truncated.args).toBeUndefined();
  });

  it("sets truncated.args when trimming args.fileText and preserves result flag", () => {
    const payload = JSON.stringify(
      toolCallBase({
        name: "write",
        truncated: { result: true },
        args: {
          path: "src/big.ts",
          fileText: "export const x = 1;\n".repeat(10_000),
        },
        result: {
          status: "success",
          value: { path: "src/big.ts", linesCreated: 10_000 },
        },
      })
    );
    const maxBytes = 20 * 1024;
    expect(utf8Bytes(payload)).toBeGreaterThan(maxBytes);

    const out = capEventPayload("tool_call", payload, maxBytes);
    const parsed = parseCap(out);
    expect(parsed._truncated).toBeUndefined();
    const truncated = parsed.truncated as { args?: boolean; result?: boolean };
    expect(truncated.result).toBe(true);
    expect(truncated.args).toBe(true);
    const args = parsed.args as { path: string; fileText: string };
    expect(args.path).toBe("src/big.ts");
    expect(args.fileText).toContain("truncated by Max");
  });

  it("falls back to the blunt envelope when an unrecognized heavy field remains", () => {
    const payload = JSON.stringify(
      toolCallBase({
        result: {
          status: "success",
          value: {
            mysteryBlob: "Z".repeat(80_000),
          },
        },
      })
    );
    const maxBytes = 4 * 1024;
    expect(utf8Bytes(payload)).toBeGreaterThan(maxBytes);

    const out = capEventPayload("tool_call", payload, maxBytes);
    const parsed = parseCap(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed.eventType).toBe("tool_call");
    expect(Number(parsed.originalBytes)).toBe(utf8Bytes(payload));
    expect(typeof parsed.preview).toBe("string");
    expect((parsed.preview as string).length).toBeLessThanOrEqual(1000);
  });

  it("blunt-caps non-tool_call oversized events unchanged from today", () => {
    const payload = JSON.stringify({ text: "x".repeat(5000) });
    const maxBytes = 200;
    const out = capEventPayload("assistant", payload, maxBytes);
    const parsed = parseCap(out);
    expect(parsed._truncated).toBe(true);
    expect(parsed.eventType).toBe("assistant");
    expect(Number(parsed.originalBytes)).toBe(utf8Bytes(payload));
    expect(parsed.preview).toBe(payload.slice(0, 1000));
  });

  it("measures UTF-8 bytes, not JavaScript string length", () => {
    // Each "中" is 3 UTF-8 bytes; 40 chars => 120 bytes, under a 100-char
    // string-length budget but over a 100-byte UTF-8 cap.
    const text = "中".repeat(40);
    expect(text.length).toBe(40);
    expect(utf8Bytes(text)).toBe(120);
    const payload = JSON.stringify({ type: "assistant", text });
    expect(payload.length).toBeLessThan(100);
    expect(utf8Bytes(payload)).toBeGreaterThan(100);

    const out = capEventPayload("assistant", payload, 100);
    expect(out).not.toBe(payload);
    const parsed = parseCap(out);
    expect(parsed._truncated).toBe(true);
    expect(Number(parsed.originalBytes)).toBe(utf8Bytes(payload));
  });

  it("trims multibyte field heads on UTF-8 boundaries without corrupting JSON", () => {
    const huge = "😀".repeat(20_000);
    const payload = JSON.stringify(
      toolCallBase({
        name: "shell",
        args: { command: "echo" },
        result: {
          status: "success",
          value: { stdout: huge, stderr: "", exitCode: 0 },
        },
      })
    );
    const maxBytes = 28 * 1024;
    const out = capEventPayload("tool_call", payload, maxBytes);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(utf8Bytes(out)).toBeLessThanOrEqual(maxBytes);
    const parsed = parseCap(out);
    const result = parsed.result as { value: { stdout: string } };
    // Re-encoding the trimmed stdout must not introduce U+FFFD replacement.
    expect(result.value.stdout.includes("\uFFFD")).toBe(false);
  });
});

describe("b38 RunStore and ChatStore persistence", () => {
  function seedRun(db: import("better-sqlite3").Database): string {
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES ('ws', '/repo', 'Repo')"
    ).run();
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
      ) VALUES ('auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'Run', 'c.yaml', 'auto')`
    ).run();
    db.prepare(
      `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
       VALUES ('run', 'auto', 'ws', 'completed', 'manual', 'Run')`
    ).run();
    return "run";
  }

  it("RunStore persists a field-trimmed tool_call intact", () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b38-run-cap-"));
    roots.push(testHome);
    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      const runId = seedRun(db);
      const store = new RunStore(db, undefined, {
        maxEventPayloadBytes: 30 * 1024,
      });
      const hugeDiff = `@@\n-${"d".repeat(50_000)}\n`;
      store.appendEvent(
        runId,
        "tool_call",
        toolCallBase({
          result: {
            status: "success",
            value: { diffString: hugeDiff, linesAdded: 1, linesRemoved: 1 },
          },
        })
      );
      const [event] = store.listRunEvents(runId);
      const parsed = parseCap(event.payload);
      expect(parsed._truncated).toBeUndefined();
      expect(parsed.name).toBe("edit");
      const result = parsed.result as { value: { diffString: string } };
      expect(result.value.diffString).toContain("truncated by Max");
      expect(utf8Bytes(event.payload)).toBeLessThanOrEqual(30 * 1024);
    } finally {
      db.close();
    }
  });

  it("ChatStore persists the same structurally intact trimmed result", () => {
    const testHome = mkdtempSync(join(tmpdir(), "lca-b38-chat-cap-"));
    roots.push(testHome);
    const db = openDatabase(join(testHome, "state.sqlite"));
    try {
      db.prepare(
        "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'Workspace')"
      ).run("/tmp/workspace");
      const store = new ChatStore(db, undefined, {
        maxEventPayloadBytes: 30 * 1024,
      });
      const session = store.createChatSession({ workspaceId: "ws" });
      const hugeDiff = `@@\n-${"c".repeat(50_000)}\n`;
      store.appendEvent(
        session.id,
        "tool_call",
        toolCallBase({
          result: {
            status: "success",
            value: { diffString: hugeDiff, linesAdded: 1, linesRemoved: 1 },
          },
        })
      );
      const [event] = store.listChatEvents(session.id);
      const parsed = parseCap(event.payload);
      expect(parsed._truncated).toBeUndefined();
      expect(parsed.name).toBe("edit");
      const args = parsed.args as { path: string };
      expect(args.path).toBe("src/example.ts");
      const result = parsed.result as { value: { diffString: string } };
      expect(result.value.diffString).toContain("truncated by Max");
      expect(
        (parsed.truncated as { result?: boolean }).result
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
