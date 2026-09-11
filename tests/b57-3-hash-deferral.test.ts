import { describe, expect, it } from "vitest";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";

function promptFor(key: string): string {
  const worker = IMPLEMENT_FULLY_WORKERS.find((w) => w.key === key);
  if (!worker) throw new Error(`missing worker ${key}`);
  return worker.prompt;
}

const GIT_LOG_FRAGMENT =
  "git log --max-count=1 --format=%h -F --grep=";

describe("b57 deferred commit-hash recording — prompt contract", () => {
  it("review sweeps earlier Done rows before closeout commit", () => {
    const prompt = promptFor("review");

    expect(prompt).toContain(GIT_LOG_FRAGMENT);
    expect(prompt).toContain("feat({{featureSlug}}): complete");
    expect(prompt).toMatch(/Leave the closing row's own/);
    expect(prompt).toMatch(/`Commit` cell blank/);
    expect(prompt).not.toMatch(/\bamend\b/i);
    expect(prompt).not.toMatch(/then make a \*\*second\*\*/);
    expect(prompt).not.toMatch(/second commit recording/i);

    const closeoutStart = prompt.indexOf("4. After Review Gate is green, close out");
    const mustNotStart = prompt.indexOf("## Must not");
    const closeout = prompt.slice(closeoutStart, mustNotStart);
    const driftIdx = closeout.indexOf("Skeleton Drift");
    const commitIdx = closeout.indexOf("Commit once with subject");
    expect(driftIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(driftIdx);
    expect(closeout.slice(driftIdx, commitIdx)).toContain(GIT_LOG_FRAGMENT);
  });

  it("final-gate sweeps remaining cells and commits the gate record", () => {
    const prompt = promptFor("final-gate");

    expect(prompt).toContain(GIT_LOG_FRAGMENT);
    expect(prompt).toContain("docs({{featureSlug}}): final gate record");
    expect(prompt).toContain("## Final Gate");
    expect(prompt).toMatch(/including the last phase/);

    const gateFixIdx = prompt.indexOf("fix({{featureSlug}}): final gate");
    const sweepIdx = prompt.indexOf("sweep remaining blank");
    const recordCommitIdx = prompt.indexOf("docs({{featureSlug}}): final gate record");
    const chainStopIdx = prompt.indexOf("chain_control");
    expect(gateFixIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeGreaterThan(gateFixIdx);
    expect(recordCommitIdx).toBeGreaterThan(sweepIdx);
    expect(chainStopIdx).toBeGreaterThan(recordCommitIdx);
  });

  it("docs-commit under execute uses deferred hash sweep like review", () => {
    const prompt = promptFor("docs-commit");

    expect(prompt).toContain(GIT_LOG_FRAGMENT);
    expect(prompt).toMatch(/Leave the closing row's own/);
    expect(prompt).toMatch(/Commit once with subject/);
    expect(prompt).not.toMatch(/then make a \*\*second\*\*/);
    expect(prompt).toMatch(/Reachable only under `loopMode: execute`/);
  });
});
