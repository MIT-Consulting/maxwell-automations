import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  triggerKindIcon,
  triggerKindLabel,
} from "../packages/dashboard/src/helpers.ts";
import { summarizeRecoveryDashboardEvent } from "../packages/dashboard/src/useDashboardData.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readDoc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

describe("summarizeRecoveryDashboardEvent — halt discovery", () => {
  it("summarizes requested and each skip code", () => {
    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-requested",
        JSON.stringify({
          code: "unrecovered-halt",
          recoveryCode: "not-safe-class",
          recoveryDetail: "failure class is not allowlisted",
        })
      )
    ).toBe("Halt discovery requested (not-safe-class)");

    for (const code of [
      "disabled",
      "wave-scoped",
      "source-resolved",
      "ineligible-source",
      "invalid-trigger",
    ] as const) {
      expect(
        summarizeRecoveryDashboardEvent(
          "run.pipeline-halt-discovery-skipped",
          JSON.stringify({ code, detail: "operator-safe detail" })
        )
      ).toBe(`Halt discovery skipped (${code})`);
    }
  });

  it("summarizes failure stage/code and action-result outcomes", () => {
    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-failed",
        JSON.stringify({
          stage: "briefing",
          code: "invalid-packet",
          detail: "bounded",
        })
      )
    ).toBe("Halt discovery failed (briefing/invalid-packet)");

    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-action-result",
        JSON.stringify({
          sourceRunId: "source-aaaaaaaa",
          advisoryRunId: "advisory-bbbbbbbb",
          action: "retry",
          outcome: "acted",
          childRunId: "child-cccccccc",
        })
      )
    ).toBe("Discovery acted retry → child-cc (source source-a)");

    const refused = summarizeRecoveryDashboardEvent(
      "run.pipeline-halt-discovery-action-result",
      JSON.stringify({
        sourceRunId: "source-aaaaaaaa",
        advisoryRunId: "advisory-bbbbbbbb",
        action: "skip",
        outcome: "refused",
        code: "already-chained",
      })
    );
    expect(refused).toBe(
      "Discovery refused skip already-chained (source source-a; not recovered)"
    );
    expect(refused?.toLowerCase()).not.toContain("source recovered");
    expect(refused?.toLowerCase()).not.toContain("source was recovered");

    const internal = summarizeRecoveryDashboardEvent(
      "run.pipeline-halt-discovery-action-result",
      JSON.stringify({
        sourceRunId: "source-aaaaaaaa",
        advisoryRunId: "advisory-bbbbbbbb",
        action: "abort",
        outcome: "internal-failure",
        code: "escalate-threw",
      })
    );
    expect(internal).toContain("internal-failure");
    expect(internal).toContain("not recovered");
    expect(internal?.toLowerCase()).not.toMatch(/source was recovered/);
  });

  it("summarizes promotion with source/chat ids and no escalation claim", () => {
    const line = summarizeRecoveryDashboardEvent(
      "run.pipeline-halt-discovery-promoted",
      JSON.stringify({
        sourceRunId: "source-aaaaaaaa",
        advisoryRunId: "advisory-bbbbbbbb",
        chatId: "chatid-cccccccc",
      })
    );
    expect(line).toBe(
      "Discovery → chat chatid-c (source source-a; not escalated)"
    );
    expect(line?.toLowerCase()).not.toContain("escalated the source");
    expect(line?.toLowerCase()).not.toContain("source recovered");
  });

  it("falls back safely on malformed discovery payloads", () => {
    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-requested",
        "not json"
      )
    ).toBe("Halt discovery requested");

    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-skipped",
        JSON.stringify({ code: "mystery" })
      )
    ).toBe("Halt discovery skipped");

    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-failed",
        JSON.stringify({ stage: "spawn" })
      )
    ).toBe("Halt discovery failed");

    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-action-result",
        JSON.stringify({ outcome: "acted" })
      )
    ).toBe("Halt discovery action result");

    expect(
      summarizeRecoveryDashboardEvent(
        "run.pipeline-halt-discovery-promoted",
        JSON.stringify({ chatId: "x" })
      )
    ).toBe("Halt discovery promoted to chat (source not escalated)");

    expect(
      summarizeRecoveryDashboardEvent("run.error", '{"message":"boom"}')
    ).toBeUndefined();
  });
});

describe("halt-discovery trigger identity", () => {
  it("labels and icons halt-discovery without a raw kind fallback", () => {
    expect(triggerKindLabel("halt-discovery")).toBe("Halt discovery");
    expect(triggerKindIcon("halt-discovery")).toBe("🩺");
    expect(triggerKindIcon("halt-discovery")).not.toBe("•");
    expect(triggerKindLabel("halt-discovery")).not.toBe("halt-discovery");
  });
});

describe("halt-discovery operator docs", () => {
  it("documents setting, env, default, and restart-loaded behavior", () => {
    const config = readDoc("docs/configuration.md");
    expect(config).toContain("pipelineHaltDiscovery");
    expect(config).toContain("LCA_PIPELINE_HALT_DISCOVERY");
    expect(config).toMatch(/pipelineHaltDiscovery[\s\S]*?`true`/);
    expect(config).toMatch(/LCA_PIPELINE_HALT_DISCOVERY[\s\S]*?Restart required/);
    expect(config).toContain("lca restart");
  });

  it("documents no-timeout best effort, escalation fallback, and promotion independence", () => {
    const troubleshooting = readDoc("docs/troubleshooting.md");
    expect(troubleshooting).toMatch(/no-timeout/i);
    expect(troubleshooting).toMatch(/best-effort/i);
    expect(troubleshooting).toContain("lca escalate");
    expect(troubleshooting).toMatch(/does \*\*not\*\* answer/);
    expect(troubleshooting).toMatch(/Promote to chat/i);
    expect(troubleshooting).toContain("disabled");
    expect(troubleshooting).toContain("wave-scoped");
    expect(troubleshooting).toContain("ineligible-source");

    const protocol = readDoc("docs/implement-fully-protocol.md");
    expect(protocol).toMatch(/Halt discovery \(best-effort post-halt advisory\)/);
    expect(protocol).toMatch(/outside.*worker transition authority/i);
    expect(protocol).toMatch(/cannot\s+call chain\/escalation tools/i);
    expect(protocol).toMatch(/does not consume transition depth/i);
    expect(protocol).toContain("LCA_PIPELINE_HALT_DISCOVERY");
    expect(protocol).toContain("lca restart");
  });
});
