import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const dbPath = join(homedir(), ".cursor-local-automations", "state.sqlite");

const ASSISTANT_MD = [
  "Here is the **plan**:",
  "",
  "- read the config",
  "- run the migration",
  "",
  "```ts",
  "function add(a: number, b: number) {",
  "  return a + b;",
  "}",
  "```",
  "",
  "| step | status |",
  "| ---- | ------ |",
  "| init | done   |",
].join("\n");

function ev(seq, eventType, payload) {
  return { seq, eventType, payload: JSON.stringify(payload) };
}

function assistantDelta(seq, text) {
  return ev(seq, "assistant", {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

// Split the markdown into ~12-char token-like deltas to mimic SDK streaming —
// these must coalesce back into a single formatted assistant bubble.
function streamDeltas(startSeq, text, size = 12) {
  const out = [];
  for (let i = 0, seq = startSeq; i < text.length; i += size, seq++) {
    out.push(assistantDelta(seq, text.slice(i, i + size)));
  }
  return out;
}

const deltas = streamDeltas(2, ASSISTANT_MD);
const afterDeltas = 2 + deltas.length;

const EDIT_DIFF = [
  "--- a/packages/dashboard/src/normalizeEvent.ts",
  "+++ b/packages/dashboard/src/normalizeEvent.ts",
  "@@ -100,3 +100,3 @@",
  " function toolDetail(value) {",
  "-  return String(value);",
  "+  return asRecord(parsed.result)?.value;",
  " }",
  "@@ -520,6 +521,7 @@",
  "     case \"thinking\": {",
  "       const { text } = parsed ? extractMessageContent(parsed) : { text: \"\" };",
  "+      const thinkingDurationMs = optNum(parsed?.thinking_duration_ms);",
  "       return {",
  "         ...base(ev, \"thinking\"),",
  "         title: \"thinking\",",
  "         body: text,",
].join("\n");

const EVENTS = [
  ev(1, "run.started", { agentId: "agent-x", sdkRunId: "sdk-x", resumed: false }),
  ...deltas,
  ev(afterDeltas, "thinking", {
    type: "thinking",
    text: "weighing the two options",
    thinking_duration_ms: 9200,
  }),
  ev(afterDeltas + 1, "tool_call", {
    type: "tool_call",
    name: "read",
    status: "completed",
    args: { path: "C:\\Users\\dev\\project\\docs\\roadmap\\00-index.md" },
    result: { status: "success", value: { content: "# index", totalLines: 1, fileSize: 8 } },
  }),
  ev(afterDeltas + 2, "tool_call", {
    type: "tool_call",
    name: "shell",
    status: "completed",
    args: { command: "npm test -- run-log-normalize" },
    result: {
      status: "success",
      value: {
        stdout: "✓ tests/run-log-normalize.test.ts (12)\n",
        stderr: "",
        exitCode: 0,
        executionTime: 1840,
      },
    },
  }),
  ev(afterDeltas + 3, "tool_call", {
    type: "tool_call",
    name: "shell",
    status: "completed",
    args: { command: "node -e \"process.exit(2)\"" },
    result: {
      status: "success",
      value: { stdout: "", stderr: "", exitCode: 2, executionTime: 40 },
    },
  }),
  ev(afterDeltas + 4, "tool_call", {
    type: "tool_call",
    name: "edit",
    status: "completed",
    args: {
      path: "C:\\Users\\dev\\project\\packages\\dashboard\\src\\normalizeEvent.ts",
    },
    result: {
      status: "success",
      value: { linesAdded: 2, linesRemoved: 1, diffString: EDIT_DIFF },
    },
  }),
  ev(afterDeltas + 5, "tool_call", {
    type: "tool_call",
    name: "updateTodos",
    status: "completed",
    args: {
      todos: [
        { content: "Add extractors", status: "completed" },
        { content: "Seed fixture", status: "inProgress" },
        { content: "Render widgets", status: "pending" },
      ],
    },
    result: {
      status: "success",
      value: {
        todos: [
          { content: "Add extractors", status: "completed" },
          { content: "Seed fixture", status: "inProgress" },
          { content: "Render widgets", status: "pending" },
        ],
        totalCount: 3,
      },
    },
  }),
  ev(afterDeltas + 6, "tool_call", {
    type: "tool_call",
    name: "task",
    status: "completed",
    args: {
      description: "Explore normalizeEvent callers",
      prompt: "Find every call site of normalizeEvent and summarize.",
      subagentType: { kind: "explore", name: "explore" },
      model: "composer-2.5",
      mode: "ask",
    },
    result: {
      status: "success",
      value: {
        agentId: "bc-subagent-1",
        durationMs: 12400,
        resultSuffix: "Found 3 call sites in the dashboard package.",
        isBackground: false,
      },
    },
  }),
  ev(afterDeltas + 7, "tool_call", {
    type: "tool_call",
    name: "shell",
    status: "completed",
    args: { command: "cat huge.log" },
    truncated: { result: true },
    result: { status: "success", value: { stdout: "(truncated)", exitCode: 0 } },
  }),
  ev(afterDeltas + 8, "input.asked", { question: "Proceed with the migration?" }),
  ev(afterDeltas + 9, "input.delivered", { answer: "yes, go ahead" }),
  assistantDelta(afterDeltas + 10, "Done. "),
  assistantDelta(afterDeltas + 11, "Migration applied."),
  ev(afterDeltas + 12, "assistant", { _truncated: true, originalBytes: 99999, preview: "<<huge>>" }),
  ev(afterDeltas + 13, "run.finished", { sdkStatus: "finished", result: "done" }),
];

/**
 * Seeds a deterministic completed run + representative events directly into the
 * runtime SQLite DB. Run status is `completed` so the daemon's boot cleanup
 * leaves it untouched. Returns ids for later cleanup. Call while no daemon holds
 * the DB (i.e. after stopLcaDaemons, before spawning the verify daemon).
 */
export function seedRunFixture() {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const suffix = Date.now();
  const workspaceId = `b3-ui-ws-${suffix}`;
  const automationId = `b3-ui-auto-${suffix}`;
  const runId = `b3-ui-run-${suffix}`;

  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
    ).run(workspaceId, `b3-fixture-path-${suffix}`, "b3 fixture");
    db.prepare(
      `INSERT INTO automations (
         id, workspace_id, name, enabled, status, trigger_json, prompt,
         config_path, config_key, origin
       ) VALUES (?, ?, ?, 0, 'enabled', '{"type":"manual"}', 'fixture',
         '__dashboard__', ?, 'dashboard')`
    ).run(automationId, workspaceId, `b3-ui-fixture-${suffix}`, `dashboard:${randomUUID()}`);
    db.prepare(
      `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, started_at, ended_at)
       VALUES (?, ?, ?, 'completed', 'manual', datetime('now'), datetime('now'))`
    ).run(runId, automationId, workspaceId);
    const insertEvent = db.prepare(
      `INSERT INTO run_events (run_id, seq, event_type, payload) VALUES (?, ?, ?, ?)`
    );
    for (const e of EVENTS) insertEvent.run(runId, e.seq, e.eventType, e.payload);
  });
  tx();
  db.close();
  return { runId, automationId, workspaceId };
}

/** Removes a seeded fixture (cascades to runs + events via the workspace FK). */
export function cleanupRunFixture({ workspaceId }) {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = seedRunFixture();
  console.log("seeded", ids);
}
