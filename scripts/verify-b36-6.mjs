/**
 * b36.06c verification — wave board chips, retry/abort controls, and hermetic
 * worktree layout on an isolated daemon.
 *
 * Isolation (non-negotiable): own temp LCA_HOME / HOME / USERPROFILE and port
 * 3767. Never calls stop-lca-daemons, never touches :3747, never sets
 * LCA_FORCE_STOP_DAEMONS.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const repoRoot = resolve(import.meta.dirname, "..");
const port = 3767;
const base = `http://127.0.0.1:${port}`;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_TIMEOUT_MS = 3_000;

if (port === 3747) {
  console.error("verify-b36-6 must not use operator port 3747");
  process.exit(1);
}

const testHome = mkdtempSync(join(tmpdir(), "lca-b36-6-ui-"));
const lcaHome = join(testHome, ".cursor-local-automations");
mkdirSync(lcaHome, { recursive: true });

process.env.USERPROFILE = testHome;
process.env.HOME = testHome;
process.env.LCA_HOME = lcaHome;

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

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "LCA Verify",
      GIT_AUTHOR_EMAIL: "lca-verify@example.com",
      GIT_COMMITTER_NAME: "LCA Verify",
      GIT_COMMITTER_EMAIL: "lca-verify@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return (result.stdout || "").trim();
}

function initRepo(repoPath) {
  mkdirSync(repoPath, { recursive: true });
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["config", "user.name", "LCA Verify"]);
  runGit(repoPath, ["config", "user.email", "lca-verify@example.com"]);
  runGit(repoPath, ["checkout", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# b36.6 verify\n");
  runGit(repoPath, ["add", "README.md"]);
  runGit(repoPath, ["commit", "-m", "initial"]);
  return runGit(repoPath, ["rev-parse", "HEAD"]);
}

const daemonServer = join(repoRoot, "packages/daemon/dist/http/server.js");
const dashboardIndex = join(repoRoot, "packages/dashboard/dist/index.html");
if (!existsSync(daemonServer)) {
  console.error("FAIL: daemon not built. Run `npm run build` first.");
  process.exit(1);
}
if (!existsSync(dashboardIndex)) {
  console.error("FAIL: dashboard not built. Run `npm run build` first.");
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
  { RunStore },
  { ChainRunner },
  { DEFAULT_SETTINGS },
  { TriggerManager },
  { PipelineWaveStore },
  { PipelineWaveCoordinator },
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
  import("../packages/daemon/dist/runs/pipeline-wave-store.js"),
  import("../packages/daemon/dist/runs/pipeline-wave-coordinator.js"),
]);

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
    next: "generated:plan-phase",
  },
  {
    key: "generated:docs-commit",
    name: "docs-commit",
    role: "docs",
    next: "generated:plan-phase",
  },
  {
    key: "generated:integrate-wave",
    name: "integrate-wave",
    role: "reviewer",
    next: "generated:plan-phase",
  },
];

function contextFor(featureId, featureSlug, idea) {
  return {
    variables: {
      pipelineId: "implement-fully",
      featureId,
      featureSlug,
      featureDir: `docs/roadmap/${featureSlug}`,
      featureIndex: `docs/roadmap/${featureSlug}/00-index.md`,
      idea,
      // Match normalizeImplementFullyChainVariables so retry enqueue equality holds.
      planningDepth: "jit",
      approvalPolicy: "none",
      researchApprovalPolicy: "none",
    },
    roleModels: {
      planner: { id: "planner-model" },
      implementer: { id: "implementer-model" },
      reviewer: { id: "reviewer-model" },
      docs: { id: "docs-model" },
    },
  };
}

function seedGroup(args) {
  const {
    store,
    waveStore,
    db,
    wsId,
    autoIds,
    repoPath,
    head,
    featureId,
    featureSlug,
    idea,
    waveOrdinal,
    blockedCode,
    makeDirtyWorktree,
  } = args;
  const context = contextFor(featureId, featureSlug, idea);
  const rootId = randomUUID();
  const coordId = randomUUID();

  store.insertRun({
    id: rootId,
    automationId: autoIds["generated:plan-skeleton"],
    workspaceId: wsId,
    triggerKind: "manual",
    prompt: "root",
    chainContext: context,
    chainRootRunId: rootId,
    chainDepth: 0,
    chainMaxDepth: 40,
  });
  store.setStatus(rootId, "completed");
  db.prepare(
    `UPDATE runs SET chain_handled_at = datetime('now') WHERE id = ?`
  ).run(rootId);

  store.insertRun({
    id: coordId,
    automationId: autoIds["generated:plan-phase"],
    workspaceId: wsId,
    triggerKind: "chain",
    prompt: "coord",
    chainContext: context,
    chainRootRunId: rootId,
    chainDepth: 1,
    chainMaxDepth: 40,
    parentRunId: rootId,
  });
  store.setStatus(coordId, "completed");
  db.prepare(
    `UPDATE runs SET chain_handled_at = datetime('now') WHERE id = ?`
  ).run(coordId);

  const shortRoot = rootId.replace(/-/g, "").slice(0, 8);
  const tracksInput = [1, 2].map((ordinal) => {
    const worktreePath = join(
      lcaHome,
      "worktrees",
      rootId,
      `w${waveOrdinal}`,
      `t${ordinal}`
    );
    const branchName = `lca/${featureSlug}/${shortRoot}/w${waveOrdinal}-t${ordinal}`;
    mkdirSync(worktreePath, { recursive: true });
    // Real git worktree for abort retention path.
    runGit(repoPath, [
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      head,
    ]);
    return {
      phaseRef: `${waveOrdinal}.${ordinal}`,
      phaseFile: `docs/p${waveOrdinal}${ordinal}.md`,
      branchName,
      worktreePath,
      ordinal,
    };
  });

  const { wave, tracks } = waveStore.createWaveIdempotent({
    rootRunId: rootId,
    coordinatorRunId: coordId,
    workspaceId: wsId,
    ordinal: waveOrdinal,
    baseCommit: head,
    tracks: tracksInput,
  });
  waveStore.markWaveRunning(wave.id);
  for (const track of tracks) {
    waveStore.assignTrackPlanner(track.id, randomUUID());
    waveStore.completeTrack(track.id, randomUUID(), head);
    const trackRunId = randomUUID();
    store.insertRun({
      id: trackRunId,
      automationId: autoIds["generated:implement"],
      workspaceId: wsId,
      triggerKind: "chain",
      prompt: `track ${track.phase_ref}`,
      chainContext: context,
      chainRootRunId: rootId,
      chainDepth: 2,
      chainMaxDepth: 40,
      pipelineWaveId: wave.id,
      pipelineTrackId: track.id,
      executionCwd: track.worktree_path,
      parentRunId: coordId,
    });
    store.setStatus(trackRunId, "completed");
    db.prepare(
      `UPDATE runs SET chain_handled_at = datetime('now') WHERE id = ?`
    ).run(trackRunId);
  }
  waveStore.claimJoin(wave.id);
  const oldIntegrationId = randomUUID();
  store.insertRun({
    id: oldIntegrationId,
    automationId: autoIds["generated:integrate-wave"],
    workspaceId: wsId,
    triggerKind: "chain",
    prompt: "old integrate",
    chainContext: context,
    chainRootRunId: rootId,
    chainDepth: 5,
    chainMaxDepth: 40,
    pipelineWaveId: wave.id,
    parentRunId: coordId,
  });
  waveStore.assignIntegrationRun(wave.id, oldIntegrationId);
  store.setStatus(oldIntegrationId, "failed");
  waveStore.blockWave(wave.id, blockedCode, "verify seed");

  if (makeDirtyWorktree) {
    writeFileSync(join(tracks[0].worktree_path, "scratch.txt"), "dirty\n");
  }

  return { rootId, coordId, wave, tracks, context, oldIntegrationId };
}

function seedHarness() {
  console.log("progress: seeding isolated workspace + waves");
  const workspace = mkdtempSync(join(tmpdir(), "lca-b36-6-ws-"));
  const head = initRepo(workspace);
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
  ).run(wsId, resolve(workspace), "b36-6-ws");

  const autoIds = {};
  for (const w of WORKERS) {
    const id = `${wsId}::${w.key}`;
    autoIds[w.key] = id;
    db.prepare(
      `INSERT INTO automations (
        id, workspace_id, name, enabled, status, origin, trigger_json, prompt,
        config_path, config_key, chain_json, model_role
      ) VALUES (?, ?, ?, 1, 'enabled', 'generated', '{"type":"manual"}', ?,
        'generated.yaml', ?, ?, ?)`
    ).run(
      id,
      wsId,
      w.name,
      `Prompt ${w.name} {{featureId}}`,
      w.key,
      JSON.stringify({ next: w.next, when: "completed", passResult: true }),
      w.role
    );
  }

  const events = new DaemonEventBus();
  const store = new RunStore(db, events);
  const waveStore = new PipelineWaveStore(db);

  const retryGroup = seedGroup({
    store,
    waveStore,
    db,
    wsId,
    autoIds,
    repoPath: workspace,
    head,
    featureId: "b36r",
    featureSlug: "b36-retry-wave",
    idea: "secret-retry-idea-must-not-leak",
    waveOrdinal: 1,
    blockedCode: "integration-incomplete",
    makeDirtyWorktree: false,
  });
  const abortGroup = seedGroup({
    store,
    waveStore,
    db,
    wsId,
    autoIds,
    repoPath: workspace,
    head,
    featureId: "b36a",
    featureSlug: "b36-abort-wave",
    idea: "secret-abort-idea-must-not-leak",
    waveOrdinal: 1,
    blockedCode: "integration-incomplete",
    makeDirtyWorktree: true,
  });

  const held = new Map();
  const fakeExecutor = {
    kind: "sdk-local",
    async spawn(params) {
      let resolveWait;
      const waitPromise = new Promise((r) => {
        resolveWait = r;
      });
      held.set(params.runId, resolveWait);
      return {
        kind: "sdk-local",
        agentId: `agent-${params.runId}`,
        sdkRunId: `sdk-${params.runId}`,
        async *stream() {},
        async wait() {
          await waitPromise;
          return { status: "finished", result: "ok" };
        },
        async cancel() {
          resolveWait({ status: "finished", result: "cancelled" });
        },
        async dispose() {},
      };
    },
    async resume() {
      throw new Error("resume not used in b36.6 verify");
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
  engine.setPipelineWaveStore(waveStore);
  const coordinator = new PipelineWaveCoordinator({
    store,
    waveStore,
    engine,
    onLog: () => {},
    maxConcurrentRuns: 4,
    pipelineResumeLookbackMs: 0,
  });
  engine.setPipelineWaveCoordinator(coordinator);
  const chainRunner = new ChainRunner({
    store,
    engine,
    events,
    onLog: () => {},
    pipelineResumeLookbackMs: 0,
    waveCoordinator: coordinator,
  });
  chainRunner.start();
  const chatEngine = new ChatEngine(db, {
    apiKey: "test-key",
    executor: fakeExecutor,
    events,
  });

  return {
    testHome,
    lcaHome,
    workspace,
    wsId,
    db,
    events,
    engine,
    chatEngine,
    store,
    waveStore,
    coordinator,
    chainRunner,
    autoIds,
    retryGroup,
    abortGroup,
    releaseRun: (runId) => {
      const resolveWait = held.get(runId);
      if (resolveWait) resolveWait({ status: "finished", result: "ok" });
    },
  };
}

async function startServer(harness) {
  console.log("progress: starting HTTP server on", port);
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
    settings: DEFAULT_SETTINGS,
    triggers,
    waveCoordinator: harness.coordinator,
  });
}

/**
 * The board expands only the active pipeline group; every other group renders
 * its header without run cards. Expand them all so per-run chips are assertable.
 */
