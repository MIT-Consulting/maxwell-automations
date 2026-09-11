import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..");
const operatorLcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(operatorLcaHome, ".env");
const testHome = mkdtempSync(join(tmpdir(), "lca-b2-ui-home-"));
const testLcaHome = join(testHome, ".cursor-local-automations");
const testWorkspace = mkdtempSync(join(tmpdir(), "lca-b2-ui-ws-"));
const port = 3753;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;

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

function envHasApiKey() {
  if (process.env.CURSOR_API_KEY?.trim().length > 10) return true;
  if (!existsSync(envPath)) return false;
  const raw = readFileSync(envPath, "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("CURSOR_API_KEY="));
  if (!line) return false;
  return line.slice("CURSOR_API_KEY=".length).trim().length > 10;
}

if (!envHasApiKey()) {
  console.error(
    "SKIP: CURSOR_API_KEY not set in ~/.cursor-local-automations/.env — the daemon cannot boot without it."
  );
  process.exit(0);
}

if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error(
    "SKIP: dashboard not built. Run `npm run build` first."
  );
  process.exit(0);
}

mkdirSync(join(testWorkspace, ".cursor", "automations"), { recursive: true });
mkdirSync(testLcaHome, { recursive: true });
writeFileSync(
  join(testLcaHome, "automations.yaml"),
  [
    "workspaces:",
    `  - ${JSON.stringify(testWorkspace)}`,
    "settings:",
    "  host: 127.0.0.1",
    "automations: []",
    "",
  ].join("\n")
);
writeFileSync(
  join(testWorkspace, ".cursor", "automations", "sample.yaml"),
  [
    "automations:",
    "  - id: sample-hello",
    "    name: Sample Hello",
    "    enabled: true",
    "    trigger: { type: manual }",
    "    model: composer-2.5",
    "    prompt: Say hello.",
    "",
  ].join("\n")
);
if (!process.env.CURSOR_API_KEY && existsSync(envPath)) {
  writeFileSync(join(testLcaHome, ".env"), readFileSync(envPath, "utf8"));
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

let log = "";
let daemon = null;

function spawnDaemon() {
  daemon = spawn("node", ["packages/daemon/dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      LCA_HOST: "127.0.0.1",
      LCA_PORT: String(port),
    },
  });
  daemon.stdout.on("data", (d) => {
    log += d.toString();
  });
  daemon.stderr.on("data", (d) => {
    log += d.toString();
  });
}

async function clickCardButton(page, name, buttonText) {
  const card = cardByName(page, name);
  await card.hover();
  await card.getByRole("button", { name: buttonText, exact: true }).click();
}

/**
 * Model control is either a text <input> (catalog outage) or a Radix
 * SelectTrigger button (catalog available). Set a custom id via fill when
 * possible; otherwise pick a catalog option. Pass "" / null to clear (Default).
 */
async function setAutomationModel(page, modelId) {
  const el = page.locator("#automation-model");
  await el.waitFor({ state: "visible", timeout: 15000 });
  const tagName = await el.evaluate((node) => node.tagName.toLowerCase());
  if (tagName === "input") {
    await el.fill(modelId ?? "");
    await el.blur();
    return;
  }
  await el.click();
  await page.waitForTimeout(200);
  if (!modelId) {
    await page
      .getByRole("option")
      .filter({ hasText: /^Default\b/ })
      .first()
      .click();
    return;
  }
  const exact = page.getByRole("option", { name: modelId });
  if ((await exact.count()) > 0) {
    await exact.first().click();
    return;
  }
  const options = page.getByRole("option");
  const count = await options.count();
  for (let i = 0; i < count; i += 1) {
    const text = (await options.nth(i).innerText()).trim();
    if (!/^Default\b/.test(text)) {
      await options.nth(i).click();
      return;
    }
  }
  throw new Error("no non-default model option available in catalog select");
}

