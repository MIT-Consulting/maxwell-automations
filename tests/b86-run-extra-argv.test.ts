import { describe, expect, it } from "vitest";
import { DaemonError } from "../packages/cli/src/client.ts";
import { assertNoExtraRunArgs } from "../packages/cli/src/run-argv.ts";

describe("assertNoExtraRunArgs", () => {
  it("allows a single automation query", () => {
    expect(() => assertNoExtraRunArgs(["plain-auto"])).not.toThrow();
  });

  it("refuses kickoff flags with an implement-fully pointer", () => {
    for (const args of [
      ["plain-auto", "--feature", "b86"],
      ["plain-auto", "--profile", "deep"],
      ["plain-auto", "--role-profile", "fast-moderate"],
      ["plain-auto", "--idea", "some idea"],
    ] as const) {
      expect(() => assertNoExtraRunArgs([...args])).toThrow(DaemonError);
      expect(() => assertNoExtraRunArgs([...args])).toThrow(/implement-fully/i);
    }
  });

  it("refuses --flag=value kickoff forms with an implement-fully pointer", () => {
    expect(() => assertNoExtraRunArgs(["plain-auto", "--feature=b86"])).toThrow(
      /implement-fully/i
    );
  });

  it("refuses non-kickoff junk without silently ignoring it", () => {
    for (const args of [
      ["plain-auto", "--nope"],
      ["plain-auto", "extra-token"],
    ] as const) {
      expect(() => assertNoExtraRunArgs([...args])).toThrow(DaemonError);
      expect(() => assertNoExtraRunArgs([...args])).toThrow(/Usage: lca run/i);
    }
  });
});
