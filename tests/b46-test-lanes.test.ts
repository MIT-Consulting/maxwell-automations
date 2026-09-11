import { describe, expect, it, vi } from "vitest";
import {
  REAL_GIT_LANE_FILES,
  REAL_GIT_TIMEOUT_MS,
  buildVitestInvocations,
  isRealGitOnlyFilter,
  runTestLanes,
} from "../scripts/run-tests.mjs";

const FAKE_VITEST = "/fake/vitest.mjs";

describe("b46 test lanes — invocation builder", () => {
  it("unfiltered run builds two disjoint fail-fast lanes", () => {
    const invocations = buildVitestInvocations([], { vitestEntry: FAKE_VITEST });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]!.label).toBe("normal");
    expect(invocations[1]!.label).toBe("real-git");

    const normal = invocations[0]!.args;
    expect(normal[0]).toBe(FAKE_VITEST);
    expect(normal[1]).toBe("run");
    for (const file of REAL_GIT_LANE_FILES) {
      expect(normal).toContain("--exclude");
      const idx = normal.indexOf(file);
      expect(idx).toBeGreaterThan(0);
      expect(normal[idx - 1]).toBe("--exclude");
    }

    const serial = invocations[1]!.args;
    expect(serial[0]).toBe(FAKE_VITEST);
    expect(serial[1]).toBe("run");
    for (const file of REAL_GIT_LANE_FILES) {
      expect(serial).toContain(file);
    }
    expect(serial).toContain("--no-file-parallelism");
    expect(serial).toContain("--maxWorkers=1");
    expect(serial).toContain(`--testTimeout=${REAL_GIT_TIMEOUT_MS}`);

    // Disjoint union: normal excludes exactly the serial set; serial lists them.
    expect(REAL_GIT_LANE_FILES).toHaveLength(4);
  });

  it("normal targeted filters use one invocation without serial flags", () => {
    const filters = ["tests/b46-verification-ownership.test.ts"];
    const invocations = buildVitestInvocations(filters, {
      vitestEntry: FAKE_VITEST,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.label).toBe("filtered");
    expect(invocations[0]!.args).toEqual([
      FAKE_VITEST,
      "run",
      ...filters,
    ]);
    expect(isRealGitOnlyFilter(filters)).toBe(false);
  });

  it("real-git targeted filters add serial flags", () => {
    const filters = [REAL_GIT_LANE_FILES[0]!, REAL_GIT_LANE_FILES[1]!];
    expect(isRealGitOnlyFilter(filters)).toBe(true);
    const invocations = buildVitestInvocations(filters, {
      vitestEntry: FAKE_VITEST,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.args).toEqual([
      FAKE_VITEST,
      "run",
      ...filters,
      "--no-file-parallelism",
      "--maxWorkers=1",
      `--testTimeout=${REAL_GIT_TIMEOUT_MS}`,
    ]);
  });

  it("mixed or unknown filters stay as a single non-serial invocation", () => {
    const mixed = [
      REAL_GIT_LANE_FILES[0]!,
      "tests/b46-verification-ownership.test.ts",
    ];
    expect(isRealGitOnlyFilter(mixed)).toBe(false);
    expect(
      buildVitestInvocations(mixed, { vitestEntry: FAKE_VITEST })[0]!.args
    ).toEqual([FAKE_VITEST, "run", ...mixed]);

    const unknown = ["b36-6-worktrees"];
    expect(isRealGitOnlyFilter(unknown)).toBe(false);
    expect(
      buildVitestInvocations(unknown, { vitestEntry: FAKE_VITEST })[0]!.args
    ).toEqual([FAKE_VITEST, "run", ...unknown]);
  });
});

describe("b46 test lanes — exit-code propagation", () => {
  it("returns the first nonzero child exit code and does not retry", async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 1) return 7;
      return 0;
    });

    const code = await runTestLanes([], {
      run,
      vitestEntry: FAKE_VITEST,
      execPath: "/fake/node",
    });

    expect(code).toBe(7);
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls[0]![0]).toBe(FAKE_VITEST);
  });

  it("returns 0 when every lane succeeds", async () => {
    const run = vi.fn(async () => 0);
    const code = await runTestLanes([], {
      run,
      vitestEntry: FAKE_VITEST,
      execPath: "/fake/node",
    });
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