function cardByName(page, name) {
  return page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
}

async function cleanupTestAutomations(page) {
  await page.evaluate(async () => {
    const res = await fetch("/api/automations");
    const data = await res.json();
    for (const a of data.automations) {
      if (a.origin === "dashboard" && /^(ui-verify-|b2-ui-)/.test(a.name)) {
        await fetch(`/api/automations/${encodeURIComponent(a.id)}`, {
          method: "DELETE",
        });
      }
    }
  });
}

async function runUiChecks(page) {
  await page.addInitScript(() => {
    window.confirm = () => true;
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const sampleCard = cardByName(page, "Sample Hello");
  await sampleCard.waitFor({ timeout: 15000 });
  assert(true, "board loads Sample Hello");
  assert(
    (await sampleCard.getByText("from config", { exact: true }).count()) === 1,
    "from config badge visible on Sample Hello"
  );
  assert(
    (await sampleCard.locator('button:has-text("Edit")').count()) === 0,
    "config card has no Edit button"
  );
  assert(
    (await sampleCard.locator('button:has-text("Delete")').count()) === 0,
    "config card has no Delete button"
  );

  const testName = `b2-ui-${Date.now()}`;
  const renamed = `${testName}-edited`;

  await page.getByRole("button", { name: "New automation", exact: true }).click();
  await page.getByRole("heading", { name: "New automation" }).waitFor();
  await page.locator("#automation-name").fill(testName);
  await page.locator("#automation-workspace").click();
  await page.getByRole("option").first().click();
  await page.locator("#automation-prompt").fill("b2 UI verify create");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForTimeout(2000);

  const newCard = cardByName(page, testName);
  await newCard.waitFor({ timeout: 15000 });
  await newCard.hover();
  assert(true, "created card appears on board");
  assert(
    (await newCard.getByRole("button", { name: "Edit", exact: true }).count()) === 1,
    "dashboard card has Edit button"
  );
  assert(
    (await newCard.getByRole("button", { name: "Delete", exact: true }).count()) ===
      1,
    "dashboard card has Delete button"
  );
  assert(
    (await newCard.getByText("from config", { exact: true }).count()) === 0,
    "dashboard card has no from config badge"
  );

  await clickCardButton(page, testName, "Edit");
  await page.getByRole("heading", { name: "Edit automation" }).waitFor();
  await page.locator("#automation-name").fill(renamed);
  await setAutomationModel(page, "test-model-ui");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(2000);
  await cardByName(page, renamed).waitFor({ timeout: 15000 });
  assert(true, "edit reflected on board");

  await clickCardButton(page, renamed, "Edit");
  await setAutomationModel(page, "");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForTimeout(2000);

  const autos = await page.evaluate(async () => {
    const res = await fetch("/api/automations");
    return res.json();
  });
  const auto = autos.automations.find((a) => a.name === renamed);
  assert(auto?.model === null, "model cleared to null via edit UI");

  // Confirm the shadcn alert dialog opened by Delete.
  await clickCardButton(page, renamed, "Delete");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await page.waitForTimeout(1500);
  assert(
    (await cardByName(page, renamed).count()) === 0,
    "delete removes card from board"
  );

  await cleanupTestAutomations(page);
}

async function main() {
  spawnDaemon();
  await sleep(1000);
  if (!(await waitForHealth())) {
    assert(false, "daemon HTTP /health responds");
    return;
  }
  assert(true, "daemon HTTP /health responds");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await runUiChecks(page);
  } finally {
    await closeWithTimeout(browser);
  }
}

try {
  await main();
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await sleep(500);
  }
  rmSync(testHome, { recursive: true, force: true });
  rmSync(testWorkspace, { recursive: true, force: true });
  clearTimeout(hardExit);
  if (process.exitCode) {
    console.error("\n--- daemon log ---\n", log);
  } else {
    console.log("\nb2 UI verification passed.");
  }
}
