import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY } from "../packages/shared/src/types/api.ts";
import { IMPLEMENT_FULLY_WORKERS } from "../packages/daemon/src/pipelines/implement-fully.ts";

function promptFor(key: string): string {
  const worker = IMPLEMENT_FULLY_WORKERS.find((w) => w.key === key);
  if (!worker) throw new Error(`missing worker ${key}`);
  return worker.prompt;
}

const PROTOCOL_PATH = resolve(
  import.meta.dirname,
  "../docs/implement-fully-protocol.md"
);

/** The single Per-worker responsibilities row for one worker. */
function protocolWorkerRow(text: string, worker: string): string {
  const row = text
    .split("\n")
    .find((line) => line.startsWith(`| \`${worker}\` |`));
  if (!row) throw new Error(`no protocol row for ${worker}`);
  return row;
}

/** Lines naming a full root compound pass, in any of its spellings. */
function rootPassLines(prompt: string): string[] {
  return prompt
    .split("\n")
    .filter(
      (line) =>
        line.includes("typecheck → build → full test") ||
        line.includes("typecheck/build/test compound pass") ||
        line.includes("full root compound pass")
    );
}

/** Every compound-pass mention must forbid running it. */
function expectAllProhibitive(lines: string[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toMatch(
      /Do \*\*not\*\* run|no full root|^- Run Review Gate|^- Run any full root|exclude|Neither section may contain/
    );
  }
}

describe("b47 focused review contract — generated prompts", () => {
  it("plan-phase names both gates and forbids a full root pass in either", () => {
    const prompt = promptFor("plan-phase");
    expect(prompt).toContain("## Implementation Checks");
    expect(prompt).toContain("## Review Gate");
    expect(prompt).toContain("implement-fully exception");
    expect(prompt).toMatch(
      /Do \*\*not\*\* place a full root `typecheck → build → full test` pass/
    );
    // Both sections forbid the compound pass; neither instructs running it.
    const ownershipBlock = prompt.slice(
      prompt.indexOf("## Verification ownership")
    );
    const placeLines = ownershipBlock
      .split("\n")
      .filter((line) =>
        line.includes("Do **not** place a full root `typecheck → build → full test` pass")
      );
    expect(placeLines.length).toBeGreaterThanOrEqual(2);
    expect(prompt).not.toMatch(
      /End with exactly one root\s+`typecheck → build → full test` pass/
    );
    expect(prompt).toContain("final-gate");
  });

  it("implement runs Implementation Checks and excludes Review Gate", () => {
    const prompt = promptFor("implement");
    expect(prompt).toContain("Implementation Checks");
    expect(prompt).toContain("Do **not** run Review Gate");
    expect(prompt).toContain(
      "Run Review Gate or any full root typecheck/build/test compound pass"
    );
    expect(prompt).toContain("exact command/outcome evidence");
    expect(prompt).toContain("Legacy fallback");
    expect(prompt).toContain("exclude the final root compound pass");
    expect(prompt).toMatch(
      /no full root `typecheck → build → full test` pass|Do \*\*not\*\* run a full root `typecheck → build → full test` pass/
    );
  });

  it("review owns closeout, may commit and mark Done, and forbids push and full root pass", () => {
    const prompt = promptFor("review");
    expect(prompt).toContain("Review Gate");
    expect(prompt).toMatch(/run \*\*Review Gate\*\* once/);
    expect(prompt).toContain("Invoke /gc for the closeout commit");
    expect(prompt).toContain("Mark the phase file complete and its tracker row `Done`");
    expect(prompt).toContain("Commit once with subject");
    expect(prompt).toMatch(/- Push, tag, or create branches\./);
    expect(prompt).not.toMatch(
      /exactly one root `typecheck → build → full test` pass/
    );
    expect(prompt).toMatch(
      /Do \*\*not\*\* run a full root `typecheck → build → full test` pass/
    );
    expect(prompt).toContain('run the full test suite to "be safe"');
    expect(prompt).toMatch(/Never blindly rerun an unchanged/);
    expect(prompt).toContain("Blindly rerun an unchanged failed command");
    expect(prompt).toContain("Run any full root typecheck/build/test compound pass");
    expect(prompt).toContain("Legacy fallback");
    expect(prompt).toContain("exclude the full root");
    expect(prompt).toContain("skip closeout and commits entirely");
  });

  it("root full-pass mentions are prohibitive in both implement and review", () => {
    expectAllProhibitive(rootPassLines(promptFor("implement")));
    expectAllProhibitive(rootPassLines(promptFor("review")));
  });

  it("integrate-wave names smoke gate and excludes the full suite", () => {
    const prompt = promptFor(IMPLEMENT_FULLY_INTEGRATION_WORKER_KEY);
    expect(prompt).toContain("combined verification");
    expect(prompt).toContain("npm run typecheck");
    expect(prompt).toContain("npm run build");
    expect(prompt).toMatch(/Do \*\*not\*\* run the full test suite/);
    expect(prompt).toContain("pipeline_wave");
  });
});

describe("b47 focused review contract — protocol", () => {
  it("documents focused gate ownership, legacy fallback, and no blind retries", () => {
    const text = readFileSync(PROTOCOL_PATH, "utf8");
    expect(text).toContain("## Verification ownership");
    expect(text).toContain("## Implementation Checks");
    expect(text).toContain("## Review Gate");
    expect(text).toContain("Legacy fallback");
    expect(text).toMatch(/never blindly retried/i);
    expect(text).not.toContain("Full root coverage remains mandatory");
    expect(text).toContain("final-gate");
    expect(text).toMatch(
      /focused\/affected checks for the phase's diff/i
    );
  });

  it("assigns each gate to one worker row in Per-worker responsibilities", () => {
    const text = readFileSync(PROTOCOL_PATH, "utf8");

    const implementRow = protocolWorkerRow(text, "implement");
    expect(implementRow).toContain("Implementation Checks");
    expect(implementRow).toContain("run Review Gate / full root compound pass");
    expect(implementRow).not.toContain("owns **Review Gate**");

    const reviewRow = protocolWorkerRow(text, "review");
    expect(reviewRow).toContain("owns focused **Review Gate** once on final code");
    expect(reviewRow).toContain("blindly rerun an unchanged failed command");
    expect(reviewRow).toContain("run a full root compound pass");

    const integrateRow = protocolWorkerRow(text, "integrate-wave");
    expect(integrateRow).toContain("merged-wave smoke verification");
    expect(integrateRow).toContain("run the full test suite");
  });
});
