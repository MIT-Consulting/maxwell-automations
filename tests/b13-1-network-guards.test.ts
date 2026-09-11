import { describe, expect, it } from "vitest";
import { isValidIp, resolveDenyTargets } from "../packages/cli/src/remote.ts";
import { validateNetworkSettings } from "../packages/daemon/src/config/settings.ts";
import { isAllowedSource } from "../packages/daemon/src/http/server.ts";

describe("isAllowedSource", () => {
  it("allows loopback with an empty allowlist", () => {
    expect(isAllowedSource("127.0.0.1", [])).toBe(true);
    expect(isAllowedSource("::1", [])).toBe(true);
  });

  it("allows IPv4-mapped IPv6 loopback", () => {
    expect(isAllowedSource("::ffff:127.0.0.1", [])).toBe(true);
  });

  it("allows any source when the allowlist is empty", () => {
    expect(isAllowedSource("100.64.0.5", [])).toBe(true);
  });

  it("allows listed IPs and denies unlisted IPs", () => {
    const allowlist = ["100.64.0.1"];
    expect(isAllowedSource("100.64.0.1", allowlist)).toBe(true);
    expect(isAllowedSource("100.64.0.2", allowlist)).toBe(false);
  });

  it("allows IPv4-mapped IPv6 form of a listed IP", () => {
    expect(isAllowedSource("::ffff:100.64.0.1", ["100.64.0.1"])).toBe(true);
  });

  it("denies missing or empty remoteAddress when allowlist is populated", () => {
    const allowlist = ["100.64.0.1"];
    expect(isAllowedSource(undefined, allowlist)).toBe(false);
    expect(isAllowedSource("", allowlist)).toBe(false);
  });
});

describe("isValidIp", () => {
  it("accepts CGNAT IPv4 and loose IPv6 literals", () => {
    expect(isValidIp("100.64.0.1")).toBe(true);
    expect(isValidIp("2001:db8::1")).toBe(true);
  });

  it("rejects out-of-range octets and junk", () => {
    expect(isValidIp("999.1.1.1")).toBe(false);
    expect(isValidIp("not-an-ip")).toBe(false);
  });
});

describe("validateNetworkSettings", () => {
  it("returns ok for loopback-only config", () => {
    expect(validateNetworkSettings("127.0.0.1", [])).toEqual({ level: "ok" });
  });

  it("returns ok for broad host with a populated allowlist", () => {
    expect(validateNetworkSettings("0.0.0.0", ["100.64.0.1"])).toEqual({
      level: "ok",
    });
  });

  it("returns fatal for broad host with empty allowlist without opt-in", () => {
    const result = validateNetworkSettings("0.0.0.0", []);
    expect(result.level).toBe("fatal");
    if (result.level === "fatal") {
      expect(result.message).toContain("allowedIps");
      expect(result.message).toContain("LCA_UNSAFE_NETWORK=1");
    }
  });

  it("returns warn when unsafe opt-in is set", () => {
    const result = validateNetworkSettings("0.0.0.0", [], {
      unsafeOptIn: true,
    });
    expect(result.level).toBe("warn");
    if (result.level === "warn") {
      expect(result.message).toContain("WARNING:");
      expect(result.message).toContain("allowedIps");
    }
  });
});

describe("resolveDenyTargets", () => {
  const list = ["100.64.0.5", "100.64.0.9"];

  it("resolves 1-based indices to IPs", () => {
    expect(resolveDenyTargets(list, ["1", "2"])).toEqual({
      ips: ["100.64.0.5", "100.64.0.9"],
      clearAll: false,
    });
  });

  it("passes through literal IPs", () => {
    expect(resolveDenyTargets(list, ["100.64.0.5"])).toEqual({
      ips: ["100.64.0.5"],
      clearAll: false,
    });
  });

  it("requests clear-all for sole all or --all", () => {
    expect(resolveDenyTargets(list, ["--all"])).toEqual({
      ips: [...list],
      clearAll: true,
    });
    expect(resolveDenyTargets(list, ["all"])).toEqual({
      ips: [...list],
      clearAll: true,
    });
  });

  it("rejects out-of-range indices", () => {
    expect(() => resolveDenyTargets(list, ["3"])).toThrow(/Invalid allowlist index/);
    expect(() => resolveDenyTargets(list, ["0"])).toThrow(/Invalid allowlist index/);
  });
});
