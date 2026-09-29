import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import {
  modelSelectionKey,
  modelSelectionSummary,
  type ModelSelection,
} from "@lca/shared";

export type ModelProbeResult =
  | { ok: true }
  | { ok: false; message: string }
  | { ok: "inconclusive"; message: string };

export type ModelProbe = (selection: ModelSelection) => Promise<ModelProbeResult>;

export type ModelPreflightFailure = {
  selection: ModelSelection;
  roles: string[];
  message: string;
};

export type ModelPreflightOptions = {
  probe: ModelProbe;
  /** How long a passing selection is trusted before it is probed again. */
  successTtlMs?: number;
  now?: () => number;
  onLog?: (message: string) => void;
};

const DEFAULT_SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const PROBE_PROMPT = "Reply with exactly: ok";

/**
 * Confirms each distinct pipeline role model is accepted by the backend before
 * a kickoff creates its root run. Cursor's catalog can advertise selections the
 * backend rejects (e.g. grok-4.7 context=500k), which otherwise surface as a
 * zero-activity `sdk_error` deep into the pipeline.
 */
export class ModelPreflight {
  private readonly probe: ModelProbe;
  private readonly successTtlMs: number;
  private readonly now: () => number;
  private readonly onLog: (message: string) => void;
  private readonly passedAt = new Map<string, number>();

  constructor(options: ModelPreflightOptions) {
    this.probe = options.probe;
    this.successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onLog = options.onLog ?? (() => undefined);
  }

  async check(
    roleModels: Partial<Record<string, ModelSelection>>
  ): Promise<ModelPreflightFailure[]> {
    const byKey = new Map<string, { selection: ModelSelection; roles: string[] }>();
    for (const [role, selection] of Object.entries(roleModels)) {
      if (!selection) continue;
      const key = modelSelectionKey(selection);
      const entry = byKey.get(key);
      if (entry) entry.roles.push(role);
      else byKey.set(key, { selection, roles: [role] });
    }

    const pending = [...byKey.entries()].filter(([key]) => {
      const at = this.passedAt.get(key);
      return at === undefined || this.now() - at > this.successTtlMs;
    });

    const results = await Promise.all(
      pending.map(async ([key, entry]) => {
        let result: ModelProbeResult;
        try {
          result = await this.probe(entry.selection);
        } catch (err) {
          result = {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
        return { key, entry, result };
      })
    );

    const failures: ModelPreflightFailure[] = [];
    for (const { key, entry, result } of results) {
      const label = modelSelectionSummary(entry.selection);
      if (result.ok === true) {
        this.passedAt.set(key, this.now());
      } else if (result.ok === "inconclusive") {
        this.onLog(
          `Model preflight inconclusive for ${label} (${entry.roles.join(", ")}): ${result.message}; allowing kickoff`
        );
      } else {
        this.passedAt.delete(key);
        failures.push({
          selection: entry.selection,
          roles: entry.roles,
          message: result.message,
        });
      }
    }
    return failures;
  }
}

export function formatModelPreflightFailures(
  failures: ModelPreflightFailure[]
): string {
  const lines = failures.map(
    (f) =>
      `${f.roles.join("/")} → ${modelSelectionSummary(f.selection)}: ${f.message}`
  );
  return (
    `model preflight failed — the backend rejected ${failures.length === 1 ? "a role model" : "role models"}. ` +
    `Pick a different selection (e.g. another context/effort variant) and kick off again. ` +
    lines.join("; ")
  );
}

export function createSdkModelProbe(options: {
  apiKey: string;
  timeoutMs?: number;
}): ModelProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const cwd = join(tmpdir(), "lca-model-preflight");

  return async (selection) => {
    mkdirSync(cwd, { recursive: true });
    // Probes answer "is this selection accepted", so they load no ambient
    // settings; real pipeline runs still use settingSources: ["all"].
    const agent = await Agent.create({
      apiKey: options.apiKey,
      model: selection,
      local: { cwd, settingSources: [] },
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const run = await agent.send(PROBE_PROMPT, { model: selection });
      const settled = (async () => {
        for await (const _ of run.stream()) {
          /* drain */
        }
        return run.wait();
      })();
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const outcome = await Promise.race([settled, timeout]);
      if (outcome === "timeout") {
        if (run.supports("cancel")) await run.cancel().catch(() => undefined);
        return {
          ok: "inconclusive",
          message: `no result within ${timeoutMs}ms`,
        };
      }
      if (outcome.status === "finished") return { ok: true };
      return {
        ok: false,
        message:
          outcome.error?.message?.trim() ||
          `probe run ended with status ${outcome.status}`,
      };
    } finally {
      if (timer) clearTimeout(timer);
      await agent[Symbol.asyncDispose]().catch(() => undefined);
    }
  };
}
