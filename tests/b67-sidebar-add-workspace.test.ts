import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), "utf8");
}

describe("b67 sidebar Add workspace", () => {
  it("WorkspacePicker exposes Add workspace on the createWorkspace path", () => {
    const picker = readSrc("packages/dashboard/src/ControlBar.tsx");
    expect(picker).toContain("Add workspace");
    expect(picker).toContain("AddWorkspaceForm");
    expect(picker).toContain("onWorkspacesRefresh");
    expect(picker).toContain('aria-label="Add workspace"');

    const form = readSrc("packages/dashboard/src/AddWorkspaceForm.tsx");
    expect(form).toContain("api.createWorkspace");
    expect(form).toContain("api.pickWorkspaceFolder");
    expect(form).toContain("Register workspace");

    const modal = readSrc("packages/dashboard/src/AutomationModal.tsx");
    expect(modal).toContain("AddWorkspaceForm");
    expect(modal).not.toMatch(/api\.createWorkspace/);
  });
});
