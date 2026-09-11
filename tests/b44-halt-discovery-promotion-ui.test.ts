import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HALT_DISCOVERY_INPUT_KIND, type InputRequest } from "@lca/shared";
import {
  isHaltDiscoveryBriefingPromotionEligible,
  isLocallyResumableAgentIdentity,
} from "../packages/dashboard/src/haltDiscoveryPromotionUi.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

function briefingRequest(overrides: Partial<InputRequest> = {}): InputRequest {
  const base: InputRequest = {
    id: "req-1",
    runId: "advisory-1",
    question: "Diagnosis briefing",
    answer: null,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    answeredAt: null,
    metadata: {
      kind: HALT_DISCOVERY_INPUT_KIND,
      choices: [
        { id: "retry", label: "Retry", description: "Retry source" },
        { id: "skip", label: "Skip", description: "Skip source" },
        { id: "abort", label: "Abort", description: "Abort source" },
      ],
      recommendedChoiceId: "retry",
    },
  };
  return { ...base, ...overrides };
}

describe("isLocallyResumableAgentIdentity", () => {
  it("requires non-empty agentId and sdkRunId without bc- prefix", () => {
    expect(isLocallyResumableAgentIdentity("agent-1", "sdk-1")).toBe(true);
    expect(isLocallyResumableAgentIdentity(null, "sdk-1")).toBe(false);
    expect(isLocallyResumableAgentIdentity("agent-1", null)).toBe(false);
    expect(isLocallyResumableAgentIdentity("", "sdk-1")).toBe(false);
    expect(isLocallyResumableAgentIdentity("bc-cloud", "sdk-1")).toBe(false);
  });
});

describe("isHaltDiscoveryBriefingPromotionEligible", () => {
  const onPromoteToChat = async (): Promise<void> => undefined;

  it("accepts pending halt-discovery briefing with resumability and callback", () => {
    expect(
      isHaltDiscoveryBriefingPromotionEligible({
        request: briefingRequest(),
        canPromoteToChat: true,
        onPromoteToChat,
      })
    ).toBe(true);
  });

  it.each([
    {
      name: "wrong metadata kind",
      request: briefingRequest({
        metadata: {
          kind: "guided-planning",
          choices: [{ id: "retry", label: "Retry", description: "x" }],
        },
      }),
      canPromoteToChat: true,
      onPromoteToChat,
    },
    {
      name: "missing metadata",
      request: briefingRequest({ metadata: null }),
      canPromoteToChat: true,
      onPromoteToChat,
    },
    {
      name: "generic needs_input without kind",
      request: briefingRequest({ metadata: undefined }),
      canPromoteToChat: true,
      onPromoteToChat,
    },
    {
      name: "non-pending request",
      request: briefingRequest({ status: "answered", answer: "retry" }),
      canPromoteToChat: true,
      onPromoteToChat,
    },
    {
      name: "non-resumable / cloud run",
      request: briefingRequest(),
      canPromoteToChat: false,
      onPromoteToChat,
    },
    {
      name: "absent promotion callback",
      request: briefingRequest(),
      canPromoteToChat: true,
      onPromoteToChat: undefined,
    },
    {
      name: "absent canPromoteToChat prop",
      request: briefingRequest(),
      canPromoteToChat: undefined,
      onPromoteToChat,
    },
  ] as const)("rejects $name", (row) => {
    expect(
      isHaltDiscoveryBriefingPromotionEligible({
        request: row.request,
        canPromoteToChat: row.canPromoteToChat,
        onPromoteToChat: row.onPromoteToChat,
      })
    ).toBe(false);
  });
});

