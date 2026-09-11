import { describe, expect, it } from "vitest";
import {
  buildRevivePrimer,
  MAX_PRIMER_TRANSCRIPT_CHARS,
} from "../packages/daemon/src/handoff/continuePrompt.ts";
import { synthesizeTranscript } from "../packages/daemon/src/handoff/transcript.ts";

function event(event_type: string, payload: unknown): { event_type: string; payload: string } {
  return { event_type, payload: JSON.stringify(payload) };
}

describe("b32 transcript revive", () => {
  it("synthesizes conversation turns and drops control events", () => {
    const transcript = synthesizeTranscript([
      event("run.message", { role: "user", text: "Fix the bug", attachments: [{ name: "bug.txt" }] }),
      event("assistant", { message: { content: [{ type: "text", text: "I found " }] } }),
      event("assistant", { message: { content: [{ type: "text", text: "the issue." }, { type: "tool_use", name: "Read" }] } }),
      event("run.finished", { sdkStatus: "finished" }),
      event("input.delivered", { answer: "Use the safer fix." }),
    ]);
    expect(transcript).toEqual([
      { role: "user", text: "Fix the bug (attachments: bug.txt)" },
      { role: "assistant", text: "I found the issue." },
      { role: "tool", text: "Read", toolName: "Read" },
      { role: "user", text: "Use the safer fix." },
    ]);
  });

  it("skips malformed payloads", () => {
    expect(() =>
      synthesizeTranscript([
        { event_type: "assistant", payload: "not json" },
        event("run.message", { text: "still works" }),
      ])
    ).not.toThrow();
  });

  it("builds and truncates a primer", () => {
    const small = buildRevivePrimer({
      transcript: [{ role: "user", text: "Earlier" }],
      newMessage: "Continue",
    });
    expect(small.truncated).toBe(false);
    expect(small.transcriptMessages).toBe(1);
    expect(small.text.indexOf("Earlier")).toBeLessThan(small.text.lastIndexOf("Continue"));

    const large = buildRevivePrimer({
      transcript: [
        { role: "user", text: "opening" },
        { role: "assistant", text: "x".repeat(30_000) },
        { role: "user", text: "latest" },
      ],
      newMessage: "new",
    });
    expect(large.truncated).toBe(true);
    expect(large.text).toContain("opening");
    expect(large.text).toContain("latest");
    expect(large.text).toContain("older context condensed");
    // Rendered transcript stays within budget; the fixed preamble/close and the
    // new message are the only overhead on top of it.
    const overhead = 500 + "new".length;
    expect(large.text.length).toBeLessThanOrEqual(
      MAX_PRIMER_TRANSCRIPT_CHARS + overhead
    );
  });
});
