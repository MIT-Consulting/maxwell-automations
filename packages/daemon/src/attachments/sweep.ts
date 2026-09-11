import type { AttachmentOwnerKind } from "@lca/shared";
import {
  AttachmentStore,
  type AttachmentOwnerKey,
} from "./store.js";
import {
  listAttachmentOwnerDirs,
  removeAttachmentOwnerDir,
} from "./storage.js";

/** Six hours between periodic orphan attachment sweeps. */
export const ATTACHMENT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const OWNER_KINDS: AttachmentOwnerKind[] = ["run", "chat"];

export type AttachmentSweepSummary = {
  metadataRowsRemoved: number;
  ownerDirsRemoved: number;
  failures: number;
};

export type AttachmentSweepDeps = {
  store: Pick<
    AttachmentStore,
    "listOrphanedOwners" | "deleteForOwner" | "ownerExists"
  >;
  /** Override for tests; defaults to `listAttachmentOwnerDirs`. */
  listOwnerDirs?: (ownerKind: AttachmentOwnerKind) => string[];
  /** Override for tests; defaults to `removeAttachmentOwnerDir`. */
  removeOwnerDir?: (ownerKind: AttachmentOwnerKind, ownerId: string) => void;
  log?: (message: string) => void;
};

export type AttachmentSweepSchedulerHandle = {
  stop: () => void;
};

export type AttachmentSweepSchedulerOptions = {
  store: AttachmentStore;
  log?: (message: string) => void;
  /** Override interval (tests). Defaults to {@link ATTACHMENT_SWEEP_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Override the one-pass sweep (tests). May return a Promise so overlap
   * guarding can be exercised with fake timers.
   */
  sweep?: () => AttachmentSweepSummary | Promise<AttachmentSweepSummary>;
};

function emptySummary(): AttachmentSweepSummary {
  return { metadataRowsRemoved: 0, ownerDirsRemoved: 0, failures: 0 };
}

function formatOwner(owner: AttachmentOwnerKey): string {
  return `${owner.ownerKind}/${owner.ownerId}`;
}

function ownerKey(ownerKind: AttachmentOwnerKind, ownerId: string): string {
  return `${ownerKind}:${ownerId}`;
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One-pass reconciliation: delete ownerless attachment metadata, then remove
 * disk-only owner directories whose run/chat no longer exists. Existing owners
 * protect their entire directory (including staged uploads).
 */
export function sweepOrphanAttachments(
  deps: AttachmentSweepDeps
): AttachmentSweepSummary {
  const summary = emptySummary();
  const listOwnerDirs = deps.listOwnerDirs ?? listAttachmentOwnerDirs;
  const removeOwnerDir = deps.removeOwnerDir ?? removeAttachmentOwnerDir;
  const log = deps.log;
  const removedDirs = new Set<string>();

  for (const owner of deps.store.listOrphanedOwners()) {
    try {
      summary.metadataRowsRemoved += deps.store.deleteForOwner(
        owner.ownerKind,
        owner.ownerId
      );
      try {
        removeOwnerDir(owner.ownerKind, owner.ownerId);
        const key = ownerKey(owner.ownerKind, owner.ownerId);
        if (!removedDirs.has(key)) {
          removedDirs.add(key);
          summary.ownerDirsRemoved += 1;
        }
      } catch (err) {
        summary.failures += 1;
        log?.(
          `Attachment sweep: failed to remove dir ${formatOwner(owner)}: ${failureMessage(err)}`
        );
      }
    } catch (err) {
      summary.failures += 1;
      log?.(
        `Attachment sweep: failed owner ${formatOwner(owner)}: ${failureMessage(err)}`
      );
    }
  }

  for (const ownerKind of OWNER_KINDS) {
    let ownerIds: string[];
    try {
      ownerIds = listOwnerDirs(ownerKind);
    } catch (err) {
      summary.failures += 1;
      log?.(
        `Attachment sweep: failed listing ${ownerKind} dirs: ${failureMessage(err)}`
      );
      continue;
    }

    for (const ownerId of ownerIds) {
      if (deps.store.ownerExists(ownerKind, ownerId)) {
        continue;
      }
      const key = ownerKey(ownerKind, ownerId);
      if (removedDirs.has(key)) {
        continue;
      }
      try {
        removeOwnerDir(ownerKind, ownerId);
        removedDirs.add(key);
        summary.ownerDirsRemoved += 1;
      } catch (err) {
        summary.failures += 1;
        log?.(
          `Attachment sweep: failed to remove disk-only ${ownerKind}/${ownerId}: ${failureMessage(err)}`
        );
      }
    }
  }

  return summary;
}

function summaryHasWork(summary: AttachmentSweepSummary): boolean {
  return (
    summary.metadataRowsRemoved > 0 ||
    summary.ownerDirsRemoved > 0 ||
    summary.failures > 0
  );
}

function formatSummary(summary: AttachmentSweepSummary): string {
  return (
    `Attachment sweep: removed ${summary.metadataRowsRemoved} metadata row(s), ` +
    `${summary.ownerDirsRemoved} owner dir(s)` +
    (summary.failures > 0 ? `, ${summary.failures} failure(s)` : "")
  );
}

/**
 * Startup pass + periodic interval. Overlapping passes are skipped; the
 * interval is `unref()`'d so it does not keep the process alive alone.
 */
export function startAttachmentSweepScheduler(
  options: AttachmentSweepSchedulerOptions
): AttachmentSweepSchedulerHandle {
  const log = options.log;
  const intervalMs = options.intervalMs ?? ATTACHMENT_SWEEP_INTERVAL_MS;
  const sweepFn =
    options.sweep ??
    (() =>
      sweepOrphanAttachments({
        store: options.store,
        log,
      }));

  let stopped = false;
  let inFlight = false;

  const runPass = (): void => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    void Promise.resolve()
      .then(() => sweepFn())
      .then((summary) => {
        if (summaryHasWork(summary)) {
          log?.(formatSummary(summary));
        }
      })
      .catch((err) => {
        log?.(`Attachment sweep: pass failed: ${failureMessage(err)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  runPass();

  const timer = setInterval(runPass, intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
