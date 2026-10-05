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
  formatPersistedUpgradeActionsLines,
  formatUpdateSummary,
  packageContentsUrl,
  parseSemver,
  releaseByTagUrl,
  releasesLatestUrl,
  releaseFromGitHubPayload,
  resolveInstallIdentity,
  resolveUpdateSettings,
  resolveUpdateState,
  updateChipLabel,
  updateStateDetail,
  type ReleaseInfo,
  type UpdateFetch,
  type UpdateSnapshot,
  type VersionIdentity,
} from "@lca/shared";
import { formatUpdateCheckReport } from "../packages/cli/src/version.ts";
import {
  extractUpgradeActionsFromReleaseBody,
  upgradeActionsForPersistence,
} from "../packages/shared/src/upgrade-actions.ts";

const running = (version: string, channel: VersionIdentity["channel"] = "public"): VersionIdentity => ({
  version,
  channel,
});

function fakeFetch(handler: (url: string, etag: string | null, init: {
  headers: Record<string, string>;
}) => {
  status: number;
  body?: unknown;
  text?: string;
  etag?: string;
}): UpdateFetch {
  return async (url, init) => {
    const result = handler(url, init.headers["If-None-Match"] ?? null, init);
    return {
      status: result.status,
      ok: result.status >= 200 && result.status < 300,
      headers: { get: (name) => (name.toLowerCase() === "etag" ? result.etag ?? null : null) },
      json: async () => result.body,
      text: async () =>
        result.text ??
        (typeof result.body === "string" ? result.body : JSON.stringify(result.body ?? "")),
    };
  };
}

