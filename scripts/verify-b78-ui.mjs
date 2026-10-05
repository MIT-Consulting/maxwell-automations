/**
 * b78 UI verification — roadmap readiness badges, post-register summary,
 * kickoff blockers, and disabled picker rows on an isolated dashboard.
 *
 * Isolation: temp HOME / USERPROFILE / LCA_HOME and port 3768 only. Never
 * preflight-kill :3747 or write live state.sqlite.
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
const port = 3768;
const livePort = 3747;
const liveBase = `http://127.0.0.1:${livePort}`;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;

if (port === 3747) {
  console.error("FAIL: verify-b78-ui must not use operator port 3747");
  process.exit(1);
}

const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  LCA_HOME: process.env.LCA_HOME,
};

const testHome = mkdtempSync(join(tmpdir(), "lca-b78-ui-"));
const lcaHome = join(testHome, ".cursor-local-automations");
mkdirSync(lcaHome, { recursive: true });

process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.LCA_HOME = lcaHome;

function restoreEnv() {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function pathUnderHome(filePath, home) {
  const norm = (p) => resolve(p).replace(/\\/g, "/");
  const resolved = norm(filePath);
  const root = norm(home);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  if (process.platform === "win32") {
    const lower = resolved.toLowerCase();
    const lowerRoot = root.toLowerCase();
    const lowerPrefix = lowerRoot.endsWith("/")
      ? lowerRoot
      : `${lowerRoot}/`;
    return lower === lowerRoot || lower.startsWith(lowerPrefix);
  }
  return resolved === root || resolved.startsWith(prefix);
}

if (!existsSync(join(repoRoot, "packages/dashboard/dist/index.html"))) {
  console.error(
    "SKIP: dashboard not built. Run `npm run build -w @lca/dashboard` first."
  );
  restoreEnv();
  process.exit(0);
}

console.log("progress: importing daemon dist under temp LCA_HOME");
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
  { GLOBAL_CONFIG_PATH },
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
  import("../packages/daemon/dist/paths.js"),
]);

assert(
  pathUnderHome(GLOBAL_CONFIG_PATH, testHome),
  `GLOBAL_CONFIG_PATH is under temp home (${GLOBAL_CONFIG_PATH})`
);

/** @returns {Promise<{ count: number; regKeys: string[] } | null>} */
async function liveWorkspaceSnapshot() {
  try {
    const res = await fetch(`${liveBase}/api/workspaces`);
    if (!res.ok) return null;
    const body = await res.json();
    const workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];
    const regKeys = workspaces
      .filter((row) => {
        const path = String(row.path ?? "");
        const name = String(row.name ?? "");
        const id = String(row.id ?? "");
        return (
          path.includes("lca-b78-reg-") ||
          name.includes("lca-b78-reg-") ||
          id.includes("lca-b78-reg-")
        );
      })
      .map((row) => String(row.id ?? row.path ?? ""))
      .sort();
    return { count: workspaces.length, regKeys };
  } catch {
    return null;
  }
}

let http;
let browser;
let db;
let hardTimeout;
let tempWorkspace;

