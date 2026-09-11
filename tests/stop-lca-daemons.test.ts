import { describe, expect, it } from "vitest";
import { classifyDaemonProtection } from "../scripts/stop-lca-daemons.mjs";

describe("classifyDaemonProtection", () => {
  it("allows loopback-only prod without remote auth", () => {
    expect(
      classifyDaemonProtection({
        ok: true,
        host: "127.0.0.1",
        bindAddresses: ["127.0.0.1"],
        remoteAuth: false,
        mode: "prod",
      })
    ).toEqual({ protected: false });
  });

  it("protects remoteAuth sessions", () => {
    expect(
      classifyDaemonProtection({
        ok: true,
        host: "100.64.0.2",
        bindAddresses: ["127.0.0.1", "100.64.0.2"],
        remoteAuth: true,
        mode: "prod",
      })
    ).toMatchObject({ protected: true, reason: "remoteAuth=on" });
  });

  it("protects non-loopback host even without remoteAuth flag", () => {
    expect(
      classifyDaemonProtection({
        ok: true,
        host: "100.64.0.2",
        bindAddresses: ["127.0.0.1"],
        remoteAuth: false,
      })
    ).toMatchObject({ protected: true, reason: "host=100.64.0.2" });
  });

  it("protects non-loopback bind address", () => {
    expect(
      classifyDaemonProtection({
        ok: true,
        host: "127.0.0.1",
        bindAddresses: ["127.0.0.1", "100.64.0.2"],
        remoteAuth: false,
      })
    ).toMatchObject({ protected: true, reason: "bind=100.64.0.2" });
  });
});
