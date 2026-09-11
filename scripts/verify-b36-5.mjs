/**
 * b36.05d verification — pipeline board grouping, lineage, escalation gating,
 * one real retry, and kickoff validation on an isolated daemon.
 *
 * Isolation (non-negotiable): own temp LCA_HOME and port 3766. Never calls
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
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3766;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;
const testHome = mkdtempSync(join(tmpdir(), "lca-b36-5-ui-"));

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
  { ChainRunner },
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
  import("../packages/daemon/dist/runs/store.js"),
  import("../packages/daemon/dist/runs/chain-runner.js"),
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
  const api = readFileSync(join(dashSrc, "api.ts"), "utf8");
  const kickoff = readFileSync(join(dashSrc, "PipelineKickoffModal.tsx"), "utf8");
  const kickoffHelpers = readFileSync(join(dashSrc, "pipelineKickoff.ts"), "utf8");
  assert(
    api.includes("/escalate") || api.includes("escalate("),
    "dashboard sources reference the escalation endpoint"
  );
  assert(
    kickoff.includes("IMPLEMENT_FULLY_PIPELINE_ID"),
    "kickoff references IMPLEMENT_FULLY_PIPELINE_ID"
  );
  assert(
    api.includes("resolveImplementFullyKickoff") &&
      api.includes("/resolve"),
    "dashboard API client exposes implement-fully resolve"
  );
  assert(
    kickoff.includes("resolveImplementFullyKickoff") &&
      kickoffHelpers.includes("buildResolveImplementFullyKickoffRequest"),
    "kickoff modal resolves through the shared request adapter"
  );
  assert(
    !kickoff.includes('id="kickoff-slug"'),
    "kickoff modal has no editable slug field"
  );
  for (const name of [
    "PipelineKickoffModal.tsx",
    "pipelineGrouping.ts",
    "cards.tsx",
    "pipelineKickoff.ts",
  ]) {
    const src = readFileSync(join(dashSrc, name), "utf8");
    assert(
      !/['"`][^'"`]*::generated:/.test(src),
      `${name} has no hand-built generated: automation id literals`
    );
  }
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

const WORKERS = [
  {
    key: "generated:plan-skeleton",
    name: "plan-skeleton",
    role: "planner",
    next: "generated:plan-phase",
  },
  {
    key: "generated:plan-phase",
    name: "plan-phase",
    role: "planner",
    next: "generated:implement",
  },
  {
    key: "generated:implement",
    name: "implement",
    role: "implementer",
    next: "generated:review",
  },
  {
    key: "generated:review",
    name: "review",
    role: "reviewer",
    next: "generated:docs-commit",
  },
  {
    key: "generated:docs-commit",
    name: "docs-commit",
    role: "docs",
    next: "generated:plan-phase",
  },
];

const CONTEXT = {
  variables: {
    pipelineId: "implement-fully",
    featureId: "b36",
    featureSlug: "b36-verify-gate",
    featureDir: "docs/roadmap/b36-verify-gate",
    featureIndex: "docs/roadmap/b36-verify-gate/00-index.md",
    idea: "verify-gate-secret-idea-should-not-appear-in-ui-chips",
  },
  roleModels: {
    planner: { id: "planner-model" },
    implementer: { id: "implementer-model" },
    reviewer: { id: "reviewer-model" },
    docs: { id: "docs-model" },
  },
};

function seedHarness() {
  const lcaDir = join(testHome, ".cursor-local-automations");
  rmSync(lcaDir, { recursive: true, force: true });
  mkdirSync(lcaDir, { recursive: true });

  const workspace = mkdtempSync(join(tmpdir(), "lca-b36-5-ws-"));
  writeFileSync(join(workspace, "README.md"), "# b36.5 verify\n");
  mkdirSync(join(workspace, ".cursor"), { recursive: true });
  // Kickoff preconditions: git repo + roadmap index with next marker + b36 prior art
  mkdirSync(join(workspace, ".git"), { recursive: true });
  mkdirSync(join(workspace, "docs", "roadmap", "b36-verify-gate"), {
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
      "- **b36** Verify gate — isolated UI check. — [docs](./b36-verify-gate/00-index.md)",
      "",
      "## Completed",
      "",
      "| ID | Feature | Description | Docs |",
      "|----|---------|-------------|------|",
      "",
      "## Documented Ideas",
      "",
      "| ID | Idea | Status | File |",
      "|----|------|--------|------|",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(workspace, "docs", "roadmap", "b36-verify-gate", "00-index.md"),
    "# b36 — Verify gate\n"
  );
  writeFileSync(
    join(workspace, "docs", "roadmap", "b36-verify-gate", "prd.md"),
    "# PRD\nIsolated prior art for resolve.\n"
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
  ).run(wsId, resolve(workspace), "b36-5-ws");

  const autoIds = {};
  for (const w of WORKERS) {
    const id = `${wsId}::${w.key}`;
    autoIds[w.key] = id;
    const chainJson = JSON.stringify({
      next: w.next,
      when: "completed",
      passResult: true,
    });
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, origin, trigger_json, prompt,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, ?, ?, 1, 'enabled', 'generated', '{"type":"manual"}', ?,
        'generated.yaml', ?, ?, ?)`
    ).run(id, wsId, w.name, `Prompt ${w.name} {{featureId}}`, w.key, chainJson, w.role);
  }

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const rootId = randomUUID();
  const depths = [
    {
      id: rootId,
      key: "generated:plan-skeleton",
      depth: 0,
      status: "completed",
      handled: true,
    },
    {
      id: randomUUID(),
      key: "generated:plan-phase",
      depth: 1,
      status: "completed",
      handled: true,
    },
    {
      id: randomUUID(),
      key: "generated:implement",
      depth: 2,
      status: "failed",
      handled: false,
      halt: true,
    },
    {
      id: randomUUID(),
      key: "generated:plan-skeleton",
      depth: 0,
      status: "failed",
      handled: false,
      rootHalt: true,
      maxDepth: 5,
    },
    {
      id: randomUUID(),
      key: "generated:docs-commit",
      depth: 5,
      status: "failed",
      handled: false,
      budgetHalt: true,
      maxDepth: 5,
      rootId: randomUUID(),
    },
  ];

  let haltedId = null;
  let rootHaltId = null;
  let budgetHaltId = null;
  let parentOfHalt = null;

  for (const d of depths) {
    const runRoot = d.rootId ?? (d.rootHalt ? d.id : rootId);
    const maxDepth = d.maxDepth ?? 9;
    store.insertRun({
      id: d.id,
      automationId: autoIds[d.key],
      workspaceId: wsId,
      triggerKind: d.depth === 0 ? "manual" : "chain",
      prompt: `stored prompt for ${d.key}`,
      chainContext: CONTEXT,
      chainRootRunId: runRoot,
      chainDepth: d.depth,
      chainMaxDepth: maxDepth,
      parentRunId: d.depth === 2 ? depths[1].id : d.depth === 1 ? rootId : null,
    });
    store.setStatus(d.id, d.status);
    if (d.handled) {
      db.prepare(
        `UPDATE runs SET chain_handled_at = datetime('now') WHERE id = ?`
      ).run(d.id);
    }
    if (d.halt) {
      haltedId = d.id;
      parentOfHalt = depths[1].id;
      store.appendEvent(d.id, "run.chain-skipped", {
        reason: "status-mismatch",
        next: "generated:review",
        status: "failed",
        when: "completed",
        depth: 2,
        maxDepth: 9,
      });
    }
    if (d.rootHalt) rootHaltId = d.id;
    if (d.budgetHalt) budgetHaltId = d.id;
  }

  const fakeExecutor = {
    kind: "sdk-local",
    async spawn(params) {
      return {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        async wait() {
          return { status: "finished", result: "ok" };
        },
        async cancel() {},
        async dispose() {},
      };
    },
    async resume() {
      throw new Error("resume not used in b36.5 verify");
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
    maxConcurrentRuns: 4,
  });
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
  });
  chainRunner.start();
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
    store,
    chainRunner,
    haltedId,
    rootHaltId,
    budgetHaltId,
    rootId,
    parentOfHalt,
    autoIds,
  };
}

const STUB_MODELS = [
  { id: "planner-model", displayName: "Planner" },
  { id: "implementer-model", displayName: "Implementer" },
  { id: "reviewer-model", displayName: "Reviewer" },
  { id: "docs-model", displayName: "Docs" },
];

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
    // Empty role defaults so the modal can refuse unresolved roles.
    settings: { ...DEFAULT_SETTINGS, pipelineRoleModels: {} },
    triggers,
    listModels: async () => STUB_MODELS,
  });
}

async function runBoardChecks(page, harness) {
  await page.addInitScript(() => {
    window.confirm = () => true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const groupHeader = page.getByText("b36", { exact: true }).first();
  await groupHeader.waitFor({ state: "visible", timeout: 15000 });
  assert(await groupHeader.isVisible(), "board group header names the feature");

  const implementChip = page.getByText(/b36 · implement/i).first();
  await implementChip.waitFor({ state: "visible", timeout: 10000 });
  assert(await implementChip.isVisible(), "cards show step/cycle chip labels");

  const haltedCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/b36 · implement/i) })
    .first();
  await haltedCard.waitFor({ state: "visible", timeout: 10000 });
  const haltedClass = await haltedCard.getAttribute("class");
  assert(
    haltedClass != null && haltedClass.includes("ring-status-failed"),
    "halted card is visually distinguished"
  );

  // Escalation actions on halted card
  await haltedCard.hover();
  const retryBtn = haltedCard.getByRole("button", { name: "Retry", exact: true });
  const skipBtn = haltedCard.getByRole("button", { name: "Skip", exact: true });
  const abortBtn = haltedCard.getByRole("button", { name: "Abort", exact: true });
  assert(await retryBtn.isVisible(), "Retry present on halted card");
  assert(await skipBtn.isVisible(), "Skip present on halted card");
  assert(await abortBtn.isVisible(), "Abort present on halted card");

  // Confirmation dialog for Retry
  await retryBtn.click();
  const dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("heading", { name: /Retry this pipeline step/i })
    .waitFor({ timeout: 5000 });
  assert(true, "Retry opens confirmation dialog");

  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await page.waitForTimeout(2500);

  // Surface UI error if escalate failed
  const escErr = page.locator(".text-destructive").filter({
    hasText: /not-halted|already-chained|root-run|Escalat/i,
  });
  if ((await escErr.count()) > 0) {
    throw new Error(`escalation UI error: ${await escErr.first().innerText()}`);
  }

  const after = await page.evaluate(async () => {
    const res = await fetch("/api/runs?limit=200");
    return res.json();
  });
  // Stub executor finishes instantly, so ChainRunner may enqueue further
  // successors — assert the escalation child itself, not a +1 count.
  const child = after.runs.find(
    (r) =>
      r.parentRunId === harness.haltedId &&
      r.triggerKind === "escalation" &&
      r.chainDepth === 2
  );
  assert(child != null, "retry created a child run at the same depth");
  assert(
    child.pipeline?.featureId === "b36" &&
      child.chainRootRunId === harness.rootId,
    "retry child preserves pipeline context identity"
  );

  // Root halt: Retry disabled
  const rootCard = page
    .locator('[data-slot="card"]')
    .filter({
      has: page.locator(`[title*="root ${harness.rootHaltId}"] , [title*="depth 0/"]`),
    })
    .first();
  // Prefer locating via plan-skeleton chip near failed root
  const skeletonCards = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/b36 · plan-skeleton|b36$/i) });
  const count = await skeletonCards.count();
  let foundRootGate = false;
  for (let i = 0; i < count; i++) {
    const card = skeletonCards.nth(i);
    await card.hover();
    const btn = card.getByRole("button", { name: "Retry", exact: true });
    if ((await btn.count()) === 0) continue;
    const disabled = await btn.isDisabled();
    const title = (await btn.getAttribute("title")) ?? "";
    if (disabled && /root/i.test(title)) {
      foundRootGate = true;
      break;
    }
  }
  assert(foundRootGate, "Retry disabled on depth-0 root with reason in title");

  // Budget halt: Skip disabled
  const budgetCards = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/docs-commit/i) });
  const bCount = await budgetCards.count();
  let foundBudgetGate = false;
  for (let i = 0; i < bCount; i++) {
    const card = budgetCards.nth(i);
    await card.hover();
    const btn = card.getByRole("button", { name: "Skip", exact: true });
    if ((await btn.count()) === 0) continue;
    const disabled = await btn.isDisabled();
    const title = (await btn.getAttribute("title")) ?? "";
    if (disabled && /budget/i.test(title)) {
      foundBudgetGate = true;
      break;
    }
  }
  assert(foundBudgetGate, "Skip disabled at budget with reason in title");

  // Lineage: open parent / root from a mid-pipeline card (post-retry implement or completed plan-phase)
  const midCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("button", { name: "Open parent run" }) })
    .first();
  await midCard.hover();
  await midCard.getByRole("button", { name: "Open parent run" }).click();
  await page.getByRole("navigation", { name: "Pipeline lineage" }).waitFor({
    timeout: 10000,
  });
  assert(true, "lineage navigation opens in run modal");
  const lineageNav = page.getByRole("navigation", { name: "Pipeline lineage" });
  const currentMarked = lineageNav.locator("button.border-primary, button.bg-primary");
  assert(
    (await currentMarked.count()) >= 1,
    "lineage marks the current run"
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // Kickoff validation — thin feature-id / idea intents resolve into review.
  const kickoffBtn = page
    .getByRole("button", { name: /Run feature pipeline/i })
    .first();
  await kickoffBtn.click();
  await page.getByRole("heading", { name: /Run feature pipeline/i }).waitFor({
    timeout: 10000,
  });

  // Workspace select (required for introspection + preconditions)
  const wsTrigger = page.locator("#kickoff-ws");
  await wsTrigger.click();
  await page.getByRole("option").first().click();
  await page.waitForTimeout(800);

  await page.getByRole("radio", { name: /Existing feature/i }).check();
  await page.locator("#kickoff-feature").fill("feature-36");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForTimeout(500);
  const validationText = await page
    .locator("p.text-destructive")
    .first()
    .innerText()
    .catch(() => "");
  assert(
    /featureId must match/i.test(validationText),
    `kickoff validates an invalid feature id inline (got: ${validationText || "(none)"})`
  );

  await page.locator("#kickoff-feature").fill("b36");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForTimeout(1500);
  assert(
    (await page.getByText(/pipelineRoleModels|no override and no default|Or pick a model/i).count()) >
      0,
    "kickoff validates an unresolved role inline"
  );

  // Pick a model for each role, then Review → canonical metadata + maxDepth: 1
  for (const role of ["planner", "implementer", "reviewer", "docs"]) {
    const trigger = page
      .locator("div.flex.items-center.gap-2")
      .filter({ has: page.getByText(role, { exact: true }) })
      .getByRole("combobox");
    await trigger.click();
    await page.getByRole("option", { name: `${role}-model` }).first().click();
    await page.waitForTimeout(150);
  }

  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForTimeout(2500);
  const reviewDialog = page.getByRole("dialog");
  assert(
    (await reviewDialog.getByText("b36", { exact: true }).count()) > 0,
    "existing-feature review shows canonical feature id"
  );
  assert(
    (await reviewDialog.getByText("b36-verify-gate", { exact: true }).count()) >
      0,
    "existing-feature review shows canonical feature slug"
  );
  assert(
    (await reviewDialog
      .getByText(/Verify gate — isolated UI check\. Prior art:/i)
      .count()) > 0,
    "existing-feature review shows canonical idea with prior art"
  );
  assert(
    (await reviewDialog.getByText(/"maxDepth"\s*:\s*1/).count()) > 0,
    "kickoff review summary shows maxDepth: 1"
  );

  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForTimeout(400);

  const uniqueIdea = "Unique thinner kickoff verify idea";
  await page.getByRole("radio", { name: /New idea/i }).check();
  await page.locator("#kickoff-idea").fill(uniqueIdea);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.waitForTimeout(2500);
  const ideaReview = page.getByRole("dialog");
  assert(
    (await ideaReview.getByText("b99", { exact: true }).count()) > 0,
    "new-idea review shows id from next marker"
  );
  assert(
    (await ideaReview
      .getByText("b99-unique-thinner-kickoff-verify-idea", { exact: true })
      .count()) > 0,
    "new-idea review shows derived slug"
  );
  assert(
    (await ideaReview.getByText(uniqueIdea, { exact: true }).count()) > 0,
    "new-idea review shows the trimmed operator idea"
  );
  // Do not click Start pipeline — review must remain side-effect-free.

  await page.keyboard.press("Escape");
}

async function runMobileChecks(page) {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  assert(
    await page.getByText("b36", { exact: true }).first().isVisible(),
    "mobile: group header visible at 720px"
  );
  const haltedCard = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByText(/implement/i) })
    .first();
  await haltedCard.hover();
  // On narrow, actions may need expand — tap card first
  await haltedCard.click();
  await page.waitForTimeout(300);
  const retry = page.getByRole("button", { name: "Retry", exact: true }).first();
  assert(await retry.isVisible(), "mobile: escalation Retry visible");
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
    await runBoardChecks(page, harness);
    await runMobileChecks(page);
  } finally {
    await closeWithTimeout(browser);
    try {
      harness?.chainRunner?.stop();
    } catch {
      /* ignore */
    }
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
    console.log("\nb36.5 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
