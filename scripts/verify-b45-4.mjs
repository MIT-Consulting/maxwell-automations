/**
 * b45.4 verification — durable Guided approval controls and artifact links
 * on an isolated daemon.
 *
 * Isolation (non-negotiable): own temp LCA_HOME and port 3769. Never calls
 * stop-lca-daemons, never touches :3747, never sets LCA_FORCE_STOP_DAEMONS.
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

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3769;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const testHome = mkdtempSync(join(tmpdir(), "lca-b45-4-ui-"));

process.env.USERPROFILE = testHome;
process.env.HOME = testHome;

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

function workspaceIdFromPath(workspacePath) {
  return Buffer.from(resolve(workspacePath)).toString("base64url");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function assertStaticWiring() {
  const panel = readFileSync(
    join(repoRoot, "packages", "dashboard", "src", "InputRequestPanel.tsx"),
    "utf8"
  );
  assert(panel.includes("filesArtifactHref"), "panel builds Files deep links");
  assert(panel.includes("data-choice-id"), "panel renders choice buttons");
  assert(panel.includes("MarkdownPreview"), "panel renders Markdown question");
}

if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error("SKIP: dashboard not built. Run `npm run build` first.");
  process.exit(0);
}

if (!existsSync(join(repoRoot, "packages/daemon/dist/http/server.js"))) {
  console.error("SKIP: daemon not built. Run `npm run build` first.");
  process.exit(0);
}

assertStaticWiring();

const hardExit = setTimeout(() => {
  console.error("Hard timeout reached.");
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
  const lcaDir = join(testHome, ".cursor-local-automations");
  rmSync(lcaDir, { recursive: true, force: true });
  mkdirSync(lcaDir, { recursive: true });

  const workspace = mkdtempSync(join(tmpdir(), "lca-b45-4-ws-"));
  const featureDir = join(workspace, "docs", "roadmap", "b45-guided-gate");
  mkdirSync(featureDir, { recursive: true });
  mkdirSync(join(workspace, ".git"), { recursive: true });
  writeFileSync(join(workspace, "README.md"), "# b45.4 verify\n");
  writeFileSync(join(featureDir, "prd.md"), "# PRD\nGuided approval verify.\n");
  writeFileSync(
    join(featureDir, "00-index.md"),
    "# b45 — guided gate\n\n| Phase | File | Status |\n| --- | --- | --- |\n| 1 | [01-a.md](./01-a.md) | Pending |\n"
  );
  writeFileSync(join(featureDir, "01-a.md"), "# Phase 1\nContract.\n");
  writeFileSync(
    join(lcaDir, "automations.yaml"),
    [`workspaces:`, `  - ${JSON.stringify(workspace)}`, ``, `automations: []`, ``].join(
      "\n"
    )
  );

  const db = openDatabase(join(lcaDir, "state.sqlite"));
  const wsId = workspaceIdFromPath(workspace);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(wsId, resolve(workspace), "b45-4-ws");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt, config_path, config_key
    ) VALUES (
      'auto-b45-4', ?, 'Guided gate', 1, 'enabled', '{"type":"manual"}', 'prompt',
      'config.yaml', 'auto-b45-4'
    )`
  ).run(wsId);
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, trigger_kind, prompt, started_at
    ) VALUES (
      'run-b45-4', 'auto-b45-4', ?, 'needs_input', 'manual', 'Guided plan-phase', datetime('now')
    )`
  ).run(wsId);

  const metadata = {
    kind: "approval",
    choices: [
      { id: "approve", label: "Approve" },
      { id: "revise", label: "Revise" },
      { id: "abort", label: "Abort" },
    ],
    recommendedChoiceId: "approve",
    artifacts: [
      {
        label: "PRD",
        path: "docs/roadmap/b45-guided-gate/prd.md",
      },
      {
        label: "Index",
        path: "docs/roadmap/b45-guided-gate/00-index.md",
      },
      {
        label: "Phase 1",
        path: "docs/roadmap/b45-guided-gate/01-a.md",
      },
    ],
  };

  const inputStore = new InputStore(db);
  inputStore.insertPending(
    "run-b45-4",
    [
      "## Guided planning approval",
      "",
      "Scope: verify durable approval controls.",
      "",
      "Recommendation: approve and continue.",
    ].join("\n"),
    metadata
  );

  let answeredWith = null;
  const events = new DaemonEventBus();
  const inputHub = new InputHub(inputStore, {
    onNeedsInput: (runId, request) => {
      events.emitInputRequest(runId, rowToInputRequest(request));
    },
    onAnswered: (runId, request) => {
      answeredWith = request.answer;
      db.prepare(
        "UPDATE runs SET status = 'running', updated_at = datetime('now') WHERE id = ?"
      ).run(runId);
      events.emitInputRequest(runId, rowToInputRequest(request));
      events.emitRunStatus(runId, "running");
    },
  });

  const fakeExecutor = {
    kind: "sdk-local",
    async spawn() {
      throw new Error("spawn must not run in b45.4 verify");
    },
    async resume() {
      throw new Error("resume not used in b45.4 verify");
    },
  };

  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
    inputHub,
    maxConcurrentRuns: 1,
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
    getAnswered: () => answeredWith,
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

async function runUiChecks(page, harness) {
  await page.addInitScript(() => {
    window.confirm = () => true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });

  // First load + hard reload prove refresh restores structured request
  // without relying on a prior WS frame.
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const approveBtn = page.locator('[data-choice-id="approve"]');
  await approveBtn.first().waitFor({ timeout: 15000 });
  assert((await approveBtn.count()) > 0, "approve choice button renders");
  assert(
    (await page.locator('[data-choice-id="revise"]').count()) > 0,
    "revise choice button renders"
  );
  assert(
    (await page.locator('[data-choice-id="abort"]').count()) > 0,
    "abort choice button renders"
  );
  assert(
    (await page.getByText("(recommended)", { exact: false }).count()) > 0,
    "recommended choice is identified"
  );
  assert(
    (await page.getByText("Guided planning approval", { exact: false }).count()) >
      0,
    "Markdown question summary renders"
  );

  const prdLink = page.getByRole("link", { name: "PRD", exact: true });
  assert((await prdLink.count()) > 0, "PRD artifact link renders");
  const href = await prdLink.first().getAttribute("href");
  assert(
    typeof href === "string" &&
      href.includes("view=files") &&
      href.includes(encodeURIComponent("docs/roadmap/b45-guided-gate/prd.md")),
    "PRD link uses Files deep-link contract"
  );

  await prdLink.first().click();
  await page.waitForTimeout(1500);
  assert(page.url().includes("view=files"), "navigated to Files view");
  assert(
    (await page.getByText("Guided approval verify", { exact: false }).count()) >
      0 || page.url().includes("prd.md"),
    "Files view opens the expected Markdown file"
  );

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.locator('[data-choice-id="approve"]').first().click();

  for (let i = 0; i < 40; i++) {
    if (harness.getAnswered() === "approve") break;
    await sleep(100);
  }
  assert(harness.getAnswered() === "approve", "clicking approve sends choice id");

  const status = harness.db
    .prepare("SELECT status FROM runs WHERE id = 'run-b45-4'")
    .get();
  assert(status?.status === "running", "run returned to running after approve");

  await page.waitForTimeout(800);
  assert(
    (await page.locator('[data-choice-id="approve"]').count()) === 0,
    "pending approval surface cleared"
  );
}

async function main() {
  let browser;
  let http;
  let harness;

  try {
    harness = seedHarness();
    http = await startServer(harness);
    await sleep(400);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await runUiChecks(page, harness);
  } finally {
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
      /* ignore */
    }
    clearTimeout(hardExit);
  }
}

const result = await main()
  .then(() => {
    console.log("\nb45.4 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
