import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

describe("b68 About surfaces", () => {
  it("renames Application to About and serves license links from this install", () => {
    const settings = readSrc("packages/dashboard/src/SettingsView.tsx");
    const about = readSrc("packages/dashboard/src/AboutSettingsPanel.tsx");
    expect(settings).toMatch(/>\s*About\s*</);
    expect(settings).not.toMatch(/ApplicationSettingsPanel/);
    expect(settings).not.toMatch(/>\s*Application\s*</);
    expect(about).toMatch(/href="\/LICENSE"/);
    expect(about).toMatch(/href="\/NOTICE"/);
    expect(about).toMatch(/Check now/);
    expect(about).toMatch(/Apache License 2\.0/);
    expect(about).toMatch(/does not install a release/);
    expect(about).toMatch(/Node requirement/);
    expect(about).toMatch(/Upgrade actions/);
    expect(about).toMatch(/runningNode/);
    expect(about).toMatch(/satisfiesNodeFloor/);
    expect(about).toMatch(/formatRunningNodeLabel/);
    expect(about).toMatch(/formatPersistedUpgradeActionsLines/);
    expect(about).toMatch(/Required:/);
    expect(about).toMatch(/retry Check now/);
  });

  it("shows a chip for available and restart-required and opens About", () => {
    const app = readSrc("packages/dashboard/src/App.tsx");
    const bar = readSrc("packages/dashboard/src/ControlBar.tsx");
    expect(app).toMatch(/updateChipLabel/);
    expect(app).toMatch(/selectView\("settings"\)/);
    expect(bar).toMatch(/updateChip/);
    expect(readSrc("packages/shared/src/version.ts")).toMatch(/Restart required/);
    expect(readSrc("packages/shared/src/version.ts")).toMatch(/needs Node/);
  });
});
