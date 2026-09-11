/**
 * b35 UI verification — catalog-backed ModelSelect across automation, settings,
 * run, and chat surfaces; clear-to-inherit; reload persistence; catalog-failure
 * fallback editing. Uses an injectable stub catalog (no live Cursor required).
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
const port = 3765;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const testHome = mkdtempSync(join(tmpdir(), "lca-b35-ui-"));

// Daemon path constants are evaluated at module import time. Set the temporary
// home first so config reconciliation and attachment storage cannot touch the
// operator's real ~/.cursor-local-automations directory.
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
  import("../packages/daemon/dist/config/settings.js"),
]);

function workspaceIdFromPath(workspacePath) {
  return Buffer.from(resolve(workspacePath)).toString("base64url");
}

const STUB_MODELS = [
  {
    id: "grok-4.5",
    displayName: "Grok 4.5",
    parameters: [
      {
        id: "reasoning",
        displayName: "Reasoning",
        values: [
          { value: "low", displayName: "Low" },
          { value: "medium", displayName: "Medium" },
          { value: "high", displayName: "High" },
        ],
      },
      {
        id: "fast",
        displayName: "Fast",
        values: [
          { value: "false", displayName: "Off" },
          { value: "true", displayName: "On" },
        ],
      },
    ],
    variants: [
      {
        displayName: "Default",
        isDefault: true,
        params: [
          { id: "reasoning", value: "medium" },
          { id: "fast", value: "false" },
        ],
      },
    ],
  },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
  },
];

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

async function selectRadixOption(page, triggerSelector, optionText) {
  const trigger = page.locator(triggerSelector);
  await trigger.waitFor({ state: "visible", timeout: 15000 });
  await trigger.click();
  await page
    .getByRole("option", { name: optionText })
    .first()
    .click({ timeout: 10000 });
}

async function selectDefaultOption(page, triggerSelector) {
  const trigger = page.locator(triggerSelector);
  await trigger.waitFor({ state: "visible", timeout: 15000 });
  await trigger.click();
  await page
    .getByRole("option")
    .filter({ hasText: /^Default\b/ })
    .first()
    .click({ timeout: 10000 });
}

async function setParamEnum(page, label, valueLabel) {
  const trigger = page.getByRole("combobox", { name: label });
  await trigger.click();
  await page.getByRole("option", { name: valueLabel }).first().click();
}

async function toggleFastSwitch(page, wantOn) {
  const sw = page.getByRole("switch", { name: "Fast" });
  await sw.waitFor({ state: "visible", timeout: 10000 });
  const checked = (await sw.getAttribute("data-state")) === "checked";
  if (checked !== wantOn) {
    await sw.click();
  }
}

function cardByText(page, text) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(text, { exact: true }) })
    .first();
}

async function clickCardButton(page, card, name) {
  await card.hover();
  await card.getByRole("button", { name, exact: true }).click();
}

function seedHarness(listModels) {
  const lcaDir = join(testHome, ".cursor-local-automations");
  rmSync(lcaDir, { recursive: true, force: true });
  mkdirSync(lcaDir, { recursive: true });

  const workspace = mkdtempSync(join(tmpdir(), "lca-b35-ws-"));
  writeFileSync(join(workspace, "README.md"), "# b35 verify\n");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });

  writeFileSync(
    join(lcaDir, "automations.yaml"),
    [`workspaces:`, `  - ${JSON.stringify(workspace)}`, ``, `automations: []`, ``].join(
      "\n"
    )
  );

  const db = openDatabase(join(lcaDir, "state.sqlite"));
  const wsId = workspaceIdFromPath(workspace);
  const autoId = randomUUID();
  const runId = randomUUID();

  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(wsId, resolve(workspace), "b35-ws");
  db.prepare(
    `INSERT INTO automations (
      id, workspace_id, name, enabled, status, trigger_json, prompt,
      config_path, config_key, origin
    ) VALUES (?, ?, 'B35 Seed', 1, 'enabled', '{"type":"manual"}', 'hi',
      'c.yaml', 'b35-seed', 'dashboard')`
  ).run(autoId, wsId);
  db.prepare(
    `INSERT INTO runs (
      id, automation_id, workspace_id, status, agent_id, sdk_run_id,
      trigger_kind, prompt
    ) VALUES (?, ?, ?, 'completed', 'local-agent', 'sdk-run-1', 'manual', 'hi')`
  ).run(runId, autoId, wsId);

  const events = new DaemonEventBus();
  const fakeExecutor = {
    kind: "sdk-local",
    async spawn() {
      throw new Error("spawn not used in b35 UI verify");
    },
    async resume() {
      const active = {
        kind: "sdk-local",
        agentId: "local-agent",
        sdkRunId: "sdk-follow",
        async *stream() {},
        async wait() {
          return { status: "finished", id: "sdk-follow" };
        },
        async cancel() {},
        async dispose() {},
        async sendFollowUp() {
          return active;
        },
      };
      return active;
    },
  };

  const engine = new RunEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
    inputHub: new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    }),
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
    autoId,
    runId,
    db,
    events,
    engine,
    chatEngine,
    listModels,
  };
}

async function startServer(harness) {
  return startHttpServer({
    engine: harness.engine,
    chatEngine: harness.chatEngine,
    store: new DashboardStore(harness.db),
    db: harness.db,
    events: harness.events,
    apiKey: "test-key",
    port,
    host: "127.0.0.1",
    settings: DEFAULT_SETTINGS,
    listModels: harness.listModels,
  });
}

async function cleanupAutomations(page) {
  await page.evaluate(async () => {
    const res = await fetch("/api/automations");
    const data = await res.json();
    for (const a of data.automations) {
      if (a.origin === "dashboard" && /^(B35 |b35-)/.test(a.name)) {
        await fetch(`/api/automations/${encodeURIComponent(a.id)}`, {
          method: "DELETE",
        });
      }
    }
  });
}

async function runCatalogUiChecks(page, harness) {
  await page.addInitScript(() => {
    window.confirm = () => true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const modelsRes = await page.evaluate(async () => {
    const res = await fetch("/api/models");
    return res.json();
  });
  assert(
    Array.isArray(modelsRes.models) && modelsRes.models.length >= 2,
    "GET /api/models returns stub catalog"
  );
  assert(
    modelsRes.models.some(
      (m) => m.id === "grok-4.5" && m.parameters?.some((p) => p.id === "reasoning")
    ),
    "catalog includes grok-4.5 reasoning parameter"
  );

  // --- Automation authoring ---
  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByRole("heading", { name: "New automation" }).waitFor();
  const autoName = `B35 UI ${Date.now()}`;
  await page.locator("#automation-name").fill(autoName);
  await page.locator("#automation-workspace").click();
  await page.getByRole("option").first().click();
  await page.locator("#automation-prompt").fill("b35 ui verify");

  await selectRadixOption(page, "#automation-model", "Grok 4.5");
  await page.waitForTimeout(300);
  await setParamEnum(page, "Reasoning", "High");
  await toggleFastSwitch(page, true);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForTimeout(1500);

  let autos = await page.evaluate(async () => {
    const res = await fetch("/api/automations");
    return res.json();
  });
  let created = autos.automations.find((a) => a.name === autoName);
  assert(created, "created automation exists");
  assert(
    created.modelSelection?.id === "grok-4.5" &&
      created.modelSelection.params?.some(
        (p) => p.id === "reasoning" && p.value === "high"
      ) &&
      created.modelSelection.params?.some(
        (p) => p.id === "fast" && p.value === "true"
      ),
    "automation persists parameterized selection"
  );

  // Clear to inherit
  await clickCardButton(page, cardByText(page, autoName), "Edit");
  await page.getByRole("heading", { name: "Edit automation" }).waitFor();
  await selectDefaultOption(page, "#automation-model");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(1200);

  autos = await page.evaluate(async () => {
    const res = await fetch("/api/automations");
    return res.json();
  });
  created = autos.automations.find((a) => a.name === autoName);
  assert(
    created?.modelSelection == null && created?.model == null,
    "clear-to-inherit nulls automation selection"
  );

  // Re-select for reload persistence check
  await clickCardButton(page, cardByText(page, autoName), "Edit");
  await selectRadixOption(page, "#automation-model", "Grok 4.5");
  await setParamEnum(page, "Reasoning", "Low");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(1000);

  // --- Workspace defaults (Settings) ---
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-model").waitFor({ state: "visible", timeout: 15000 });
  await selectRadixOption(page, "#settings-model", "Composer 2.5");
  await page.getByRole("button", { name: "Save defaults" }).click();
  await page.waitForTimeout(1000);

  const defaultsAfter = await page.evaluate(async (wsId) => {
    const res = await fetch(
      `/api/workspaces/${encodeURIComponent(wsId)}/chat-defaults`
    );
    return res.json();
  }, harness.wsId);
  const defaultSelection =
    defaultsAfter.defaults?.modelSelection ??
    defaultsAfter.modelSelection ??
    null;
  assert(
    defaultSelection?.id === "composer-2.5",
    "workspace default model persisted"
  );

  // --- Per-run override ---
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.waitForTimeout(500);
  const seedRunCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText("B35 Seed", { exact: true }) })
    .filter({ has: page.locator('button:has-text("Logs")') })
    .first();
  await clickCardButton(page, seedRunCard, "Logs");
  await page.waitForTimeout(800);

  const runModelId = `#run-model-${harness.runId}`;
  await page.locator(runModelId).waitFor({ state: "visible", timeout: 15000 });
  await selectRadixOption(page, runModelId, "Grok 4.5");
  await page.waitForTimeout(400);
  // Ghost variant hides params behind a button
  const paramsBtn = page.getByRole("button", { name: "Model parameters" });
  if ((await paramsBtn.count()) > 0) {
    await paramsBtn.click();
    await setParamEnum(page, "Reasoning", "High");
    await toggleFastSwitch(page, true);
  }
  await page.waitForTimeout(800);

  const runAfter = await page.evaluate(async (runId) => {
    const res = await fetch("/api/runs?limit=50");
    const data = await res.json();
    return (data.runs ?? []).find((r) => r.id === runId) ?? null;
  }, harness.runId);
  assert(
    runAfter?.modelSelection?.id === "grok-4.5",
    "per-run override persists base model"
  );

  // Clear run override
  await selectDefaultOption(page, runModelId);
  await page.waitForTimeout(800);
  const runCleared = await page.evaluate(async (runId) => {
    const res = await fetch("/api/runs?limit=50");
    const data = await res.json();
    return (data.runs ?? []).find((r) => r.id === runId) ?? null;
  }, harness.runId);
  assert(
    runCleared?.modelSelection == null,
    "run clear-to-inherit restores null override"
  );

  // Close modal if present
  const closeBtn = page.getByRole("button", { name: /close/i }).first();
  if ((await closeBtn.count()) > 0) {
    await closeBtn.click().catch(() => {});
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // --- Per-chat override ---
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "New chat" }).first().click();
  await page.waitForTimeout(1200);

  const chatId = await page.evaluate(async (wsId) => {
    const res = await fetch(
      `/api/workspaces/${encodeURIComponent(wsId)}/chats`
    );
    const data = await res.json();
    const chats = data.chats ?? data;
    return Array.isArray(chats) ? chats[0]?.id : null;
  }, harness.wsId);
  assert(chatId, "chat created");

  const chatModelId = `#chat-model-${chatId}`;
  await page.locator(chatModelId).waitFor({ state: "visible", timeout: 15000 });
  await selectRadixOption(page, chatModelId, "Grok 4.5");
  await page.waitForTimeout(400);
  const chatParamsBtn = page.getByRole("button", { name: "Model parameters" });
  if ((await chatParamsBtn.count()) > 0) {
    await chatParamsBtn.click();
    await setParamEnum(page, "Reasoning", "Medium");
  }
  await page.waitForTimeout(800);

  const chatAfter = await page.evaluate(async (id) => {
    const res = await fetch(`/api/chats/${encodeURIComponent(id)}`);
    return res.json();
  }, chatId);
  const chatSel =
    chatAfter.session?.modelSelection ??
    chatAfter.chat?.modelSelection ??
    chatAfter.modelSelection ??
    null;
  assert(chatSel?.id === "grok-4.5", "per-chat override persists");

  // --- Reload persistence ---
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.waitForTimeout(500);

  const afterReload = await page.evaluate(async () => {
    const res = await fetch("/api/automations");
    return res.json();
  });
  const reloaded = afterReload.automations.find((a) => a.name === autoName);
  assert(
    reloaded?.modelSelection?.id === "grok-4.5" &&
      reloaded.modelSelection.params?.some(
        (p) => p.id === "reasoning" && p.value === "low"
      ),
    "automation selection survives reload"
  );

  await cleanupAutomations(page);
}

async function runCatalogFailureChecks(page) {
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByRole("heading", { name: "New automation" }).waitFor();
  const name = `B35 Fail ${Date.now()}`;
  await page.locator("#automation-name").fill(name);
  await page.locator("#automation-workspace").click();
  await page.getByRole("option").first().click();
  await page.locator("#automation-prompt").fill("catalog failure path");

  const modelInput = page.locator("#automation-model");
  await modelInput.waitFor({ state: "visible", timeout: 15000 });
  const tag = await modelInput.evaluate((n) => n.tagName.toLowerCase());
  assert(tag === "input", "catalog failure renders text input");
  await modelInput.fill("custom-offline-model");
  await modelInput.blur();

  await page.getByRole("button", { name: "Add parameter" }).click();
  await page.getByLabel("Parameter 1 id").fill("reasoning");
  await page.getByLabel("Parameter 1 value").fill("high");
  await page.getByLabel("Parameter 1 value").blur();
  await page.waitForTimeout(400);

  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForTimeout(1500);

  const autos = await page.evaluate(async () => {
    const res = await fetch("/api/automations");
    return res.json();
  });
  const created = autos.automations.find((a) => a.name === name);
  assert(
    created?.modelSelection?.id === "custom-offline-model" &&
      created.modelSelection.params?.some(
        (p) => p.id === "reasoning" && p.value === "high"
      ),
    "catalog-failure custom id/params persist"
  );

  await cleanupAutomations(page);
}

async function main() {
  // Isolated temp LCA_HOME — do not call stopLcaDaemons(); that would POST
  // /api/shutdown at the operator daemon on :3747 (remote Max footgun).

  let browser;
  let http;
  let harness;

  try {
    harness = seedHarness(async () => STUB_MODELS);
    http = await startServer(harness);
    await sleep(400);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await runCatalogUiChecks(page, harness);
    await closeWithTimeout(browser);
    browser = null;
    await http.close();
    http = null;
    await harness.engine.shutdown();
    await harness.chatEngine.shutdown();
    harness.db.close();
    rmSync(harness.testHome, { recursive: true, force: true });
    rmSync(harness.workspace, { recursive: true, force: true });

    // Fresh harness with failing catalog
    harness = seedHarness(async () => {
      throw new Error("stub catalog outage");
    });
    http = await startServer(harness);
    await sleep(400);
    browser = await chromium.launch({ headless: true });
    const failPage = await browser.newPage();
    await runCatalogFailureChecks(failPage);
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
      if (harness?.testHome) {
        rmSync(harness.testHome, { recursive: true, force: true });
      }
      if (harness?.workspace) {
        rmSync(harness.workspace, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
    clearTimeout(hardExit);
  }
}

try {
  await main();
  console.log("\nb35 UI verification passed.");
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
}
