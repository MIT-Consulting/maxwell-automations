import { describe, expect, it } from "vitest";
import {
  coalesceTranscript,
  normalizeEvent,
} from "../packages/dashboard/src/normalizeEvent.ts";
import type { StoredEvent } from "../packages/dashboard/src/transcript-types.ts";

function ev(seq: number, eventType: string, payload: unknown): StoredEvent {
  return { seq, eventType, payload: JSON.stringify(payload) };
}

describe("normalizeEvent", () => {
  it("maps an assistant message to an assistant bubble with text", () => {
    const msg = normalizeEvent(
      ev(1, "assistant", {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello world" }] },
      })
    );
    expect(msg.role).toBe("assistant");
    expect(msg.body).toContain("hello world");
  });

  it("notes tool_use blocks inside assistant content", () => {
    const msg = normalizeEvent(
      ev(1, "assistant", {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", name: "read", input: {} },
          ],
        },
      })
    );
    expect(msg.role).toBe("assistant");
    expect(msg.body).toContain("read");
  });

  it("maps an unknown tool_call to a fallback title and preserves status", () => {
    const msg = normalizeEvent(
      ev(2, "tool_call", { type: "tool_call", name: "mysteryTool", status: "completed" })
    );
    expect(msg.role).toBe("tool");
    expect(msg.title).toBe("mysteryTool");
    expect(msg.status).toBe("completed");
  });

  it("labels a read of a doc path as a file read with a short path", () => {
    const msg = normalizeEvent(
      ev(2, "tool_call", {
        type: "tool_call",
        name: "read",
        status: "completed",
        args: { path: "C:\\Users\\dev\\app\\docs\\roadmap\\00-index.md" },
      })
    );
    expect(msg.title).toBe("Read file: docs/roadmap/00-index.md");
    expect(msg.raw).toContain("00-index.md");
  });

  it("labels a read of a SKILL.md as a skill read", () => {
    const raw = {
      type: "tool_call",
      name: "read",
      status: "completed",
      args: { path: "C:\\Users\\dev\\vault\\.cursor\\skills\\me-agenda\\SKILL.md" },
    };
    const msg = normalizeEvent(ev(3, "tool_call", raw));
    expect(msg.title).toBe("Read skill: me-agenda");
    expect(msg.raw).toBe(JSON.stringify(raw));
  });

  it("labels grep, glob, shell, edit, and ask_user tool calls", () => {
    expect(
      normalizeEvent(
        ev(1, "tool_call", { name: "grep", args: { pattern: "tool_call" } })
      ).title
    ).toBe("Search code: tool_call");

    expect(
      normalizeEvent(
        ev(2, "tool_call", { name: "glob", args: { globPattern: "**/*.tsx" } })
      ).title
    ).toBe("Find files: **/*.tsx");

    expect(
      normalizeEvent(
        ev(3, "tool_call", { name: "shell", args: { command: "npm   run   build" } })
      ).title
    ).toBe("Run command: npm run build");

    expect(
      normalizeEvent(
        ev(4, "tool_call", {
          name: "edit",
          args: { path: "C:\\Code\\app\\packages\\dashboard\\src\\transcript.tsx" },
        })
      ).title
    ).toBe("Edit file: packages/dashboard/src/transcript.tsx");

    expect(
      normalizeEvent(
        ev(5, "tool_call", {
          name: "mcp",
          args: { providerIdentifier: "automations-io", toolName: "ask_user" },
        })
      ).title
    ).toBe("Ask user");

    expect(
      normalizeEvent(
        ev(6, "tool_call", {
          name: "mcp",
          args: { providerIdentifier: "google-calendar", toolName: "list-events" },
        })
      ).title
    ).toBe("Call MCP tool: google-calendar.list-events");
  });

  it("never throws on malformed tool_call args and falls back safely", () => {
    expect(
      normalizeEvent(ev(1, "tool_call", { name: "read", args: 42 })).title
    ).toBe("Read file");
    expect(
      normalizeEvent(ev(2, "tool_call", { name: "grep" })).title
    ).toBe("Search code");
    expect(normalizeEvent(ev(3, "tool_call", {})).title).toBe("tool");
  });

  it("recovers a labeled tool row from a store-truncated tool_call", () => {
    const original = JSON.stringify({
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c",
      name: "read",
      status: "completed",
      args: {
        path: "C:\\Users\\dev\\vault\\notes\\100_THE_ENGINE\\Protocol.md",
      },
      result: { status: "success", value: { content: "x".repeat(5000) } },
    });
    const truncated = {
      _truncated: true,
      eventType: "tool_call",
      originalBytes: original.length,
      preview: original.slice(0, 1000),
    };
    const msg = normalizeEvent(ev(1, "tool_call", truncated));
    expect(msg.role).toBe("tool");
    expect(msg.title).toBe("Read file: notes/100_THE_ENGINE/Protocol.md");
    expect(msg.status).toBe("completed");
  });

  it("recovers a tool label even when truncation cut off the args", () => {
    const truncated = {
      _truncated: true,
      eventType: "tool_call",
      originalBytes: 99999,
      // preview cut before the args object closes
      preview: '{"type":"tool_call","name":"grep","status":"running","args":{"pattern":"al',
    };
    const msg = normalizeEvent(ev(1, "tool_call", truncated));
    expect(msg.role).toBe("tool");
    expect(msg.title).toBe("Search code");
    expect(msg.status).toBe("running");
  });

  it("truncates long tool-call detail so a collapsed row stays compact", () => {
    const longCommand = "echo " + "x".repeat(400);
    const msg = normalizeEvent(
      ev(1, "tool_call", { name: "shell", args: { command: longCommand } })
    );
    expect(msg.title).toBeDefined();
    expect(msg.title!.length).toBeLessThan(140);
    expect(msg.title!.length).toBeLessThan(longCommand.length);
    expect(msg.title!.startsWith("Run command:")).toBe(true);
  });

  it("maps thinking and user to their roles", () => {
    expect(normalizeEvent(ev(1, "thinking", { type: "thinking", text: "hmm" })).role).toBe(
      "thinking"
    );
    expect(
      normalizeEvent(
        ev(1, "user", { type: "user", message: { content: [{ type: "text", text: "go" }] } })
      ).role
    ).toBe("user");
  });

  it("maps run.message follow-ups to user bubbles", () => {
    const msg = normalizeEvent(
      ev(1, "run.message", { role: "user", text: "continue with the fix" })
    );
    expect(msg.role).toBe("user");
    expect(msg.body).toBe("continue with the fix");
  });

  it("maps run.message attachments onto the user bubble", () => {
    const msg = normalizeEvent(
      ev(1, "run.message", {
        role: "user",
        text: "see screenshot",
        attachments: [
          {
            id: "att-1",
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 1200,
            kind: "image",
          },
        ],
      })
    );
    expect(msg.attachments).toEqual([
      {
        id: "att-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 1200,
        kind: "image",
      },
    ]);
    expect(msg.body).toBe("see screenshot");
  });

  it("maps attachment-only messages without (no text) placeholder", () => {
    const msg = normalizeEvent(
      ev(1, "run.message", {
        role: "user",
        text: "",
        attachments: [
          {
            id: "att-2",
            name: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 40,
            kind: "file",
          },
        ],
      })
    );
    expect(msg.body).toBeUndefined();
    expect(msg.attachments?.[0]?.name).toBe("notes.md");
  });

  it("maps input.asked/request to a question and input.delivered to an answer", () => {
    expect(normalizeEvent(ev(1, "input.asked", { question: "Which branch?" })).role).toBe(
      "question"
    );
    expect(normalizeEvent(ev(1, "request", { question: "Approve?" })).body).toBe("Approve?");
    const answer = normalizeEvent(ev(2, "input.delivered", { answer: "main" }));
    expect(answer.role).toBe("answer");
    expect(answer.body).toBe("main");
  });

  it("maps run lifecycle events to system rows", () => {
    expect(normalizeEvent(ev(1, "run.started", { agentId: "a" })).role).toBe("system");
    const finished = normalizeEvent(ev(2, "run.finished", { sdkStatus: "finished" }));
    expect(finished.role).toBe("system");
    expect(finished.title).toContain("finished");
    const error = normalizeEvent(ev(3, "run.error", { message: "boom" }));
    expect(error.role).toBe("system");
    expect(error.tone).toBe("error");
    expect(error.body).toBe("boom");

    const stale = normalizeEvent(ev(4, "run.error", { message: "not found", stale: true }));
    expect(stale.role).toBe("system");
    expect(stale.tone).toBe("error");
    expect(stale.title).toBe("session unavailable");
    expect(stale.body).toBe("This conversation's local session is no longer available");

    const authExpired = normalizeEvent(
      ev(5, "run.error", { message: "ERROR_NOT_LOGGED_IN", reason: "auth_expired" })
    );
    expect(authExpired.title).toBe("Cursor auth expired");
    expect(authExpired.body).toContain("refresh CURSOR_API_KEY");

    const chatAuth = normalizeEvent(
      ev(6, "chat.error", { message: "not logged in", reason: "auth_expired" })
    );
    expect(chatAuth.title).toBe("Cursor auth expired");
  });

  it("maps run.revived / chat.revived to a session-revived system divider", () => {
    const revived = normalizeEvent(
      ev(1, "run.revived", {
        previousAgentId: "agent-old",
        agentId: "agent-new",
        model: "composer-2.5",
        transcriptMessages: 12,
        truncated: false,
      })
    );
    expect(revived.role).toBe("system");
    expect(revived.tone).toBe("info");
    expect(revived.title).toBe("session revived");
    expect(revived.body).toContain("fresh agent");
    expect(revived.body).toContain("composer-2.5");
    expect(revived.body).not.toContain("condensed");

    const chatRevived = normalizeEvent(
      ev(2, "chat.revived", { model: "composer-2.5", truncated: true })
    );
    expect(chatRevived.role).toBe("system");
    expect(chatRevived.tone).toBe("info");
    expect(chatRevived.title).toBe("session revived");
    expect(chatRevived.body).toContain("condensed");
  });

  it("notes a failed automatic revive on the stale error body", () => {
    const failed = normalizeEvent(
      ev(1, "run.error", {
        message: "Agent agent-old not found",
        stale: true,
        reviveFailed: true,
      })
    );
    expect(failed.title).toBe("session unavailable");
    expect(failed.tone).toBe("error");
    expect(failed.body).toContain("revive was attempted");
  });

  it("maps chat.message / chat.message.queued / chat.interrupted to user bubbles", () => {
    const sent = normalizeEvent(
      ev(1, "chat.message", { role: "user", text: "scan dds is Hannah's appt" })
    );
    expect(sent.role).toBe("user");
    expect(sent.body).toBe("scan dds is Hannah's appt");
    expect(sent.title).toBeUndefined();

    const queued = normalizeEvent(ev(2, "chat.message.queued", { text: "later" }));
    expect(queued.role).toBe("user");
    expect(queued.title).toBe("Queued");
    expect(queued.body).toBe("later");

    const interrupted = normalizeEvent(
      ev(3, "chat.interrupted", { role: "user", text: "actually stop" })
    );
    expect(interrupted.role).toBe("user");
    expect(interrupted.title).toBe("Interrupted");
    expect(interrupted.body).toBe("actually stop");
  });

  it("maps chat lifecycle events to compact system dividers", () => {
    const started = normalizeEvent(
      ev(1, "chat.started", { agentId: "a", sdkRunId: "r", model: "composer-2.5" })
    );
    expect(started.role).toBe("system");
    expect(started.title).toBe("started (composer-2.5)");

    const resumed = normalizeEvent(
      ev(2, "chat.resumed", { agentId: "a", sdkRunId: "r", model: "composer-2.5" })
    );
    expect(resumed.role).toBe("system");
    expect(resumed.title).toBe("resumed (composer-2.5)");

    // chat.finished must NOT re-dump the (large) result payload as a body — the
    // result text already streamed in as assistant token deltas.
    const finished = normalizeEvent(
      ev(3, "chat.finished", { sdkStatus: "finished", result: "x".repeat(5000) })
    );
    expect(finished.role).toBe("system");
    expect(finished.title).toBe("finished (finished)");
    expect(finished.body).toBeUndefined();

    const error = normalizeEvent(ev(4, "chat.error", { message: "boom" }));
    expect(error.role).toBe("system");
    expect(error.tone).toBe("error");
    expect(error.body).toBe("boom");

    const reconciled = normalizeEvent(ev(5, "chat.reconciled", { priorStatus: "running" }));
    expect(reconciled.role).toBe("system");
    expect(reconciled.title).toBe("reconciled");
    expect(reconciled.body).toBe("was running");
  });

  it("maps run.model to a readable divider instead of a raw payload dump", () => {
    const set = normalizeEvent(ev(1, "run.model", { model: "composer-2.5" }));
    expect(set.role).toBe("system");
    expect(set.title).toBe("model changed");
    expect(set.body).toBe("Next turn uses composer-2.5");

    const cleared = normalizeEvent(ev(2, "run.model", { model: null }));
    expect(cleared.title).toBe("model changed");
    expect(cleared.body).toBe("Next turn uses the automation default");
  });

  it("summarizes run.references with resolved and unresolved counts", () => {
    const ok = normalizeEvent(
      ev(1, "run.references", { resolved: 2, unknown: 0, unknownReferences: [] })
    );
    expect(ok.role).toBe("system");
    expect(ok.tone).toBe("info");
    expect(ok.title).toBe("prompt references");
    expect(ok.body).toBe("Resolved 2 references");

    const withUnknown = normalizeEvent(
      ev(2, "run.references", {
        resolved: 1,
        unknown: 2,
        unknownReferences: [{ raw: "@missing" }, { raw: "/nope" }],
        unknownReferencesTruncated: 0,
      })
    );
    expect(withUnknown.tone).toBe("error");
    expect(withUnknown.body).toContain("Resolved 1 reference");
    expect(withUnknown.body).toContain("2 unresolved references");
    expect(withUnknown.body).toContain("@missing, /nope");

    const failed = normalizeEvent(
      ev(3, "run.references", { resolved: 0, unknown: 1, error: "scan boom" })
    );
    expect(failed.tone).toBe("error");
    expect(failed.body).toContain("scan boom");
  });

  it("renders a truncated payload as a system note", () => {
    const msg = normalizeEvent(
      ev(1, "assistant", { _truncated: true, originalBytes: 99999, preview: "abc" })
    );
    expect(msg.role).toBe("system");
    expect(msg.body).toContain("abc");
    expect(msg.body).toContain("99999");
  });

  it("never throws on invalid JSON and falls back to a system row", () => {
    const msg = normalizeEvent({ seq: 1, eventType: "assistant", payload: "{not json" });
    expect(msg.role).toBe("system");
    expect(msg.body).toBe("{not json");
    expect(msg.raw).toBe("{not json");
  });

  it("maps an unknown event type to a system row titled with the type", () => {
    const msg = normalizeEvent(ev(1, "mystery", { foo: "bar" }));
    expect(msg.role).toBe("system");
    expect(msg.title).toBe("mystery");
  });

  it("maps daemon automatic retry/skip pipeline escalations", () => {
    const retry = normalizeEvent(
      ev(1, "run.pipeline-escalated", {
        action: "retry",
        actor: "daemon",
        childRunId: "child-retry-aaaaaaaa",
        recoveryCode: "safe-class",
        recoveryDetail: "late sdk_error after substantive activity",
      })
    );
    expect(retry.role).toBe("system");
    expect(retry.tone).toBe("info");
    expect(retry.title).toBe("automatic recovery");
    expect(retry.body).toContain("Automatic retry");
    expect(retry.body).toContain("Successor: child-re");
    expect(retry.body).toContain("safe-class");
    expect(retry.body).toContain("late sdk_error");
    expect(retry.body).not.toMatch(/operator/i);

    const skip = normalizeEvent(
      ev(2, "run.pipeline-escalated", {
        action: "skip",
        actor: "daemon",
        childRunId: "child-skip-bbbbbbbb",
        recoveryCode: "safe-class",
        recoveryDetail: "review ladder skip",
      })
    );
    expect(skip.title).toBe("automatic recovery");
    expect(skip.body).toContain("Automatic skip");
    expect(skip.body).toContain("Successor: child-sk");
    expect(skip.body).not.toMatch(/operator/i);
  });

  it("maps operator pipeline escalation without recovery metadata", () => {
    const msg = normalizeEvent(
      ev(1, "run.pipeline-escalated", {
        action: "retry",
        actor: "operator",
        childRunId: "child-op-cccccccc",
        reason: "manual unblock",
        recoveryCode: "safe-class",
        recoveryDetail: "should not appear for operator",
      })
    );
    expect(msg.title).toBe("operator escalation");
    expect(msg.body).toContain("Operator escalated with retry");
    expect(msg.body).toContain("Successor: child-op");
    expect(msg.body).toContain("Reason: manual unblock");
    expect(msg.body).not.toContain("automatic");
    expect(msg.body).not.toContain("safe-class");
    expect(msg.body).not.toContain("should not appear");
  });

  it("maps unrecovered halt with code, detail, and observed reason", () => {
    const msg = normalizeEvent(
      ev(1, "run.pipeline-halt-unrecovered", {
        action: "none",
        code: "not-safe-class",
        detail: "failure class is not allowlisted",
        observedReason: "auth_failed",
      })
    );
    expect(msg.role).toBe("system");
    expect(msg.tone).toBe("error");
    expect(msg.title).toBe("pipeline remains halted");
    expect(msg.body).toContain("Automatic recovery declined");
    expect(msg.body).toContain("not-safe-class");
    expect(msg.body).toContain("failure class is not allowlisted");
    expect(msg.body).toContain("Observed reason: auth_failed");
    expect(msg.body).toMatch(/operator escalation remains available/i);
  });

  it("handles null child and malformed recovery payloads safely", () => {
    const nullChild = normalizeEvent(
      ev(1, "run.pipeline-escalated", {
        action: "abort",
        actor: "operator",
        childRunId: null,
      })
    );
    expect(nullChild.body).toContain("Operator escalated with abort");
    expect(nullChild.body).not.toContain("Successor");

    const malformedEscalation = normalizeEvent(
      ev(2, "run.pipeline-escalated", { foo: "bar" })
    );
    expect(malformedEscalation.title).toBe("pipeline escalated");
    expect(malformedEscalation.body).toBe("Pipeline escalation recorded.");
    expect(malformedEscalation.body).not.toContain("<");

    const malformedUnrecovered = normalizeEvent(
      ev(3, "run.pipeline-halt-unrecovered", { code: 1 })
    );
    expect(malformedUnrecovered.tone).toBe("error");
    expect(malformedUnrecovered.title).toBe("pipeline remains halted");
    expect(malformedUnrecovered.body).toContain("Automatic recovery declined");
    expect(malformedUnrecovered.body).toMatch(
      /operator escalation remains available/i
    );
  });

  it("maps halt-discovery requested and skipped lifecycle events", () => {
    const requested = normalizeEvent(
      ev(1, "run.pipeline-halt-discovery-requested", {
        code: "unrecovered-halt",
        recoveryCode: "not-safe-class",
        recoveryDetail: "failure class is not allowlisted",
      })
    );
    expect(requested.role).toBe("system");
    expect(requested.tone).toBe("info");
    expect(requested.title).toBe("halt discovery requested");
    expect(requested.body).toContain("not-safe-class");
    expect(requested.body).not.toContain("{");

    const skipped = normalizeEvent(
      ev(2, "run.pipeline-halt-discovery-skipped", {
        code: "disabled",
        detail: "pipelineHaltDiscovery is off",
      })
    );
    expect(skipped.title).toBe("halt discovery skipped");
    expect(skipped.body).toContain("disabled");
    expect(skipped.body).toMatch(/existing source controls remain available/i);

    const malformedRequested = normalizeEvent(
      ev(3, "run.pipeline-halt-discovery-requested", { code: "other" })
    );
    expect(malformedRequested.tone).toBe("info");
    expect(malformedRequested.title).toBe("halt discovery requested");
    expect(malformedRequested.body).toBe(
      "Halt discovery requested after an unrecovered halt."
    );
    expect(malformedRequested.body).not.toContain("{");

    const malformedSkipped = normalizeEvent(
      ev(4, "run.pipeline-halt-discovery-skipped", { code: "mystery" })
    );
    expect(malformedSkipped.tone).toBe("info");
    expect(malformedSkipped.title).toBe("halt discovery skipped");
    expect(malformedSkipped.body).toMatch(
      /existing source controls remain available/i
    );
    expect(malformedSkipped.body).not.toContain("mystery");
    expect(malformedSkipped.body).not.toContain("{");
  });

  it("maps halt-discovery failed with stage/code and safe malformed fallback", () => {
    const failed = normalizeEvent(
      ev(1, "run.pipeline-halt-discovery-failed", {
        stage: "diagnosis",
        code: "worker-error",
        detail: "bounded detail only",
        advisoryRunId: "advisory-aaaaaaaa",
      })
    );
    expect(failed.tone).toBe("error");
    expect(failed.title).toBe("halt discovery failed");
    expect(failed.body).toContain("diagnosis");
    expect(failed.body).toContain("worker-error");
    expect(failed.body).toContain("Advisory: advisory");
    expect(failed.body).not.toContain("bounded detail only");
    expect(failed.body).toMatch(/operator escalation on the source remains available/i);

    const malformed = normalizeEvent(
      ev(2, "run.pipeline-halt-discovery-failed", { stage: 1 })
    );
    expect(malformed.tone).toBe("error");
    expect(malformed.title).toBe("halt discovery failed");
    expect(malformed.body).not.toContain("{");
    expect(malformed.body).not.toContain("<");
  });

  it("maps halt-discovery action-result outcomes without false recovery", () => {
    const acted = normalizeEvent(
      ev(1, "run.pipeline-halt-discovery-action-result", {
        sourceRunId: "source-aaaaaaaa",
        advisoryRunId: "advisory-bbbbbbbb",
        action: "retry",
        outcome: "acted",
        childRunId: "child-cccccccc",
      })
    );
    expect(acted.tone).toBe("info");
    expect(acted.title).toBe("halt discovery action applied");
    expect(acted.body).toContain("retry");
    expect(acted.body).toContain("Source: source-a");
    expect(acted.body).toContain("Advisory: advisory");
    expect(acted.body).toContain("Child: child-cc");

    const refused = normalizeEvent(
      ev(2, "run.pipeline-halt-discovery-action-result", {
        sourceRunId: "source-aaaaaaaa",
        advisoryRunId: "advisory-bbbbbbbb",
        action: "skip",
        outcome: "refused",
        code: "already-chained",
      })
    );
    expect(refused.tone).toBe("error");
    expect(refused.title).toBe("halt discovery action refused");
    expect(refused.body).toContain("already-chained");
    expect(refused.body).toMatch(/was not recovered/i);
    expect(refused.body).not.toMatch(/source was recovered|source recovered/i);

    const internal = normalizeEvent(
      ev(3, "run.pipeline-halt-discovery-action-result", {
        sourceRunId: "source-aaaaaaaa",
        advisoryRunId: "advisory-bbbbbbbb",
        action: "abort",
        outcome: "internal-failure",
        code: "escalate-threw",
      })
    );
    expect(internal.tone).toBe("error");
    expect(internal.title).toBe("halt discovery action failed");
    expect(internal.body).toContain("escalate-threw");
    expect(internal.body).toMatch(/was not recovered/i);

    const malformed = normalizeEvent(
      ev(4, "run.pipeline-halt-discovery-action-result", { foo: "bar" })
    );
    expect(malformed.title).toBe("halt discovery action result");
    expect(malformed.body).toBe("Halt discovery action result recorded.");
    expect(malformed.body).not.toContain("{");
  });

  it("maps halt-discovery promotion without claiming source escalation", () => {
    const promoted = normalizeEvent(
      ev(1, "run.pipeline-halt-discovery-promoted", {
        sourceRunId: "source-aaaaaaaa",
        advisoryRunId: "advisory-bbbbbbbb",
        chatId: "chatid-cccccccc",
      })
    );
    expect(promoted.tone).toBe("info");
    expect(promoted.title).toBe("halt discovery promoted to chat");
    expect(promoted.body).toContain("chatid-c");
    expect(promoted.body).toContain("Source: source-a");
    expect(promoted.body).toContain("Advisory: advisory");
    expect(promoted.body).toMatch(/was not escalated/i);
    expect(promoted.body).not.toMatch(/source was recovered|source recovered/i);

    const malformed = normalizeEvent(
      ev(2, "run.pipeline-halt-discovery-promoted", { chatId: "x" })
    );
    expect(malformed.title).toBe("halt discovery promoted to chat");
    expect(malformed.body).toMatch(/was not escalated/i);
    expect(malformed.body).not.toContain("{");
  });

  it("always preserves seq and raw", () => {
    const raw = JSON.stringify({ type: "tool_call", name: "x" });
    const msg = normalizeEvent({ seq: 7, eventType: "tool_call", payload: raw });
    expect(msg.seq).toBe(7);
    expect(msg.raw).toBe(raw);
  });

  it("extracts a shell ToolView from a success envelope", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        type: "tool_call",
        name: "shell",
        status: "completed",
        args: { command: "npm test" },
        result: {
          status: "success",
          value: {
            stdout: "ok\n",
            stderr: "warn\n",
            exitCode: 0,
            executionTime: 1200,
          },
        },
      })
    );
    expect(msg.title).toBe("Run command: npm test");
    expect(msg.tool).toEqual({
      kind: "shell",
      command: "npm test",
      stdout: "ok\n",
      stderr: "warn\n",
      exitCode: 0,
      executionTimeMs: 1200,
      truncated: false,
    });
  });

  it("extracts an edit ToolView with diffString counts", () => {
    const diff = "@@ -1,1 +1,2 @@\n-a\n+a\n+b\n";
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "edit",
        status: "completed",
        args: { path: "C:\\Code\\app\\packages\\dashboard\\src\\transcript.tsx" },
        result: {
          status: "success",
          value: { linesAdded: 1, linesRemoved: 1, diffString: diff },
        },
      })
    );
    expect(msg.title).toBe("Edit file: packages/dashboard/src/transcript.tsx");
    expect(msg.tool).toEqual({
      kind: "diff",
      path: "C:\\Code\\app\\packages\\dashboard\\src\\transcript.tsx",
      linesAdded: 1,
      linesRemoved: 1,
      diffString: diff,
      truncated: false,
    });
  });

  it("maps write linesCreated onto a diff ToolView without diffString", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "write",
        status: "completed",
        args: { path: "C:\\Code\\app\\notes.md", fileText: "hi" },
        result: {
          status: "success",
          value: { path: "C:\\Code\\app\\notes.md", linesCreated: 3, fileSize: 3 },
        },
      })
    );
    expect(msg.tool).toEqual({
      kind: "diff",
      path: "C:\\Code\\app\\notes.md",
      linesAdded: 3,
      truncated: false,
    });
    expect(msg.tool && "diffString" in msg.tool ? msg.tool.diffString : undefined).toBeUndefined();
  });

  it("extracts todos ToolView with completed/total counts", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "updateTodos",
        status: "completed",
        args: {
          todos: [
            { content: "one", status: "completed" },
            { content: "two", status: "inProgress" },
            { content: "three", status: "pending" },
          ],
        },
        result: {
          status: "success",
          value: {
            todos: [
              { content: "one", status: "completed" },
              { content: "two", status: "inProgress" },
              { content: "three", status: "pending" },
            ],
            totalCount: 3,
          },
        },
      })
    );
    expect(msg.title).toBe("Update todo list");
    expect(msg.tool).toEqual({
      kind: "todos",
      todos: [
        { content: "one", status: "completed" },
        { content: "two", status: "inProgress" },
        { content: "three", status: "pending" },
      ],
      completed: 1,
      total: 3,
      truncated: false,
    });
  });

  it("falls back to args.todos when updateTodos result is absent", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "updateTodos",
        status: "completed",
        args: {
          todos: [
            { content: "a", status: "completed" },
            { content: "b", status: "completed" },
            { content: "c", status: "cancelled" },
          ],
        },
      })
    );
    expect(msg.tool?.kind).toBe("todos");
    if (msg.tool?.kind !== "todos") throw new Error("expected todos");
    expect(msg.tool.completed).toBe(2);
    expect(msg.tool.total).toBe(3);
    expect(msg.tool.todos).toHaveLength(3);
  });

  it("ignores a nonsensical todo totalCount and counts the extracted items", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "updateTodos",
        status: "completed",
        args: { todos: [{ content: "a", status: "completed" }] },
        result: {
          status: "success",
          value: {
            todos: [{ content: "a", status: "completed" }],
            totalCount: -4,
          },
        },
      })
    );
    if (msg.tool?.kind !== "todos") throw new Error("expected todos");
    expect(msg.tool.total).toBe(1);
    expect(msg.tool.completed).toBe(1);
  });

  it("extracts an empty updateTodos list with safe zero counts", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "updateTodos",
        status: "completed",
        args: { todos: [] },
        result: {
          status: "success",
          value: { todos: [], totalCount: 0 },
        },
      })
    );
    expect(msg.title).toBe("Update todo list");
    expect(msg.tool).toEqual({
      kind: "todos",
      todos: [],
      completed: 0,
      total: 0,
      truncated: false,
    });
  });

  it("keeps Update todo list title when todos are missing from args and result", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "updateTodos",
        status: "completed",
        args: {},
        result: { status: "success", value: {} },
      })
    );
    expect(msg.title).toBe("Update todo list");
    expect(msg.tool?.kind).toBe("todos");
    if (msg.tool?.kind !== "todos") throw new Error("expected todos");
    expect(msg.tool.todos).toEqual([]);
    expect(msg.tool.completed).toBe(0);
    expect(msg.tool.total).toBe(0);
  });

  it("extracts a task ToolView from args and success value", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "task",
        status: "completed",
        args: {
          description: "Explore callers",
          prompt: "Find normalizeEvent call sites",
          subagentType: { kind: "explore", name: "explore" },
          model: "composer-2.5",
          mode: "ask",
        },
        result: {
          status: "success",
          value: {
            agentId: "sub-1",
            durationMs: 5000,
            resultSuffix: "  Three call sites.  ",
          },
        },
      })
    );
    expect(msg.title).toBe("Run agent: Explore callers");
    expect(msg.tool).toEqual({
      kind: "task",
      description: "Explore callers",
      prompt: "Find normalizeEvent call sites",
      subagentKind: "explore",
      subagentName: "explore",
      model: "composer-2.5",
      mode: "ask",
      durationMs: 5000,
      agentId: "sub-1",
      resultText: "Three call sites.",
      truncated: false,
    });
  });

  it("extracts a running task ToolView with no result", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "task",
        status: "running",
        args: {
          description: "Inspect hooks",
          prompt: "List git hooks",
          subagentType: { kind: "explore", name: "explore" },
        },
      })
    );
    expect(msg.role).toBe("tool");
    expect(msg.status).toBe("running");
    expect(msg.title).toBe("Run agent: Inspect hooks");
    expect(msg.tool?.kind).toBe("task");
    if (msg.tool?.kind !== "task") throw new Error("expected task");
    expect(msg.tool.description).toBe("Inspect hooks");
    expect(msg.tool.prompt).toBe("List git hooks");
    expect(msg.tool.subagentKind).toBe("explore");
    expect(msg.tool.resultText).toBeUndefined();
    expect(msg.tool.durationMs).toBeUndefined();
    expect(msg.tool.truncated).toBe(false);
  });

  it("preserves top-level task progress status and text", () => {
    const payload = {
      type: "task",
      status: "running",
      text: "Exploring packages/dashboard",
      agent_id: "bc-1",
      run_id: "run-9",
    };
    const msg = normalizeEvent(ev(1, "task", payload));
    expect(msg.role).toBe("task");
    expect(msg.status).toBe("running");
    expect(msg.body).toBe("Exploring packages/dashboard");
    expect(msg.title).toBe("task");
    expect(msg.raw).toBe(JSON.stringify(payload));
  });

  it("keeps args-derived task description when SDK marks result truncated", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "task",
        status: "completed",
        args: {
          description: "Deep dive",
          prompt: "Read the full transcript fidelity PRD",
          subagentType: { kind: "generalPurpose", name: "generalPurpose" },
        },
        truncated: { result: true },
        result: { status: "success", value: { resultSuffix: "partial" } },
      })
    );
    expect(msg.title).toBe("Run agent: Deep dive");
    expect(msg.tool?.kind).toBe("task");
    if (msg.tool?.kind !== "task") throw new Error("expected task");
    expect(msg.tool.description).toBe("Deep dive");
    expect(msg.tool.prompt).toBe("Read the full transcript fidelity PRD");
    expect(msg.tool.truncated).toBe(true);
  });

  it("degrades task extraction when subagentType, prompt, or args are missing/malformed", () => {
    expect(() =>
      normalizeEvent(
        ev(1, "tool_call", {
          name: "task",
          status: "completed",
          args: { description: "No type" },
          result: { status: "success", value: { resultSuffix: "ok" } },
        })
      )
    ).not.toThrow();

    const noType = normalizeEvent(
      ev(1, "tool_call", {
        name: "task",
        status: "completed",
        args: { description: "No type", prompt: "Do work" },
        result: { status: "success", value: { resultSuffix: "ok" } },
      })
    );
    expect(noType.title).toBe("Run agent: No type");
    expect(noType.tool?.kind).toBe("task");
    if (noType.tool?.kind !== "task") throw new Error("expected task");
    expect(noType.tool.subagentKind).toBeUndefined();
    expect(noType.tool.subagentName).toBeUndefined();
    expect(noType.tool.prompt).toBe("Do work");
    expect(noType.tool.resultText).toBe("ok");

    const noPrompt = normalizeEvent(
      ev(2, "tool_call", {
        name: "task",
        status: "running",
        args: {
          description: "Silent launch",
          subagentType: { kind: "explore" },
        },
      })
    );
    expect(noPrompt.title).toBe("Run agent: Silent launch");
    expect(noPrompt.tool?.kind).toBe("task");
    if (noPrompt.tool?.kind !== "task") throw new Error("expected task");
    expect(noPrompt.tool.prompt).toBeUndefined();
    expect(noPrompt.tool.subagentKind).toBe("explore");

    const badArgs = normalizeEvent(
      ev(3, "tool_call", {
        name: "task",
        status: "error",
        args: 42,
        result: { status: "error", error: "spawn failed" },
      })
    );
    expect(badArgs.title).toBe("Run agent");
    expect(badArgs.status).toBe("error");
    expect(badArgs.tool?.kind).toBe("task");
    if (badArgs.tool?.kind !== "task") throw new Error("expected task");
    expect(badArgs.tool.description).toBeUndefined();
    expect(badArgs.tool.prompt).toBeUndefined();
    expect(badArgs.tool.error).toBe("spawn failed");

    const emptyTask = normalizeEvent(ev(4, "task", { type: "task" }));
    expect(emptyTask.role).toBe("task");
    expect(emptyTask.title).toBe("task");
    expect(emptyTask.status).toBeUndefined();
    expect(emptyTask.body).toBeUndefined();
  });

  it("populates tool.error on an error envelope without content fields", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "shell",
        status: "error",
        args: { command: "npm test" },
        result: { status: "error", error: "spawn EACCES" },
      })
    );
    expect(msg.title).toBe("Run command: npm test");
    expect(msg.tool).toEqual({
      kind: "shell",
      command: "npm test",
      truncated: false,
      error: "spawn EACCES",
    });
    expect(msg.tool && "stdout" in msg.tool ? msg.tool.stdout : undefined).toBeUndefined();
    expect(msg.tool && "exitCode" in msg.tool ? msg.tool.exitCode : undefined).toBeUndefined();
  });

  it("marks truncated when SDK truncated.result is true and keeps the title", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "shell",
        status: "completed",
        args: { command: "cat huge.log" },
        truncated: { result: true },
        result: { status: "success", value: { stdout: "partial", exitCode: 0 } },
      })
    );
    expect(msg.title).toBe("Run command: cat huge.log");
    expect(msg.tool?.kind).toBe("shell");
    expect(msg.tool?.truncated).toBe(true);
  });

  it("marks truncated on store _truncated recovery and keeps the b27 title", () => {
    const original = JSON.stringify({
      type: "tool_call",
      name: "shell",
      status: "completed",
      args: { command: "npm run build" },
      result: { status: "success", value: { stdout: "x".repeat(5000), exitCode: 0 } },
    });
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        _truncated: true,
        eventType: "tool_call",
        originalBytes: original.length,
        preview: original.slice(0, 1000),
      })
    );
    expect(msg.role).toBe("tool");
    expect(msg.title).toBe("Run command: npm run build");
    expect(msg.tool?.kind).toBe("shell");
    expect(msg.tool?.truncated).toBe(true);
  });

  it("leaves unrecognized tools without a ToolView", () => {
    const msg = normalizeEvent(
      ev(1, "tool_call", {
        name: "read",
        status: "completed",
        args: { path: "C:\\Code\\app\\docs\\roadmap\\00-index.md" },
        result: { status: "success", value: { content: "x", totalLines: 1 } },
      })
    );
    expect(msg.title).toBe("Read file: docs/roadmap/00-index.md");
    expect(msg.tool).toBeUndefined();
  });

  it("never throws on malformed result envelopes", () => {
    expect(() =>
      normalizeEvent(ev(1, "tool_call", { name: "shell", args: { command: "x" }, result: null }))
    ).not.toThrow();
    expect(() =>
      normalizeEvent(ev(2, "tool_call", { name: "shell", args: { command: "x" }, result: [] }))
    ).not.toThrow();
    expect(() =>
      normalizeEvent(
        ev(3, "tool_call", {
          name: "edit",
          args: { path: "a.ts" },
          result: { status: "success" },
        })
      )
    ).not.toThrow();
    expect(() =>
      normalizeEvent(ev(4, "tool_call", { name: "shell", args: 42, result: { status: "error" } }))
    ).not.toThrow();

    const noValue = normalizeEvent(
      ev(5, "tool_call", {
        name: "shell",
        args: { command: "echo hi" },
        result: { status: "success" },
      })
    );
    expect(noValue.title).toBe("Run command: echo hi");
    expect(noValue.tool?.kind).toBe("shell");
    if (noValue.tool?.kind !== "shell") throw new Error("expected shell");
    expect(noValue.tool.stdout).toBeUndefined();

    const badArgs = normalizeEvent(
      ev(6, "tool_call", { name: "shell", args: 42, result: { status: "error", error: "nope" } })
    );
    expect(badArgs.title).toBe("Run command");
    expect(badArgs.tool?.kind).toBe("shell");
    expect(badArgs.tool?.error).toBe("nope");
  });

  it("carries thinking_duration_ms onto ChatMessage", () => {
    const msg = normalizeEvent(
      ev(1, "thinking", {
        type: "thinking",
        text: "hmm",
        thinking_duration_ms: 4500,
      })
    );
    expect(msg.role).toBe("thinking");
    expect(msg.thinkingDurationMs).toBe(4500);
  });

  it("omits thinkingDurationMs when the SDK did not report one", () => {
    const msg = normalizeEvent(ev(1, "thinking", { type: "thinking", text: "hmm" }));
    expect(msg.thinkingDurationMs).toBeUndefined();
  });
});

