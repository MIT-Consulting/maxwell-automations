import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  HALT_DISCOVERY_INPUT_KIND,
  PLAN_APPROVAL_INPUT_KIND,
} from "@lca/shared";
import { openDatabase } from "../packages/daemon/src/db/index.ts";
import { InputHub } from "../packages/daemon/src/input/hub.ts";
import { isPlanApprovalShaped } from "../packages/daemon/src/input/plan-approval-shape.ts";
import { InputStore } from "../packages/daemon/src/input/store.ts";
import { notifyPlanApprovalIfApplicable } from "../packages/daemon/src/notify/plan-approval-notifications.ts";
import { isPlanApprovalShapedRequest } from "../packages/dashboard/src/planApprovalUi.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

const PLAN_APPROVAL_META = {
  kind: PLAN_APPROVAL_INPUT_KIND,
  choices: [
    { id: "approve", label: "Approve" },
    { id: "revise", label: "Revise" },
    { id: "abort", label: "Abort" },
  ],
  recommendedChoiceId: "approve",
};

function pendingRow(metadata: unknown) {
  return {
    id: "req-1",
    run_id: "run-1",
    question: "Approve the plan?",
    answer: null,
    status: "pending" as const,
    created_at: "2026-07-10 12:00:00",
    answered_at: null,
    metadata_json: JSON.stringify(metadata),
  };
}