async function cleanup() {
  clearTimeout(hardTimeout);
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  try {
    await http?.close();
  } catch {
    /* ignore */
  }
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  try {
    if (tempWorkspace) rmSync(tempWorkspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    /* Windows may briefly lock SQLite WAL files */
  }
  restoreEnv();
}

hardTimeout = setTimeout(() => {
  console.error("FAIL: hard timeout");
  void cleanup().finally(() => process.exit(1));
}, HARD_TIMEOUT_MS);

function writeRoadmapIndex(workspacePath) {
  const roadmapDir = join(workspacePath, "docs", "roadmap");
  mkdirSync(roadmapDir, { recursive: true });
  writeFileSync(
    join(roadmapDir, "00-index.md"),
    `# Roadmap

<!-- next: b100 -->

## Backlog (prioritized)

- **b96** Visible backlog row — no link.

## Planning scratchpad

| ID | Item | Notes |
| --- | ---- | ----- |
| b99 | Should not be kickoff-visible | ignored |

## Completed

| ID | Feature | Description | Docs |
|----|---------|-------------|------|
| b98 | Duplicate one | first | — |
`
  );
}

try {
  db = openDatabase(join(lcaHome, "state.sqlite"));

  tempWorkspace = mkdtempSync(join(tmpdir(), "lca-b78-ws-"));
  mkdirSync(join(tempWorkspace, ".git"));
  writeRoadmapIndex(tempWorkspace);

  const wsId = randomUUID();
  db.prepare("INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)").run(
    wsId,
    tempWorkspace,
    "b78-ui"
  );

  const events = new DaemonEventBus();
  const fakeExecutor = {
    kind: "sdk-local",
    async spawn() {
      throw new Error("spawn not used");
    },
    async resume() {
      throw new Error("resume not used");
    },
  };

  const engine = new RunEngine(db, {
    apiKey: "test",
    executor: fakeExecutor,
    events,
    inputHub: new InputHub(new InputStore(db), {
      onNeedsInput: () => {},
      onAnswered: () => {},
    }),
    maxConcurrentRuns: 1,
  });
  const chatEngine = new ChatEngine(db, {
    apiKey: "test",
    executor: fakeExecutor,
    events,
  });

  http = await startHttpServer({
    engine,
    chatEngine,
    store: new DashboardStore(db),
    db,
    events,
    apiKey: "test",
    port,
    host: "127.0.0.1",
    settings: DEFAULT_SETTINGS,
  });

  const summaries = await fetch(`${base}/api/roadmap-readiness`);
  assert(summaries.ok, "roadmap-readiness summaries endpoint");
  const summaryBody = await summaries.json();
  assert(
    summaryBody.workspaces?.some((row) => row.workspaceId === wsId),
    "summary includes seeded workspace"
  );

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: "networkidle" });

  await page.waitForSelector('[aria-label="Workspace"]', { timeout: 15000 });
  await page.click('[aria-label="Workspace"]');
  await page.waitForSelector('[aria-label^="Roadmap"]', { timeout: 10000 });
  assert(true, "workspace row shows roadmap readiness badge");
  await page.keyboard.press("Escape");

  const liveBefore = await liveWorkspaceSnapshot();
  if (liveBefore) {
    console.log(
      `OK: live daemon snapshot before register (count=${liveBefore.count}, reg=${liveBefore.regKeys.length})`
    );
  }

  const addWorkspace = page
    .getByRole("button", { name: "Add workspace" })
    .or(page.getByRole("button", { name: /Add workspace/i }))
    .or(page.getByText("Add workspace…"));
  await addWorkspace.first().click({ timeout: 15000 });
  await page.waitForSelector("#sidebar-add-workspace-path", { timeout: 10000 });
  const registerPath = mkdtempSync(join(tmpdir(), "lca-b78-reg-"));
  mkdirSync(join(registerPath, ".git"));
  writeRoadmapIndex(registerPath);
  await page.fill("#sidebar-add-workspace-path", registerPath);
  await page.click('button:has-text("Register workspace")');
  await page.waitForSelector('[data-testid="post-register-readiness"]', {
    timeout: 15000,
  });
  const postRegister = await page.textContent(
    '[data-testid="post-register-readiness"]'
  );
  assert(
    postRegister && /Roadmap readiness:/i.test(postRegister),
    "post-registration readiness summary"
  );

  const tempRegRows = db
    .prepare("SELECT path FROM workspaces WHERE path LIKE ?")
    .all("%lca-b78-reg-%");
  assert(
    tempRegRows.some((row) => String(row.path).includes("lca-b78-reg-")),
    "temp DB contains lca-b78-reg- workspace"
  );

  if (liveBefore) {
    const liveAfter = await liveWorkspaceSnapshot();
    if (!liveAfter) {
      throw new Error(
        "ISOLATION: live daemon was reachable before register but not after"
      );
    }
    assert(
      liveAfter.count === liveBefore.count,
      `live workspace count unchanged (${liveBefore.count})`
    );
    assert(
      JSON.stringify(liveAfter.regKeys) === JSON.stringify(liveBefore.regKeys),
      "live daemon has no new lca-b78-reg-* workspaces"
    );
  }
  assert(true, "isolation assertions passed");

  await page.click('button:has-text("Done")');

  await page.click('[aria-label="Workspace"]');
  await page.getByRole("option", { name: /b78-ui/i }).click();
  await page.keyboard.press("Escape");

  const readinessRes = await fetch(
    `${base}/api/workspaces/${encodeURIComponent(wsId)}/roadmap-readiness`
  );
  assert(readinessRes.ok, "full readiness report");
  const readiness = await readinessRes.json();
  const ignored = readiness.findings?.find((f) => f.code === "ignored-section-ids");
  assert(
    ignored?.featureIds?.includes("b99"),
    "fixture exposes ignored-section b99 in readiness report"
  );

  const kickoff = page
    .getByRole("button", { name: /Run feature pipeline/i })
    .or(page.getByLabel("Run feature pipeline"));
  await Promise.all([
    page.waitForResponse(
      (resp) =>
        resp.url().includes("/api/pipelines/implement-fully") &&
        resp.url().includes("workspaceId") &&
        resp.status() === 200,
      { timeout: 15000 }
    ),
    kickoff.first().click({ timeout: 15000 }),
  ]);
  await page.waitForSelector("#kickoff-feature", { timeout: 15000 });
  await page.fill("#kickoff-feature", "b99");
  await page.locator("#kickoff-feature").click();
  await page.waitForSelector('[data-lca-dialog-portal] button[disabled]', {
    timeout: 15000,
  });
  const disabledReason = await page
    .locator('[data-lca-dialog-portal] button[disabled]')
    .filter({ hasText: "b99" })
    .first()
    .textContent()
    .catch(() => null);
  assert(
    disabledReason && /sections Max ignores/i.test(disabledReason),
    "disabled picker row shows shared reason"
  );
  const disabledFocused = await page.evaluate(() => {
    const buttons = [
      ...document.querySelectorAll("[data-lca-dialog-portal] button[disabled]"),
    ];
    const btn = buttons.find((el) => (el.textContent ?? "").includes("b99"));
    if (!(btn instanceof HTMLButtonElement)) return "missing";
    btn.focus();
    return document.activeElement === btn ? "focused" : "skipped";
  });
  assert(
    disabledFocused === "skipped",
    "disabled picker row is not keyboard-focusable"
  );

  const resolveRes = await fetch(
    `${base}/api/pipelines/implement-fully/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: wsId,
        input: { kind: "feature-id", featureId: "b99" },
      }),
    }
  );
  assert(resolveRes.status === 400, "resolve rejects ignored-section feature id");
  const resolveBody = await resolveRes.json();
  assert(
    /sections Max ignores/i.test(resolveBody.error ?? ""),
    "kickoff resolve returns shared blocker/fix text"
  );

  rmSync(registerPath, { recursive: true, force: true });
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error("FAIL:", err instanceof Error ? err.message : err);
  await cleanup();
  process.exit(1);
}
