/**
 * Pure derivation of pipeline identity and step/cycle labels from run metadata.
 *
 * Off-cycle workers (`research`, `plan-skeleton`, `integrate-wave`, `final-gate`)
 * always report null cycle/step. Loop-worker cycles recover any research prelude
 * offset from the worker's own loop index so legacy labels stay byte-identical.
 */

import type { ChainRunContext } from "./types/config.js";
import {
  GENERATED_CONFIG_KEY_PREFIX,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_LOOP_WORKER_KEYS,
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
} from "./types/api.js";

export type RunPipelineSummary = {
  pipelineId: string;
  featureId: string;
  featureSlug: string;
};

export type PipelineStepDescriptor = {
  /** Worker key, e.g. "implement"; null when the automation is not a generated worker. */
  workerKey: string | null;
  /** 1-based position within the loop; null for off-cycle or unknown keys. */
  stepInCycle: number | null;
  /**
   * 1-based loop cycle; null for off-cycle workers, unknown keys, or when depth
   * cannot yield a cycle ≥ 1. Independent of whether depth is 0.
   */
  cycle: number | null;
};

/** Workers that never participate in plan→implement→review cycle arithmetic. */
const OFF_CYCLE_WORKER_KEYS: ReadonlySet<string> = new Set([
  IMPLEMENT_FULLY_RESEARCH_WORKER_KEY,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY,
  IMPLEMENT_FULLY_FINAL_GATE_WORKER_KEY,
]);

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Non-negative `n mod m` (JS `%` is signed). */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Strip `generated:` from a config key; return null when the prefix is absent. */
export function workerKeyFromConfigKey(
  configKey: string | null | undefined
): string | null {
  if (configKey == null || !configKey.startsWith(GENERATED_CONFIG_KEY_PREFIX)) {
    return null;
  }
  const key = configKey.slice(GENERATED_CONFIG_KEY_PREFIX.length);
  return key.length > 0 ? key : null;
}

/**
 * Derive which loop step and cycle a run represents from its automation key and depth.
 * Unknown or incomplete input yields null fields — never throws.
 */
export function describePipelineStep(
  configKey: string | null | undefined,
  chainDepth: number | null | undefined
): PipelineStepDescriptor {
  const workerKey = workerKeyFromConfigKey(configKey);
  if (workerKey == null) {
    return { workerKey: null, stepInCycle: null, cycle: null };
  }

  if (OFF_CYCLE_WORKER_KEYS.has(workerKey)) {
    return { workerKey, stepInCycle: null, cycle: null };
  }

  const loopLen = IMPLEMENT_FULLY_LOOP_WORKER_KEYS.length;
  const idx = (IMPLEMENT_FULLY_LOOP_WORKER_KEYS as readonly string[]).indexOf(
    workerKey
  );
  if (idx < 0) {
    // Unknown / legacy non-loop keys (e.g. docs-commit): both fields null.
    return { workerKey, stepInCycle: null, cycle: null };
  }

  const stepInCycle = idx + 1;

  if (
    chainDepth == null ||
    !Number.isFinite(chainDepth) ||
    chainDepth < 0
  ) {
    return { workerKey, stepInCycle, cycle: null };
  }

  // D10: recover research-prelude offset from (depth − idx − 1) mod loopLen.
  // Offset is 0 for every non-prefixed run, so legacy labels are unchanged.
  // D11: after a wave integration, sequential depth spacing is already not a
  // clean multiple of loopLen — cycle labels stay best-effort there.
  const raw = chainDepth - idx - 1;
  const offset = mod(raw, loopLen);
  const cycle = Math.floor((raw - offset) / loopLen) + 1;
  if (cycle < 1) {
    return { workerKey, stepInCycle, cycle: null };
  }

  return { workerKey, stepInCycle, cycle };
}

/**
 * Extract the three board-safe identity strings from a chain context.
 * Returns null unless pipelineId, featureId, and featureSlug are all non-empty.
 * Never reads `idea` or `roleModels`.
 */
export function pipelineSummaryFromContext(
  context: ChainRunContext | null | undefined
): RunPipelineSummary | null {
  if (context == null) {
    return null;
  }
  const variables = context.variables;
  const pipelineId = nonEmptyString(variables.pipelineId);
  const featureId = nonEmptyString(variables.featureId);
  const featureSlug = nonEmptyString(variables.featureSlug);
  if (pipelineId == null || featureId == null || featureSlug == null) {
    return null;
  }
  return { pipelineId, featureId, featureSlug };
}
