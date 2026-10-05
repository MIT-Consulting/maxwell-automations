import { describe, expect, it } from "vitest";
import { describeRemoteBinding } from "../packages/cli/src/remote.ts";

describe("describeRemoteBinding", () => {
  it("reports loopback-only config as remote off and trivially bound", () => {
    const r = describeRemoteBinding({
      host: "127.0.0.1",
      bindAddresses: ["127.0.0.1"],
      unboundHosts: [],
    });
    expect(r).toEqual({ remoteOn: false, hostBound: true, unboundHosts: [] });
  });

  it("reports a bound Tailscale host as remote on and bound", () => {
    const r = describeRemoteBinding({
      host: "100.64.0.2",
      bindAddresses: ["127.0.0.1", "100.64.0.2"],
      unboundHosts: [],
    });
    expect(r).toEqual({ remoteOn: true, hostBound: true, unboundHosts: [] });
  });

  it("flags remote configured but not bound when the daemon degraded at boot", () => {
    const r = describeRemoteBinding({
      host: "100.64.0.2",
      bindAddresses: ["127.0.0.1"],
      unboundHosts: ["100.64.0.2"],
    });
    expect(r).toEqual({
      remoteOn: true,
      hostBound: false,
      unboundHosts: ["100.64.0.2"],
    });
  });

  it("falls back to bindAddresses for daemons that predate unboundHosts", () => {
    expect(
      describeRemoteBinding({ host: "100.64.0.2", bindAddresses: ["127.0.0.1"] })
    ).toEqual({ remoteOn: true, hostBound: false, unboundHosts: ["100.64.0.2"] });
    expect(
      describeRemoteBinding({
        host: "100.64.0.2",
        bindAddresses: ["127.0.0.1", "100.64.0.2"],
      })
    ).toEqual({ remoteOn: true, hostBound: true, unboundHosts: [] });
  });

  it("treats a wildcard bind as bound", () => {
    const r = describeRemoteBinding({
      host: "0.0.0.0",
      bindAddresses: ["0.0.0.0"],
      unboundHosts: [],
    });
    expect(r.remoteOn).toBe(true);
    expect(r.hostBound).toBe(true);
  });
});
