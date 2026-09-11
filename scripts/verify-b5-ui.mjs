import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { stopLcaDaemons } from "./stop-lca-daemons.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(lcaHome, ".env");
const port = 3755;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
  console.log("OK:", msg);
}

function envHasApiKey() {
  if (process.env.CURSOR_API_KEY?.trim().length > 10) return true;
  if (!existsSync(envPath)) return false;
  const raw = readFileSync(envPath, "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("CURSOR_API_KEY="));
  return !!line && line.slice("CURSOR_API_KEY=".length).trim().length > 10;
}

if (!envHasApiKey()) {
  console.error("SKIP: CURSOR_API_KEY not set — the daemon cannot boot without it.");
  process.exit(0);
}
if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error("SKIP: dashboard not built. Run `npm run build` first.");
  process.exit(0);
}

const hardExit = setTimeout(() => {
  console.error("Hard timeout reached.");
  process.exit(2);
}, HARD_TIMEOUT_MS);
hardExit.unref();

async function rmWithRetries(path, options = {}) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      rmSync(path, options);
      return;
    } catch (err) {
      if (err?.code !== "EBUSY" || attempt === 59) {
        throw err;
      }
      await sleep(500);
    }
  }
}

function seedTempWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "lca-b5-workspace-"));
  mkdirSync(join(workspace, ".cursor", "rules"), { recursive: true });
  mkdirSync(join(workspace, ".cursor", "skills", "temp-skill"), { recursive: true });
  writeFileSync(
    join(workspace, ".cursor", "rules", "temp-rule.mdc"),
    [
      "---",
      "description: Temporary b5 workspace rule",
      "---",
      "# Temp Rule",
    ].join("\n"),
    { flag: "w" }
  );
  writeFileSync(
    join(workspace, ".cursor", "skills", "temp-skill", "SKILL.md"),
    [
      "---",
      "name: temp-skill",
      "description: Temporary b5 workspace skill",
      "---",
      "# Temp Skill",
    ].join("\n"),
    { flag: "w" }
  );
  return workspace;
}

function prepareTempUserHome() {
  const userHome = mkdtempSync(join(tmpdir(), "lca-b5-home-"));
  const tempLcaHome = join(userHome, ".cursor-local-automations");
  mkdirSync(tempLcaHome, { recursive: true });
  writeFileSync(
    join(tempLcaHome, "automations.yaml"),
    ["workspaces: []", "", "automations: []", ""].join("\n")
  );
  if (existsSync(envPath)) {
    copyFileSync(envPath, join(tempLcaHome, ".env"));
  }
  return userHome;
}

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
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  return false;
}

