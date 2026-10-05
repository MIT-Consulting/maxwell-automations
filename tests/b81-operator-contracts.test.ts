import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTOR_ID_MAX_LENGTH,
  exitCodeForWatchUntilReason,
  PIPELINE_DIRECTIVE_MAX_COUNT,
  PIPELINE_DIRECTIVE_NOTE_MAX_BYTES,
  PIPELINE_DIRECTIVE_ROLE_OVERRIDE_MAX_ROLES,
  PIPELINE_WATCH_UNTIL_REASONS,
} from "@lca/shared";
import type { PipelineOutcome } from "../packages/shared/src/pipeline-outcome.ts";
import {
  PIPELINE_FEED_DEFAULT_WAIT_SEC,
  PIPELINE_FEED_MAX_WAIT_SEC,
} from "../packages/daemon/src/runs/pipeline-projection.ts";
import { parseEscalateArgs } from "../packages/cli/src/cli.ts";
import { parseOperatorTargetFlags } from "../packages/cli/src/operator-target.ts";
import {
  parseWatchArgs,
  type WatchJsonEnvelope,
} from "../packages/cli/src/watch.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TEST_DIR, "..");
const CLI_INDEX = join(REPO_ROOT, "packages", "cli", "src", "cli.ts");
const CONFIG_DOC = join(REPO_ROOT, "docs", "configuration.md");
const PROTOCOL_DOC = join(REPO_ROOT, "docs", "implement-fully-protocol.md");
const TROUBLESHOOTING_DOC = join(REPO_ROOT, "docs", "troubleshooting.md");
const B80_DOC = join(REPO_ROOT, "docs", "roadmap", "b80-orchestrator-capability-map.md");
const LCA_DEV_SKILL = join(REPO_ROOT, ".cursor", "skills", "lca-dev", "SKILL.md");

const PIPELINE_OUTCOMES: readonly PipelineOutcome[] = [
  "running",
  "green",
  "blocked",
  "deadlock",
  "aborted",
  "failed",
];

function readDoc(path: string): string {
  return readFileSync(path, "utf8");
}

describe("b81 operator CLI help contracts", () => {
  const helpSrc = readFileSync(CLI_INDEX, "utf8");
  const helpBlock = helpSrc.slice(
    helpSrc.indexOf("function printHelp"),
    helpSrc.indexOf("async function main")
  );

  it("documents watch, feature targeting, actor, directive, and pipeline-stop", () => {
    expect(helpBlock).toContain("max watch");
    expect(helpBlock).toContain("--feature");
    expect(helpBlock).toContain("LCA_ACTOR");
    expect(helpBlock).toContain("max directive");
    expect(helpBlock).toContain("max pipeline-stop");
    expect(helpBlock).toContain("--after-step");
    expect(helpBlock).not.toMatch(
      /max stop[\s\S]{0,120}Stop chaining after the current step/
    );
  });

  it("documents until vocabulary and exit codes in help", () => {
    for (const reason of PIPELINE_WATCH_UNTIL_REASONS) {
      expect(helpBlock).toContain(reason);
    }
    expect(helpBlock).toContain("Exit codes:");
    expect(helpBlock).toContain(String(PIPELINE_FEED_DEFAULT_WAIT_SEC));
    expect(helpBlock).toContain(String(PIPELINE_FEED_MAX_WAIT_SEC));
    expect(helpBlock).toContain(String(PIPELINE_DIRECTIVE_MAX_COUNT));
    expect(helpBlock).toContain("8 KiB");
  });
});

describe("b81 documented command parsers", () => {
  it("parses the configuration watch examples", () => {
    const featureWatch = parseWatchArgs([
      "b81",
      "--until",
      "needs_input,halted,blocked,green",
      "--json",
    ]);
    expect(featureWatch.ok).toBe(true);
    if (featureWatch.ok) {
      expect(featureWatch.target).toBe("b81");
      expect(featureWatch.json).toBe(true);
      expect([...featureWatch.until ?? []]).toEqual([
        "needs_input",
        "halted",
        "blocked",
        "green",
      ]);
    }

    const resumeWatch = parseWatchArgs([
      "00000000-0000-4000-8000-000000000001",
      "-w",
      "C:\\Users\\dev\\my-repo",
      "--since",
      "12045",
      "--timeout",
      "30m",
    ]);
    expect(resumeWatch.ok).toBe(true);
    if (resumeWatch.ok) {
      expect(resumeWatch.since).toBe(12045);
      expect(resumeWatch.timeoutMs).toBe(30 * 60_000);
      expect(resumeWatch.workspaceQuery).toBe("C:\\Users\\dev\\my-repo");
      expect(resumeWatch.until).toBeNull();
    }
  });

  it("parses documented steering spellings", () => {
    const directive = parseOperatorTargetFlags(["b81", "keep newest notes"]);
    expect(directive).toEqual({
      ok: true,
      positional: "b81",
      feature: undefined,
      workspaceQuery: undefined,
      rest: ["keep newest notes"],
    });

    const stop = parseOperatorTargetFlags([
      "b81",
      "--after-step",
      "--reason",
      "park after review",
    ]);
    expect(stop.ok).toBe(true);
    if (stop.ok) {
      expect(stop.positional).toBe("b81");
      expect(stop.rest).toEqual([
        "--after-step",
        "--reason",
        "park after review",
      ]);
    }

    const roleSwap = parseEscalateArgs([
      "--feature",
      "b81",
      "--role",
      "reviewer=composer-2?effort=high",
    ]);
    expect(roleSwap.roleDirectiveOnly).toBe(true);
    expect(roleSwap.roleModels?.reviewer?.id).toBe("composer-2");
  });
});

