/**
 * b50 verification — static contract gate for pause/resume and soft-steer invariants.
 *
 * Isolation: boots no daemon, binds no port, performs no network I/O. Reads built
 * output and source on disk only. Fail fast when dist is missing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

const requiredDist = [
  "packages/daemon/dist/runs/state-machine.js",
  "packages/shared/dist/types/entities.js",
  "packages/shared/dist/pipeline-kickoff.js",
  "packages/daemon/dist/runs/chain-runner.js",
];

for (const rel of requiredDist) {
  if (!existsSync(join(repoRoot, rel))) {
    console.error(`FAIL: missing built file ${rel}. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log("OK:", msg);
}

function read(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

const { canTransition } = await import("../packages/daemon/dist/runs/state-machine.js");
const entitiesSource = read("packages/shared/src/types/entities.ts");
const stateMachineSource = read("packages/daemon/src/runs/state-machine.ts");
const runStoreSource = read("packages/daemon/src/runs/store.ts");
const pipelineKickoffSource = read("packages/shared/src/pipeline-kickoff.ts");
const chainRunnerSource = read("packages/daemon/src/runs/chain-runner.ts");
const dashboardGroupingSource = read("packages/dashboard/src/pipelineGrouping.ts");
const logsModalSource = read("packages/dashboard/src/LogsModal.tsx");
const appSource = read("packages/dashboard/src/App.tsx");
const chatEngineSource = read("packages/daemon/src/chats/engine.ts");

assert(entitiesSource.includes('"paused"'), "RunStatus union includes paused");
assert(stateMachineSource.includes("paused:"), "state machine defines paused transitions");
assert(!canTransition("paused", "completed"), "no paused → completed edge");

const terminalSets = [
  ["run store TERMINAL_RUN_STATUSES", runStoreSource.match(/const TERMINAL_RUN_STATUSES = new Set<RunStatus>\(\[([\s\S]*?)\]\)/)?.[1] ?? ""],
  ["pipelineGrouping TERMINAL_STATUSES", dashboardGroupingSource.match(/const TERMINAL_STATUSES = new Set<RunStatus>\(\[([\s\S]*?)\]\)/)?.[1] ?? ""],
  ["chat engine TERMINAL_RUN_STATUSES", chatEngineSource.match(/const TERMINAL_RUN_STATUSES = new Set<RunStatus>\(\[([\s\S]*?)\]\)/)?.[1] ?? ""],
];

for (const [label, body] of terminalSets) {
  assert(!body.includes('"paused"'), `${label} excludes paused`);
}

assert(
  logsModalSource.includes(
    'return status === "completed" || status === "failed" || status === "cancelled"'
  ),
  "LogsModal isTerminalStatus excludes paused"
);
assert(
  appSource.includes('status === "completed" || status === "failed" || status === "cancelled"'),
  "App isTerminalRun excludes paused"
);

assert(
  !runStoreSource.includes("status IN ('running', 'needs_input', 'paused')") ||
    runStoreSource.includes("listResumableRuns(): RunRow[]"),
  "listResumableRuns present"
);
assert(
  !runStoreSource.match(/listResumableRuns[\s\S]*?'paused'/),
  "listResumableRuns excludes paused"
);
assert(
  !runStoreSource.match(/listStallCandidates[\s\S]*?'paused'/),
  "listStallCandidates excludes paused"
);
assert(
  !runStoreSource.match(/listOrphanedActiveRuns[\s\S]*?'paused'/),
  "listOrphanedActiveRuns excludes paused"
);
assert(
  !runStoreSource.match(/deleteTerminalRuns[\s\S]*?'paused'/),
  "deleteTerminalRuns excludes paused"
);

assert(
  pipelineKickoffSource.includes('"paused"') &&
    pipelineKickoffSource.includes("ACTIVE_PIPELINE_STATUSES"),
  "ACTIVE_PIPELINE_STATUSES includes paused"
);
assert(
  runStoreSource.includes("status IN ('running', 'needs_input', 'paused')"),
  "countActiveRuns includes paused"
);

assert(
  chainRunnerSource.includes('message.status !== "completed"') &&
    chainRunnerSource.includes('message.status !== "failed"'),
  "ChainRunner run_status subscription ignores non-terminal statuses (incl. paused)"
);
assert(
  !chainRunnerSource.includes('message.status === "paused"'),
  "ChainRunner never handles paused as terminal"
);

assert(
  chainRunnerSource.includes('if (status === "failed" && contextAware)') &&
    runStoreSource.includes("WHERE status = 'failed'") &&
    runStoreSource.includes("listPipelineHaltRecoveryCandidates"),
  "b43/b44 recovery candidate queries key on failed only"
);

const runStoreFiles = readdirSync(join(repoRoot, "packages/daemon/src/runs")).filter(
  (name) => name.endsWith(".ts")
);
const enqueueCallSites = [];
for (const file of runStoreFiles) {
  const text = read(join("packages/daemon/src/runs", file));
  if (text.includes(".enqueueQueuedMessage(")) {
    enqueueCallSites.push(file);
  }
}
assert(
  enqueueCallSites.length === 1 && enqueueCallSites[0] === "engine.ts",
  "only RunEngine calls RunStore.enqueueQueuedMessage in packages/daemon/src/runs"
);

console.log("\nb50 static contract verification passed.");