const release = (
  version: string,
  extra: Partial<ReleaseInfo> = {}
): ReleaseInfo => ({
  version,
  tag: `v${version}`,
  url: `https://github.com/example/max/releases/tag/v${version}`,
  notes: "notes",
  nodeFloor: null,
  upgradeActions: null,
  ...extra,
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
    const manifest = JSON.stringify({ engines: { node: ">=22.13" } });
    const fetchImpl = fakeFetch((url, etag, init) => {
      seen.push(`${url} ${etag ?? ""}`);
      calls += 1;
      if (etag === "abc") return { status: 304 };
      if (url.includes("/contents/package.json")) {
        expect(init.headers.Accept).toBe("application/vnd.github.raw+json");
        return { status: 200, text: manifest };
      }
      if (url.includes("/releases/tags/")) {
        return {
          status: 200,
          body: {
            tag_name: "v1.0.5",
            body: "### Upgrade actions\n\n- Rebuild\n",
          },
        };
      }
      return {
        status: 200,
        etag: "abc",
        body: {
          tag_name: "v1.0.5",
          html_url: "https://github.com/example/max/releases/tag/v1.0.5",
          body: "### Upgrade actions\n\n- Rebuild\n",
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
      runningNode: "22.12.0",
      readCache: () => (stored ? stored : null),
      writeCache: (text) => {
        stored = text;
      },
      fetch: fetchImpl,
      now: () => Date.parse("2026-09-21T00:00:00Z"),
    });

    const first = await checker.checkNow();
    expect(first.updateState).toBe("available");
    expect(first.available?.version).toBe("1.0.5");
    expect(first.available?.nodeFloor).toBe(">=22.13");
    expect(first.available?.upgradeActions).toEqual(["- Rebuild"]);
    expect(first.runningNode).toBe("22.12.0");
    expect(first.releaseUrl).toContain("/releases/tag/v1.0.5");
    expect(updateChipLabel(first)).toBe("Update 1.0.5 · needs Node 22.13");
    expect(formatUpdateSummary(first)).toMatch(/needs Node 22\.13/);

    const second = await checker.checkNow();
    expect(second.updateState).toBe("available");
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(seen.some((entry) => entry.includes("abc"))).toBe(true);
  });

  it("reports offline when the check fails and nothing is cached", async () => {
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({ file: { repo: "MIT-Consulting/maxwell-automations" } }),
      running: running("1.0.5"),
      checkout: running("1.0.5"),
      runningNode: "22.13.0",
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
      runningNode: "22.13.0",
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
      runningNode: "22.13.0",
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

  it("normalizes old cache releases without enrichment fields", () => {
    const cached = JSON.stringify({
      repo: "MIT-Consulting/maxwell-automations",
      etag: "abc",
      checkedAt: "2026-09-21T00:00:00.000Z",
      release: {
        version: "1.0.5",
        tag: "v1.0.5",
        url: "https://example/releases/v1.0.5",
        notes: "notes",
      },
      publicRepo: null,
      publicEtag: null,
      publicRelease: null,
      error: null,
    });
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({ file: { repo: "MIT-Consulting/maxwell-automations" } }),
      running: running("1.0.4"),
      checkout: running("1.0.4"),
      runningNode: "22.13.0",
      readCache: () => cached,
      writeCache: () => {},
      fetch: async () => {
        throw new Error("should not fetch on snapshot");
      },
    });
    const snapshot = checker.snapshot();
    expect(snapshot.available?.nodeFloor).toBeNull();
    expect(snapshot.available?.upgradeActions).toBeNull();
    expect(updateChipLabel(snapshot)).toBe("Update 1.0.5");
  });

  it("extracts upgrade actions from a release body without a changelog heading", () => {
    const payload = releaseFromGitHubPayload({
      tag_name: "v1.0.7",
      html_url: "https://example/v1.0.7",
      body: "### Upgrade actions\n\n- npm ci\n",
    });
    expect(payload).toMatchObject({
      version: "1.0.7",
      upgradeActions: ["- npm ci"],
      nodeFloor: null,
    });
    expect(extractUpgradeActionsFromReleaseBody("no section")).toEqual({
      status: "missing-section",
    });
    expect(upgradeActionsForPersistence({ status: "missing-section" })).toBeNull();
    expect(formatPersistedUpgradeActionsLines(null)).toEqual(["unavailable"]);
    expect(formatPersistedUpgradeActionsLines([])).toEqual(["none"]);
  });

  it("builds contents and tag URLs like releasesLatestUrl", () => {
    expect(packageContentsUrl("MIT-Consulting/maxwell-automations", "v1.0.5", null)).toBe(
      "https://api.github.com/repos/MIT-Consulting/maxwell-automations/contents/package.json?ref=v1.0.5"
    );
    expect(
      packageContentsUrl("KLH/maxwell-automations", "v1.0.5", "https://ghe.example.com")
    ).toBe(
      "https://ghe.example.com/api/v3/repos/KLH/maxwell-automations/contents/package.json?ref=v1.0.5"
    );
    expect(releaseByTagUrl("MIT-Consulting/maxwell-automations", "v1.0.5", null)).toContain(
      "/releases/tags/v1.0.5"
    );
  });

  it("backfills enrichment on 304 when metadata was absent", async () => {
    const cached = JSON.stringify({
      repo: "MIT-Consulting/maxwell-automations",
      etag: "abc",
      checkedAt: "2026-09-20T00:00:00.000Z",
      release: release("1.0.5"),
      publicRepo: null,
      publicEtag: null,
      publicRelease: null,
      error: null,
    });
    let stored = cached;
    const fetchImpl = fakeFetch((url, etag) => {
      if (etag === "abc") return { status: 304 };
      if (url.includes("/contents/package.json")) {
        return {
          status: 200,
          text: JSON.stringify({ engines: { node: ">=22.13" } }),
        };
      }
      if (url.includes("/releases/tags/")) {
        return {
          status: 200,
          body: { body: "### Upgrade actions\n\nnone\n" },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({
        file: { repo: "MIT-Consulting/maxwell-automations", cacheHours: 24 },
      }),
      running: running("1.0.4"),
      checkout: running("1.0.4"),
      runningNode: "22.13.0",
      readCache: () => stored,
      writeCache: (text) => {
        stored = text;
      },
      fetch: fetchImpl,
      now: () => Date.parse("2026-09-21T00:00:00Z"),
    });
    const snapshot = await checker.checkNow();
    expect(snapshot.available?.nodeFloor).toBe(">=22.13");
    expect(snapshot.available?.upgradeActions).toEqual([]);
    const parsed = JSON.parse(stored) as { release: ReleaseInfo };
    expect(parsed.release.nodeFloor).toBe(">=22.13");
  });

  it("keeps release availability when manifest enrichment fails", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/releases/latest")) {
        return {
          status: 200,
          etag: "abc",
          body: {
            tag_name: "v1.0.5",
            html_url: "https://github.com/example/max/releases/tag/v1.0.5",
            body: "Ship it",
          },
        };
      }
      if (url.includes("/contents/package.json")) return { status: 404 };
      return { status: 404 };
    });
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({
        file: { repo: "MIT-Consulting/maxwell-automations" },
      }),
      running: running("1.0.4"),
      checkout: running("1.0.4"),
      runningNode: "22.13.0",
      readCache: () => null,
      writeCache: () => {},
      fetch: fetchImpl,
    });
    const snapshot = await checker.checkNow();
    expect(snapshot.updateState).toBe("available");
    expect(snapshot.available?.nodeFloor).toBeNull();
  });

  it("uses shared floor copy when the requirement is satisfied", () => {
    const input = {
      updateState: "available" as const,
      available: release("1.0.5", { nodeFloor: ">=22.13" }),
      runningNode: "22.13.1",
    };
    expect(updateChipLabel(input)).toBe("Update 1.0.5");
    expect(formatUpdateSummary(input)).not.toMatch(/needs Node/);
    expect(updateStateDetail("available", input)).toMatch(/manual pin move/);
  });

  it("keeps malformed or unknown floors honest instead of satisfied or unmet", () => {
    const malformed = {
      updateState: "available" as const,
      available: release("1.0.5", { nodeFloor: "^22.13" }),
      runningNode: "20.11.0",
    };
    expect(updateChipLabel(malformed)).toBe("Update 1.0.5");
    expect(formatUpdateSummary(malformed)).not.toMatch(/needs Node/);
    expect(updateStateDetail("available", malformed)).toMatch(/manual pin move/);

    const unknown = {
      updateState: "available" as const,
      available: release("1.0.5"),
      runningNode: "20.11.0",
    };
    expect(updateChipLabel(unknown)).toBe("Update 1.0.5");
    expect(formatUpdateSummary(unknown)).not.toMatch(/needs Node/);

    const noRuntime = {
      updateState: "available" as const,
      available: release("1.0.5", { nodeFloor: ">=22.13" }),
      runningNode: null,
    };
    expect(updateChipLabel(noRuntime)).toBe("Update 1.0.5");
    expect(formatUpdateSummary(noRuntime)).not.toMatch(/needs Node/);
  });

  it("bounds oversized cached Upgrade actions on load", () => {
    const cached = JSON.stringify({
      repo: "MIT-Consulting/maxwell-automations",
      etag: "abc",
      checkedAt: "2026-09-21T00:00:00.000Z",
      release: release("1.0.5", {
        upgradeActions: Array.from({ length: 60 }, (_, i) => `- action ${i + 1}`),
      }),
      publicRepo: null,
      publicEtag: null,
      publicRelease: null,
      error: null,
    });
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({ file: { repo: "MIT-Consulting/maxwell-automations" } }),
      running: running("1.0.4"),
      checkout: running("1.0.4"),
      runningNode: "22.13.0",
      readCache: () => cached,
      writeCache: () => {},
      fetch: async () => {
        throw new Error("should not fetch on snapshot");
      },
    });
    expect(checker.snapshot().available?.upgradeActions).toHaveLength(50);
  });

  it("prints persisted Upgrade actions without mapping null to none", () => {
    const base: UpdateSnapshot = {
      running: running("1.0.4"),
      checkout: running("1.0.4"),
      available: release("1.0.5", { upgradeActions: null }),
      publicAvailable: null,
      updateState: "available",
      lastCheckedAt: null,
      releaseUrl: "https://example/releases/v1.0.5",
      runningNode: "22.13.0",
    };
    const unknown = formatUpdateCheckReport(base);
    expect(unknown.split("\n")).toContain("Upgrade actions");
    expect(unknown).toContain("\n  unavailable");
    expect(unknown).not.toContain("\n  none");

    const none = formatUpdateCheckReport({
      ...base,
      available: release("1.0.5", { upgradeActions: [] }),
    });
    expect(none.split("\n")).toContain("Upgrade actions");
    expect(none).toContain("\n  none");
    expect(none).not.toContain("unavailable");

    const present = formatUpdateCheckReport({
      ...base,
      available: release("1.0.5", { upgradeActions: ["- Rebuild"] }),
    });
    expect(present).toContain("\n  - Rebuild");
  });

  it("enriches publicRepo releases with the same compatibility shape", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("maxwell-public") && url.includes("/contents/package.json")) {
        return { status: 200, text: JSON.stringify({ engines: { node: ">=22.13" } }) };
      }
      if (url.includes("maxwell-public")) {
        return {
          status: 200,
          body: {
            tag_name: "v1.0.9",
            html_url: "https://github.com/example/public/releases/tag/v1.0.9",
            body: "### Upgrade actions\n\nnone\n",
          },
        };
      }
      if (url.includes("/contents/package.json")) {
        return { status: 200, text: JSON.stringify({ engines: { node: ">=22.13" } }) };
      }
      return {
        status: 200,
        body: {
          tag_name: "v1.0.5",
          html_url: "https://github.com/example/max/releases/tag/v1.0.5",
          body: "### Upgrade actions\n\n- Rebuild\n",
        },
      };
    });
    const checker = new UpdateChecker({
      settings: resolveUpdateSettings({
        file: {
          repo: "MIT-Consulting/maxwell-automations",
          publicRepo: "MIT-Consulting/maxwell-public",
        },
      }),
      running: running("1.0.4"),
      checkout: running("1.0.4"),
      runningNode: "22.13.0",
      readCache: () => null,
      writeCache: () => {},
      fetch: fetchImpl,
    });
    const snapshot = await checker.checkNow();
    expect(snapshot.available?.nodeFloor).toBe(">=22.13");
    expect(snapshot.available?.upgradeActions).toEqual(["- Rebuild"]);
    expect(snapshot.publicAvailable?.version).toBe("1.0.9");
    expect(snapshot.publicAvailable?.nodeFloor).toBe(">=22.13");
    expect(snapshot.publicAvailable?.upgradeActions).toEqual([]);
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
