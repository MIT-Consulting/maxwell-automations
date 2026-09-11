import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERT_NOTIFY_EVENTS } from "@lca/shared";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

describe("b51 phase 3 — Settings Alerts tab UI", () => {
  it("SettingsView exposes Chat defaults and Alerts tabs with accessible tablist", () => {
    const settingsView = readSrc("packages/dashboard/src/SettingsView.tsx");
    expect(settingsView).toMatch(/role="tablist"/);
    expect(settingsView).toMatch(/Chat defaults/);
    expect(settingsView).toMatch(/Alerts/);
    expect(settingsView).toMatch(/AlertsSettingsPanel/);
    expect(settingsView).not.toMatch(
      /if \(workspaces\.length === 0\)\s*\{\s*return\s*\(/
    );
  });

  it("AlertsSettingsPanel wires GET/PATCH/test client methods and thirteen-event matrix", () => {
    const panel = readSrc("packages/dashboard/src/AlertsSettingsPanel.tsx");
    expect(panel).toMatch(/getNotifySettings\(\)/);
    expect(panel).toMatch(/updateNotifySettings\(/);
    expect(panel).toMatch(/testNotifySettings\(\)/);
    expect(panel).toMatch(/ALERT_NOTIFY_EVENTS\.map\(/);
    expect(ALERT_NOTIFY_EVENTS).toHaveLength(13);
    for (const eventId of ALERT_NOTIFY_EVENTS) {
      expect(panel).toContain(eventId);
    }
  });

  it("AlertsSettingsPanel greys muted/unusable columns and never binds raw token from GET", () => {
    const panel = readSrc("packages/dashboard/src/AlertsSettingsPanel.tsx");
    expect(panel).toMatch(/envMutes\.toast/);
    expect(panel).toMatch(/envMutes\.ntfy/);
    expect(panel).toMatch(/LCA_NO_TOAST/);
    expect(panel).toMatch(/LCA_NO_NTFY/);
    expect(panel).toMatch(/usableNtfy/);
    expect(panel).toMatch(/toastColumnMuted/);
    expect(panel).toMatch(/ntfyColumnMuted/);
    expect(panel).toMatch(/type="password"/);
    expect(panel).toMatch(/tokenPresent/);
    expect(panel).toMatch(/tokenInput:\s*""/);
    expect(panel).not.toMatch(/tokenInput:\s*snapshot/);
  });

  it("api client exposes notify settings helpers on expected routes", () => {
    const apiSrc = readSrc("packages/dashboard/src/api.ts");
    expect(apiSrc).toMatch(
      /getNotifySettings\(\): Promise<NotifySettingsPublic>/
    );
    expect(apiSrc).toMatch(
      /updateNotifySettings\([\s\S]*?\/api\/settings\/notify/
    );
    expect(apiSrc).toMatch(
      /testNotifySettings\([\s\S]*?\/api\/settings\/notify\/test/
    );
    expect(apiSrc).toMatch(/NotifySettingsPublic/);
    expect(apiSrc).toMatch(/UpdateNotifySettingsInput/);
  });
});
