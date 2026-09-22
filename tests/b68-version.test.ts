import { describe, expect, it } from "vitest";
import {
  changelogReleaseVersion,
  normalizeReleaseVersion,
  publicVersionJson,
} from "../scripts/export-public.mjs";
import {
  FACTORY_IDENTITY,
  UpdateChecker,
  compareSemver,
  formatUpdateSummary,
  parseSemver,
  releasesLatestUrl,
  resolveInstallIdentity,
  resolveUpdateSettings,
  resolveUpdateState,
  updateChipLabel,
  type ReleaseInfo,
  type UpdateFetch,
  type VersionIdentity,
} from "@lca/shared";

const running = (version: string, channel: VersionIdentity["channel"] = "public"): VersionIdentity => ({
  version,
  channel,
});

function fakeFetch(handler: (url: string, etag: string | null) => {
  status: number;
  body?: unknown;
  etag?: string;
}): UpdateFetch {
  return async (url, init) => {
    const result = handler(url, init.headers["If-None-Match"] ?? null);
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      headers: { get: (name) => (name.toLowerCase() === "etag" ? result.etag ?? null : null) },
      json: async () => result.body,
    };
  };
}

const release = (version: string): ReleaseInfo => ({
  version,
  tag: `v${version}`,
  url: `https://github.com/example/max/releases/tag/v${version}`,
  notes: "notes",
});

