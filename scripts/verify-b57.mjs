/**
 * b57 verification — static contract gate for review-owned phase closeout.
 *
 * Isolation (non-negotiable): boots no daemon, binds no port, performs no
 * network I/O. Reads built daemon output and docs on disk only. Fail fast when
 * dist is missing — run `npm run build` first.
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

const [
  {
    IMPLEMENT_FULLY_WORKERS,
    IMPLEMENT_FULLY_ENTRY_WORKER_KEY,
  },
] = await Promise.all([import(daemonDist)]);

const { PIPELINE_MODEL_ROLES, IMPLEMENT_FULLY_LOOP_WORKER_KEYS } = await import(
  sharedDist
);

assert(
  IMPLEMENT_FULLY_WORKERS.length === 8,
  "IMPLEMENT_FULLY_WORKERS has 8 worker specs"
);

const rolesDeclared = new Set(
  IMPLEMENT_FULLY_WORKERS.map((w) => w.modelRole).filter(Boolean)
);
for (const role of PIPELINE_MODEL_ROLES) {
  assert(
    rolesDeclared.has(role),
    `PIPELINE_MODEL_ROLES role "${role}" is declared by a worker`
  );
}

assert(
  JSON.stringify([...IMPLEMENT_FULLY_LOOP_WORKER_KEYS]) ===
    JSON.stringify(["plan-phase", "implement", "review"]),
  'IMPLEMENT_FULLY_LOOP_WORKER_KEYS is exactly ["plan-phase", "implement", "review"]'
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
  cursor = nextWorkerKey(spec);
}

assert(
  JSON.stringify(reachable) ===
    JSON.stringify(["plan-skeleton", "plan-phase", "implement", "review"]),
  "chain from plan-skeleton reaches plan-skeleton, plan-phase, implement, review"
);
assert(
  !reachable.includes("docs-commit"),
  "reachable chain from plan-skeleton never includes docs-commit"
);

const reviewWorker = workerByKey.get("review");
assert(reviewWorker != null, "review worker spec exists");
const reviewPrompt = reviewWorker.prompt;
assert(
  reviewPrompt.includes("/gc"),
  "review prompt references /gc"
);
assert(
  reviewPrompt.includes("/review-speed-implementation"),
  "review prompt references /review-speed-implementation"
);
assert(
  reviewPrompt.includes("git log") && reviewPrompt.includes("--grep="),
  "review prompt contains git log --grep= sweep fragment"
);
assert(
  !/\bamend\b/i.test(reviewPrompt),
  "review prompt contains no amend"
);

const finalGateWorker = workerByKey.get("final-gate");
assert(finalGateWorker != null, "final-gate worker spec exists");
assert(
  finalGateWorker.prompt.includes("docs({{featureSlug}}): final gate record"),
  "final-gate prompt contains docs(...): final gate record subject"
);

const protocol = readFileSync(protocolPath, "utf8");

const loopDiagramMatch = protocol.match(
  /`plan-skeleton`[\s\S]{0,120}?`plan-phase`[\s\S]{0,200}?`review`[\s\S]{0,80}?`plan-phase`/i
);
assert(loopDiagramMatch != null, "protocol loop diagram arrow chain exists");
assert(
  !loopDiagramMatch[0].includes("docs-commit"),
  "protocol loop diagram arrow chain has no docs-commit"
);
assert(
  !protocol.includes("two-commit"),
  "docs/implement-fully-protocol.md has no surviving two-commit phrase"
);

console.log("\nb57 static contract verification passed.");
