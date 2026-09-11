/**
 * Root test runner: normal Vitest lane, then a serial real-git lane.
 * Fail-fast; never retries. Importable — executable only when run as main.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const require = createRequire(import.meta.url);

/** Resource-heavy real-git files that contend under full-suite parallelism. */
export const REAL_GIT_LANE_FILES = Object.freeze([
  "tests/b36-6-worktrees.test.ts",
  "tests/b36-6-wave-actions.test.ts",
  "tests/b36-6-restart-recovery.test.ts",
  "tests/b36-6-fanout-join.test.ts",
]);

const REAL_GIT_SET = new Set(REAL_GIT_LANE_FILES);

/**
 * Real git operations on Windows routinely exceed Vitest's 5s default for a
 * single test. The lane is fail-fast and never retries, so the budget has to
 * cover the slowest honest run rather than the typical one.
 */
export const REAL_GIT_TIMEOUT_MS = 30000;

/** Flags shared by every serial real-git invocation. */
const REAL_GIT_SERIAL_ARGS = Object.freeze([
  "--no-file-parallelism",
  "--maxWorkers=1",
  `--testTimeout=${REAL_GIT_TIMEOUT_MS}`,
]);

/**
 * @param {string} [entry]
 * @returns {string}
 */
export function resolveVitestEntry(entry) {
  if (entry) return entry;
  // vitest.mjs is the package bin; it is not in "exports", so resolve via package.json.
  const vitestRoot = dirname(require.resolve("vitest/package.json"));
  return resolve(vitestRoot, "vitest.mjs");
}

/**
 * Normalize a CLI path filter for membership checks.
 * @param {string} value
 * @returns {string}
 */
function normalizeFilterPath(value) {
  return normalize(value).split(sep).join("/");
}

/**
 * Positional (non-flag) args that look like file paths.
 * @param {string[]} cliArgs
 * @returns {string[]}
 */
function explicitFileFilters(cliArgs) {
  return cliArgs.filter((arg) => !arg.startsWith("-") && /\.[cm]?[jt]sx?$/.test(arg));
}

/**
 * True when every explicit file filter is in the real-git lane (and at least one).
 * @param {string[]} cliArgs
 * @returns {boolean}
 */
export function isRealGitOnlyFilter(cliArgs) {
  const files = explicitFileFilters(cliArgs);
  if (files.length === 0) return false;
  return files.every((f) => REAL_GIT_SET.has(normalizeFilterPath(f)));
}

/**
 * @typedef {{ label: string, args: string[] }} VitestInvocation
 */

/**
 * Pure builder for Vitest child argv (node executable is separate).
 * @param {string[]} [cliArgs]
 * @param {{ vitestEntry?: string }} [opts]
 * @returns {VitestInvocation[]}
 */
export function buildVitestInvocations(cliArgs = [], opts = {}) {
  const vitestEntry = resolveVitestEntry(opts.vitestEntry);

  if (cliArgs.length === 0) {
    const excludeArgs = REAL_GIT_LANE_FILES.flatMap((file) => ["--exclude", file]);
    return [
      {
        label: "normal",
        args: [vitestEntry, "run", ...excludeArgs],
      },
      {
        label: "real-git",
        args: [
          vitestEntry,
          "run",
          ...REAL_GIT_LANE_FILES,
          ...REAL_GIT_SERIAL_ARGS,
        ],
      },
    ];
  }

  const serialArgs = isRealGitOnlyFilter(cliArgs) ? [...REAL_GIT_SERIAL_ARGS] : [];

  return [
    {
      label: "filtered",
      args: [vitestEntry, "run", ...cliArgs, ...serialArgs],
    },
  ];
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdio?: import("node:child_process").StdioOptions }} [opts]
 * @returns {Promise<number>}
 */
function defaultSpawnRunner(command, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: opts.env ?? process.env,
      stdio: opts.stdio ?? "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        // Propagate termination; never retry.
        process.kill(process.pid, signal);
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

/**
 * Run the configured lanes; return the first nonzero exit code.
 * @param {string[]} [cliArgs]
 * @param {{
 *   run?: (command: string, args: string[], opts?: object) => Promise<number>,
 *   vitestEntry?: string,
 *   execPath?: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   onLane?: (label: string) => void,
 * }} [opts]
 * @returns {Promise<number>}
 */
export async function runTestLanes(cliArgs = [], opts = {}) {
  const run = opts.run ?? defaultSpawnRunner;
  const execPath = opts.execPath ?? process.execPath;
  const invocations = buildVitestInvocations(cliArgs, {
    vitestEntry: opts.vitestEntry,
  });

  for (const inv of invocations) {
    opts.onLane?.(inv.label);
    const code = await run(execPath, inv.args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: opts.env,
    });
    if (code !== 0) return code;
  }
  return 0;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const cliArgs = process.argv.slice(2);
  try {
    const code = await runTestLanes(cliArgs, {
      onLane(label) {
        if (label === "normal") {
          console.error("[run-tests] normal lane (excluding real-git files)");
        } else if (label === "real-git") {
          console.error("[run-tests] real-git lane (serial, maxWorkers=1)");
        }
      },
    });
    process.exit(code);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
