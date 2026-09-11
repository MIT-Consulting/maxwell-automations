import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const LCA_GIT_MARKER_BEGIN = "# >>> lca-git-trigger (cursor-local-automations)";
const LCA_GIT_MARKER_END = "# <<< lca-git-trigger";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const globalConfig = join(lcaHome, "automations.yaml");
const dbPath = join(lcaHome, "state.sqlite");
const port = 3748;
const base = `http://127.0.0.1:${port}`;
// File-watch now uses a real `**` glob (`.phase4-watch/**/*.ts`). The matching
// target lives in a nested dir; a sibling `.md` file is the negative control.
const watchDir = join(repoRoot, ".phase4-watch");
const watchNestedDir = join(watchDir, "nested");
const debounceTarget = join(watchNestedDir, "deep.ts");
const nonMatchTarget = join(watchNestedDir, "ignored.md");
// Real git push test fixtures (local bare remote, no network).
const bareRemoteDir = join(repoRoot, ".phase4-bare.git");
const testRemoteName = "lca-phase4-test";
const testRemoteBranch = "lca-phase4-test";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    return false;
  }
  console.log("OK:", msg);
  return true;
}

mkdirSync(lcaHome, { recursive: true });
writeFileSync(
  globalConfig,
  `workspaces:\n  - ${repoRoot.replace(/\\/g, "/")}\n\nautomations: []\n`,
  "utf8"
);

enablePhase4Yaml();

// The file-watch glob base dir must exist before the daemon arms chokidar.
rmSync(watchDir, { recursive: true, force: true });
mkdirSync(watchNestedDir, { recursive: true });
writeFileSync(debounceTarget, "seed\n", "utf8");

let log = "";
let daemon = spawn("node", ["packages/daemon/dist/index.js"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, LCA_PORT: String(port) },
});
daemon.stdout.on("data", (d) => {
  log += d.toString();
});
daemon.stderr.on("data", (d) => {
  log += d.toString();
});

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  return false;
}

function openDb() {
  return new Database(dbPath, { readonly: true });
}

function getAutomationId(nameLike) {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT id FROM automations WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 1`
    )
    .get(nameLike);
  db.close();
  return row?.id;
}

function countRuns(triggerKindLike, sinceIso) {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs
       WHERE trigger_kind LIKE ? AND created_at >= ?`
    )
    .get(triggerKindLike, sinceIso);
  db.close();
  return row?.n ?? 0;
}

