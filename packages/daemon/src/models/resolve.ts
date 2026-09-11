import {
  DEFAULT_AUTOMATION_MODEL,
  normalizeModelSelection,
  type ModelSelection,
} from "@lca/shared";

const GLOBAL_DEFAULT: ModelSelection = { id: DEFAULT_AUTOMATION_MODEL };

/**
 * First non-nullish candidate wins, normalized. Corrupt candidates are skipped.
 * Always returns a selection with a non-empty id — never throws.
 */
export function resolveModelSelection(
  ...candidates: Array<ModelSelection | null | undefined>
): ModelSelection {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    try {
      return normalizeModelSelection(candidate);
    } catch {
      // Corrupt data that slipped past selectionFromStored — skip and continue.
    }
  }
  return GLOBAL_DEFAULT;
}
