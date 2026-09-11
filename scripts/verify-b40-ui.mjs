/**
 * b40 UI verification — automation-name fallback, live run.metadata delivery,
 * reload persistence, and expander/transcript behavior on an isolated daemon.
 *
 * Isolation (non-negotiable): own temp LCA_HOME and port 3767. Never calls
 * stop-lca-daemons, never touches :3747, never sets LCA_FORCE_STOP_DAEMONS.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3767;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const testHome = mkdtempSync(join(tmpdir(), "lca-b40-ui-"));

process.env.USERPROFILE = testHome;
process.env.HOME = testHome;

const [
  { openDatabase },
  { DaemonEventBus },
  { DashboardStore },
  { startHttpServer },
  { InputHub },
  { InputStore },
  { ChatEngine },
  { RunEngine },
  { RunStore },
  { DEFAULT_SETTINGS },
] = await Promise.all([
  import("../packages/daemon/dist/db/index.js"),
  import("../packages/daemon/dist/events.js"),
  import("../packages/daemon/dist/http/dashboard-store.js"),
  import("../packages/daemon/dist/http/server.js"),
  import("../packages/daemon/dist/input/hub.js"),
  import("../packages/daemon/dist/input/store.js"),
  import("../packages/daemon/dist/chats/engine.js"),
  import("../packages/daemon/dist/runs/engine.js"),
  import("../packages/daemon/dist/runs/store.js"),
  import("../packages/daemon/dist/config/settings.js"),
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

if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error("SKIP: dashboard not built. Run `npm run build` first.");
  process.exit(0);
}

if (!existsSync(join(repoRoot, "packages/daemon/dist/http/server.js"))) {
  console.error("SKIP: daemon not built. Run `npm run build` first.");
  process.exit(0);
}

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

function cardByText(page, text) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(text, { exact: true }) })
    .first();
}

/** Run cards expose a log expander (`aria-expanded`); automation cards do not. */
function runCardByText(page, text) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(text, { exact: true }) })
    .filter({ has: page.locator("button[aria-expanded]") })
    .first();
}

