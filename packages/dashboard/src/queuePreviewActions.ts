import type { FeatureQueueEntry, QueuePreviewItem } from "@lca/shared";

export type PreviewMoveTarget =
  | { before: string }
  | { after: string }
  | { top: true };

function movableInWorkspace(
  items: QueuePreviewItem[],
  workspaceId: string
): QueuePreviewItem[] {
  return items.filter(
    (item) =>
      item.workspaceId === workspaceId && item.readiness !== "starting"
  );
}

export function previewMoveTarget(
  items: QueuePreviewItem[],
  entryId: string,
  direction: "up" | "down" | "top"
): PreviewMoveTarget | null {
  const subject = items.find((item) => item.entryId === entryId);
  if (!subject) return null;

  const sequence = movableInWorkspace(items, subject.workspaceId);
  const index = sequence.findIndex((item) => item.entryId === entryId);
  if (index === -1) return null;

  if (direction === "up") {
    if (index === 0) return null;
    return { before: sequence[index - 1]!.entryId };
  }

  if (direction === "down") {
    if (index >= sequence.length - 1) return null;
    return { after: sequence[index + 1]!.entryId };
  }

  if (index === 0) return null;
  return { top: true };
}

export function waitingDependentCount(
  entries: FeatureQueueEntry[],
  args: { workspaceId: string; featureId: string; entryId: string }
): number {
  return entries.filter(
    (entry) =>
      entry.workspaceId === args.workspaceId &&
      (entry.state === "queued" || entry.state === "blocked") &&
      entry.after.includes(args.featureId) &&
      entry.id !== args.entryId
  ).length;
}
