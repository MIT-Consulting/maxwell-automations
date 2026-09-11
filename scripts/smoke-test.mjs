/**
 * End-to-end smoke test: health → trigger Ask User Sample → answer → completed.
 * Requires CURSOR_API_KEY in ~/.cursor-local-automations/.env and daemon running.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = "http://127.0.0.1:3747";
const envPath = join(homedir(), ".cursor-local-automations", ".env");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

if (!existsSync(envPath)) {
  fail(`Missing ${envPath} — add CURSOR_API_KEY=crsr_...`);
}
const keyLine = readFileSync(envPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("CURSOR_API_KEY="));
if (!keyLine || keyLine.length < 24) {
  fail("CURSOR_API_KEY not set in .env");
}

console.log("1. Health check...");
let health;
try {
  health = await fetch(`${base}/health`);
} catch {
  fail("Daemon not running. In another terminal: npm run daemon");
}
if (!health.ok) fail(`/health returned ${health.status}`);

console.log("2. Trigger Ask User Sample...");
const automationId =
  "QzpcQ29kZVxQZXJzb25hbFxjdXJzb3ItbG9jYWwtYXV0b21hdGlvbnM::ask-user-sample";
const trigger = await fetch(`${base}/api/runs`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ automationId }),
});
if (!trigger.ok) {
  fail(`trigger ${trigger.status}: ${await trigger.text()}`);
}
const { runId } = await trigger.json();
console.log(`   runId=${runId}`);

console.log("3. Wait for needs_input (up to 3 min)...");
let sawNeedsInput = false;
for (let i = 0; i < 90; i++) {
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
  const snap = await res.json();
  const status = snap.run?.status;
  if (status === "needs_input") {
    sawNeedsInput = true;
    console.log("   status=needs_input");
    break;
  }
  if (status === "failed") {
    fail(`run failed early — check daemon terminal. events=${snap.events?.length}`);
  }
  await sleep(2000);
}
if (!sawNeedsInput) fail("timed out waiting for needs_input");

console.log("4. Submit answer...");
const answerRes = await fetch(
  `${base}/api/runs/${encodeURIComponent(runId)}/answer`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "smoke-ok" }),
  }
);
if (!answerRes.ok) {
  fail(`answer ${answerRes.status}: ${await answerRes.text()}`);
}

console.log("5. Wait for completed (up to 3 min)...");
for (let i = 0; i < 90; i++) {
  const res = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
  const snap = await res.json();
  const status = snap.run?.status;
  if (status === "completed") {
    console.log("OK: smoke test passed (completed).");
    process.exit(0);
  }
  if (status === "failed") {
    fail("run failed after answer — check daemon terminal");
  }
  await sleep(2000);
}
fail("timed out waiting for completed");
