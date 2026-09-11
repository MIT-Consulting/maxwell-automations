import { describe, expect, it } from "vitest";
import {
  buildAllowedOrigins,
  isCsrfSafe,
} from "../packages/daemon/src/http/server.ts";

describe("buildAllowedOrigins", () => {
  it("always includes loopback origins", () => {
    const origins = buildAllowedOrigins({
      host: "127.0.0.1",
      port: 3747,
      allowedIps: [],
    });
    expect(origins.has("http://127.0.0.1:3747")).toBe(true);
    expect(origins.has("http://localhost:3747")).toBe(true);
    expect(origins.has("http://[::1]:3747")).toBe(true);
  });

  it("does not add wildcard bind hosts as origins", () => {
    const origins = buildAllowedOrigins({
      host: "0.0.0.0",
      port: 3747,
      allowedIps: [],
    });
    expect(origins.has("http://0.0.0.0:3747")).toBe(false);
    expect(origins.has("http://[::]:3747")).toBe(false);
  });

  it("adds allowlisted IPv4 and bracketed IPv6", () => {
    const origins = buildAllowedOrigins({
      host: "127.0.0.1",
      port: 3747,
      allowedIps: ["100.64.0.1", "fd7a::1"],
    });
    expect(origins.has("http://100.64.0.1:3747")).toBe(true);
    expect(origins.has("http://[fd7a::1]:3747")).toBe(true);
  });
});

describe("isCsrfSafe", () => {
  const allowed = buildAllowedOrigins({
    host: "127.0.0.1",
    port: 3747,
    allowedIps: [],
  });

  it("allows non-mutating methods with foreign origin", () => {
    expect(
      isCsrfSafe(
        { method: "GET", origin: "http://evil.test" },
        allowed
      )
    ).toBe(true);
  });

  it("allows header-less loopback mutations (CLI/hooks/cancel)", () => {
    expect(isCsrfSafe({ method: "POST" }, allowed)).toBe(true);
    expect(
      isCsrfSafe(
        { method: "POST", contentType: "application/json" },
        allowed
      )
    ).toBe(true);
  });

  it("allows same-origin JSON mutations", () => {
    expect(
      isCsrfSafe(
        {
          method: "POST",
          origin: "http://127.0.0.1:3747",
          contentType: "application/json",
        },
        allowed
      )
    ).toBe(true);
    expect(
      isCsrfSafe(
        {
          method: "POST",
          origin: "http://127.0.0.1:3747",
          contentType: "application/json; charset=utf-8",
        },
        allowed
      )
    ).toBe(true);
  });

  it("rejects foreign origin and referer", () => {
    expect(
      isCsrfSafe(
        {
          method: "POST",
          origin: "http://evil.test",
          contentType: "application/json",
        },
        allowed
      )
    ).toBe(false);
    expect(
      isCsrfSafe(
        {
          method: "POST",
          referer: "http://evil.test/x",
          contentType: "application/json",
        },
        allowed
      )
    ).toBe(false);
  });

  it("rejects non-JSON content types when declared", () => {
    expect(
      isCsrfSafe({ method: "POST", contentType: "text/plain" }, allowed)
    ).toBe(false);
    expect(
      isCsrfSafe(
        {
          method: "POST",
          contentType: "application/x-www-form-urlencoded",
        },
        allowed
      )
    ).toBe(false);
  });

  it("rejects Origin null and foreign DELETE", () => {
    expect(
      isCsrfSafe(
        { method: "POST", origin: "null", contentType: "application/json" },
        allowed
      )
    ).toBe(false);
    expect(
      isCsrfSafe(
        { method: "DELETE", origin: "http://evil.test" },
        allowed
      )
    ).toBe(false);
  });
});
