import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildRunDeepLink } from "../packages/daemon/dist/notify/notifier.js";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(lcaHome, ".env");
const globalConfig = join(lcaHome, "automations.yaml");
const port = 3751;
const base = `http://127.0.0.1:${port}`;

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
  if (!existsSync(envPath)) return false;
  const raw = readFileSync(envPath, "utf8");
  const line = raw.split(/\r?\n/).find((l) => l.startsWith("CURSOR_API_KEY="));
  if (!line) return false;
  return line.slice("CURSOR_API_KEY=".length).trim().length > 10;
}

// --- Pure unit: deep-link builder (no daemon needed) ---
assert(
  buildRunDeepLink("http://127.0.0.1:3747", "abc 1") ===
    "http://127.0.0.1:3747/?run=abc%201",
  "buildRunDeepLink encodes the runId into a dashboard query"
);
assert(
  buildRunDeepLink("http://127.0.0.1:3747/", "r1") ===
    "http://127.0.0.1:3747/?run=r1",
  "buildRunDeepLink strips trailing slash"
);

if (!envHasApiKey()) {
  console.error(
    "SKIP: CURSOR_API_KEY not set in ~/.cursor-local-automations/.env — agent-backed CLI checks need it. Pure deep-link checks passed."
  );
  process.exit(process.exitCode ?? 0);
}

mkdirSync(lcaHome, { recursive: true });
writeFileSync(
  globalConfig,
  `workspaces:\n  - ${repoRoot.replace(/\\/g, "/")}\n\nautomations: []\n`,
  "utf8"
);

let log = "";
const daemon = spawn("node", ["packages/daemon/dist/index.js"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  // LCA_NO_TOAST suppresses real OS toasts during the headless test.
  env: { ...process.env, LCA_PORT: String(port), LCA_NO_TOAST: "1" },
});
daemon.stdout.on("data", (d) => (log += d.toString()));
daemon.stderr.on("data", (d) => (log += d.toString()));

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

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Spawn the built CLI against the test daemon. `onStdout` can drive stdin. */
function runCli(args, { timeoutMs = 60000, onStdout } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn("node", ["packages/cli/dist/index.js", ...args], {
      cwd: repoRoot,
      env: { ...process.env, LCA_DAEMON_URL: base },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      onStdout?.(s, child);
    });
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, out, err });
    });
  });
}

