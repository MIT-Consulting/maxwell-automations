import { describe, expect, it } from "vitest";
import {
  emptyQueueEntryDetail,
  type FeatureQueueEntry,
  type QueuePreviewItem,
} from "@lca/shared";
import {
  previewMoveTarget,
  waitingDependentCount,
} from "../packages/dashboard/src/queuePreviewActions.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const WS_A = "ws-a";
const WS_B = "ws-b";

function previewItem(
  overrides: Partial<QueuePreviewItem> & Pick<QueuePreviewItem, "entryId">
): QueuePreviewItem {
  return {
    workspaceId: WS_A,
    featureId: "feat",
    featureSlug: null,
    summary: null,
    position: 1,
    after: [],
    entryDetail: emptyQueueEntryDetail(),
    createdAt: NOW,
    afterStates: [],
    readiness: "waiting",
    reason: null,
    ...overrides,
  };
}

function queueEntry(
  overrides: Partial<FeatureQueueEntry> &
    Pick<FeatureQueueEntry, "id" | "featureId" | "position" | "state">
): FeatureQueueEntry {
  return {
    workspaceId: WS_A,
    after: [],
    origin: "queue",
    runId: null,
    detail: null,
    createdAt: NOW,
    startedAt: null,
    settledAt: null,
    updatedAt: NOW,
    entryDetail: emptyQueueEntryDetail(),
    ...overrides,
  };
}

describe("previewMoveTarget", () => {
  it("returns null for up on the first movable item", () => {
    const items = [
      previewItem({ entryId: "e1", position: 1, readiness: "next" }),
      previewItem({ entryId: "e2", position: 2 }),
    ];
    expect(previewMoveTarget(items, "e1", "up")).toBeNull();
  });

  it("returns null for down on the last movable item", () => {
    const items = [
      previewItem({ entryId: "e1", position: 1, readiness: "next" }),
      previewItem({ entryId: "e2", position: 2 }),
    ];
    expect(previewMoveTarget(items, "e2", "down")).toBeNull();
  });

  it("returns null for top on the first movable item", () => {
    const items = [
      previewItem({ entryId: "e1", position: 1, readiness: "next" }),
      previewItem({ entryId: "e2", position: 2 }),
    ];
    expect(previewMoveTarget(items, "e1", "top")).toBeNull();
  });

  it("returns top for a later movable item", () => {
    const items = [
      previewItem({ entryId: "e1", position: 1, readiness: "next" }),
      previewItem({ entryId: "e2", position: 2 }),
    ];
    expect(previewMoveTarget(items, "e2", "top")).toEqual({ top: true });
  });

  it("returns before/after neighbors within the same workspace", () => {
    const items = [
      previewItem({ entryId: "e1", position: 1, readiness: "next" }),
      previewItem({ entryId: "e2", position: 2 }),
      previewItem({ entryId: "e3", position: 3 }),
    ];
    expect(previewMoveTarget(items, "e2", "up")).toEqual({ before: "e1" });
    expect(previewMoveTarget(items, "e2", "down")).toEqual({ after: "e3" });
  });

  it("skips starting rows as move neighbors", () => {
    const items = [
      previewItem({
        entryId: "start",
        position: 1,
        readiness: "starting",
        reason: "starting",
      }),
      previewItem({ entryId: "q1", position: 2, readiness: "waiting" }),
      previewItem({ entryId: "q2", position: 3, readiness: "waiting" }),
    ];
    expect(previewMoveTarget(items, "q1", "up")).toBeNull();
    expect(previewMoveTarget(items, "q1", "top")).toBeNull();
    expect(previewMoveTarget(items, "q1", "down")).toEqual({ after: "q2" });
    expect(previewMoveTarget(items, "q2", "up")).toEqual({ before: "q1" });
  });

  it("never uses a foreign-workspace row as a neighbor", () => {
    const firstWsA = previewItem({
      entryId: "a1",
      workspaceId: WS_A,
      position: 1,
      readiness: "next",
    });
    const foreign = previewItem({
      entryId: "b1",
      workspaceId: WS_B,
      position: 1,
      readiness: "next",
    });
    const secondWsA = previewItem({
      entryId: "a2",
      workspaceId: WS_A,
      position: 2,
    });
    const items = [firstWsA, foreign, secondWsA];
    expect(previewMoveTarget(items, "a2", "up")).toEqual({ before: "a1" });
  });
});

describe("waitingDependentCount", () => {
  const subject = {
    workspaceId: WS_A,
    featureId: "parent",
    entryId: "parent-row",
  };

  it("counts waiting rows that name the feature in after", () => {
    const entries = [
      queueEntry({
        id: "parent-row",
        featureId: "parent",
        position: 1,
        state: "queued",
      }),
      queueEntry({
        id: "d1",
        featureId: "child-a",
        position: 2,
        state: "queued",
        after: ["parent"],
      }),
      queueEntry({
        id: "d2",
        featureId: "child-b",
        position: 3,
        state: "blocked",
        after: ["parent"],
      }),
    ];
    expect(waitingDependentCount(entries, subject)).toBe(2);
  });

  it("ignores done and other non-waiting states", () => {
    const entries = [
      queueEntry({
        id: "parent-row",
        featureId: "parent",
        position: 1,
        state: "queued",
      }),
      queueEntry({
        id: "done-dep",
        featureId: "child",
        position: 2,
        state: "done",
        after: ["parent"],
      }),
      queueEntry({
        id: "running-dep",
        featureId: "run-child",
        position: 3,
        state: "running",
        after: ["parent"],
      }),
    ];
    expect(waitingDependentCount(entries, subject)).toBe(0);
  });

  it("ignores other workspaces and rows without the feature in after", () => {
    const entries = [
      queueEntry({
        id: "parent-row",
        featureId: "parent",
        position: 1,
        state: "queued",
      }),
      queueEntry({
        id: "foreign",
        featureId: "child",
        position: 2,
        state: "queued",
        workspaceId: WS_B,
        after: ["parent"],
      }),
      queueEntry({
        id: "unrelated",
        featureId: "other",
        position: 3,
        state: "queued",
        after: ["something-else"],
      }),
    ];
    expect(waitingDependentCount(entries, subject)).toBe(0);
  });

  it("excludes the subject entry id", () => {
    const entries = [
      queueEntry({
        id: "parent-row",
        featureId: "parent",
        position: 1,
        state: "queued",
        after: ["parent"],
      }),
    ];
    expect(waitingDependentCount(entries, subject)).toBe(0);
  });
});
