/**
 * b56.9 verification — isolated kickoff-modal DOM proof for optional roles
 * and research approval (Phase 9 surface at the wire).
 *
 * Isolation (non-negotiable): own temp LCA_HOME / HOME / USERPROFILE and port
 * 3772. Never calls stop-lca-daemons, never touches :3747, never sets
 * LCA_FORCE_STOP_DAEMONS. No readFileSync of dashboard source (D35). Drive
 * real controls only (D39). Review must start nothing (D38).
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
const port = 3772;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;

const REQUIRED_ROLES = ["planner", "implementer", "reviewer", "docs"];
const OPTIONAL_ROLES = ["researcher", "gatekeeper", "architect"];
const RESEARCHER_MODEL = "researcher-model";
const GATEKEEPER_MODEL = "gatekeeper-model";
const REVIEWER_MODEL = "reviewer-model";

if (port === 3747) {
  console.error("verify-b56-9 must not use operator port 3747");
  process.exit(1);
}

const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevLcaHome = process.env.LCA_HOME;

const testHome = mkdtempSync(join(tmpdir(), "lca-b56-9-ui-"));
const lcaHome = join(testHome, ".cursor-local-automations");
mkdirSync(lcaHome, { recursive: true });

process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.LCA_HOME = lcaHome;

function restoreEnv() {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevLcaHome === undefined) delete process.env.LCA_HOME;
  else process.env.LCA_HOME = prevLcaHome;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  console.log("OK:", msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bounded poll — never a bare sleep as the only completion condition. */
async function waitUntil(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(150);
  }
}

function workspaceIdFromPath(workspacePath) {
  return Buffer.from(resolve(workspacePath)).toString("base64url");
}

function approvalRadio(page, value) {
  return page.locator(
    `input[name="kickoff-research-approval"][value="${value}"]`
  );
}

/**
 * Poll for an attribute value, then assert it once. On timeout the last
 * observed value is reported, so the printed line fails with a diagnosis
 * instead of a bare timeout.
 */
async function assertAttrBecomes(locator, attr, expected, msg) {
  let actual;
  try {
    actual = await waitUntil(msg, async () => {
      const value = await locator.getAttribute(attr);
      return value === expected ? value : null;
    });
  } catch {
    actual = await locator.getAttribute(attr);
  }
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);
}