async function expandAllPipelineGroups(page) {
  const toggles = page.getByRole("button", { name: /^Expand .+ pipeline$/ });
  for (let guard = 0; guard < 20; guard++) {
    if ((await toggles.count()) === 0) return;
    await toggles.first().click();
  }
  throw new Error("pipeline groups never finished expanding");
}

async function runBoardChecks(page, harness) {
  console.log("progress: browser board checks");
  await page.addInitScript(() => {
    window.confirm = () => true;
    localStorage.clear();
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await expandAllPipelineGroups(page);

  const retryHeader = page.getByText("b36r", { exact: true }).first();
  await retryHeader.waitFor({ state: "visible", timeout: 15000 });
  assert(await retryHeader.isVisible(), "retry group header visible");

  const abortHeader = page.getByText("b36a", { exact: true }).first();
  await abortHeader.waitFor({ state: "visible", timeout: 15000 });
  assert(await abortHeader.isVisible(), "abort group header visible");

  const progress = page.getByText(/w1 blocked.*2\/2 tracks/i).first();
  await progress.waitFor({ state: "visible", timeout: 10000 });
  assert(await progress.isVisible(), "wave ordinal/status and N/M tracks shown");

  const trackChip = page.getByText(/b36r · 1\.1 · implement · w1/i).first();
  await trackChip.waitFor({ state: "visible", timeout: 10000 });
  assert(await trackChip.isVisible(), "track cards show phase + worker + wave");

  const trackLabels = await page
    .getByText(/^b36r · 1\.\d · implement · w1$/)
    .allInnerTexts();
  assert(
    trackLabels.length === 2 &&
      trackLabels[0].includes("1.1") &&
      trackLabels[1].includes("1.2"),
    `track cards render in tracker order (${trackLabels.join(", ")})`
  );
  assert(
    !trackLabels.some((label) => /·\s*\d+$/.test(label)),
    "track labels carry no fabricated sequential cycle"
  );

  const bodyText = await page.locator("body").innerText();
  assert(
    !bodyText.includes("secret-retry-idea") &&
      !bodyText.includes("secret-abort-idea"),
    "board text does not leak pipeline idea"
  );
  assert(
    !bodyText.includes(harness.retryGroup.tracks[0].worktree_path) &&
      !bodyText.includes("execution_cwd"),
    "board text does not leak worktree paths or execution_cwd"
  );

  const listPayload = await page.evaluate(async () => {
    const res = await fetch("/api/runs?limit=200");
    return res.json();
  });
  const listedJson = JSON.stringify(listPayload);
  assert(
    !listedJson.includes("executionCwd") &&
      !listedJson.includes("execution_cwd"),
    "list payload omits execution_cwd"
  );
  assert(
    !listedJson.includes(harness.retryGroup.tracks[0].worktree_path),
    "list payload omits absolute worktree paths"
  );
  assert(
    !listedJson.includes("secret-retry-idea") &&
      !listedJson.includes("secret-abort-idea"),
    "list payload omits idea"
  );

  // Retry integration on retry group
  console.log("progress: retry integration action");
  const retryGroup = page
    .locator("div.flex.flex-col.gap-1\\.5")
    .filter({ has: page.getByText("b36r", { exact: true }) })
    .first();
  const retryBtn = retryGroup.getByRole("button", {
    name: "Retry integration",
    exact: true,
  });
  await retryBtn.waitFor({ state: "visible", timeout: 10000 });
  assert(
    await retryBtn.isEnabled(),
    "Retry offered for blocked all-complete wave"
  );
  await retryBtn.click();

  const waveAfter = await waitUntil(
    "retry to move the wave to integrating",
    () => {
      const current = harness.waveStore.getWave(harness.retryGroup.wave.id);
      return current?.status === "integrating" ? current : null;
    }
  );
  assert(waveAfter.status === "integrating", "retry moved wave to integrating");
  assert(
    waveAfter.integration_run_id &&
      waveAfter.integration_run_id !== harness.retryGroup.oldIntegrationId,
    "retry created a replacement integration run id"
  );
  const replacement = harness.store.getRun(waveAfter.integration_run_id);
  assert(replacement != null, "replacement integration run exists");
  assert(replacement.chain_depth === 5, "replacement at coordinator + loop + 1 depth");
  assert(replacement.pipeline_track_id == null, "replacement has null track id");
  assert(replacement.execution_cwd == null, "replacement uses main cwd");
  assert(
    replacement.chain_root_run_id === harness.retryGroup.rootId,
    "replacement preserves pipeline root"
  );
  assert(
    JSON.stringify(JSON.parse(replacement.chain_context_json)) ===
      JSON.stringify(harness.retryGroup.context),
    "replacement preserves pipeline context"
  );

  const afterRetry = await waitUntil(
    "replacement integration run to appear on the API",
    async () => {
      const payload = await page.evaluate(async () => {
        const res = await fetch("/api/runs?limit=200");
        return res.json();
      });
      const found = payload.runs.find((r) => r.id === replacement.id);
      return found ? { payload, found } : null;
    }
  );
  assert(
    afterRetry.found.chainRootRunId === harness.retryGroup.rootId &&
      afterRetry.found.chainDepth === 5,
    "replacement integration run is visible through the API at the right depth"
  );
  assert(
    !JSON.stringify(afterRetry.payload).includes("executionCwd"),
    "post-retry list payload still omits execution_cwd"
  );

  // Gate is blocked-only: the control disappears once the wave is integrating.
  await waitUntil("retry control to disappear for a non-blocked wave", async () =>
    (await retryGroup
      .getByRole("button", { name: "Retry integration", exact: true })
      .count()) === 0
  );
  assert(true, "Retry offered only while the wave is blocked");

  // Abort the other wave
  console.log("progress: abort wave action");
  const abortGroupEl = page
    .locator("div.flex.flex-col.gap-1\\.5")
    .filter({ has: page.getByText("b36a", { exact: true }) })
    .first();
  const abortBtn = abortGroupEl.getByRole("button", {
    name: "Abort wave",
    exact: true,
  });
  await abortBtn.waitFor({ state: "visible", timeout: 10000 });
  await abortBtn.click();

  // Status flips before the worktree sweep, so wait for the recorded cleanup too.
  const aborted = await waitUntil(
    "abort to mark the wave aborted and record cleanup",
    () => {
      const current = harness.waveStore.getWave(harness.abortGroup.wave.id);
      return current?.status === "aborted" && current.cleanup_state != null
        ? current
        : null;
    }
  );
  assert(aborted.status === "aborted", "abort changes wave to aborted");
  const cleanup = aborted.cleanup_state
    ? JSON.parse(aborted.cleanup_state)
    : null;
  assert(
    cleanup?.retained?.length > 0,
    "abort retains the dirty worktree instead of deleting it"
  );
  assert(
    existsSync(harness.abortGroup.tracks[0].worktree_path),
    "dirty track worktree is still on disk after abort"
  );

  // Retained resources must surface through durable API state, not just SQLite.
  const abortedRun = await waitUntil(
    "aborted wave summary to reach the API",
    async () => {
      const payload = await page.evaluate(async () => {
        const res = await fetch("/api/runs?limit=200");
        return res.json();
      });
      return (
        payload.runs.find(
          (r) =>
            r.chainRootRunId === harness.abortGroup.rootId &&
            r.pipelineWave?.status === "aborted"
        ) ?? null
      );
    }
  );
  assert(
    abortedRun.pipelineWave.cleanupRequired === true,
    "API wave summary reports cleanup required after abort"
  );
  assert(
    abortedRun.pipelineWave.completedTrackCount ===
      abortedRun.pipelineWave.trackCount,
    "API wave summary keeps N/M track progress after abort"
  );

  const abortHeaderText = await abortGroupEl
    .locator("div")
    .first()
    .innerText();
  assert(
    /cleanup required/i.test(abortHeaderText),
    "board reports retained resources as 'cleanup required'"
  );
  assert(
    !abortHeaderText.includes(harness.abortGroup.tracks[0].worktree_path),
    "abort reporting does not leak the absolute worktree path"
  );

  await waitUntil("abort control to disappear for an aborted wave", async () =>
    (await abortGroupEl
      .getByRole("button", { name: "Abort wave", exact: true })
      .count()) === 0
  );
  assert(true, "wave controls are withdrawn once the wave is terminal");
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
    await runBoardChecks(page, harness);
  } finally {
    console.log("progress: cleanup");
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
      /* tolerate Windows WAL locks */
    }
    clearTimeout(hardExit);
  }
}

const result = await main()
  .then(() => {
    console.log("\nb36.6 verification passed.");
    return { success: true };
  })
  .catch((err) => {
    console.error("ERROR:", err);
    return { success: false };
  });

process.exit(result.success ? 0 : 1);
