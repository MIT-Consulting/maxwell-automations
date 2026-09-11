/**
 * b63 verification — static contract gate for execute-mode (loopMode, budget,
 * remap, docs-commit prompt, protocol section).
 *
 * Isolation: boots no daemon, binds no port, performs no network I/O. Reads
 * built daemon output and docs on disk only. Fail fast when dist is missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const daemonDist = "../packages/daemon/dist/pipelines/implement-fully.js";
const sharedDist = "../packages/shared/dist/types/api.js";
const protocolPath = join(repoRoot, "docs/implement-fully-protocol.md");

if (!existsSync(join(repoRoot, "packages/daemon/dist/pipelines/implement-fully.js"))) {
  console.error("FAIL: daemon not built. Run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(join(repoRoot, "packages/shared/dist/types/api.js"))) {
  console.error("FAIL: shared package not built. Run `npm run build` first.");
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log("OK:", msg);
}

const {
  IMPLEMENT_FULLY_VARIABLES,
  IMPLEMENT_FULLY_BUDGET_FORMULA,
  IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA,
  IMPLEMENT_FULLY_PIPELINE_ID,
  IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
} = await import(sharedDist);

const {
  IMPLEMENT_FULLY_WORKERS,
  IMPLEMENT_FULLY_BUDGET_FORMULA_STRING,
  IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA_STRING,
  computeImplementFullyBudget,
  resolveExecuteModeNext,
} = await import(daemonDist);

assert(
  IMPLEMENT_FULLY_VARIABLES.includes("loopMode"),
  "IMPLEMENT_FULLY_VARIABLES contains loopMode"
);
assert(
  IMPLEMENT_FULLY_VARIABLES.length === 10,
  "IMPLEMENT_FULLY_VARIABLES has ten entries"
);

assert(
  IMPLEMENT_FULLY_BUDGET_FORMULA_STRING === IMPLEMENT_FULLY_BUDGET_FORMULA,
  "normal budget formula string matches shared export"
);
assert(
  IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA_STRING ===
    IMPLEMENT_FULLY_EXECUTE_BUDGET_FORMULA,
  "execute budget formula string matches shared export"
);
assert(
  computeImplementFullyBudget(2, "execute") === 8,
  "execute budget computes 3 × phaseCount + 2"
);
assert(
  computeImplementFullyBudget(2, "normal") === 13,
  "normal budget computes 6 × phaseCount + 1"
);

const reviewKey = "generated:review";
const docsCommitKey = "generated:docs-commit";
assert(
  resolveExecuteModeNext({
    sourceWorkerKey: "implement",
    chainNext: reviewKey,
    variables: { pipelineId: IMPLEMENT_FULLY_PIPELINE_ID, loopMode: "execute" },
  }) === docsCommitKey,
  "resolveExecuteModeNext remaps implement→review under execute"
);
assert(
  resolveExecuteModeNext({
    sourceWorkerKey: "implement",
    chainNext: reviewKey,
    variables: { pipelineId: IMPLEMENT_FULLY_PIPELINE_ID, loopMode: "normal" },
  }) === reviewKey,
  "resolveExecuteModeNext leaves review under normal"
);

const workerByKey = new Map(
  IMPLEMENT_FULLY_WORKERS.map((w) => [w.key, w])
);

function nextWorkerKey(spec) {
  const next = spec?.chain?.next;
  if (next == null) return null;
  return next.replace(/^generated:/, "");
}

const reachable = [];
let cursor = IMPLEMENT_FULLY_ENTRY_WORKER_KEY;
const seen = new Set();
while (cursor != null && !seen.has(cursor)) {
  seen.add(cursor);
  reachable.push(cursor);
  const spec = workerByKey.get(cursor);
  cursor = spec ? nextWorkerKey(spec) : null;
}

assert(
  !reachable.includes("docs-commit"),
  "static graph from plan-skeleton excludes docs-commit"
);

const docsCommitWorker = IMPLEMENT_FULLY_WORKERS.find(
  (w) => w.key === "docs-commit"
);
assert(docsCommitWorker != null, "docs-commit worker spec exists");
const docsPrompt = docsCommitWorker.prompt;
assert(
  !/unreachable/i.test(docsPrompt),
  "docs-commit prompt does not claim to be unreachable"
);
assert(
  !docsPrompt.includes("## Review Gate"),
  "docs-commit prompt has no Review Gate section heading"
);
assert(
  /Must not[\s\S]*Review Gate/i.test(docsPrompt),
  "docs-commit prompt forbids running Review Gate in Must not"
);
assert(
  docsPrompt.includes("Reachable only under `loopMode: execute`"),
  "docs-commit prompt documents execute-mode reachability"
);

const protocol = readFileSync(protocolPath, "utf8");
assert(
  protocol.includes("## Execute mode"),
  "docs/implement-fully-protocol.md contains Execute mode section"
);
assert(
  protocol.includes("3 × phaseCount + 2"),
  "protocol documents execute budget formula"
);

console.log("\nb63 static contract verification passed.");
