import { describe, expect, it } from "vitest";
import { checkControlToken } from "../packages/daemon/src/http/server.ts";

const SECRET = "s3cret-control-token";

describe("checkControlToken", () => {
  it("exempts loopback sources when no token is configured", () => {
    expect(
      checkControlToken({ isLoopbackSource: true, controlToken: undefined })
    ).toBe("ok");
  });

  it("exempts loopback sources even when a token is configured", () => {
    expect(
      checkControlToken({
        isLoopbackSource: true,
        controlToken: SECRET,
        presented: undefined,
      })
    ).toBe("ok");
  });

  it("fails closed for non-loopback when remote is unprovisioned", () => {
    expect(
      checkControlToken({ isLoopbackSource: false, controlToken: undefined })
    ).toBe("unprovisioned");
  });

  it("reports missing when a token is configured but none presented", () => {
    expect(
      checkControlToken({ isLoopbackSource: false, controlToken: SECRET })
    ).toBe("missing");
  });

  it("reports mismatch on a wrong token", () => {
    expect(
      checkControlToken({
        isLoopbackSource: false,
        controlToken: SECRET,
        presented: "wrong-token",
      })
    ).toBe("mismatch");
  });

  it("accepts the correct token", () => {
    expect(
      checkControlToken({
        isLoopbackSource: false,
        controlToken: SECRET,
        presented: SECRET,
      })
    ).toBe("ok");
  });

  it("returns mismatch (not a throw) when presented length differs", () => {
    expect(() =>
      checkControlToken({
        isLoopbackSource: false,
        controlToken: SECRET,
        presented: "x",
      })
    ).not.toThrow();
    expect(
      checkControlToken({
        isLoopbackSource: false,
        controlToken: SECRET,
        presented: "x",
      })
    ).toBe("mismatch");
  });
});