function seedRunDb(root: string) {
  const db = openDatabase(join(root, "state.sqlite"));
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES ('ws', ?, 'WS')"
  ).run(root);
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      'auto', 'ws', 'A', 1, 'enabled', '{"type":"manual"}', 'p', 'c.yaml', 'auto'
    )`
  ).run();
  db.prepare(
    `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
     VALUES ('run', 'auto', 'ws', 'running', 'manual', 'p')`
  ).run();
  return db;
}

describe("b53 phase 2 — plan-approval shape predicate", () => {
  it("matches Guided approval kind with approve/revise/abort triad", () => {
    expect(isPlanApprovalShaped(PLAN_APPROVAL_META)).toBe(true);
    expect(
      isPlanApprovalShaped({
        ...PLAN_APPROVAL_META,
        choices: [
          ...PLAN_APPROVAL_META.choices,
          { id: "extra", label: "Extra" },
        ],
      })
    ).toBe(true);
  });

  it("rejects missing triad, wrong kind, free-form, and halt-discovery", () => {
    expect(
      isPlanApprovalShaped({
        kind: PLAN_APPROVAL_INPUT_KIND,
        choices: [{ id: "approve", label: "Approve" }],
      })
    ).toBe(false);
    expect(isPlanApprovalShaped({ kind: "other-kind", choices: [] })).toBe(
      false
    );
    expect(isPlanApprovalShaped(null)).toBe(false);
    expect(
      isPlanApprovalShaped({
        kind: HALT_DISCOVERY_INPUT_KIND,
        choices: [
          { id: "retry", label: "Retry" },
          { id: "skip", label: "Skip" },
          { id: "abort", label: "Abort" },
        ],
      })
    ).toBe(false);
  });
});

describe("b53 phase 2 — notifyPlanApprovalIfApplicable", () => {
  it("calls planApprovalRequired once for approval-shaped pending and returns true", () => {
    const planApprovalRequired = vi.fn();
    const needsInput = vi.fn();
    const logs: string[] = [];

    const handled = notifyPlanApprovalIfApplicable({
      runId: "run-1",
      question: "Approve the plan?",
      getPending: () => pendingRow(PLAN_APPROVAL_META),
      notifier: { planApprovalRequired },
      onLog: (m) => logs.push(m),
    });

    expect(handled).toBe(true);
    expect(planApprovalRequired).toHaveBeenCalledTimes(1);
    expect(planApprovalRequired).toHaveBeenCalledWith(
      "run-1",
      "Approve the plan?"
    );
    expect(logs.some((l) => /plan approval required/i.test(l))).toBe(true);
    expect(needsInput).not.toHaveBeenCalled();
  });

  it("returns false without planApprovalRequired for generic and malformed pending", () => {
    const planApprovalRequired = vi.fn();

    expect(
      notifyPlanApprovalIfApplicable({
        runId: "run-generic",
        question: "What next?",
        getPending: () => pendingRow(null),
        notifier: { planApprovalRequired },
      })
    ).toBe(false);

    expect(
      notifyPlanApprovalIfApplicable({
        runId: "run-partial",
        question: "Approve?",
        getPending: () =>
          pendingRow({
            kind: PLAN_APPROVAL_INPUT_KIND,
            choices: [{ id: "approve", label: "Approve" }],
          }),
        notifier: { planApprovalRequired },
      })
    ).toBe(false);

    expect(planApprovalRequired).not.toHaveBeenCalled();
  });

  it("does not treat halt-discovery briefing as plan approval", () => {
    const planApprovalRequired = vi.fn();
    const handled = notifyPlanApprovalIfApplicable({
      runId: "advisory-1",
      question: "Choose action",
      getPending: () =>
        pendingRow({
          kind: HALT_DISCOVERY_INPUT_KIND,
          choices: [
            { id: "retry", label: "Retry" },
            { id: "skip", label: "Skip" },
            { id: "abort", label: "Abort" },
          ],
        }),
      notifier: { planApprovalRequired },
    });
    expect(handled).toBe(false);
    expect(planApprovalRequired).not.toHaveBeenCalled();
  });
});

describe("b53 phase 2 — Input Hub approval free text", () => {
  it("accepts choice ids and Other free text for approval-shaped asks", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b53-2-approve-"));
    const db = seedRunDb(root);
    try {
      const hub = new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      });

      const choicePromise = hub.ask("run", "Approve?", PLAN_APPROVAL_META);
      hub.submitAnswer("run", "approve");
      await expect(choicePromise).resolves.toBe("approve");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts non-choice free text and rejects empty for approval-shaped asks", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b53-2-other-"));
    const db = seedRunDb(root);
    try {
      const hub = new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      });

      const otherPromise = hub.ask("run", "Approve?", PLAN_APPROVAL_META);
      hub.submitAnswer("run", "  Please revise section 3  ");
      await expect(otherPromise).resolves.toBe("Please revise section 3");

      db.prepare(
        `INSERT INTO runs (id, automation_id, workspace_id, status, trigger_kind, prompt)
         VALUES ('run2', 'auto', 'ws', 'running', 'manual', 'p')`
      ).run();
      const emptyPromise = hub.ask("run2", "Approve?", PLAN_APPROVAL_META);
      expect(() => hub.submitAnswer("run2", "   ")).toThrow(/answer is required/);
      hub.submitAnswer("run2", "abort");
      await expect(emptyPromise).resolves.toBe("abort");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps non-approval structured asks choice-id-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "lca-b53-2-structured-"));
    const db = seedRunDb(root);
    try {
      const hub = new InputHub(new InputStore(db), {
        onNeedsInput: () => {},
        onAnswered: () => {},
      });
      const meta = {
        kind: "custom-gate",
        choices: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      };
      const p = hub.ask("run", "Proceed?", meta);
      expect(() => hub.submitAnswer("run", "Yes")).toThrow(/declared choice ids/);
      hub.submitAnswer("run", "yes");
      await expect(p).resolves.toBe("yes");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("b53 phase 2 — dashboard Other affordance", () => {
  it("planApprovalUi uses shared kind and matches request metadata", () => {
    const helperSrc = readSrc("packages/dashboard/src/planApprovalUi.ts");
    expect(helperSrc).toContain("PLAN_APPROVAL_INPUT_KIND");
    expect(helperSrc).toContain("isPlanApprovalShapedRequest");

    expect(
      isPlanApprovalShapedRequest({
        id: "r1",
        runId: "run",
        question: "q",
        answer: null,
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        answeredAt: null,
        metadata: PLAN_APPROVAL_META,
      })
    ).toBe(true);
  });

  it("InputRequestPanel exposes Other control for plan-approval-shaped cards", () => {
    const panelSrc = readSrc("packages/dashboard/src/InputRequestPanel.tsx");
    expect(panelSrc).toContain("isPlanApprovalShapedRequest");
    expect(panelSrc).toContain('data-other-control="plan-approval"');
    expect(panelSrc).toContain("Other");
    expect(panelSrc).toMatch(/showOther/);
    expect(panelSrc).toMatch(/void submit\(trimmed\)/);
    expect(panelSrc).not.toMatch(/submit\(\s*["']other["']\s*\)/);
  });
});

describe("b53 phase 2 — run onNotify replace-not-double composition", () => {
  it("chains halt-discovery then plan-approval then generic needsInput", () => {
    const indexSrc = readSrc("packages/daemon/src/index.ts");
    const onNotifyIdx = indexSrc.indexOf("onNotify:");
    const chatIdx = indexSrc.indexOf("onChatNeedsInput:");
    expect(onNotifyIdx).toBeGreaterThan(-1);
    expect(chatIdx).toBeGreaterThan(onNotifyIdx);

    const onNotifyBlock = indexSrc.slice(onNotifyIdx, chatIdx);
    expect(onNotifyBlock).toContain("notifyHaltDiscoveryBriefingIfApplicable");
    expect(onNotifyBlock).toContain("notifyPlanApprovalIfApplicable");
    expect(onNotifyBlock).toMatch(
      /if \(discoveryNotified\) \{\s*return;\s*\}/
    );
    expect(onNotifyBlock).toMatch(
      /if \(!planApprovalNotified\) \{[\s\S]*notifier\.needsInput/
    );
    expect(onNotifyBlock).not.toContain("uxApprovalRequired");

    const chatBlock = indexSrc.slice(chatIdx, chatIdx + 400);
    expect(chatBlock).toContain("notifier.needsInput");
    expect(chatBlock).not.toContain("notifyPlanApprovalIfApplicable");
  });
});