function assistantDelta(seq: number, text: string): StoredEvent {
  return ev(seq, "assistant", { type: "assistant", message: { content: [{ type: "text", text }] } });
}

describe("coalesceTranscript", () => {
  it("merges consecutive assistant token deltas into one bubble", () => {
    const out = coalesceTranscript([
      assistantDelta(1, "Hello"),
      assistantDelta(2, " formatted"),
      assistantDelta(3, " world"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    expect(out[0].body).toBe("Hello formatted world");
    expect(out[0].seq).toBe(1); // keyed by the first delta for a stable bubble
  });

  it("does not insert separators between deltas (preserves streamed whitespace)", () => {
    const out = coalesceTranscript([assistantDelta(1, "Back"), assistantDelta(2, "log")]);
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe("Backlog");
  });

  it("breaks the group on a non-stream event", () => {
    const out = coalesceTranscript([
      assistantDelta(1, "thinking about it"),
      ev(2, "tool_call", { type: "tool_call", name: "read", status: "completed" }),
      assistantDelta(3, "done"),
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(out[0].body).toBe("thinking about it");
    expect(out[2].body).toBe("done");
  });

  it("keeps separate assistant and thinking groups distinct", () => {
    const out = coalesceTranscript([
      ev(1, "thinking", { type: "thinking", text: "hmm" }),
      ev(2, "thinking", { type: "thinking", text: " more" }),
      assistantDelta(3, "answer"),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("thinking");
    expect(out[0].body).toBe("hmm more");
    expect(out[1].role).toBe("assistant");
  });

  it("renders a truncated assistant payload standalone, not coalesced", () => {
    const out = coalesceTranscript([
      assistantDelta(1, "partial"),
      ev(2, "assistant", { _truncated: true, originalBytes: 70000, preview: "x" }),
      assistantDelta(3, "resumed"),
    ]);
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe("system");
    expect(out[1].title).toBe("truncated payload");
  });

  it("coalesces thinking duration as the max across deltas, not a sum", () => {
    const out = coalesceTranscript([
      ev(1, "thinking", { type: "thinking", text: "a", thinking_duration_ms: 1000 }),
      ev(2, "thinking", { type: "thinking", text: "b", thinking_duration_ms: 9000 }),
      ev(3, "thinking", { type: "thinking", text: "c", thinking_duration_ms: 4500 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("thinking");
    expect(out[0].body).toBe("abc");
    expect(out[0].thinkingDurationMs).toBe(9000);
  });

  it("leaves coalesced thinkingDurationMs undefined when no delta reports one", () => {
    const out = coalesceTranscript([
      ev(1, "thinking", { type: "thinking", text: "a" }),
      ev(2, "thinking", { type: "thinking", text: "b" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].thinkingDurationMs).toBeUndefined();
  });
});
