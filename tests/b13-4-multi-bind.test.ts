import { describe, expect, it } from "vitest";
import { resolveBindHosts } from "../packages/daemon/src/http/server.ts";

describe("resolveBindHosts", () => {
  it("binds a single listener for IPv4 loopback", () => {
    expect(resolveBindHosts("127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  it("binds a single listener for IPv6 loopback", () => {
    expect(resolveBindHosts("::1")).toEqual(["::1"]);
  });

  it("binds a single listener for the localhost alias", () => {
    expect(resolveBindHosts("localhost")).toEqual(["localhost"]);
  });

  it("binds a single listener for the IPv4 wildcard (back-compat)", () => {
    expect(resolveBindHosts("0.0.0.0")).toEqual(["0.0.0.0"]);
  });

  it("binds a single listener for the IPv6 wildcard", () => {
    expect(resolveBindHosts("::")).toEqual(["::"]);
  });

  it("pairs a specific IPv4 host with a loopback companion, loopback first", () => {
    expect(resolveBindHosts("100.64.0.2")).toEqual(["127.0.0.1", "100.64.0.2"]);
  });

  it("pairs a specific IPv6 host with a loopback companion", () => {
    expect(resolveBindHosts("fd7a::1")).toEqual(["127.0.0.1", "fd7a::1"]);
  });
});
