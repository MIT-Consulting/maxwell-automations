/**
 * b45.1 verification — planning profile selector, defaults, and review payload
 * on an isolated daemon.
 *
 * Isolation (non-negotiable): own temp LCA_HOME and port 3768. Never calls
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
const port = 3768;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const testHome = mkdtempSync(join(tmpdir(), "lca-b45-1-ui-"));

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
  const dashSrc = join(repoRoot, "packages", "dashboard", "src");
  const kickoff = readFileSync(join(dashSrc, "PipelineKickoffModal.tsx"), "utf8");
  const helpers = readFileSync(join(dashSrc, "pipelineKickoff.ts"), "utf8");
  assert(
    kickoff.includes("Planning profile") &&
      kickoff.includes("name=\"kickoff-profile\""),
    "kickoff modal renders planning profile radios"
  );
  assert(
    helpers.includes("profileId") && helpers.includes("buildKickoffVariables"),
    "assembleKickoffPayload accepts profileId"
  );
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

const STUB_MODELS = [
  { id: "planner-model", displayName: "Planner" },
  { id: "implementer-model", displayName: "Implementer" },
  { id: "reviewer-model", displayName: "Reviewer" },
  { id: "docs-model", displayName: "Docs" },
];

const ROLE_DEFAULTS = {
  planner: { id: "planner-model" },
  implementer: { id: "implementer-model" },
  reviewer: { id: "reviewer-model" },
  docs: { id: "docs-model" },
};

function seedHarness() {
  const lcaDir = join(testHome, ".cursor-local-automations");
  rmSync(lcaDir, { recursive: true, force: true });
  mkdirSync(lcaDir, { recursive: true });

  const workspace = mkdtempSync(join(tmpdir(), "lca-b45-1-ws-"));
  writeFileSync(join(workspace, "README.md"), "# b45.1 verify\n");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, "docs", "roadmap", "b45-profiles"), {
    recursive: true,
  });
  writeFileSync(
    join(workspace, "docs", "roadmap", "00-index.md"),
    [
      "# Roadmap",
      "",
      "<!-- next: b99 -->",
      "",
      "## Backlog",
      "",
      "- **b45** Configurable planning profiles. — [docs](./b45-profiles/00-index.md)",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(workspace, "docs", "roadmap", "b45-profiles", "00-index.md"),
    "# b45 — profiles\n"
  );
  writeFileSync(
    join(workspace, "docs", "roadmap", "b45-profiles", "prd.md"),
    "# PRD\nPrior art for resolve.\n"
  );
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
  ).run(wsId, resolve(workspace), "b45-1-ws");

  const fakeExecutor = {
    kind: "sdk-local",
    async spawn() {
      throw new Error("spawn must not run in b45.1 verify");
    },
    async resume() {
      throw new Error("resume not used in b45.1 verify");
    },
  };

  const events = new DaemonEventBus();
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

  return { testHome, workspace, wsId, db, events, engine, chatEngine };
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
    settings: { ...DEFAULT_SETTINGS, pipelineRoleModels: ROLE_DEFAULTS },
    triggers,
    listModels: async () => STUB_MODELS,
  });
}

async function openKickoff(page) {
  await page.addInitScript(() => {
    window.confirm = () => true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  await page
    .getByRole("button", { name: /Run feature pipeline/i })
    .first()
    .click();
  await page.getByRole("heading", { name: /Run feature pipeline/i }).waitFor({
    timeout: 10000,
  });

  const wsTrigger = page.locator("#kickoff-ws");
  await wsTrigger.click();
  await page.getByRole("option").first().click();
  await page.waitForTimeout(1000);

  await page.getByRole("radio", { name: /Existing feature/i }).check();
  await page.locator("#kickoff-feature").fill("b45");
}

async function assertReviewControls(page, expected) {
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForTimeout(2500);
  const dialog = page.getByRole("dialog");
  assert(
    (await dialog.getByText(expected.label, { exact: false }).count()) > 0,
    `review shows profile label ${expected.label}`
  );
  const json = await dialog.locator("pre").innerText();
  const payload = JSON.parse(json);
  assert(
    payload.variables?.planningDepth === expected.planningDepth,
    `payload planningDepth=${expected.planningDepth} (got ${payload.variables?.planningDepth})`
  );
  assert(
    payload.variables?.approvalPolicy === expected.approvalPolicy,
    `payload approvalPolicy=${expected.approvalPolicy} (got ${payload.variables?.approvalPolicy})`
  );
  assert(
    (await dialog.getByText(expected.planningDepth, { exact: true }).count()) >
      0,
    `review dl shows planningDepth ${expected.planningDepth}`
  );
  assert(
    (await dialog.getByText(expected.approvalPolicy, { exact: true }).count()) >
      0,
    `review dl shows approvalPolicy ${expected.approvalPolicy}`
  );
}

async function runProfileChecks(page) {
  await openKickoff(page);

  const quickRadio = page.locator('input[name="kickoff-profile"][value="quick"]');
  assert(await quickRadio.isChecked(), "Quick/JIT selected by default");

  await assertReviewControls(page, {
    label: "Quick/JIT",
    planningDepth: "jit",
    approvalPolicy: "none",
  });

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForTimeout(400);

  await page.locator('input[name="kickoff-profile"][value="deep"]').check();
  await assertReviewControls(page, {
    label: "Deep",
    planningDepth: "full",
    approvalPolicy: "none",
  });

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForTimeout(400);

  await page.locator('input[name="kickoff-profile"][value="guided"]').check();
  await assertReviewControls(page, {
    label: "Guided",
    planningDepth: "full",
    approvalPolicy: "before-implementation",
  });

  // Changing profile after Back must rebuild the review payload.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator('input[name="kickoff-profile"][value="quick"]').check();
  await assertReviewControls(page, {
    label: "Quick/JIT",
    planningDepth: "jit",
    approvalPolicy: "none",
  });

  // Do not click Start pipeline — review must remain side-effect-free.
  await page.keyboard.press("Escape");
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
    await runProfileChecks(page);
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
    console.log("\nb45.1 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