async function main() {
  assert(await waitForHealth(), "daemon HTTP /health responds");

  // --- lca list ---
  const list = await runCli(["list"]);
  assert(
    list.code === 0 && /Sample Hello/.test(list.out),
    "lca list shows automations (Sample Hello present)"
  );
  assert(/Recent runs/.test(list.out), "lca list includes a runs section");

  // --- lca disable / enable round-trip (cross-checked over REST) ---
  // The daemon id is hashed; the operator-facing handle is the YAML id
  // (`configKey`), which is what the CLI resolves against.
  const findSample = (autos) =>
    autos.automations.find((a) => a.configKey === "sample-hello");

  const disable = await runCli(["disable", "sample-hello"]);
  assert(disable.code === 0, "lca disable sample-hello exits 0");
  let sample = findSample(await getJson("/api/automations"));
  assert(sample && sample.enabled === false, "REST confirms automation disarmed");

  const enable = await runCli(["enable", "sample-hello"]);
  assert(enable.code === 0, "lca enable sample-hello exits 0");
  sample = findSample(await getJson("/api/automations"));
  assert(sample && sample.enabled === true, "REST confirms automation re-armed");

  const badEnable = await runCli(["enable", "does-not-exist"]);
  assert(
    badEnable.code !== 0 && /No automation matches/.test(badEnable.err),
    "lca enable on unknown automation errors cleanly"
  );

  // --- lca run (follows to terminal) ---
  const run = await runCli(["run", "sample-hello"], { timeoutMs: 120000 });
  assert(
    run.code === 0 && /status → completed/.test(run.out),
    `lca run sample-hello followed to completion (exit ${run.code})`
  );
  const runIdMatch = run.out.match(/run ([0-9a-f]{8})/);
  assert(Boolean(runIdMatch), "lca run printed the run id");

  // --- lca logs --no-follow on the finished run ---
  const runs = await getJson("/api/runs");
  const completed = runs.runs.find((r) => r.status === "completed");
  assert(Boolean(completed), "a completed run exists to tail");
  const logs = await runCli(["logs", completed.id, "--no-follow"], {
    timeoutMs: 20000,
  });
  assert(
    logs.code === 0 && /status: completed/.test(logs.out) && /\n\s+\d+\s+/.test(logs.out),
    "lca logs --no-follow prints status and event lines"
  );

  // --- lca answer error paths (deterministic; no agent dependency) ---
  const noRun = await runCli(["answer", "00000000-no-such-run", "x"], {
    timeoutMs: 20000,
  });
  assert(
    noRun.code !== 0 && /No run matches/.test(noRun.err),
    "lca answer on an unknown run errors cleanly"
  );
  const notPaused = await runCli(["answer", completed.id, "x"], { timeoutMs: 20000 });
  assert(
    notPaused.code !== 0 && /not awaiting input/i.test(notPaused.err),
    "lca answer on a finished (non-paused) run surfaces the daemon error"
  );

  // --- lca answer unblocks a paused (needs_input) run (best-effort) ---
  // The pause/ask/resume mechanic itself is proven deterministically by
  // verify:phase3. Here we additionally drive it end-to-end through the CLI
  // *when* the agent actually calls ask_user. Because tool-calling is
  // nondeterministic, a failure to pause is reported as a SKIP, not a FAIL.
  const askAutos = await getJson("/api/automations");
  const askAuto = askAutos.automations.find((a) => a.configKey === "ask-user-sample");
  assert(Boolean(askAuto), "ask-user-sample automation present");

  let askRunId = null;
  for (let attempt = 1; attempt <= 2 && !askRunId; attempt++) {
    const askTrigger = await postJson("/api/runs", { automationId: askAuto.id });
    if (askTrigger.status !== 201 || !askTrigger.body.runId) continue;
    const candidate = askTrigger.body.runId;

    const askDeadline = Date.now() + 120000;
    while (Date.now() < askDeadline) {
      const snap = await getJson(`/api/runs/${candidate}`);
      const pending = (snap.inputRequests ?? []).some((r) => r.status === "pending");
      if (snap.run.status === "needs_input" && pending) {
        askRunId = candidate;
        break;
      }
      if (["completed", "failed", "cancelled"].includes(snap.run.status)) {
        console.log(
          `  (attempt ${attempt}: agent finished without calling ask_user — retrying)`
        );
        break;
      }
      await sleep(1500);
    }
  }

  if (!askRunId) {
    console.log(
      "SKIP: agent did not call ask_user this run (nondeterministic). " +
        "lca answer plumbing is covered above; pause/resume is covered by verify:phase3."
    );
  } else {
    assert(
      /needs input:/i.test(log),
      "daemon fired the needs-input notification sink (terminal/toast)"
    );

    const answer = await runCli(["answer", askRunId, "banana"], { timeoutMs: 20000 });
    assert(
      answer.code === 0 && /Answer sent/.test(answer.out),
      "lca answer sent the answer through the Input Hub"
    );

    const doneDeadline = Date.now() + 120000;
    let askFinal = null;
    while (Date.now() < doneDeadline) {
      const snap = await getJson(`/api/runs/${askRunId}`);
      if (["completed", "failed", "cancelled"].includes(snap.run.status)) {
        askFinal = snap;
        break;
      }
      await sleep(1500);
    }
    assert(
      askFinal && askFinal.run.status === "completed",
      `answered run resumed and completed (status: ${askFinal?.run.status})`
    );
    const echoed = askFinal?.events.some((e) => /banana/i.test(e.payload));
    assert(echoed, "agent echoed the operator's answer back (Input Hub convergence)");
  }
}

try {
  await main();
} catch (err) {
  console.error("ERROR:", err);
  process.exitCode = 1;
} finally {
  daemon.kill("SIGTERM");
  await sleep(500);
  if (process.exitCode) {
    console.error("\n--- daemon log ---\n", log);
  } else {
    console.log("\nPhase 6 verification passed.");
  }
}
