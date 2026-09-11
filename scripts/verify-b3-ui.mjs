import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { stopLcaDaemons } from "./stop-lca-daemons.mjs";
import { seedRunFixture, cleanupRunFixture } from "./seed-run-fixture.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(lcaHome, ".env");
const port = 3754;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 5 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let log = "";
let daemon = null;
function spawnDaemon() {
  daemon = spawn("node", ["packages/daemon/dist/index.js"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LCA_PORT: String(port) },
  });
  daemon.stdout.on("data", (d) => (log += d.toString()));
  daemon.stderr.on("data", (d) => (log += d.toString()));
}

async function runUiChecks(page, runId) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/?run=${encodeURIComponent(runId)}`, {
    waitUntil: "networkidle",
  });

  const modal = page.locator(".modal");
  await modal.waitFor({ timeout: 15000 });
  assert(true, "logs modal opens from ?run= deep link");

  const transcript = page.locator(".transcript");
  await transcript.waitFor({ timeout: 10000 });

  // Old raw rows must be gone in Pretty mode; bubbles present instead.
  // The first assistant turn is streamed as many token deltas; they must
  // coalesce — so the whole transcript has exactly 2 assistant bubbles
  // (the streamed markdown turn + the short "Done." turn), not one-per-token.
  const assistantCount = await transcript.locator(".bubble.assistant").count();
  assert(
    assistantCount === 2,
    `assistant deltas coalesce into 2 bubbles (got ${assistantCount}, not one-per-token)`
  );
  assert(
    (await page.locator(".bubble.question").count()) >= 1,
    "question bubble renders"
  );
  assert(
    (await page.locator(".bubble.answer").count()) >= 1,
    "answer bubble renders"
  );
  assert(
    (await page.locator(".system-divider").count()) >= 1,
    "system divider renders (run lifecycle)"
  );

  // Markdown: assistant fixture has a fenced code block.
  assert(
    (await page.locator(".bubble.assistant .md pre code").count()) >= 1,
    "assistant markdown renders a code block"
  );
  assert(
    (await page.locator(".bubble.assistant .md table").count()) >= 1,
    "assistant markdown renders a GFM table"
  );

  // Truncated payload renders as a system note, not a crash.
  assert(
    await page.locator(".system-title", { hasText: "truncated" }).count() >= 1,
    "truncated payload renders as a system note"
  );

  // Tool chip expands to raw.
  const toolHead = page.locator(".tool-chip .tool-head").first();
  assert((await toolHead.count()) >= 1, "tool chip renders");
  await toolHead.click();
  assert(
    (await page.locator(".tool-chip .raw-block").count()) >= 1,
    "tool chip expands to show raw payload"
  );

  // Pretty/Raw toggle flips to raw rows and back.
  const toggle = page.locator(".mode-toggle");
  await toggle.click();
  await page.waitForTimeout(200);
  assert(
    (await transcript.locator(".log-line").count()) >= 1,
    "Raw mode shows raw log lines"
  );
  await toggle.click();
  await page.waitForTimeout(200);
  assert(
    (await transcript.locator(".bubble").count()) >= 1,
    "Pretty mode restores bubbles"
  );
}

async function main() {
  await stopLcaDaemons([3747, port]);
  const fixture = seedRunFixture();
  console.log("seeded fixture run:", fixture.runId);
  spawnDaemon();
  await sleep(1000);
  if (!(await waitForHealth())) {
    assert(false, "daemon HTTP /health responds");
    return fixture;
  }
  assert(true, "daemon HTTP /health responds");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await runUiChecks(page, fixture.runId);
  } finally {
    await closeWithTimeout(browser);
  }
  return fixture;
}

let fixture = null;
try {
  fixture = await main();
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  if (daemon) {
    daemon.kill("SIGTERM");
    await sleep(500);
  }
  if (fixture) {
    try {
      cleanupRunFixture(fixture);
      console.log("cleaned up fixture");
    } catch (e) {
      console.error("cleanup failed:", e);
    }
  }
  clearTimeout(hardExit);
  if (process.exitCode) {
    console.error("\n--- daemon log ---\n", log);
  } else {
    console.log("\nb3 UI verification passed.");
  }
}
