import { describe, expect, it } from "vitest";

import {
  assertTransition,
  canTransition,
} from "../packages/daemon/src/runs/state-machine.ts";

describe("b4 interactive run chat state transitions", () => {
  it("allows terminal runs to reopen as running", () => {
    for (const from of ["completed", "failed", "cancelled"] as const) {
      expect(canTransition(from, "running")).toBe(true);
    }
  });

  it("keeps reopened running runs able to pause or finish", () => {
    for (const to of ["needs_input", "completed", "failed", "cancelled"] as const) {
      expect(canTransition("running", to)).toBe(true);
    }
  });

  it("keeps non-resume terminal transitions illegal", () => {
    expect(canTransition("completed", "needs_input")).toBe(false);
    expect(canTransition("failed", "completed")).toBe(false);
    expect(canTransition("cancelled", "failed")).toBe(false);
  });

  it("throws on illegal transitions", () => {
    expect(() => assertTransition("completed", "needs_input")).toThrow(
      "Invalid run transition"
    );
  });
});