describe("b81 frozen runtime constants", () => {
  it("maps watch until reasons to fixed exit codes", () => {
    expect(exitCodeForWatchUntilReason("green")).toBe(0);
    expect(exitCodeForWatchUntilReason("step")).toBe(0);
    expect(exitCodeForWatchUntilReason("paused")).toBe(0);
    expect(exitCodeForWatchUntilReason("needs_input")).toBe(10);
    expect(exitCodeForWatchUntilReason("halted")).toBe(11);
    expect(exitCodeForWatchUntilReason("blocked")).toBe(12);
    expect(exitCodeForWatchUntilReason("deadlock")).toBe(12);
    expect(exitCodeForWatchUntilReason("aborted")).toBe(13);
    expect(exitCodeForWatchUntilReason("failed")).toBe(13);
    expect(exitCodeForWatchUntilReason("timeout")).toBe(14);
  });

  it("pins default and max long-poll wait seconds", () => {
    expect(PIPELINE_FEED_DEFAULT_WAIT_SEC).toBe(25);
    expect(PIPELINE_FEED_MAX_WAIT_SEC).toBe(55);
  });

  it("pins directive and actor caps", () => {
    expect(PIPELINE_DIRECTIVE_MAX_COUNT).toBe(64);
    expect(PIPELINE_DIRECTIVE_NOTE_MAX_BYTES).toBe(8 * 1024);
    expect(PIPELINE_DIRECTIVE_ROLE_OVERRIDE_MAX_ROLES).toBe(8);
    expect(ACTOR_ID_MAX_LENGTH).toBe(64);
  });

  it("types the watch JSON envelope stable fields", () => {
    const sample: WatchJsonEnvelope = {
      rootRunId: "00000000-0000-4000-8000-000000000001",
      snapshot: {
        outcome: "running",
      } as WatchJsonEnvelope["snapshot"],
      cursor: 0,
      reason: null,
    };
    expect(sample.rootRunId).toBeTruthy();
    expect(sample.cursor).toBe(0);
    expect(PIPELINE_OUTCOMES).toContain(sample.snapshot.outcome as PipelineOutcome);
  });
});

describe("b81 operator documentation contracts", () => {
  const config = readDoc(CONFIG_DOC);
  const protocol = readDoc(PROTOCOL_DOC);
  const troubleshooting = readDoc(TROUBLESHOOTING_DOC);
  const b80 = readDoc(B80_DOC);
  const lcaDev = readDoc(LCA_DEV_SKILL);

  it("configuration documents watch, exit codes, actor, and steering", () => {
    expect(config).toContain("max watch");
    expect(config).toContain("LCA_ACTOR");
    expect(config).toContain("X-LCA-Actor");
    expect(config).toContain("max pipeline-stop");
    expect(config).toContain("max directive");
    expect(config).toMatch(/Exit code[\s\S]*14/);
    expect(config).toContain(String(PIPELINE_FEED_DEFAULT_WAIT_SEC));
    expect(config).toContain(String(PIPELINE_FEED_MAX_WAIT_SEC));
    expect(config).toContain("rootRunId");
    expect(config).toContain("pruned cursors");
    expect(config).toContain("lca wave");
    expect(config).toContain("max stop");
    expect(config).toContain(String(PIPELINE_DIRECTIVE_MAX_COUNT));
    expect(config).toContain("512-byte");
    expect(config).toContain("240");
    expect(config).toContain("operator-stop:");
  });

  it("protocol and troubleshooting cover recovery, directives, and cursors", () => {
    expect(protocol).toContain("max directive");
    expect(protocol).toContain("max pipeline-stop");
    expect(protocol.replace(/\s+/g, " ")).toMatch(
      /do \*\*not\*\* reach the active step/
    );
    expect(protocol).toContain("pruned cursors");
    expect(protocol).toMatch(/not `404`/);
    expect(protocol).toContain("halt.recoveryCommand");

    expect(troubleshooting).toMatch(/bare `max doctor`/);
    expect(troubleshooting).toContain("max watch");
    expect(troubleshooting).toContain("does not reach the active step");
    expect(troubleshooting).toContain("pruned");
    expect(troubleshooting).toMatch(/Prefer CLI[\s\S]*SQLite/);
  });

  it("b80 playbooks and lca-dev point at watch outcome without claiming b80 runtime", () => {
    expect(b80).toContain("outcome: green");
    expect(b80).toContain("max watch");
    expect(b80).toMatch(/Status:\*\* Planned/);
    expect(lcaDev).toContain("max watch");
    expect(lcaDev).toContain("max pipeline-stop");
    expect(lcaDev).toContain("outcome: green");
    expect(lcaDev).toMatch(/do not treat `runs` as the pipeline supervisor/);
    expect(lcaDev).not.toContain("max capabilities --json");
  });
});