function seedHarness() {
  const lcaDir = join(testHome, ".cursor-local-automations");
  rmSync(lcaDir, { recursive: true, force: true });
  mkdirSync(lcaDir, { recursive: true });

  const workspace = mkdtempSync(join(tmpdir(), "lca-b40-ws-"));
  writeFileSync(join(workspace, "README.md"), "# b40 verify\n");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });

  writeFileSync(
    join(lcaDir, "automations.yaml"),
    [`workspaces:`, `  - ${JSON.stringify(workspace)}`, ``, `automations: []`, ``].join(
      "\n"
    )
  );

  const db = openDatabase(join(lcaDir, "state.sqlite"));
  const wsId = workspaceIdFromPath(workspace);

  const autos = [
    { id: randomUUID(), name: "Complete Auto", key: "complete-auto" },
    { id: randomUUID(), name: "Failed Auto", key: "failed-auto" },
    { id: randomUUID(), name: "Cancelled Auto", key: "cancelled-auto" },
  ];

  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(wsId, resolve(workspace), "b40-ws");

  for (const auto of autos) {
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, origin, trigger_json, prompt,
        config_path, config_key
      ) VALUES (?, ?, ?, 1, 'enabled', 'config', '{"type":"manual"}', ?,
        'a.yaml', ?)`
    ).run(auto.id, wsId, auto.name, `Prompt for ${auto.name}`, auto.key);
  }

  const completedId = randomUUID();
  const failedId = randomUUID();
  const cancelledId = randomUUID();

  const insertRun = (id, autoId, status) => {
    db.prepare(
      `INSERT INTO runs (
        id, automation_id, workspace_id, status, trigger_kind, prompt,
        started_at, ended_at
      ) VALUES (?, ?, ?, ?, 'manual', 'stored prompt', datetime('now'), datetime('now'))`
    ).run(id, autoId, wsId, status);
  };

  insertRun(completedId, autos[0].id, "completed");
  insertRun(failedId, autos[1].id, "failed");
  insertRun(cancelledId, autos[2].id, "cancelled");

  db.prepare(
    `INSERT INTO run_events (run_id, seq, event_type, payload)
     VALUES (?, 1, 'run.error', ?)`
  ).run(failedId, JSON.stringify({ message: "seeded failure context" }));

  const events = new DaemonEventBus();
  const runStore = new RunStore(db, events);
  const stubExecutor = {
    kind: "sdk-local",
    spawn: async () => {
      throw new Error("stub executor must not spawn");
    },
    resume: async () => {
      throw new Error("stub executor must not resume");
    },
  };
  const inputHub = new InputHub(new InputStore(db), {
    onNeedsInput: () => undefined,
    onAnswered: () => undefined,
  });
  const engine = new RunEngine(db, {
    apiKey: "verify-b40",
    executor: stubExecutor,
    inputHub,
    events,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "verify-b40",
    executor: stubExecutor,
    events,
  });
  const store = new DashboardStore(db);

  return {
    db,
    events,
    engine,
    chatEngine,
    store,
    runStore,
    workspace,
    completedId,
    failedId,
    cancelledId,
    autos,
  };
}

async function run() {
  let browser;
  let http;
  let harness;
  try {
    harness = seedHarness();
    http = await startHttpServer({
      engine: harness.engine,
      chatEngine: harness.chatEngine,
      store: harness.store,
      db: harness.db,
      events: harness.events,
      apiKey: "verify-b40",
      port,
      settings: DEFAULT_SETTINGS,
      listModels: async () => [],
    });
    console.log(`Isolated dashboard on ${base} (LCA_HOME=${testHome})`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });

    await runCardByText(page, "Complete Auto").waitFor({
      state: "visible",
      timeout: 20000,
    });
    assert(
      (await runCardByText(page, "Complete Auto").count()) > 0,
      "completed card shows automation-name fallback"
    );
    assert(
      (await runCardByText(page, "Failed Auto").count()) > 0,
      "failed card shows automation-name fallback"
    );
    assert(
      (await runCardByText(page, "Cancelled Auto").count()) > 0,
      "cancelled card shows automation-name fallback"
    );
    assert(
      (await page.getByText("Shipped card polish", { exact: true }).count()) === 0,
      "no generated titles before metadata write"
    );

    const completedMeta = {
      title: "Shipped card polish",
      summary: "Completed UI polish without regressions.",
    };
    const failedMeta = {
      title: "Auth spawn failed",
      summary: "Missing API credentials blocked the agent.",
    };

    assert(
      harness.runStore.setRunMetadataIfEligible(
        harness.completedId,
        completedMeta
      ),
      "store accepts completed metadata"
    );
    harness.runStore.appendEvent(harness.completedId, "run.metadata", completedMeta);

    assert(
      harness.runStore.setRunMetadataIfEligible(harness.failedId, failedMeta),
      "store accepts failed metadata"
    );
    harness.runStore.appendEvent(harness.failedId, "run.metadata", failedMeta);

    await runCardByText(page, completedMeta.title).waitFor({
      state: "visible",
      timeout: 15000,
    });
    await runCardByText(page, failedMeta.title).waitFor({
      state: "visible",
      timeout: 15000,
    });
    assert(
      (await runCardByText(page, completedMeta.title).count()) > 0,
      "completed title updates live without reload"
    );
    assert(
      (await runCardByText(page, completedMeta.title)
        .getByText(completedMeta.summary, { exact: true })
        .count()) > 0,
      "completed summary appears in expander line"
    );
    assert(
      (await runCardByText(page, failedMeta.title).count()) > 0,
      "failed title updates live without reload"
    );
    assert(
      (await runCardByText(page, failedMeta.title)
        .getByText(failedMeta.summary, { exact: true })
        .count()) > 0,
      "failed summary appears in expander line"
    );
    assert(
      (await runCardByText(page, "Cancelled Auto").count()) > 0,
      "cancelled card retains automation fallback after sibling metadata"
    );
    assert(
      (await runCardByText(page, failedMeta.title).count()) === 1,
      "only the failed card shows the generated failed title"
    );

    const failedCard = runCardByText(page, failedMeta.title);
    const failedSummary = failedCard.getByText(failedMeta.summary, {
      exact: true,
    });
    const failedClass = await failedSummary.getAttribute("class");
    assert(
      failedClass && failedClass.includes("destructive"),
      "failed summary keeps destructive styling"
    );

    const completedCard = runCardByText(page, completedMeta.title);
    const expander = completedCard.getByRole("button").filter({
      hasText: completedMeta.summary,
    });
    assert((await expander.count()) > 0, "summary line remains a button");
    await expander.click();
    await sleep(300);
    const named = completedCard.getByText("run named", { exact: false });
    assert(
      (await named.count()) > 0,
      "expanded log shows compact run.metadata lifecycle event"
    );
    const bodyText = await completedCard.innerText();
    assert(
      !bodyText.includes('"title":"Shipped card polish"'),
      "metadata event does not dump raw JSON payload"
    );

    await page.reload({ waitUntil: "networkidle", timeout: 60000 });
    await runCardByText(page, completedMeta.title).waitFor({
      state: "visible",
      timeout: 20000,
    });
    assert(
      (await runCardByText(page, completedMeta.title).count()) > 0,
      "completed title survives reload via REST"
    );
    assert(
      (await runCardByText(page, completedMeta.title)
        .getByText(completedMeta.summary, { exact: true })
        .count()) > 0,
      "completed summary survives reload via REST"
    );
    assert(
      (await runCardByText(page, failedMeta.title).count()) > 0,
      "failed title survives reload via REST"
    );
    assert(
      (await runCardByText(page, failedMeta.title)
        .getByText(failedMeta.summary, { exact: true })
        .count()) > 0,
      "failed summary survives reload via REST"
    );
    assert(
      (await runCardByText(page, "Cancelled Auto").count()) > 0,
      "cancelled automation name still present after reload"
    );

    return { success: true };
  } catch (error) {
    console.error(error);
    return { success: false };
  } finally {
    await closeWithTimeout(browser);
    if (http) await http.close().catch(() => {});
    if (harness?.engine) await harness.engine.shutdown().catch(() => {});
    if (harness?.chatEngine) await harness.chatEngine.shutdown().catch(() => {});
    if (harness?.db) {
      try {
        harness.db.close();
      } catch {
        /* ignore */
      }
    }
    rmSync(testHome, { recursive: true, force: true });
    if (harness?.workspace) {
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  }
}

const result = await run();
clearTimeout(hardExit);
process.exit(result.success ? 0 : 1);
