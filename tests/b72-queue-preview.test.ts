import { describe, expect, it } from "vitest";
import type { FeatureQueueEntry, Run } from "@lca/shared";
import {
  readQueuePreviewFields,
  selectQueuePreview,
  visibleQueuePreviews,
} from "../packages/shared/src/feature-queue-preview.ts";
import { toFeatureQueueEntry } from "../packages/daemon/src/runs/feature-queue-store.ts";
import type { FeatureQueueEntryRow } from "../packages/daemon/src/runs/feature-queue-store.ts";
import { buildColumnMeta } from "../packages/dashboard/src/columnLayout.ts";

const WS = "ws-1";
const NOW = "2026-01-01T00:00:00.000Z";

function entry(
  overrides: Partial<FeatureQueueEntry> & Pick<FeatureQueueEntry, "id" | "featureId" | "position" | "state">
): FeatureQueueEntry {
  return {
    workspaceId: WS,
    after: [],
    runId: null,
    detail: null,
    createdAt: NOW,
    startedAt: null,
    settledAt: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function row(overrides: Partial<FeatureQueueEntryRow> & Pick<FeatureQueueEntryRow, "id">): FeatureQueueEntryRow {
  return {
    workspace_id: WS,
    feature_id: "b72",
    position: 1,
    after_json: "[]",
    kickoff_json: JSON.stringify({
      automationId: "auto-1",
      variables: {
        featureSlug: "b72-slug",
        idea: "First line summary",
      },
    }),
    state: "queued",
    run_id: null,
    detail: null,
    created_at: NOW,
    started_at: null,
    settled_at: null,
    updated_at: NOW,
    batch_digest_at: null,
    ...overrides,
  };
}

describe("b72 queue preview", () => {
  it("selectQueuePreview orders by position and omits terminal or run-bound rows", () => {
    const entries = [
      entry({ id: "e3", featureId: "c", position: 3, state: "queued" }),
      entry({ id: "e1", featureId: "a", position: 1, state: "queued" }),
      entry({ id: "e2", featureId: "b", position: 2, state: "queued" }),
      entry({ id: "d1", featureId: "done", position: 0, state: "done" }),
      entry({ id: "f1", featureId: "fail", position: 4, state: "failed" }),
      entry({ id: "x1", featureId: "x", position: 5, state: "cancelled" }),
      entry({ id: "r1", featureId: "run", position: 6, state: "queued", runId: "run-1" }),
    ];
    const preview = selectQueuePreview({ entries, slotBusy: false });
    expect(preview.map((p) => p.entryId)).toEqual(["e1", "e2", "e3"]);
    expect(preview[0]?.readiness).toBe("next");
    expect(preview[1]?.reason).toBe("queued behind a");
  });

  it("keeps unmet after rows in place while a later dep-eligible row is Next", () => {
    const entries = [
      entry({
        id: "e1",
        featureId: "a",
        position: 1,
        state: "queued",
        after: ["dep"],
      }),
      entry({ id: "e2", featureId: "b", position: 2, state: "queued" }),
      entry({ id: "dep-old", featureId: "dep", position: 1, state: "done" }),
      entry({ id: "dep-new", featureId: "dep", position: 2, state: "queued" }),
    ];
    const preview = selectQueuePreview({ entries, slotBusy: false });
    expect(preview[0]).toMatchObject({
      entryId: "e1",
      readiness: "waiting",
      reason: "after dep",
    });
    expect(preview[1]).toMatchObject({ entryId: "e2", readiness: "next" });
  });

  it("uses newest dep row — older done plus newer non-done is unsatisfied", () => {
    const entries = [
      entry({
        id: "e1",
        featureId: "a",
        position: 1,
        state: "queued",
        after: ["dep"],
      }),
      entry({ id: "dep-old", featureId: "dep", position: 1, state: "done" }),
      entry({ id: "dep-new", featureId: "dep", position: 2, state: "failed" }),
    ];
    const preview = selectQueuePreview({ entries, slotBusy: false });
    expect(preview[0]?.readiness).toBe("waiting");
    expect(preview[0]?.reason).toBe("after dep");
  });

  it("treats any running input row as queue busy and prevents Next", () => {
    const entries = [
      entry({ id: "e1", featureId: "a", position: 1, state: "queued" }),
      entry({
        id: "busy",
        featureId: "busy",
        position: 0,
        state: "running",
        runId: "run-1",
      }),
    ];
    const preview = selectQueuePreview({ entries, slotBusy: false });
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({
      readiness: "waiting",
      reason: "queue busy",
    });
  });

  it("slotBusy forces waiting for slot on the head dep-eligible row", () => {
    const entries = [
      entry({ id: "e1", featureId: "a", position: 1, state: "queued" }),
      entry({ id: "e2", featureId: "b", position: 2, state: "queued" }),
    ];
    const preview = selectQueuePreview({ entries, slotBusy: true });
    expect(preview[0]).toMatchObject({
      readiness: "waiting",
      reason: "waiting for slot",
    });
    expect(preview[1]?.reason).toBe("queued behind a");
  });

  it("blocked uses detail and running without runId is starting", () => {
    const entries = [
      entry({
        id: "b1",
        featureId: "blocked",
        position: 1,
        state: "blocked",
        detail: "  needs operator  ",
      }),
      entry({
        id: "s1",
        featureId: "start",
        position: 2,
        state: "running",
      }),
    ];
    const preview = selectQueuePreview({ entries, slotBusy: false });
    expect(preview[0]).toMatchObject({
      readiness: "blocked",
      reason: "needs operator",
    });
    expect(preview[1]).toMatchObject({
      readiness: "starting",
      reason: "starting",
    });
  });

  it("throws when entries span multiple workspaces", () => {
    expect(() =>
      selectQueuePreview({
        entries: [
          entry({ id: "e1", featureId: "a", position: 1, state: "queued" }),
          entry({
            id: "e2",
            featureId: "b",
            position: 2,
            state: "queued",
            workspaceId: "ws-2",
          }),
        ],
        slotBusy: false,
      })
    ).toThrow("selectQueuePreview expects one workspace");
  });

  it("readQueuePreviewFields parses slug, first idea line, truncation, and corrupt JSON", () => {
    const longIdea = "x".repeat(130);
    const parsed = readQueuePreviewFields(
      JSON.stringify({
        automationId: "a",
        variables: {
          featureSlug: "  my-slug  ",
          idea: `line one\nline two`,
        },
      })
    );
    expect(parsed.featureSlug).toBe("my-slug");
    expect(parsed.summary).toBe("line one");

    const truncated = readQueuePreviewFields(
      JSON.stringify({
        automationId: "a",
        variables: { idea: longIdea },
      })
    );
    expect(truncated.summary).toHaveLength(120);
    expect(truncated.summary?.endsWith("…")).toBe(true);

    expect(readQueuePreviewFields("{")).toEqual({
      featureSlug: null,
      summary: null,
    });
    expect(readQueuePreviewFields(JSON.stringify({ automationId: "a" }))).toEqual({
      featureSlug: null,
      summary: null,
    });
  });

  it("toFeatureQueueEntry copies slug and summary without kickoff", () => {
    const mapped = toFeatureQueueEntry(row({ id: "q1" }));
    expect(mapped.featureSlug).toBe("b72-slug");
    expect(mapped.summary).toBe("First line summary");
    expect(mapped).not.toHaveProperty("kickoff");
  });

  it("visibleQueuePreviews filters workspace and search", () => {
    const entries = [
      entry({
        id: "e1",
        featureId: "a",
        position: 1,
        state: "queued",
        featureSlug: "alpha-slug",
        summary: "alpha idea",
      }),
      entry({
        id: "e2",
        featureId: "b",
        position: 1,
        state: "queued",
        workspaceId: "ws-2",
        featureSlug: "beta-slug",
      }),
    ];
    const runs: Pick<Run, "workspaceId" | "status" | "pipeline">[] = [];

    const ws1 = visibleQueuePreviews({
      entries,
      runs,
      workspaceId: WS,
      workspaceOrder: [WS, "ws-2"],
      search: "",
    });
    expect(ws1).toHaveLength(1);
    expect(ws1[0]?.entryId).toBe("e1");

    const searched = visibleQueuePreviews({
      entries,
      runs,
      workspaceId: null,
      workspaceOrder: [WS, "ws-2"],
      search: "beta",
    });
    expect(searched).toHaveLength(1);
    expect(searched[0]?.featureSlug).toBe("beta-slug");
  });

  it("buildColumnMeta includes preview count in Running without liveWorkActive", () => {
    const prefs = {
      backlog: "auto" as const,
      enabled: "auto" as const,
      running: "auto" as const,
      needs_input: "auto" as const,
      completed: "auto" as const,
      failed: "auto" as const,
    };
    const meta = buildColumnMeta({
      columnPrefs: prefs,
      visibleAutomations: [{ enabled: false }, { enabled: true }],
      visibleRuns: [],
      pendingInputByRun: {},
      recentlyActiveFailed: false,
      runColumn: () => "running",
      runningPreviewCount: 2,
    });
    expect(meta.running.count).toBe(2);
    expect(meta.running.collapsed).toBe(false);
    expect(meta.backlog.collapsed).toBe(false);
    expect(meta.enabled.collapsed).toBe(false);
  });
});
