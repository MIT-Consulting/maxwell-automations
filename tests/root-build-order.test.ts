import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;
}

function buildOrder(): string[] {
  const scripts = readJson("package.json").scripts as Record<string, string>;
  return [...scripts.build.matchAll(/npm run build -w (@lca\/[\w-]+)/g)].map((m) => m[1]);
}

function internalDeps(pkg: string): string[] {
  const manifest = readJson(join("packages", pkg.replace("@lca/", ""), "package.json"));
  const deps = (manifest.dependencies ?? {}) as Record<string, string>;
  return Object.keys(deps).filter((name) => name.startsWith("@lca/"));
}

// Vite bundles @lca/shared from its dist, so building a consumer before its
// dependency ships the previous checkout's shared code.
describe("root build order", () => {
  it("builds every workspace package after its @lca dependencies", () => {
    const order = buildOrder();
    const packages = readJson("package.json").workspaces as string[];
    expect(packages).toEqual(["packages/*"]);
    for (const pkg of order) {
      for (const dep of internalDeps(pkg)) {
        expect(order.indexOf(dep), `${dep} must build before ${pkg}`).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(dep), `${dep} must build before ${pkg}`).toBeLessThan(
          order.indexOf(pkg)
        );
      }
    }
  });

  it("stamps daemon, cli, and dashboard from their own build scripts", () => {
    for (const pkg of ["daemon", "cli", "dashboard"]) {
      const scripts = readJson(`packages/${pkg}/package.json`).scripts as Record<string, string>;
      expect(scripts.build).toContain("embed-version.mjs");
      expect(scripts.build).toContain(`--package ${pkg}`);
    }
  });

  it("lists every buildable workspace package", () => {
    const order = buildOrder();
    for (const pkg of ["automations-io", "cli", "daemon", "dashboard", "shared"]) {
      expect(order).toContain(`@lca/${pkg}`);
    }
  });
});
