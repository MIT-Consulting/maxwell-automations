/**
 * b56.3 verification — isolated Input Hub research-approval UI proof.
 *
 * Isolation (non-negotiable): own temp LCA_HOME / HOME / USERPROFILE and port
 * 3771. Never calls stop-lca-daemons, never touches :3747, never sets
 * LCA_FORCE_STOP_DAEMONS.
 *
 * Drives askAndWait through the real engine (D32). Proves the operator surface
 * only — does not assert ## Operator Review append (D33).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { INPUT_ANSWER_MAX_LENGTH } from "@lca/shared";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3771;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const RUN_ID = "run-b56-3";
const AUTO_ID = "auto-b56-3";
const RESEARCH_REL =
  "docs/roadmap/b56-verify/research.md";
const OPERATOR_COMMENT =
  "Keep the Sol path; drop the Luna detour.";

if (port === 3747) {
  console.error("verify-b56-3 must not use operator port 3747");
  process.exit(1);
}

const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevLcaHome = process.env.LCA_HOME;

const testHome = mkdtempSync(join(tmpdir(), "lca-b56-3-ui-"));
const lcaHome = join(testHome, ".cursor-local-automations");
mkdirSync(lcaHome, { recursive: true });

process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.LCA_HOME = lcaHome;

function restoreEnv() {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevLcaHome === undefined) delete process.env.LCA_HOME;
  else process.env.LCA_HOME = prevLcaHome;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bounded poll — never a bare sleep as the only completion condition. */
async function waitUntil(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(150);
  }
}

function workspaceIdFromPath(workspacePath) {
  return Buffer.from(resolve(workspacePath)).toString("base64url");
}

function statusOf(db, runId) {
  const row = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId);
  return row?.status;
}

