/**
 * Pure Node runtime floor parsing and comparison (b76).
 * No filesystem, no network — safe for dependency-light bootstraps.
 */

export type NodeFloorTuple = readonly [major: number, minor: number, patch: number];

export type ParseNodeFloorRequirementResult =
  | { ok: true; minimum: NodeFloorTuple; raw: string }
  | { ok: false; reason: string };

export type NodeFloorCheckResult =
  | { ok: true; running: NodeFloorTuple; minimum: NodeFloorTuple; requirement: string }
  | {
      ok: false;
      running: NodeFloorTuple | null;
      minimum: NodeFloorTuple | null;
      requirement: string;
      reason: string;
    };

const REQUIREMENT_RE = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/;

/** Parse a running semver (optional `v`, optional prerelease/build suffix). */
export function parseRunningNodeVersion(input: string): NodeFloorTuple | null {
  const trimmed = input.trim();
  const withPatch = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(trimmed);
  if (withPatch) {
    return [Number(withPatch[1]), Number(withPatch[2]), Number(withPatch[3])];
  }
  const withoutPatch = /^(?:v)?(\d+)\.(\d+)(?:[-+].*)?$/.exec(trimmed);
  if (withoutPatch) {
    return [Number(withoutPatch[1]), Number(withoutPatch[2]), 0];
  }
  return null;
}

/** Accept only `>=X.Y` or `>=X.Y.Z`; normalize omitted patch to zero. */
export function parseNodeFloorRequirement(input: string): ParseNodeFloorRequirementResult {
  const raw = input.trim();
  const match = REQUIREMENT_RE.exec(raw);
  if (!match) {
    return { ok: false, reason: `unsupported Node floor syntax: ${raw}` };
  }
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  return {
    ok: true,
    minimum: [Number(match[1]), Number(match[2]), patch],
    raw,
  };
}

function compareTuples(
  left: NodeFloorTuple,
  right: NodeFloorTuple
): -1 | 0 | 1 {
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! < right[i]!) return -1;
    if (left[i]! > right[i]!) return 1;
  }
  return 0;
}

/** True when `runningVersion` meets the `>=X.Y[.Z]` requirement string. */
export function satisfiesNodeFloor(
  runningVersion: string,
  requirement: string
): NodeFloorCheckResult {
  const req = parseNodeFloorRequirement(requirement);
  if (!req.ok) {
    return {
      ok: false,
      running: parseRunningNodeVersion(runningVersion),
      minimum: null,
      requirement: requirement.trim(),
      reason: req.reason,
    };
  }
  const running = parseRunningNodeVersion(runningVersion);
  if (!running) {
    return {
      ok: false,
      running: null,
      minimum: req.minimum,
      requirement: req.raw,
      reason: `could not parse running Node version: ${runningVersion}`,
    };
  }
  if (compareTuples(running, req.minimum) < 0) {
    return {
      ok: false,
      running,
      minimum: req.minimum,
      requirement: req.raw,
      reason: "running Node is below the required floor",
    };
  }
  return {
    ok: true,
    running,
    minimum: req.minimum,
    requirement: req.raw,
  };
}

export function formatRunningNodeLabel(version: string): string {
  const parsed = parseRunningNodeVersion(version);
  if (!parsed) return version.trim();
  return `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
}

export function formatNodeFloorRefusal(input: {
  requirement: string;
  running: string;
  productName?: string;
}): string {
  const product = input.productName ?? "Max";
  const req = input.requirement.trim();
  const running = formatRunningNodeLabel(input.running);
  return (
    `${product} needs Node ${req}; this machine runs ${running}. ` +
    "Install Node 22 or 24 LTS (https://nodejs.org/en/download), then re-run."
  );
}

export function parseNodeFloorFromEmbed(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.nodeFloor !== "string") return null;
  const trimmed = record.nodeFloor.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseNodeFloorFromPackageManifest(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const engines = (value as Record<string, unknown>).engines;
  if (!engines || typeof engines !== "object") return null;
  const node = (engines as Record<string, unknown>).node;
  if (typeof node !== "string") return null;
  const trimmed = node.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type ResolveNodeFloorDeps = {
  readText: (path: string) => string | null;
  startDir: string;
  dirname: (path: string) => string;
  join: (...parts: string[]) => string;
  parseRoot: (path: string) => string;
  maxDepth?: number;
};

/** Read embed beside `startDir`, then walk up for root `package.json`. */
export function resolveNodeFloorRequirement(
  deps: ResolveNodeFloorDeps
): { requirement: string | null; source: "embed" | "package.json" | null } {
  const embedText = deps.readText(deps.join(deps.startDir, "version-embed.json"));
  if (embedText) {
    const fromEmbed = parseNodeFloorFromEmbed(embedText);
    if (fromEmbed) return { requirement: fromEmbed, source: "embed" };
  }

  let current = deps.startDir;
  const fsRoot = deps.parseRoot(current);
  const maxDepth = deps.maxDepth ?? 8;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const manifestText = deps.readText(deps.join(current, "package.json"));
    if (manifestText) {
      const fromManifest = parseNodeFloorFromPackageManifest(manifestText);
      if (fromManifest) return { requirement: fromManifest, source: "package.json" };
    }
    if (current === fsRoot) break;
    const parent = deps.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { requirement: null, source: null };
}

export type BootstrapNodeFloorDecision =
  | { ok: true; requirement: string; source: "embed" | "package.json" }
  | { ok: false; message: string };

export function evaluateBootstrapNodeFloor(input: {
  runningVersion: string;
  deps: ResolveNodeFloorDeps;
  productName?: string;
}): BootstrapNodeFloorDecision {
  const resolved = resolveNodeFloorRequirement(input.deps);
  if (!resolved.requirement || !resolved.source) {
    return {
      ok: false,
      message:
        "Could not resolve the required Node version from version-embed.json or package.json.",
    };
  }
  const check = satisfiesNodeFloor(input.runningVersion, resolved.requirement);
  if (!check.ok) {
    const message =
      check.minimum === null || check.running === null
        ? check.reason
        : formatNodeFloorRefusal({
            requirement: resolved.requirement,
            running: input.runningVersion,
            productName: input.productName,
          });
    return { ok: false, message };
  }
  return {
    ok: true,
    requirement: resolved.requirement,
    source: resolved.source,
  };
}

export type GuardedBootstrapApp = {
  main: () => Promise<void>;
};

export type RunGuardedBootstrapInput = {
  runningVersion: string;
  deps: ResolveNodeFloorDeps;
  loadApp: () => Promise<GuardedBootstrapApp>;
  writeError: (message: string) => void;
  exit: (code: number) => void;
  productName?: string;
};

/**
 * Floor decision, then at most one dynamic application load.
 * `exit` must stop production bootstraps; tests may no-op it.
 */
export async function runGuardedBootstrap(
  input: RunGuardedBootstrapInput
): Promise<"refused" | "loaded"> {
  const decision = evaluateBootstrapNodeFloor({
    runningVersion: input.runningVersion,
    deps: input.deps,
    productName: input.productName,
  });
  if (!decision.ok) {
    input.writeError(decision.message);
    input.exit(1);
    return "refused";
  }
  const app = await input.loadApp();
  await app.main();
  return "loaded";
}