describe("halt-discovery promotion UI source contracts", () => {
  const panelSrc = readSrc("packages/dashboard/src/InputRequestPanel.tsx");
  const cardsSrc = readSrc("packages/dashboard/src/cards.tsx");
  const logsSrc = readSrc("packages/dashboard/src/LogsModal.tsx");
  const appSrc = readSrc("packages/dashboard/src/App.tsx");

  it("panel imports shared kind and keeps promotion separate from onSubmit", () => {
    const helperSrc = readSrc(
      "packages/dashboard/src/haltDiscoveryPromotionUi.ts"
    );
    expect(helperSrc).toContain("HALT_DISCOVERY_INPUT_KIND");
    expect(helperSrc).toContain("isHaltDiscoveryBriefingPromotionEligible");
    expect(panelSrc).toContain("Continue diagnosis in chat");
    expect(panelSrc).toContain("isHaltDiscoveryBriefingPromotionEligible");
    expect(panelSrc).toMatch(/await onPromoteToChat\(\)/);
    expect(panelSrc).not.toMatch(/onSubmit\(\s*["']chat["']\s*\)/);
    expect(panelSrc).not.toMatch(/submit\(\s*["']chat["']\s*\)/);
    // Independent busy/error state from answer submission.
    expect(panelSrc).toMatch(/const \[promoting,/);
    expect(panelSrc).toMatch(/const \[promoteError,/);
    expect(panelSrc).toMatch(/const \[submitting,/);
    expect(panelSrc).toMatch(/const \[error,/);
  });

  it("panel suppresses duplicate in-flight promotion and surfaces backend rejection", () => {
    const promote = panelSrc.slice(
      panelSrc.indexOf("const promote = async"),
      panelSrc.indexOf("return (")
    );
    expect(promote).not.toBe("");
    // Local duplicate-click guard; backend stays authoritative for races.
    expect(promote).toMatch(/if \([^)]*promoting[^)]*\)\s*return;/);
    expect(panelSrc).toMatch(/disabled=\{promoting \|\| submitting\}/);
    // Backend conflict/not-found/ineligible flows to the promotion error path.
    expect(promote).toMatch(/catch \(err\) \{\s*setPromoteError\(/);
    expect(panelSrc).toContain("{promoteError}");
    // Rejection must not disable retry/skip/abort submission.
    expect(promote).not.toMatch(/setSubmitting\(/);
    expect(promote).not.toMatch(/setError\(/);
  });

  it("board wires resumability + App-owned promote callback without answering", () => {
    expect(cardsSrc).toContain("isLocallyResumableAgentIdentity");
    expect(cardsSrc).toContain("canPromoteToChat={isLocallyResumableAgentIdentity");
    expect(cardsSrc).toContain("onPromoteToChat={onPromoteToChat}");
    expect(cardsSrc).toContain("onSubmit={onAnswer}");

    expect(appSrc).toContain("handlePromoteSuccess");
    expect(appSrc).toMatch(
      /onPromoteToChat=\{async \(\) => \{\s*const chat = await api\.promoteRunToChat\(r\.id\);\s*handlePromoteSuccess\(chat\);/
    );
    expect(appSrc).toContain("onPromoteSuccess={handlePromoteSuccess}");
    expect(appSrc).toMatch(
      /setActiveWorkspaceId\(chat\.workspaceId\)[\s\S]*setActiveChatId\(chat\.id\)[\s\S]*setActiveView\("chat"\)/
    );
    expect(appSrc).toMatch(/handlePromoteSuccess[\s\S]*void refresh\(\)/);
    // Board promotion must not synthesize an Input Hub answer.
    expect(appSrc).not.toMatch(
      /onPromoteToChat=\{async \(\) => \{[\s\S]*api\.answer\(/
    );
  });

  it("Logs modal reuses canContinue for briefing promote and keeps terminal Continue as chat", () => {
    expect(logsSrc).toContain("canPromoteToChat={canContinue}");
    expect(logsSrc).toMatch(
      /onPromoteToChat=\{async \(\) => \{\s*const chat = await api\.promoteRunToChat\(runId\);/
    );
    expect(logsSrc).toContain("onPromoteSuccess?.(chat)");
    expect(logsSrc).toContain("onClose()");
    // Terminal header path unchanged.
    expect(logsSrc).toMatch(
      /const canPromoteToChat =\s*isTerminalStatus\(runStatus\) && canContinue && Boolean\(workspaceId\)/
    );
    expect(logsSrc).toContain("Continue as chat");
    expect(logsSrc).toMatch(/const promoteRun = async \(\) => \{/);
    // Structured answer path remains answer API, not promote.
    expect(logsSrc).toContain("onSubmit={(answer) => api.answer(runId, answer)}");
    expect(logsSrc).not.toMatch(/onSubmit=\{[^}]*promoteRunToChat/);
  });

  it("promotion invokes promoteRunToChat once per host path and never with chat answer id", () => {
    const boardPromoteCalls = (
      appSrc.match(/api\.promoteRunToChat\(r\.id\)/g) ?? []
    ).length;
    expect(boardPromoteCalls).toBe(1);

    const logsPromoteCalls = (
      logsSrc.match(/api\.promoteRunToChat\(runId\)/g) ?? []
    ).length;
    // Header promoteRun + structured briefing panel callback.
    expect(logsPromoteCalls).toBe(2);

    for (const src of [panelSrc, cardsSrc, logsSrc, appSrc]) {
      expect(src).not.toMatch(/answer\([^)]*["']chat["']/);
      expect(src).not.toMatch(/onSubmit\([^)]*["']chat["']/);
    }
  });
});
