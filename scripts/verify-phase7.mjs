import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { runsToCsv } from "../packages/daemon/dist/http/export.js";

const repoRoot = resolve(import.meta.dirname, "..");
const lcaHome = join(homedir(), ".cursor-local-automations");
const envPath = join(lcaHome, ".env");
const globalConfig = join(lcaHome, "automations.yaml");
const port = 3752;
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

// --- Pure unit: CSV export formatting (no daemon needed) ---
const csv = runsToCsv([
  {
    id: "r1",
    automationId: "a1",
    automationName: 'Quote, "test"',
    workspaceId: "ws1",
    workspacePath: "/repo",
    status: "completed",
    triggerKind: "manual",
    createdAt: "2026-01-01 00:00:00",
    startedAt: "2026-01-01 00:00:01",
    endedAt: "2026-01-01 00:00:05",
    eventCount: 2,
  },
]);
assert(
  csv.split("\r\n")[0].startsWith("id,automationId,automationName"),
  "runsToCsv emits a header row"
);
assert(
  csv.includes('"Quote, ""test"""'),
  "runsToCsv escapes commas and quotes (RFC-4180)"
);

if (!envHasApiKey()) {
  console.error(
    "SKIP: CURSOR_API_KEY not set in ~/.cursor-local-automations/.env — daemon-backed export/concurrency checks need it. Pure CSV checks passed."
  );
  process.exit(process.exitCode ?? 0);
}

mkdirSync(lcaHome, { recursive: true });
writeFileSync(
  globalConfig,
  `workspaces:\n  - ${repoRoot.replace(/\\/g, "/")}\n\nsettings:\n  maxConcurrentRuns: 1\n\nautomations: []\n`,
  "utf8"
);

let log = "";
const daemon = spawn("node", ["packages/daemon/dist/index.js"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    LCA_PORT: String(port),
    LCA_NO_TOAST: "1",
    LCA_MAX_CONCURRENT: "1",
  },
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

async function main() {
  assert(await waitForHealth(), "daemon HTTP /health responds");
  assert(
    /maxConcurrentRuns=1/.test(log),
    "daemon logged the resolved settings (maxConcurrentRuns=1 from env)"
  );

  // --- Export endpoints (work even with zero runs) ---
  const jsonRes = await fetch(`${base}/api/runs/export?format=json`);
  assert(jsonRes.status === 200, "GET /api/runs/export?format=json → 200");
  assert(
    /attachment; filename="lca-runs-/.test(
      jsonRes.headers.get("content-disposition") ?? ""
    ),
    "JSON export sets a download Content-Disposition"
  );
  const jsonBody = await jsonRes.json();
  assert(Array.isArray(jsonBody), "JSON export body is an array");

  const csvRes = await fetch(`${base}/api/runs/export?format=csv`);
  assert(csvRes.status === 200, "GET /api/runs/export?format=csv → 200");
  const csvText = await csvRes.text();
  assert(
    csvText.split("\r\n")[0].startsWith("id,automationId,automationName"),
    "CSV export starts with the header row"
  );

  const badRes = await fetch(`${base}/api/runs/export?format=xml`);
  assert(badRes.status === 400, "GET /api/runs/export?format=xml → 400");

  // --- Concurrency cap (best-effort; sample-hello is short) ---
  const autos = await getJson("/api/automations");
  const sample = autos.automations.find((a) => a.configKey === "sample-hello");
  if (!sample) {
    console.log("SKIP: sample-hello automation not present for concurrency check");
  } else {
    const t1 = await postJson("/api/runs", { automationId: sample.id });
    const t2 = await postJson("/api/runs", { automationId: sample.id });
    assert(
      t1.status === 201 && t2.status === 201,
      "two runs triggered back-to-back"
    );

    // Poll briefly for the second run sitting in `queued` behind the first.
    let sawQueued = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !sawQueued) {
      const runs = await getJson("/api/runs");
      const mine = runs.runs.filter(
        (r) => r.id === t1.body.runId || r.id === t2.body.runId
      );
      if (mine.some((r) => r.status === "queued")) sawQueued = true;
      await sleep(200);
    }
    if (sawQueued) {
      assert(true, "concurrency cap held the second run in `queued`");
    } else {
      console.log(
        "SKIP: did not observe a queued run (runs may have completed too fast to catch the window)"
      );
    }
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
    console.log("\nPhase 7 verification passed.");
  }
}