async function json(path, options) {
  const res = await fetch(`${base}${path}`, options);
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText}${detail}`);
  }
  return res.json();
}

function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

async function ensureWorkspace(path, name) {
  const before = await json("/api/workspaces");
  const existing = before.workspaces.find((workspace) => samePath(workspace.path, path));
  if (existing) {
    return existing;
  }

  await json("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, name }),
  });
  const after = await json("/api/workspaces");
  const created = after.workspaces.find((workspace) => samePath(workspace.path, path));
  if (!created) {
    throw new Error(`Workspace was registered but not listed: ${path}`);
  }
  return created;
}

let log = "";
let daemon = null;
function spawnDaemon(userHome) {
  daemon = spawn("node", ["packages/daemon/dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      LCA_PORT: String(port),
    },
  });
  daemon.stdout.on("data", (d) => (log += d.toString()));
  daemon.stderr.on("data", (d) => (log += d.toString()));
}

async function stopSpawnedDaemon() {
  if (!daemon) return;
  const exited = new Promise((resolveExit) => daemon.once("exit", resolveExit));
  await fetch(`${base}/api/shutdown`, {
    method: "POST",
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
  await Promise.race([exited, sleep(10000)]);
  if (daemon.exitCode === null && daemon.signalCode === null) {
    if (process.platform === "win32" && daemon.pid) {
      spawnSync("taskkill", ["/PID", String(daemon.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      daemon.kill("SIGKILL");
    }
    await Promise.race([exited, sleep(5000)]);
  }
  await sleep(2000);
  daemon = null;
}

async function optionTextAt(page, index) {
  return (
    (await page
      .locator(".prompt-suggestion")
      .nth(index)
      .locator(".prompt-suggestion-name")
      .textContent()) ?? ""
  ).trim();
}

async function waitForSuggestion(page, text) {
  await page
    .locator(".prompt-suggestion", { hasText: text })
    .first()
    .waitFor({ timeout: 10000 });
}

async function runUiChecks(page, repoWorkspace, tempWorkspace) {
  await page.addInitScript(() => {
    window.confirm = () => true;
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(base, { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "+ New automation" }).click();
  await page.getByRole("heading", { name: "New automation" }).waitFor();
  await page.locator("#automation-workspace").selectOption(repoWorkspace.id);

  const prompt = page.locator("#automation-prompt");
  await prompt.fill("@te");
  await waitForSuggestion(page, "tech-stack");
  assert(true, "`@te` suggests the tech-stack rule");
  await prompt.press("Enter");
  assert((await prompt.inputValue()) === "@tech-stack ", "Enter inserts @tech-stack");

  await prompt.fill("/lca");
  await waitForSuggestion(page, "lca-dev");
  assert(true, "`/lca` suggests the lca-dev skill");
  await prompt.press("Enter");
  assert((await prompt.inputValue()) === "/lca-dev ", "Enter inserts /lca-dev");

  await prompt.fill("@");
  await waitForSuggestion(page, "tech-stack");
  const optionCount = await page.locator(".prompt-suggestion").count();
  const firstBefore = await optionTextAt(page, 0);
  await prompt.press("ArrowDown");
  if (optionCount > 1) {
    const activeAfterDown = (
      (await page.locator(".prompt-suggestion.active .prompt-suggestion-name").textContent()) ??
      ""
    ).trim();
    assert(
      activeAfterDown !== firstBefore,
      "ArrowDown moves the highlighted suggestion"
    );
  } else {
    assert(
      (await page.locator(".prompt-suggestion.active").count()) === 1,
      "ArrowDown keeps a single suggestion highlighted"
    );
  }
  await prompt.press("ArrowUp");
  assert(
    (await page.locator(".prompt-suggestion.active").count()) === 1,
    "ArrowUp leaves one suggestion highlighted"
  );
  await prompt.press("Escape");
  await page.locator("#automation-prompt-suggestions").waitFor({
    state: "detached",
    timeout: 5000,
  });
  assert(true, "Escape closes the typeahead");

  await prompt.fill("@te");
  await waitForSuggestion(page, "tech-stack");
  await page.locator("#automation-workspace").selectOption(tempWorkspace.id);
  await waitForSuggestion(page, "temp-rule");
  assert(
    (await page.locator(".prompt-suggestion", { hasText: "tech-stack" }).count()) === 0,
    "switching workspace changes rule suggestions"
  );

  await page.getByRole("button", { name: "Cancel" }).click();
}

async function main() {
  await stopLcaDaemons([3747, 3752, 3753, 3754, port]);
  const tempUserHome = prepareTempUserHome();
  const tempWorkspacePath = seedTempWorkspace();
  let browser = null;

  try {
    spawnDaemon(tempUserHome);
    await sleep(1000);
    assert(await waitForHealth(), "daemon HTTP /health responds");

    const repoWorkspace = await ensureWorkspace(repoRoot, "cursor-local-automations");
    const tempWorkspace = await ensureWorkspace(tempWorkspacePath, "b5 verify temp");

    const repoArtifacts = await json(
      `/api/workspaces/${encodeURIComponent(repoWorkspace.id)}/artifacts`
    );
    assert(
      repoArtifacts.artifacts.some(
        (artifact) => artifact.kind === "rule" && artifact.name === "tech-stack"
      ),
      "artifact endpoint includes tech-stack"
    );
    assert(
      repoArtifacts.artifacts.some(
        (artifact) => artifact.kind === "skill" && artifact.name === "lca-dev"
      ),
      "artifact endpoint includes lca-dev"
    );

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await runUiChecks(page, repoWorkspace, tempWorkspace);
  } finally {
    await closeWithTimeout(browser);
    await stopSpawnedDaemon();
    rmSync(tempWorkspacePath, { recursive: true, force: true });
    await rmWithRetries(tempUserHome, { recursive: true, force: true }).catch((err) => {
      console.error("WARN: temporary LCA home cleanup failed:", err.message);
    });
  }
}

try {
  await main();
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  clearTimeout(hardExit);
  if (process.exitCode) {
    console.error("\n--- daemon log ---\n", log);
  } else {
    console.log("\nb5 UI verification passed.");
  }
}
