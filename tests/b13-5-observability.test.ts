import { describe, expect, it } from "vitest";
import {
  isDegradableBindError,
  shouldAuditMutation,
} from "../packages/daemon/src/http/server.ts";
import { classifyTailscaleCandidates } from "../packages/cli/src/remote.ts";

describe("shouldAuditMutation", () => {
  it("audits state-changing methods from a non-loopback source", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(shouldAuditMutation(method, false)).toBe(true);
    }
  });

  it("is case-insensitive on the method", () => {
    expect(shouldAuditMutation("post", false)).toBe(true);
    expect(shouldAuditMutation("delete", false)).toBe(true);
  });

  it("does not audit safe methods", () => {
    expect(shouldAuditMutation("GET", false)).toBe(false);
    expect(shouldAuditMutation("HEAD", false)).toBe(false);
    expect(shouldAuditMutation("OPTIONS", false)).toBe(false);
  });

  it("never audits loopback sources, even for mutations", () => {
    expect(shouldAuditMutation("POST", true)).toBe(false);
    expect(shouldAuditMutation("DELETE", true)).toBe(false);
    expect(shouldAuditMutation("GET", true)).toBe(false);
  });
});

describe("isDegradableBindError", () => {
  const notAvail = { code: "EADDRNOTAVAIL" } as NodeJS.ErrnoException;
  const inUse = { code: "EADDRINUSE" } as NodeJS.ErrnoException;

  it("degrades a specific non-loopback host that isn't assigned", () => {
    expect(isDegradableBindError(notAvail, "100.64.0.2")).toBe(true);
    expect(isDegradableBindError(notAvail, "fd7a:115c:a1e0::1")).toBe(true);
  });

  it("never degrades the loopback companion or localhost", () => {
    expect(isDegradableBindError(notAvail, "127.0.0.1")).toBe(false);
    expect(isDegradableBindError(notAvail, "::1")).toBe(false);
    expect(isDegradableBindError(notAvail, "localhost")).toBe(false);
  });

  it("never degrades a wildcard host", () => {
    expect(isDegradableBindError(notAvail, "0.0.0.0")).toBe(false);
    expect(isDegradableBindError(notAvail, "::")).toBe(false);
  });

  it("keeps port-in-use and other codes fatal even on a specific host", () => {
    expect(isDegradableBindError(inUse, "100.64.0.2")).toBe(false);
    expect(
      isDegradableBindError({ code: "EACCES" } as NodeJS.ErrnoException, "100.64.0.2")
    ).toBe(false);
  });
});

describe("classifyTailscaleCandidates", () => {
  it("picks IPv4 CGNAT and IPv6 ULA, skips everything else", () => {
    const entries = [
      { family: "IPv4", address: "127.0.0.1", internal: true },
      { family: "IPv4", address: "192.168.1.10", internal: false },
      { family: "IPv4", address: "100.64.0.2", internal: false },
      { family: "IPv4", address: "100.127.255.1", internal: false },
      { family: "IPv4", address: "100.200.0.1", internal: false },
      { family: "IPv6", address: "fe80::1", internal: false },
      { family: "IPv6", address: "fd7a:115c:a1e0::1", internal: false },
      { family: "IPv6", address: "::1", internal: true },
    ];
    expect(classifyTailscaleCandidates(entries)).toEqual([
      "100.64.0.2",
      "100.127.255.1",
      "fd7a:115c:a1e0::1",
    ]);
  });

  it("skips internal Tailscale-range addresses", () => {
    expect(
      classifyTailscaleCandidates([
        { family: "IPv4", address: "100.64.0.2", internal: true },
        { family: "IPv6", address: "fd7a::1", internal: true },
      ])
    ).toEqual([]);
  });

  it("matches the fd7a ULA prefix case-insensitively", () => {
    expect(
      classifyTailscaleCandidates([
        { family: "IPv6", address: "FD7A:115C:A1E0::5", internal: false },
      ])
    ).toEqual(["FD7A:115C:A1E0::5"]);
  });

  it("dedupes repeated addresses", () => {
    expect(
      classifyTailscaleCandidates([
        { family: "IPv4", address: "100.64.0.2", internal: false },
        { family: "IPv4", address: "100.64.0.2", internal: false },
      ])
    ).toEqual(["100.64.0.2"]);
  });

  it("returns nothing when no interface qualifies", () => {
    expect(
      classifyTailscaleCandidates([
        { family: "IPv4", address: "10.0.0.5", internal: false },
        { family: "IPv6", address: "2001:db8::1", internal: false },
      ])
    ).toEqual([]);
  });
});
