import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SkillCopyStatus } from "./doctor.js";

const ENV_PROBE_TIMEOUT_MS = 15_000;

/** Probe bundled skill install drift (shared by doctor and capabilities). */
export function probeBundledSkillStatus(
  repoRootPath: string
): { status: SkillCopyStatus; unavailableReason?: string } {
  const skillScript = join(repoRootPath, "scripts", "install-skill.mjs");
  if (!existsSync(skillScript)) {
    return {
      status: "unavailable",
      unavailableReason:
        "install-skill.mjs not found in this checkout — max skills install unavailable",
    };
  }
  try {
    const skillResult = spawnSync(process.execPath, [skillScript, "--check"], {
      encoding: "utf8",
      timeout: ENV_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const combined = `${skillResult.stdout ?? ""}${skillResult.stderr ?? ""}`;
    if (skillResult.error) {
      return {
        status: "unavailable",
        unavailableReason: skillResult.error.message,
      };
    }
    if (combined.includes("Drift detected.")) {
      return { status: "drift" };
    }
    if (combined.includes("In sync.")) {
      return { status: "in-sync" };
    }
    if (skillResult.status === 1) {
      return { status: "drift" };
    }
    if (skillResult.status === 0) {
      return { status: "in-sync" };
    }
    return {
      status: "unavailable",
      unavailableReason: `skill check exited ${skillResult.status ?? "signal"}`,
    };
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason:
        err instanceof Error ? err.message : "skill check probe failed",
    };
  }
}