describe("b68 version identities", () => {
  it("compares semver and ignores a v prefix", () => {
    expect(parseSemver("v1.0.5")).toEqual([1, 0, 5]);
    expect(compareSemver("1.0.4", "1.0.5")).toBe(-1);
    expect(compareSemver("1.0.5", "1.0.5")).toBe(0);
    expect(compareSemver("1.2.0", "1.0.9")).toBe(1);
    expect(compareSemver("latest", "1.0.0")).toBeNull();
  });

  it("resolves pairwise states", () => {
    expect(
      resolveUpdateState({
        running: running("1.0.4"),
        checkout: running("1.0.5"),
        available: "1.0.5",
        availableUnresolved: false,
        checkEnabled: true,
        offline: false,
      })
    ).toBe("restart-required");

    expect(
      resolveUpdateState({
        running: running("1.0.4"),
        checkout: running("1.0.4"),
        available: "1.0.5",
        availableUnresolved: false,
        checkEnabled: true,
        offline: false,
      })
    ).toBe("available");

    expect(
      resolveUpdateState({
        running: FACTORY_IDENTITY,
        checkout: FACTORY_IDENTITY,
        available: "1.0.5",
        availableUnresolved: false,
        checkEnabled: true,
        offline: false,
      })
    ).toBe("ahead/dev");

    expect(
      resolveUpdateState({
        running: running("1.0.5"),
        checkout: running("1.0.5"),
        available: "1.0.5",
        availableUnresolved: false,
        checkEnabled: false,
        offline: false,
      })
    ).toBe("disabled");

    expect(
      resolveUpdateState({
        running: running("1.0.5"),
        checkout: running("1.0.5"),
        available: null,
        availableUnresolved: false,
        checkEnabled: true,
        offline: true,
      })
    ).toBe("offline");

    expect(
      resolveUpdateState({
        running: running("1.0.5"),
        checkout: running("1.0.5"),
        available: null,
        availableUnresolved: true,
        checkEnabled: true,
        offline: false,
      })
    ).toBe("unknown");

    expect(
      resolveUpdateState({
        running: running("1.0.5"),
        checkout: running("1.0.5"),
        available: "1.0.5",
        availableUnresolved: false,
        checkEnabled: true,
        offline: false,
      })
    ).toBe("current");
  });

  it("drops a publicRepo that matches the approved repo", () => {
    expect(
      resolveUpdateSettings({
        file: {
          repo: "KLH/maxwell-automations",
          publicRepo: "KLH/maxwell-automations",
        },
      }).publicRepo
    ).toBeNull();
  });

  it("builds a GitHub and enterprise releases URL", () => {
    expect(releasesLatestUrl("MIT-Consulting/maxwell-automations", null)).toBe(
      "https://api.github.com/repos/MIT-Consulting/maxwell-automations/releases/latest"
    );
    expect(
      releasesLatestUrl("KLH/maxwell-automations", "https://ghe.example.com")
    ).toBe(
      "https://ghe.example.com/api/v3/repos/KLH/maxwell-automations/releases/latest"
    );
  });

  it("walks ancestors for version.json and prefers the embed beside the module", () => {
    const files = new Map<string, string>([
      ["/repo/packages/daemon/dist/version-embed.json", JSON.stringify(running("1.0.4"))],
      ["/repo/version.json", JSON.stringify({ version: "1.0.5", channel: "public" })],
    ]);
    const resolved = resolveInstallIdentity({
      modulePath: "/repo/packages/daemon/dist/index.js",
      dirname: (path) => path.split("/").slice(0, -1).join("/") || "/",
      join: (...parts) => parts.join("/").replace(/\/+/g, "/"),
      parseRoot: () => "/",
      readText: (path) => files.get(path) ?? null,
    });
    expect(resolved.running.version).toBe("1.0.4");
    expect(resolved.checkout?.version).toBe("1.0.5");
    expect(resolved.checkoutRoot).toBe("/repo");
  });

  it("checks the approved release and reuses an ETag", async () => {
    const seen: string[] = [];
    let calls = 0;
    const fetchImpl = fakeFetch((url, etag) => {
      seen.push(`${url} ${etag ?? ""}`);
      calls += 1;
      if (etag === "abc") return { status: 304 };
      return {
        status: 200,
        etag: "abc",
        body: {
          tag_name: "v1.0.5",
          html_url: "https://github.com/example/max/releases/tag/v1.0.5",
          body: "Ship it",
        },
      };
    });
    let stored = "";
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({
        file: { repo: "MIT-Consulting/maxwell-automations", cacheHours: 24 },
      }),
      running: running("1.0.4"),
      checkout: running("1.0.4"),
      readCache: () => (stored ? stored : null),
      writeCache: (text) => {
        stored = text;
      },
      fetch: fetchImpl,
      now: () => Date.parse("2026-09-21T00:00:00Z"),
    });

    const first = await checker.checkNow();
    expect(first.updateState).toBe("available");
    expect(first.available).toEqual({ ...release("1.0.5"), notes: "Ship it" });
    expect(first.releaseUrl).toContain("/releases/tag/v1.0.5");
    expect(updateChipLabel(first)).toBe("Update 1.0.5");
    expect(formatUpdateSummary(first)).toMatch(/approved 1.0.5/);

    const second = await checker.checkNow();
    expect(second.updateState).toBe("available");
    expect(calls).toBe(2);
    expect(seen[1]).toContain("abc");
  });

  it("reports offline when the check fails and nothing is cached", async () => {
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({ file: { repo: "MIT-Consulting/maxwell-automations" } }),
      running: running("1.0.5"),
      checkout: running("1.0.5"),
      readCache: () => null,
      writeCache: () => {},
      fetch: async () => {
        throw new Error("offline");
      },
    });
    const snapshot = await checker.checkNow();
    expect(snapshot.updateState).toBe("offline");
    expect(updateChipLabel(snapshot)).toBeNull();
  });

  it("does not call GitHub for a factory checkout", async () => {
    let calls = 0;
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({}),
      running: FACTORY_IDENTITY,
      checkout: FACTORY_IDENTITY,
      readCache: () => null,
      writeCache: () => {},
      fetch: async () => {
        calls += 1;
        throw new Error("should not fetch");
      },
    });
    const snapshot = await checker.checkNow();
    expect(snapshot.updateState).toBe("ahead/dev");
    expect(calls).toBe(0);
    expect(checker.shouldPoll()).toBe(false);
  });

  it("does not surface a cached public release on a factory checkout", () => {
    const cached = JSON.stringify({
      repo: "MIT-Consulting/maxwell-automations",
      etag: "abc",
      checkedAt: "2026-09-21T00:00:00.000Z",
      release: release("1.0.5"),
      publicRepo: null,
      publicEtag: null,
      publicRelease: null,
      error: null,
    });
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({}),
      running: FACTORY_IDENTITY,
      checkout: FACTORY_IDENTITY,
      readCache: () => cached,
      writeCache: () => {},
      fetch: async () => {
        throw new Error("should not fetch");
      },
    });
    const snapshot = checker.snapshot();
    expect(snapshot.updateState).toBe("ahead/dev");
    expect(snapshot.available).toBeNull();
    expect(snapshot.releaseUrl).toBeNull();
  });

  it("stamps the public export version from the changelog", () => {
    expect(changelogReleaseVersion("## [Unreleased]\n\n## [1.0.5] - 2026-09-16\n")).toBe(
      "1.0.5"
    );
    expect(normalizeReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(publicVersionJson("1.0.5")).toContain('"channel": "public"');
    expect(publicVersionJson("1.0.5")).toContain('"version": "1.0.5"');
  });
});