async function postGitTrigger() {
  const res = await fetch(`${base}/api/triggers/git`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: repoRoot.replace(/\\/g, "/"),
      event: "post-commit",
      sha: "phase4-test-sha",
    }),
  });
  if (!res.ok) {
    throw new Error(`git trigger failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function manualTrigger(automationId) {
  const res = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ automationId }),
  });
  if (!res.ok) {
    throw new Error(`manual trigger failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function readHook() {
  const hookPath = join(repoRoot, ".git", "hooks", "post-commit");
  if (!existsSync(hookPath)) {
    return null;
  }
  return readFileSync(hookPath, "utf8");
}

function dbNow() {
  const db = openDb();
  const row = db.prepare(`SELECT datetime('now') AS now`).get();
  db.close();
  return row.now;
}

mkdirSync(join(repoRoot, ".cursor", "automations"), { recursive: true });

await sleep(1200);
assert(await waitForHealth(), "daemon HTTP /health responds");

function enablePhase4Yaml() {
  const dir = join(repoRoot, ".cursor", "automations");
  for (const file of [
    "phase4-cron.yaml",
    "phase4-git.yaml",
    "phase4-filewatch.yaml",
    "phase4-command.yaml",
  ]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace(/enabled:\s*false/, "enabled: true"), "utf8");
  }
}

const startedAt = dbNow();
assert(log.includes("Trigger subsystem active"), "daemon started trigger manager");
assert(log.includes("Triggers refreshed"), "daemon refreshed triggers on start");

// Manual trigger
const manualId = getAutomationId("Sample Hello%");
assert(Boolean(manualId), `manual automation found (${manualId})`);
const manualBody = await manualTrigger(manualId);
assert(Boolean(manualBody.runId), `manual trigger created run (${manualBody.runId})`);

// Git POST trigger
const gitBody = await postGitTrigger();
assert(
  Array.isArray(gitBody.runIds) && gitBody.runIds.length >= 1,
  `git trigger fired ${gitBody.runIds?.length ?? 0} run(s)`
);

await sleep(500);
assert(countRuns("git:%", startedAt) >= 1, "git run recorded in SQLite");

// Command trigger (non-zero exit)
await sleep(2500);
assert(countRuns("command", startedAt) >= 1, "command trigger created a run");

// File-watch debounce (target must match phase4-filewatch globs)
const fileWatchStartedAt = dbNow();
for (let i = 0; i < 6; i++) {
  writeFileSync(debounceTarget, `burst-${i}-${Date.now()}\n`, "utf8");
  await sleep(40);
}
await sleep(1500);
const fileRuns = countRuns("file-watch", fileWatchStartedAt);
assert(fileRuns >= 1, "file-watch fired at least once via ** glob (nested .ts)");
assert(fileRuns <= 2, `file-watch debounced (${fileRuns} run(s), expected 1-2)`);

// Negative control: a non-matching path (.md) inside the watched base dir must
// NOT fire, proving picomatch filtering (not just base-dir watching) works.
const negControlStartedAt = dbNow();
for (let i = 0; i < 4; i++) {
  writeFileSync(nonMatchTarget, `nomatch-${i}-${Date.now()}\n`, "utf8");
  await sleep(40);
}
await sleep(1500);
assert(
  countRuns("file-watch", negControlStartedAt) === 0,
  "file-watch ignores non-matching path (.md does not fire **/*.ts glob)"
);

// Cron (6-field / every 3s)
await sleep(4500);
assert(countRuns("cron", startedAt) >= 1, "cron scheduler fired a run");

// Git hook install + idempotency (after file-watch to avoid watcher reset)
const hook1 = readHook();
assert(Boolean(hook1), "post-commit hook exists");
assert(hook1.includes(LCA_GIT_MARKER_BEGIN), "hook contains lca marker begin");
assert(hook1.includes(LCA_GIT_MARKER_END), "hook contains lca marker end");
const markerCount1 = hook1.split(LCA_GIT_MARKER_BEGIN).length - 1;
assert(markerCount1 === 1, "hook has exactly one lca block");

const touchTs = Date.now();
writeFileSync(
  globalConfig,
  `workspaces:\n  - ${repoRoot.replace(/\\/g, "/")}\n\nautomations: []\n# touch ${touchTs}\n`,
  "utf8"
);
await sleep(1200);
const hook2 = readHook();
const markerCount2 = hook2.split(LCA_GIT_MARKER_BEGIN).length - 1;
assert(markerCount2 === 1, "re-install is idempotent (single lca block)");

// pre-push hook is installed alongside post-commit/post-merge
const prePushHookPath = join(repoRoot, ".git", "hooks", "pre-push");
assert(existsSync(prePushHookPath), "pre-push hook exists (replaces dead post-push)");

// Real git push → pre-push hook fires end to end (local bare remote, no network).
function git(args) {
  return spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

const pushStartedAt = dbNow();
rmSync(bareRemoteDir, { recursive: true, force: true });
git(["init", "--bare", bareRemoteDir]);
git(["remote", "remove", testRemoteName]);
git(["remote", "add", testRemoteName, bareRemoteDir]);
const pushResult = git(["push", testRemoteName, `HEAD:refs/heads/${testRemoteBranch}`]);
assert(
  pushResult.status === 0,
  `git push to local bare remote succeeded${
    pushResult.status === 0 ? "" : `: ${(pushResult.stderr ?? "").trim()}`
  }`
);
await sleep(1000);
assert(
  countRuns("git:pre-push", pushStartedAt) >= 1,
  "real git push fired a pre-push run end to end"
);

daemon.kill("SIGTERM");
await sleep(500);

// Tear down git push fixtures (local-only; does not touch real remotes).
git(["remote", "remove", testRemoteName]);
rmSync(bareRemoteDir, { recursive: true, force: true });
rmSync(watchDir, { recursive: true, force: true });

// Restore sample automations to disabled
for (const file of [
  "phase4-cron.yaml",
  "phase4-git.yaml",
  "phase4-filewatch.yaml",
  "phase4-command.yaml",
]) {
  const path = join(repoRoot, ".cursor", "automations", file);
  if (!existsSync(path)) continue;
  const raw = readFileSync(path, "utf8");
  writeFileSync(path, raw.replace(/enabled:\s*true/, "enabled: false"), "utf8");
}

if (process.exitCode) {
  console.error("\n--- daemon log ---\n", log);
} else {
  console.log("\nPhase 4 verification passed.");
}
