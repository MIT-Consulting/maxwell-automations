import { describe, expect, it } from "vitest";
import { summarizeRecoveryDashboardEvent } from "../packages/dashboard/src/useDashboardData.ts";

describe("summarizeRecoveryDashboardEvent", () => {
  it("summarizes daemon automatic retry and skip", () => {
    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-escalated",
        JSON.stringify({
          action: "retry",
          actor: "daemon",
          childRunId: "child-retry-aaaaaaaa",
          recoveryCode: "safe-class",
        })
      )
    ).toBe("Automatic retry → child-re");

    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-escalated",
        JSON.stringify({
          action: "skip",
          actor: "daemon",
          childRunId: null,
          recoveryCode: "safe-class",
        })
      )
    ).toBe("Automatic skip");
  });

  it("summarizes operator escalation without calling it automatic", () => {
    const line = summarizeRecoveryDashboardEvent(
      "run.pipeline-escalated",
      JSON.stringify({
        action: "retry",
        actor: "operator",
        childRunId: "child-op-cccccccc",
      })
    );
    expect(line).toBe("Operator escalated with retry → child-op");
    expect(line).not.toMatch(/automatic/i);
  });

  it("summarizes unrecovered declines with their code", () => {
    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-unrecovered",
        JSON.stringify({
          action: "none",
          code: "not-safe-class",
          detail: "failure class is not allowlisted",
          observedReason: "auth_failed",
        })
      )
    ).toBe("Automatic recovery declined (not-safe-class)");
  });

  it("falls back safely on malformed recovery payloads", () => {
    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-escalated",
        JSON.stringify({ foo: "bar" })
      )
    ).toBe("Pipeline escalated");

    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-unrecovered",
        "not json"
      )
    ).toBe("Automatic recovery declined");

    expect(
      summarizeRecoveryDashboardEvent("run.error", '{"message":"boom"}')
    ).toBeUndefined();
  });

  it("keeps missing actor generic (never guesses operator or daemon)", () => {
    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-escalated",
        JSON.stringify({ action: "skip", childRunId: "child-x" })
      )
    ).toBe("Pipeline escalated with skip → child-x");
  });
});
