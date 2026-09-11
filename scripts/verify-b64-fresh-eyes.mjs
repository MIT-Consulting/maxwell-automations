/**
 * b64 Phase 3 — fresh-eyes walk on isolated empty DB (S4 scripted path).
 *
 * Isolation (non-negotiable): own temp LCA_HOME and port 3774. Never calls
 * stop-lca-daemons, never touches :3747, never sets LCA_FORCE_STOP_DAEMONS.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3774;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;

if (port === 3747) {
  console.error("verify-b64-fresh-eyes must not use operator port 3747");
  process.exit(1);
}

const testHome = mkdtempSync(join(tmpdir(), "lca-b64-fresh-eyes-"));
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.LCA_HOME = join(testHome, ".cursor-local-automations");

const [
  { openDatabase },
  { DaemonEventBus },
  { DashboardStore },
  { startHttpServer },
  { InputHub },
  { InputStore },
  { ChatEngine },
  { RunEngine },
  { DEFAULT_SETTINGS, loadNotifySettings },
  { buildNotifySettingsPublic },
  { writeNotifySettings },
  { Notifier },
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
  import("../packages/daemon/dist/config/notify-public.js"),
  import("../packages/daemon/dist/config/write.js"),
  import("../packages/daemon/dist/notify/notifier.js"),
]);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error("SKIP: dashboard not built. Run `npm run build -w @lca/dashboard` first.");
  process.exit(0);
}

if (!existsSync(join(repoRoot, "packages/daemon/dist/http/server.js"))) {
  console.error("SKIP: daemon not built. Run `npm run build -w @lca/daemon` first.");
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

function seedHarness() {
  const lcaDir = join(testHome, ".cursor-local-automations");
  rmSync(lcaDir, { recursive: true, force: true });
  mkdirSync(lcaDir, { recursive: true });

  writeFileSync(
    join(lcaDir, "automations.yaml"),
    ["workspaces: []", "", "automations: []", ""].join("\n")
  );

  const db = openDatabase(join(lcaDir, "state.sqlite"));
  const events = new DaemonEventBus();
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
    apiKey: "verify-b64",
    executor: stubExecutor,
    inputHub,
    events,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "verify-b64",
    executor: stubExecutor,
    events,
  });
  const store = new DashboardStore(db);

  let currentNotify = loadNotifySettings();
  const notifier = new Notifier({
    dashboardUrl: base,
    eventPrefs: currentNotify.events,
    ntfy: currentNotify.ntfy,
    onLog: () => {},
  });

  const reloadAndApply = () => {
    currentNotify = loadNotifySettings();
    notifier.reconfigureNotify({
      eventPrefs: currentNotify.events,
      ntfy: currentNotify.ntfy,
    });
    return currentNotify;
  };

  const configPath = join(lcaDir, "automations.yaml");

  return {
    db,
    events,
    engine,
    chatEngine,
    store,
    notifier,
    getCurrentNotify: () => currentNotify,
    reloadAndApply,
    configPath,
  };
}

async function assertBoardCluster(page, expectVisible) {
  const search = page.getByPlaceholder("Search automations…");
  const wsFilter = page.getByRole("group", { name: "Workspace filter" });
  const smartLayout = page.getByRole("button", { name: "Smart layout" });
  if (expectVisible) {
    assert((await search.count()) > 0, "board cluster: search visible");
    assert((await wsFilter.count()) > 0, "board cluster: workspace filter visible");
    assert((await smartLayout.count()) > 0, "board cluster: Smart layout visible");
  } else {
    assert((await search.count()) === 0, "board cluster hidden: no search");
    assert((await wsFilter.count()) === 0, "board cluster hidden: no workspace filter");
    assert((await smartLayout.count()) === 0, "board cluster hidden: no Smart layout");
  }
}

async function selectView(page, name) {
  await page.getByRole("group", { name: "View" }).getByRole("button", { name, exact: true }).click();
  await sleep(300);
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
      apiKey: "verify-b64",
      port,
      settings: DEFAULT_SETTINGS,
      listModels: async () => [],
      notify: {
        getPublic: () => buildNotifySettingsPublic(harness.getCurrentNotify()),
        patch: (body) => {
          writeNotifySettings(harness.configPath, body);
          return buildNotifySettingsPublic(harness.reloadAndApply());
        },
        testSend: () => harness.notifier.testNtfy(),
      },
    });
    console.log(`Isolated dashboard on ${base} (LCA_HOME=${testHome})`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.clear();
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });
    await sleep(500);

    // 1 — empty board: S3 hint + CTA
    assert(
      (await page.getByText("Create an automation to see it on the board.").count()) > 0,
      "empty board shows S3 hint"
    );
    const emptyBoardCta = page.getByRole("button", { name: "New automation" }).first();
    await emptyBoardCta.click();
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10000 });
    assert(true, "empty-board New automation opens create modal");
    await page.keyboard.press("Escape");
    await sleep(300);
    await assertBoardCluster(page, true);

    // 2 — Chat / Files / Settings: board cluster absent; pipeline + Settings remain
    for (const view of ["Chat", "Files"]) {
      await selectView(page, view);
      await assertBoardCluster(page, false);
      assert(
        (await page.getByRole("button", { name: /Run feature pipeline/i }).count()) > 0,
        `${view}: Run feature pipeline still visible`
      );
    }
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await sleep(300);
    await assertBoardCluster(page, false);
    assert(
      (await page.getByRole("button", { name: /Run feature pipeline/i }).count()) > 0,
      "Settings: Run feature pipeline still visible"
    );

    // 3 — Board again: cluster returns
    await selectView(page, "Board");
    await assertBoardCluster(page, true);

    // 4 — kickoff modal clarity
    await page.getByRole("button", { name: /Run feature pipeline/i }).first().click();
    await page.getByRole("dialog").waitFor({ state: "visible", timeout: 10000 });
    assert(
      (await page.getByRole("heading", { name: /Run feature pipeline/i }).count()) > 0,
      "kickoff modal human title"
    );
    assert(
      (await page.getByText("Workspace", { exact: true }).count()) > 0,
      "kickoff shows Workspace section"
    );
    assert(
      (await page.getByText("Kickoff input", { exact: true }).count()) > 0,
      "kickoff shows Kickoff input section"
    );
    assert(
      (await page.getByText("Planning profile", { exact: true }).count()) > 0,
      "kickoff shows Planning profile section"
    );
    assert(
      (await page.getByText("Advanced", { exact: true }).count()) > 0,
      "kickoff shows Advanced summary"
    );
    assert(
      !(await page.getByText("Execute mode", { exact: true }).first().isVisible()),
      "Advanced collapsed: Execute mode not visible by default"
    );
    const visibleText = await page.getByRole("dialog").innerText();
    assert(!/\/implement-fully/i.test(visibleText), "no /implement-fully in default-visible copy");
    assert(!/maxDepth/i.test(visibleText), "no maxDepth in default-visible copy");
    assert(!/plan-skeleton/i.test(visibleText), "no plan-skeleton in default-visible copy");
    await page.getByText("Advanced", { exact: true }).click();
    await sleep(200);
    assert(
      await page.getByText("Execute mode", { exact: true }).first().isVisible(),
      "Advanced opens to Execute mode"
    );
    await page.keyboard.press("Escape");
    await sleep(300);

    // 5 — collapsed sidebar rail
    await page.getByRole("button", { name: "Collapse control bar" }).click();
    await sleep(300);
    assert(
      (await page.getByRole("button", { name: "Run feature pipeline" }).count()) > 0,
      "collapsed rail: Run feature pipeline present"
    );
    await page.getByRole("button", { name: "Chat view" }).click();
    await sleep(300);
    assert(
      (await page.getByRole("button", { name: "Filter workspaces" }).count()) === 0,
      "collapsed Chat: no Filter workspaces rail"
    );
    assert(
      (await page.getByRole("button", { name: "Search automations" }).count()) === 0,
      "collapsed Chat: no Search automations rail"
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
  }
}

const result = await run();
clearTimeout(hardExit);
process.exit(result.success ? 0 : 1);
