/**
 * b51 UI verification — Settings → Alerts at narrow and desktop widths on an
 * isolated daemon (zero workspaces; Alerts is daemon-global).
 *
 * Isolation (non-negotiable): own temp LCA_HOME and port 3773. Never calls
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
const port = 3773;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const VIEWPORTS = [720, 1280];

if (port === 3747) {
  console.error("verify-b51-ui must not use operator port 3747");
  process.exit(1);
}

const testHome = mkdtempSync(join(tmpdir(), "lca-b51-ui-"));
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
    apiKey: "verify-b51",
    executor: stubExecutor,
    inputHub,
    events,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "verify-b51",
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

async function openSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-tab-alerts").waitFor({
    state: "visible",
    timeout: 20000,
  });
}

async function openAlertsTab(page) {
  await page.locator("#settings-tab-alerts").click();
  await page.locator("#settings-panel-alerts").waitFor({
    state: "visible",
    timeout: 15000,
  });
}

async function waitForAlertsLoaded(page) {
  await page.getByText("Enable ntfy", { exact: true }).waitFor({
    state: "visible",
    timeout: 20000,
  });
}

async function assertAlertsPanel(page, width) {
  await waitForAlertsLoaded(page);
  await page.getByRole("tab", { name: "Alerts" }).waitFor({
    state: "visible",
    timeout: 15000,
  });
  assert(
    (await page.getByText("Enable ntfy", { exact: true }).count()) > 0,
    `width ${width}: ntfy enable affordance visible`
  );
  const enableSwitch = page.locator("#alerts-ntfy-enabled");
  if ((await enableSwitch.count()) > 0 && !(await enableSwitch.isChecked())) {
    await enableSwitch.click();
    await page.locator("#alerts-ntfy-topic").waitFor({
      state: "visible",
      timeout: 5000,
    });
  }
  assert(
    (await page.locator("#alerts-ntfy-topic").count()) > 0,
    `width ${width}: topic field visible`
  );
  assert(
    (await page.getByRole("button", { name: "Test send" }).count()) > 0,
    `width ${width}: Test send button visible`
  );
  assert(
    (await page.getByText("Toast", { exact: true }).count()) > 0,
    `width ${width}: Toast column header visible`
  );
  assert(
    (await page.getByText("ntfy", { exact: true }).count()) > 0,
    `width ${width}: ntfy column header visible`
  );
  assert(
    (await page.getByText("Needs input", { exact: true }).count()) > 0,
    `width ${width}: catalog row label visible`
  );
  assert(
    (await page.getByRole("button", { name: "Reset to defaults" }).count()) > 0,
    `width ${width}: Reset to defaults visible`
  );
  assert(
    (await page.getByRole("button", { name: "Save alerts" }).count()) > 0,
    `width ${width}: Save alerts visible`
  );
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
      apiKey: "verify-b51",
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

    for (const width of VIEWPORTS) {
      console.log(`progress: viewport ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(base, { waitUntil: "networkidle", timeout: 60000 });
      await sleep(400);
      await openSettings(page);
      await openAlertsTab(page);
      await assertAlertsPanel(page, width);
    }

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