const daemonServer = join(repoRoot, "packages/daemon/dist/http/server.js");
const dashboardIndex = join(repoRoot, "packages/dashboard/dist/index.html");
if (!existsSync(daemonServer)) {
  console.error("FAIL: daemon not built. Run `npm run build` first.");
  restoreEnv();
  process.exit(1);
}
if (!existsSync(dashboardIndex)) {
  console.error("FAIL: dashboard not built. Run `npm run build` first.");
  restoreEnv();
  process.exit(1);
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

const STUB_MODELS = [
  { id: "planner-model", displayName: "Planner" },
  { id: "implementer-model", displayName: "Implementer" },
  { id: REVIEWER_MODEL, displayName: "Reviewer" },
  { id: "docs-model", displayName: "Docs" },
  { id: RESEARCHER_MODEL, displayName: "Researcher" },
  { id: GATEKEEPER_MODEL, displayName: "Gatekeeper" },
];

/** Four required roles only — no researcher / gatekeeper profile default. */
const ROLE_DEFAULTS = {
  planner: { id: "planner-model" },
  implementer: { id: "implementer-model" },
  reviewer: { id: REVIEWER_MODEL },
  docs: { id: "docs-model" },
};

const hardExit = setTimeout(() => {
  console.error("Hard timeout reached.");
  restoreEnv();
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
  const workspace = mkdtempSync(join(tmpdir(), "lca-b56-9-ws-"));
  writeFileSync(join(workspace, "README.md"), "# b56.9 verify\n");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, "docs", "roadmap", "b56-kickoff"), {
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
      "- **b56** Optional researcher kickoff DOM proof. — [docs](./b56-kickoff/00-index.md)",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(workspace, "docs", "roadmap", "b56-kickoff", "00-index.md"),
    "# b56 — kickoff verify\n"
  );
  writeFileSync(
    join(workspace, "docs", "roadmap", "b56-kickoff", "prd.md"),
    "# PRD\nPrior art for kickoff resolve.\n"
  );
  writeFileSync(
    join(lcaHome, "automations.yaml"),
    [`workspaces:`, `  - ${JSON.stringify(workspace)}`, ``, `automations: []`, ``].join(
      "\n"
    )
  );

  const db = openDatabase(join(lcaHome, "state.sqlite"));
  const wsId = workspaceIdFromPath(workspace);
  db.prepare(
    "INSERT INTO workspaces (id, path, name) VALUES (?, ?, ?)"
  ).run(wsId, resolve(workspace), "b56-9-ws");

  const executorCalls = { spawn: 0, resume: 0 };
  const fakeExecutor = {
    kind: "sdk-local",
    async spawn() {
      executorCalls.spawn += 1;
      throw new Error("spawn must not run in b56.9 verify");
    },
    async resume() {
      executorCalls.resume += 1;
      throw new Error("resume must not run in b56.9 verify");
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

  return {
    testHome,
    workspace,
    wsId,
    db,
    events,
    engine,
    chatEngine,
    executorCalls,
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
    timeout: 10_000,
  });

  const wsTrigger = page.locator("#kickoff-ws");
  await wsTrigger.click();
  await page.getByRole("option").first().click();
  await waitUntil("optional role section after workspace select", async () =>
    (await page.locator("[data-optional-role-models]").count()) === 1
      ? true
      : null
  );

  await page.getByRole("radio", { name: /Existing feature/i }).check();
  await page.locator("#kickoff-feature").fill("b56");
}

async function selectOptionalRole(page, role, modelId) {
  const trigger = page.locator(
    `[data-optional-role="${role}"] [data-slot="select-trigger"]`
  );
  await trigger.click();
  await page.getByRole("option", { name: modelId, exact: true }).click();
  await waitUntil(`${role} select shows ${modelId}`, async () => {
    const text = (await trigger.innerText()).trim();
    return text.includes(modelId) ? true : null;
  });
}

async function resetOptionalRoleToDefault(page, role, defaultLabel) {
  const trigger = page.locator(
    `[data-optional-role="${role}"] [data-slot="select-trigger"]`
  );
  await trigger.click();
  await page.getByRole("option", { name: defaultLabel, exact: true }).click();
  await waitUntil(`${role} select shows ${defaultLabel}`, async () => {
    const text = (await trigger.innerText()).trim();
    return text.includes(defaultLabel) ? true : null;
  });
}

async function goToReview(page) {
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await waitUntil("review screen with payload pre", async () => {
    const dialog = page.getByRole("dialog");
    const hasHeading =
      (await dialog.getByText("Review — nothing written yet").count()) > 0;
    const hasPre = (await dialog.locator("pre").count()) > 0;
    return hasHeading && hasPre ? true : null;
  }, 20_000);
}

async function goBackToForm(page) {
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await waitUntil("form phase with optional roles", async () =>
    (await page.locator("[data-optional-role-models]").count()) === 1
      ? true
      : null
  );
}

async function reviewPayload(page) {
  const json = await page.getByRole("dialog").locator("pre").innerText();
  return JSON.parse(json);
}

async function assertStructure(page) {
  const required = page.locator("[data-required-role]");
  const requiredCount = await required.count();
  assert(requiredCount === 4, "exactly four [data-required-role] rows");

  const requiredRoles = [];
  for (let i = 0; i < requiredCount; i += 1) {
    requiredRoles.push(await required.nth(i).getAttribute("data-required-role"));
  }
  assert(
    JSON.stringify(requiredRoles) === JSON.stringify(REQUIRED_ROLES),
    `required rows are exactly ${REQUIRED_ROLES.join(", ")} with no researcher or gatekeeper (got ${requiredRoles.join(", ")})`
  );

  const optionalSections = page.locator("[data-optional-role-models]");
  assert(
    (await optionalSections.count()) === 1,
    "exactly one [data-optional-role-models] section"
  );

  const optional = page.locator("[data-optional-role]");
  const optionalCount = await optional.count();
  assert(optionalCount === 3, "exactly three [data-optional-role] rows");
  const optionalRoles = [];
  for (let i = 0; i < optionalCount; i += 1) {
    optionalRoles.push(await optional.nth(i).getAttribute("data-optional-role"));
  }
  assert(
    JSON.stringify(optionalRoles) === JSON.stringify(OPTIONAL_ROLES),
    `optional roles are researcher then gatekeeper (got ${optionalRoles.join(", ")})`
  );

  const researcherTrigger = page.locator(
    '[data-optional-role="researcher"] [data-slot="select-trigger"]'
  );
  const gatekeeperTrigger = page.locator(
    '[data-optional-role="gatekeeper"] [data-slot="select-trigger"]'
  );
  const architectTrigger = page.locator(
    '[data-optional-role="architect"] [data-slot="select-trigger"]'
  );
  const researcherLabel = (await researcherTrigger.innerText()).trim();
  const gatekeeperLabel = (await gatekeeperTrigger.innerText()).trim();
  const architectLabel = (await architectTrigger.innerText()).trim();
  assert(
    researcherLabel.includes("Disabled"),
    `unset researcher default reads Disabled (got ${JSON.stringify(researcherLabel)})`
  );
  assert(
    gatekeeperLabel.includes("Reviewer fallback"),
    `unset gatekeeper default reads Reviewer fallback (got ${JSON.stringify(gatekeeperLabel)})`
  );
  assert(
    architectLabel.includes("Planner fallback"),
    `unset architect default reads Planner fallback (got ${JSON.stringify(architectLabel)})`
  );

  const approval = page.locator("[data-research-approval]");
  assert((await approval.count()) === 1, "research approval fieldset present");
  assert(
    (await approval.getAttribute("data-research-approval")) === "none",
    "approval reports none without a researcher"
  );

  const radios = page.locator('input[name="kickoff-research-approval"]');
  assert((await radios.count()) === 2, "two research-approval radios");
  assert(
    await approvalRadio(page, "none").isDisabled(),
    "Continue automatically radio disabled without a researcher"
  );
  assert(
    await approvalRadio(page, "before-planning").isDisabled(),
    "Review before planning radio disabled without a researcher"
  );

  const adjacency = await page.evaluate(() => {
    const section = document.querySelector("[data-optional-role-models]");
    if (!section) return { ok: false, reason: "missing optional section" };
    const researcher = section.querySelector(
      '[data-optional-role="researcher"]'
    );
    const gatekeeper = section.querySelector(
      '[data-optional-role="gatekeeper"]'
    );
    const architect = section.querySelector('[data-optional-role="architect"]');
    const fieldset = section.querySelector("[data-research-approval]");
    if (!researcher || !gatekeeper || !architect || !fieldset) {
      return {
        ok: false,
        reason: "missing researcher, gatekeeper, architect, or fieldset",
      };
    }
    if (researcher.contains(fieldset)) {
      return { ok: false, reason: "fieldset is inside researcher row" };
    }
    if (
      researcher.parentElement !== section ||
      gatekeeper.parentElement !== section ||
      fieldset.parentElement !== section
    ) {
      return {
        ok: false,
        reason: "fieldset/rows are not direct children of optional section",
      };
    }
    if (researcher.nextElementSibling !== fieldset) {
      return {
        ok: false,
        reason: "fieldset is not the sibling immediately after researcher",
      };
    }
    if (fieldset.nextElementSibling !== gatekeeper) {
      return {
        ok: false,
        reason: "gatekeeper is not the sibling immediately after fieldset",
      };
    }
    if (gatekeeper.nextElementSibling !== architect) {
      return {
        ok: false,
        reason: "architect is not the sibling immediately after gatekeeper",
      };
    }
    return { ok: true };
  });
  assert(
    adjacency.ok,
    `approval fieldset adjacency/order (${adjacency.reason ?? "ok"})`
  );
}

async function assertArming(page) {
  await selectOptionalRole(page, "researcher", RESEARCHER_MODEL);

  const approval = page.locator("[data-research-approval]");
  assert(
    (await approval.getAttribute("data-research-approval")) === "none",
    "approval still none after selecting researcher"
  );
  assert(
    await approvalRadio(page, "none").isEnabled(),
    "Continue automatically radio enabled once a researcher resolves"
  );
  assert(
    await approvalRadio(page, "before-planning").isEnabled(),
    "Review before planning radio enabled once a researcher resolves"
  );

  await approvalRadio(page, "before-planning").check();
  await assertAttrBecomes(
    approval,
    "data-research-approval",
    "before-planning",
    "checking Review before planning sets before-planning"
  );
}

async function assertReviewFactsAndPayload(page, expected) {
  await goToReview(page);
  const dialog = page.getByRole("dialog");

  const entryText = (
    await dialog.locator('[data-review-fact="entry-worker"]').innerText()
  ).trim();
  assert(
    entryText.includes(expected.entryWorker),
    `entry-worker fact shows ${expected.entryWorker} (got ${JSON.stringify(entryText)})`
  );

  const researcherText = (
    await dialog.locator('[data-review-fact="researcher"]').innerText()
  ).trim();
  assert(
    researcherText.includes(expected.researcher),
    `researcher fact shows ${expected.researcher} (got ${JSON.stringify(researcherText)})`
  );

  const approvalText = (
    await dialog.locator('[data-review-fact="research-approval"]').innerText()
  ).trim();
  assert(
    approvalText.includes(expected.researchApproval),
    `research-approval fact shows ${expected.researchApproval} (got ${JSON.stringify(approvalText)})`
  );

  const gatekeeperText = (
    await dialog.locator('[data-review-fact="gatekeeper"]').innerText()
  ).trim();
  assert(
    gatekeeperText.includes(expected.gatekeeperId) &&
      gatekeeperText.includes(expected.gatekeeperSource),
    `gatekeeper fact shows ${expected.gatekeeperId} (${expected.gatekeeperSource}) (got ${JSON.stringify(gatekeeperText)})`
  );

  const architectText = (
    await dialog.locator('[data-review-fact="architect"]').innerText()
  ).trim();
  assert(
    architectText.includes(expected.architectId) &&
      architectText.includes(expected.architectSource),
    `architect fact shows ${expected.architectId} (${expected.architectSource}) (got ${JSON.stringify(architectText)})`
  );

  const payload = await reviewPayload(page);
  assert(
    payload.variables?.researchApprovalPolicy === expected.researchApproval,
    `payload researchApprovalPolicy=${expected.researchApproval} (got ${payload.variables?.researchApprovalPolicy})`
  );
  return payload;
}

async function runUiChecks(page, harness) {
  console.log("progress: open kickoff modal");
  await openKickoff(page);

  console.log("progress: structure assertions");
  await assertStructure(page);

  console.log("progress: arm researcher + before-planning");
  await assertArming(page);

  console.log("progress: review facts (reviewer fallback gatekeeper)");
  await assertReviewFactsAndPayload(page, {
    entryWorker: "research",
    researcher: RESEARCHER_MODEL,
    researchApproval: "before-planning",
    gatekeeperId: REVIEWER_MODEL,
    gatekeeperSource: "reviewer fallback",
    architectId: "planner-model",
    architectSource: "planner fallback",
  });

  console.log("progress: explicit gatekeeper");
  await goBackToForm(page);
  await selectOptionalRole(page, "gatekeeper", GATEKEEPER_MODEL);
  await assertReviewFactsAndPayload(page, {
    entryWorker: "research",
    researcher: RESEARCHER_MODEL,
    researchApproval: "before-planning",
    gatekeeperId: GATEKEEPER_MODEL,
    gatekeeperSource: "explicit",
    architectId: "planner-model",
    architectSource: "planner fallback",
  });

  console.log("progress: reset researcher clears armed policy");
  await goBackToForm(page);
  await resetOptionalRoleToDefault(page, "researcher", "Disabled");

  const approval = page.locator("[data-research-approval]");
  await assertAttrBecomes(
    approval,
    "data-research-approval",
    "none",
    "approval back to none after researcher reset"
  );
  assert(
    await approvalRadio(page, "none").isDisabled(),
    "Continue automatically radio disabled again after researcher reset"
  );
  assert(
    await approvalRadio(page, "before-planning").isDisabled(),
    "Review before planning radio disabled again after researcher reset"
  );

  await goToReview(page);
  const payload = await reviewPayload(page);
  assert(
    payload.variables?.researchApprovalPolicy === "none",
    `fresh review payload researchApprovalPolicy=none (got ${payload.variables?.researchApprovalPolicy})`
  );
  // Do not click Start pipeline — review must remain side-effect-free (D38).
  await page.keyboard.press("Escape");

  const runCount = harness.db
    .prepare("SELECT COUNT(*) AS c FROM runs")
    .get().c;
  assert(runCount === 0, `runs table empty at end (got ${runCount})`);
  assert(
    harness.executorCalls.spawn === 0 && harness.executorCalls.resume === 0,
    `fake executor never called (spawn=${harness.executorCalls.spawn}, resume=${harness.executorCalls.resume})`
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

    console.log("progress: launching browser");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await runUiChecks(page, harness);
  } finally {
    console.log("progress: cleanup");
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
      /* tolerate Windows WAL locks */
    }
    restoreEnv();
    clearTimeout(hardExit);
  }
}

const result = await main()
  .then(() => {
    console.log("\nb56.9 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
