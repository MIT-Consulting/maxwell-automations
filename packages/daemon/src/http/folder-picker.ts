import { spawn } from "node:child_process";

export type PickFolderResult = {
  supported: boolean;
  path: string | null;
};

// The dialog is launched by the detached/hidden daemon process, so without an
// owner window it opens behind everything and never gets focus. We create a
// hidden TopMost owner form, force it to the foreground, and parent the dialog
// to it so the picker reliably appears in front of the browser.
const FOLDER_PICKER_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "$owner.ShowInTaskbar = $false",
  "$owner.Opacity = 0",
  "$owner.Size = New-Object System.Drawing.Size(1,1)",
  "$owner.StartPosition = 'CenterScreen'",
  "$owner.Show()",
  "$owner.Activate()",
  "[System.Windows.Forms.Application]::DoEvents()",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.Description = 'Select workspace folder'",
  "$d.ShowNewFolderButton = $true",
  // Seed the initial folder from an env var so backslashes/spaces never need
  // escaping inside this -Command string.
  "$base = $env:LCA_PICK_BASE",
  "if ($base -and (Test-Path -LiteralPath $base)) { $d.SelectedPath = $base }",
  "$result = $d.ShowDialog($owner)",
  "$owner.Close()",
  "if ($result -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
].join("; ");

function runWindowsFolderPicker(base?: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", FOLDER_PICKER_SCRIPT],
      {
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, LCA_PICK_BASE: base ?? "" },
      }
    );

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("error", (err) => {
      console.error("folder picker spawn failed:", err);
      resolve("");
    });

    child.on("close", () => {
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
  });
}

export async function pickWorkspaceFolder(
  base?: string
): Promise<PickFolderResult> {
  if (process.platform !== "win32") {
    return { supported: false, path: null };
  }

  try {
    const selected = await runWindowsFolderPicker(base);
    if (!selected) {
      return { supported: true, path: null };
    }
    return { supported: true, path: selected };
  } catch (err) {
    console.error("folder picker failed:", err);
    return { supported: true, path: null };
  }
}
