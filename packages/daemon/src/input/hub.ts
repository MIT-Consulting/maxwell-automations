import {
  INPUT_ANSWER_MAX_LENGTH,
  type InputRequestMetadata,
} from "@lca/shared";
import type { InputRequestRow } from "./store.js";
import { isPlanApprovalShaped } from "./plan-approval-shape.js";
import { InputStore, parseInputMetadataJson } from "./store.js";

export type InputHubCallbacks = {
  onNeedsInput: (runId: string, request: InputRequestRow) => void;
  onAnswered: (runId: string, request: InputRequestRow) => void;
  onNotify?: (runId: string, question: string) => void;
};

type PendingWaiter = {
  runId: string;
  requestId: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
};

export type PresentWithoutWaitResult =
  | { status: "created"; request: InputRequestRow }
  | { status: "existing"; request: InputRequestRow };

export class InputHub {
  private readonly waiters = new Map<string, PendingWaiter>();

  constructor(
    private readonly store: InputStore,
    private readonly callbacks: InputHubCallbacks
  ) {}

  /**
   * Register a question, flip the run to needs_input, and block until answered.
   * Used by the MCP `ask_user` tool (via daemon HTTP) and stream sentinel fallback.
   * `metadata` must already be schema-validated by the caller.
   */
  async ask(
    runId: string,
    question: string,
    metadata?: InputRequestMetadata | null
  ): Promise<string> {
    const existing = this.store.getPendingForRun(runId);
    if (existing) {
      throw new Error(
        `Run ${runId} already has a pending input request (${existing.id})`
      );
    }

    const row = this.store.insertPending(runId, question, metadata);
    this.callbacks.onNeedsInput(runId, row);
    this.callbacks.onNotify?.(runId, question);

    return new Promise<string>((resolve, reject) => {
      this.waiters.set(row.id, {
        runId,
        requestId: row.id,
        resolve,
        reject,
      });
    });
  }

  /**
   * Persist a durable needs-input card without registering a waiter or timeout.
   * Idempotent for `metadata.kind`: any prior same-kind request (pending,
   * answered, or cancelled) is returned and no second card is inserted.
   * A pending request of a different kind is a conflict (same as `ask`).
   * `metadata` must already be schema-validated by the caller.
   */
  presentWithoutWait(
    runId: string,
    question: string,
    metadata: InputRequestMetadata
  ): PresentWithoutWaitResult {
    const kind = metadata.kind;
    const prior = this.store.findLatestForRunByKind(runId, kind);
    if (prior) {
      return { status: "existing", request: prior };
    }

    const pending = this.store.getPendingForRun(runId);
    if (pending) {
      throw new Error(
        `Run ${runId} already has a pending input request (${pending.id})`
      );
    }

    const row = this.store.insertPending(runId, question, metadata);
    this.callbacks.onNeedsInput(runId, row);
    this.callbacks.onNotify?.(runId, question);
    return { status: "created", request: row };
  }

  /**
   * Submit an operator answer from any sink (HTTP, CLI, dashboard).
   * Structured asks require a declared choice id, except Guided plan-approval
   * gates which also accept Cursor-style Other free text. Invalid answers
   * leave the request pending.
   */
  submitAnswer(runId: string, answer: string): InputRequestRow {
    const pending = this.store.getPendingForRun(runId);
    if (!pending) {
      throw new Error(`No pending input request for run ${runId}`);
    }

    if (answer.length > INPUT_ANSWER_MAX_LENGTH) {
      throw new Error(
        `answer exceeds maximum length of ${INPUT_ANSWER_MAX_LENGTH} characters`
      );
    }

    const metadata = parseInputMetadataJson(pending.metadata_json);
    const choices = metadata?.choices;
    let accepted = answer;
    if (choices && choices.length > 0) {
      const ids = new Set(choices.map((c) => c.id));
      if (ids.has(answer)) {
        // Declared choice id — accepted as-is.
      } else if (isPlanApprovalShaped(metadata)) {
        const trimmed = answer.trim();
        if (!trimmed) {
          throw new Error("answer is required");
        }
        // Cursor-style Other free text for Guided plan-approval gates.
        accepted = trimmed;
      } else {
        throw new Error(
          `Answer must be one of the declared choice ids (${[...ids].join(", ")}); got "${answer}"`
        );
      }
    } else if (!answer.trim()) {
      throw new Error("answer is required");
    }

    const updated = this.store.answer(pending.id, accepted);
    if (!updated?.answer) {
      throw new Error(`Failed to record answer for run ${runId}`);
    }

    const waiter = this.waiters.get(pending.id);
    if (waiter) {
      this.waiters.delete(pending.id);
      waiter.resolve(accepted);
    }

    this.callbacks.onAnswered(runId, updated);
    return updated;
  }

  hasActiveWaiter(runId: string): boolean {
    for (const waiter of this.waiters.values()) {
      if (waiter.runId === runId) {
        return true;
      }
    }
    return false;
  }

  getPendingQuestion(runId: string): InputRequestRow | undefined {
    return this.store.getPendingForRun(runId);
  }

  listForRun(runId: string): InputRequestRow[] {
    return this.store.listForRun(runId);
  }

  /**
   * Exact pending → cancelled compare-and-set. Purpose-neutral; callers supply
   * the request id after their own eligibility checks.
   */
  cancelPendingById(id: string): boolean {
    return this.store.cancelPendingById(id);
  }

  cancelWaitersForRun(runId: string): void {
    for (const [id, waiter] of this.waiters) {
      if (waiter.runId === runId) {
        waiter.reject(new Error("Run cancelled"));
        this.waiters.delete(id);
      }
    }
    this.store.cancelPendingForRun(runId);
  }
}
