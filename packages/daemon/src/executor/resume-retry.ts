import { AuthenticationError, CursorAgentError } from "@cursor/sdk";
import type { ActiveRun } from "./types.js";

export type ResumeRetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
};

export const DEFAULT_RESUME_RETRY_POLICY: ResumeRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 1000,
};

export class ResumeAbortError extends Error {
  constructor() {
    super("Resume aborted");
    this.name = "ResumeAbortError";
  }
}

export function resolveResumeRetryPolicy(
  partial?: Partial<ResumeRetryPolicy>
): ResumeRetryPolicy {
  return {
    maxAttempts:
      partial?.maxAttempts ?? DEFAULT_RESUME_RETRY_POLICY.maxAttempts,
    backoffMs: partial?.backoffMs ?? DEFAULT_RESUME_RETRY_POLICY.backoffMs,
  };
}

export function isAuthResumeError(err: unknown): boolean {
  if (err instanceof AuthenticationError) {
    return true;
  }
  const code = (err as { code?: unknown }).code;
  const text = `${(err as { message?: unknown }).message ?? ""}`;
  return (
    code === 16 ||
    code === "unauthenticated" ||
    /unauthenticated|ERROR_NOT_LOGGED_IN|not logged in/i.test(text)
  );
}

export function isTransientResumeError(err: unknown): boolean {
  if (isAuthResumeError(err)) {
    return false;
  }
  if (err instanceof CursorAgentError) {
    if (/not found/i.test(err.message)) {
      return true;
    }
    if (err.isRetryable) {
      return true;
    }
    return false;
  }
  if (err instanceof Error && err.name === "SpawnTimeoutError") {
    return true;
  }
  return false;
}

async function delayAbortAware(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new ResumeAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new ResumeAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort);
  });
}

export type ResumeRetryCallback = (info: {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  message: string;
}) => void;

export async function resumeWithRetry(input: {
  make: () => Promise<ActiveRun>;
  signal: AbortSignal;
  policy: ResumeRetryPolicy;
  onRetry?: ResumeRetryCallback;
}): Promise<ActiveRun> {
  const { make, signal, policy, onRetry } = input;
  const { maxAttempts, backoffMs } = policy;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) {
      throw new ResumeAbortError();
    }

    try {
      const activeRun = await make();
      if (signal.aborted) {
        try {
          await activeRun.dispose();
        } catch {
          /* ignore */
        }
        throw new ResumeAbortError();
      }
      return activeRun;
    } catch (err) {
      lastError = err;
      const message =
        err instanceof Error ? err.message : String(err);
      const canRetry =
        attempt < maxAttempts && isTransientResumeError(err);

      if (!canRetry) {
        throw err;
      }

      const delayMs = backoffMs * attempt;
      onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        message,
      });
      await delayAbortAware(delayMs, signal);
    }
  }

  throw lastError;
}