// created_at is second-resolution, so rowid breaks ties deterministically.
function pendingRow(db, runId) {
  return db
    .prepare(
      `SELECT id, status, answer, metadata_json FROM input_requests
       WHERE run_id = ? AND status = 'pending'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(runId);
}

function answeredRows(db, runId) {
  return db
    .prepare(
      `SELECT answer, metadata_json FROM input_requests
       WHERE run_id = ? AND status = 'answered'
       ORDER BY created_at ASC, rowid ASC`
    )
    .all(runId);
}

const daemonServer = join(repoRoot, "packages/daemon/dist/http/server.js");
const dashboardIndex = join(repoRoot, "packages/dashboard/dist/index.html");
if (!existsSync(daemonServer)) {
  console.error("FAIL: daemon not built. Run `npm run build` first.");
  restoreEnv();
  process.exit(1);
}
if (!existsSync(dashboardIndex)) {
  console.error("FAIL: dashboard not built. Run `npm run build` first.");
  restoreEnv();
  process.exit(1);
}

console.log("progress: importing daemon dist under temp LCA_HOME");
const [
  { openDatabase },
  { DaemonEventBus },
  { DashboardStore },
  { startHttpServer },
  { InputHub },
  { InputStore, rowToInputRequest },
  { ChatEngine },
  { RunEngine },
  { DEFAULT_SETTINGS },
  { TriggerManager },
] = await Promise.all([
  import("../packages/daemon/dist/db/index.js"),
  import("../packages/daemon/dist/events.js"),
  import("../packages/daemon/dist/http/dashboard-store.js"),
  import("../packages/daemon/dist/http/server.js"),
  import("../packages/daemon/dist/input/hub.js"),
  import("../packages/daemon/dist/input/store.js"),
  import("../packages/daemon/dist/chats/engine.js"),
  import("../packages/daemon/dist/runs/engine.js"),
  import("../packages/daemon/dist/config/settings.js"),
  import("../packages/daemon/dist/triggers/manager.js"),
]);

const RESEARCH_REVIEW_META = {
  kind: "research-review",
  choices: [
    { id: "approve", label: "Approve as-is" },
    { id: "comment", label: "Add comments" },
  ],
  recommendedChoiceId: "approve",
  artifacts: [{ label: "research.md", path: RESEARCH_REL }],
};

const RESEARCH_COMMENTS_META = {
  kind: "research-comments",
  artifacts: [{ label: "research.md", path: RESEARCH_REL }],
};

const RESEARCH_MD = [
  "# Research",
  "",
  "## Findings",
  "Seed findings for the b56 verify harness.",
  "",
  "## Recommendation",
  "Prefer the Sol path.",
  "",
  "## Risks",
  "None for this fixture.",
  "",
  "## Open Questions",
  "None.",
  "",
].join("\n");

const hardExit = setTimeout(() => {
  console.error("Hard timeout reached.");
  restoreEnv();
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardExit.unref();

async function closeWithTimeout(browser) {
  if (!browser) return;
  await Promise.race([
    browser.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("browser.close() timed out")), CLOSE_TIMEOUT_MS)
    ),
  ]).catch(() => {});
}

function seedHarness() {
  const workspace = mkdtempSync(join(tmpdir(), "lca-b56-3-ws-"));
  const featureDir = join(workspace, "docs", "roadmap", "b56-verify");
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# b56.3 verify\n");
  writeFileSync(join(featureDir, "research.md"), RESEARCH_MD);

  writeFileSync(
    join(lcaHome, "automations.yaml"),
    [`workspaces:`, `  - ${JSON.stringify(workspace)}`, ``, `automations: []`, ``].join(
      "\n"
    )
  );

  const db = openDatabase(join(lcaHome, "state.sqlite"));
  const wsId = workspaceIdFromPath(workspace);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(wsId, resolve(workspace), "b56-3-ws");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      ?, ?, 'Research', 1, 'enabled', '{"type":"manual"}', 'research prompt',
      'config.yaml', 'generated:research'
    )`
  ).run(AUTO_ID, wsId);
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt,
      agent_id, sdk_run_id, started_at
    ) VALUES (
      ?, ?, ?, 'running', 'manual', 'Research prelude',
      'agent-b56-3', 'sdk-b56-3', datetime('now')
    )`
  ).run(RUN_ID, AUTO_ID, wsId);

  const events = new DaemonEventBus();
  const inputStore = new InputStore(db);
  const inputHub = new InputHub(inputStore, {
    onNeedsInput: (runId, request) => {
      if (statusOf(db, runId) === "running") {
        db.prepare(
          "UPDATE runs SET status = 'needs_input', updated_at = datetime('now') WHERE id = ?"
        ).run(runId);
        events.emitRunStatus(runId, "needs_input");
      }
      events.emitInputRequest(runId, rowToInputRequest(request));
    },
    onAnswered: (runId, request) => {
      if (statusOf(db, runId) === "needs_input") {
        db.prepare(
          "UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?"
        ).run(runId);
        events.emitRunStatus(runId, "running");
      }
      events.emitInputRequest(runId, rowToInputRequest(request));
    },
  });

  const fakeExecutor = {
    kind: "sdk-local",
    async spawn() {
      throw new Error("spawn must not run in b56.3 verify");
    },
    async resume() {
      throw new Error("resume must not run in b56.3 verify");
    },
  };

  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
    inputHub,
    maxConcurrentRuns: 1,
    runStallTimeoutMs: 60_000,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
  });

  return {
    testHome,
    workspace,
    wsId,
    db,
    events,
    engine,
    chatEngine,
    researchPath: join(featureDir, "research.md"),
  };
}

async function startServer(harness) {
  const triggers = new TriggerManager(harness.db, harness.engine, { port });
  return startHttpServer({
    engine: harness.engine,
    chatEngine: harness.chatEngine,
    store: new DashboardStore(harness.db),
    db: harness.db,
    events: harness.events,
    apiKey: "test-key",
    port,
    host: "127.0.0.1",
    settings: { ...DEFAULT_SETTINGS },
    triggers,
    listModels: async () => [],
  });
}

async function assertCardRendered(page, harness) {
  const approveBtn = page.locator('[data-choice-id="approve"]');
  await approveBtn.first().waitFor({ timeout: 15_000 });
  assert((await approveBtn.count()) > 0, "approve choice button renders");
  assert(
    (await page.locator('[data-choice-id="comment"]').count()) > 0,
    "comment choice button renders"
  );
  assert(
    (await page.getByText("(recommended)", { exact: false }).count()) > 0,
    "recommended choice is identified"
  );

  const artifactLink = page.getByRole("link", {
    name: "research.md",
    exact: true,
  });
  assert((await artifactLink.count()) > 0, "research.md artifact link renders");
  const href = await artifactLink.first().getAttribute("href");
  assert(typeof href === "string", "artifact link carries an href");
  const params = new URL(href, base).searchParams;
  assert(
    params.get("view") === "files" && params.get("workspace") === harness.wsId,
    "artifact link uses filesArtifactHref form (view=files, seeded workspace)"
  );
  assert(
    params.get("path") === RESEARCH_REL,
    "artifact href path is the workspace-relative seeded research.md"
  );
}

async function runUiChecks(page, harness) {
  await page.addInitScript(() => {
    window.confirm = () => true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });

  console.log("progress: ask #1 research-review via engine.askAndWait");
  const reviewPromise = harness.engine.askAndWait(
    RUN_ID,
    "## Research review\n\nApprove findings or add comments.",
    undefined,
    RESEARCH_REVIEW_META
  );

  await waitUntil(
    "run to reach needs_input for research-review",
    () =>
      statusOf(harness.db, RUN_ID) === "needs_input" && pendingRow(harness.db, RUN_ID)
        ? true
        : null
  );
  assert(
    statusOf(harness.db, RUN_ID) === "needs_input",
    "askAndWait parks run as needs_input"
  );
  assert(pendingRow(harness.db, RUN_ID) != null, "research-review request is pending");

  console.log("progress: loading dashboard");
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await assertCardRendered(page, harness);
  console.log(
    "PASS: structured research review card renders choices, recommendation, artifact"
  );

  // No-timeout: needs_input is excluded from stall candidates; backdate + sweep.
  console.log("progress: stall-sweep survival");
  harness.db
    .prepare(
      `UPDATE runs SET updated_at = datetime('now','-3600 seconds') WHERE id = ?`
    )
    .run(RUN_ID);
  harness.engine.runStallSweep();
  assert(
    statusOf(harness.db, RUN_ID) === "needs_input",
    "stall sweep leaves needs_input research run intact"
  );
  assert(
    pendingRow(harness.db, RUN_ID)?.status === "pending",
    "stall sweep leaves research-review pending"
  );

  console.log("progress: reload survival");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await assertCardRendered(page, harness);
  console.log("PASS: card survives full page reload (durable needs_input)");

  console.log("progress: click Add comments");
  await page.locator('[data-choice-id="comment"]').first().click();

  await waitUntil("first input_requests row answered with comment", () => {
    const rows = answeredRows(harness.db, RUN_ID);
    const first = rows[0];
    return first?.answer === "comment" ? first : null;
  });
  const reviewAnswer = await reviewPromise;
  assert(reviewAnswer === "comment", "askAndWait #1 resolves to comment");
  assert(
    answeredRows(harness.db, RUN_ID)[0]?.answer === "comment",
    "first row answered with exactly comment"
  );

  console.log("progress: ask #2 research-comments via engine.askAndWait");
  const commentsPromise = harness.engine.askAndWait(
    RUN_ID,
    "Add operator comments for the planner.",
    undefined,
    RESEARCH_COMMENTS_META
  );

  await waitUntil(
    "run to reach needs_input for research-comments",
    () =>
      statusOf(harness.db, RUN_ID) === "needs_input" && pendingRow(harness.db, RUN_ID)
        ? true
        : null
  );

  const freeForm = page.getByPlaceholder("Answer the agent…");
  await freeForm.waitFor({ timeout: 15_000 });
  assert(
    (await page.locator("[data-choice-id]").count()) === 0,
    "comments step shows free-form form (no choice buttons)"
  );
  assert(
    (await page.getByRole("link", { name: "research.md", exact: true }).count()) >
      0,
    "comments step keeps research.md artifact link"
  );

  console.log("progress: over-cap HTTP refusal");
  const overCapRes = await fetch(`${base}/api/runs/${encodeURIComponent(RUN_ID)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      answer: "x".repeat(INPUT_ANSWER_MAX_LENGTH + 1),
    }),
  });
  assert(overCapRes.status === 400, "over-cap answer returns HTTP 400");
  assert(
    pendingRow(harness.db, RUN_ID)?.status === "pending",
    "over-cap refusal leaves request pending"
  );

  console.log("progress: submit operator comment text");
  await freeForm.fill(OPERATOR_COMMENT);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const commentsAnswer = await commentsPromise;
  assert(
    commentsAnswer === OPERATOR_COMMENT,
    "askAndWait #2 resolves with operator text byte-for-byte"
  );

  await waitUntil("run returns to running after comments", () =>
    statusOf(harness.db, RUN_ID) === "running" ? true : null
  );
  assert(
    statusOf(harness.db, RUN_ID) === "running",
    "run returns to running after comments"
  );

  const answered = answeredRows(harness.db, RUN_ID);
  assert(answered.length === 2, "two answered input_requests rows");
  assert(
    answered[1]?.answer === OPERATOR_COMMENT,
    "second row stores operator text byte-for-byte"
  );

  const onDisk = readFileSync(harness.researchPath, "utf8");
  assert(
    onDisk.includes("## Findings") &&
      onDisk.includes("## Recommendation") &&
      onDisk.includes("## Risks") &&
      onDisk.includes("## Open Questions"),
    "research.md still on disk with original four headings"
  );
  assert(onDisk === RESEARCH_MD, "research.md content unchanged by harness");
}

async function main() {
  let browser;
  let http;
  let harness;

  try {
    harness = seedHarness();
    http = await startServer(harness);
    await sleep(400);

    console.log("progress: launching browser");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await runUiChecks(page, harness);
  } finally {
    console.log("progress: cleanup");
    await closeWithTimeout(browser);
    try {
      await http?.close();
    } catch {
      /* ignore */
    }
    try {
      await harness?.engine?.shutdown();
      await harness?.chatEngine?.shutdown();
      harness?.db?.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(testHome, { recursive: true, force: true });
      if (harness?.workspace) {
        rmSync(harness.workspace, { recursive: true, force: true });
      }
    } catch {
      /* tolerate Windows WAL locks */
    }
    restoreEnv();
    clearTimeout(hardExit);
  }
}

const result = await main()
  .then(() => {
    console.log("\nb56.3 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
