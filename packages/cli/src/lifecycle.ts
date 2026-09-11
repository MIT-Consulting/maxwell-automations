import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LCA_HOME = join(homedir(), ".cursor-local-automations");
export const DEV_PID_PATH = join(LCA_HOME, "dev.pid");
export const DEV_LOG_PATH = join(LCA_HOME, "dev.log");
export const VITE_PORT = 5273;

export type InstanceMode = "dev" | "prod";

/** Repo root: packages/cli/dist → repo root (same hop count as daemon entry). */
export function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
}

export function ensureLcaHome(): void {
  mkdirSync(LCA_HOME, { recursive: true });
}

export function readDevPid(): number | undefined {
  if (!existsSync(DEV_PID_PATH)) return undefined;
  const raw = readFileSync(DEV_PID_PATH, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

export function writeDevPid(pid: number): void {
  ensureLcaHome();
  writeFileSync(DEV_PID_PATH, String(pid), "utf8");
}

export function clearDevPid(): void {
  if (existsSync(DEV_PID_PATH)) unlinkSync(DEV_PID_PATH);
}

/** Best-effort: is anything listening on this port? */
export async function portListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Windows: find LISTENING PID via netstat. POSIX: not implemented here — callers
 * use killTree on dev.pid instead.
 */
export function findPortListenerPid(port: number): number | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split(/\r?\n/).find((l) => l.includes("LISTENING"));
    if (!line) return undefined;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 2000).unref();
}

export async function killPortOwner(port: number): Promise<void> {
  const pid = findPortListenerPid(port);
  if (pid) killTree(pid);
}

/**
 * Detached hot-reload rig: `npm run dev` at repo root. Returns the rig's top-level
 * PID (process group leader on POSIX, Start-Process PID on Windows).
 */
export function spawnDevRig(): number {
  const repoRoot = resolveRepoRoot();
  ensureLcaHome();

  if (process.platform === "win32") {
    // Launch the rig via `cmd.exe /c npm run dev > dev.log 2>&1` so stdout AND
    // stderr merge into a single log (Start-Process rejects identical
    // -RedirectStandardOutput/-RedirectStandardError paths). Start-Process gives
    // the rig its own hidden console (no per-grandchild console popups) and
    // breaks it away from the CLI's job object so it survives the CLI exiting —
    // same rationale as spawnDaemonWindows. Paths pass via env to avoid quoting
    // pitfalls. The launcher PID file holds the cmd.exe PID; killTree(/T) reaps
    // the whole npm/node/vite tree under it.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$cmdLine = 'npm run dev > ' + '\"' + $env:LCA_DEV_LOG + '\"' + ' 2>&1'",
      "$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -WorkingDirectory $env:LCA_REPO_ROOT -WindowStyle Hidden -PassThru",
      "$p.Id | Out-File -FilePath $env:LCA_DEV_PID -Encoding ascii -NoNewline",
    ].join("; ");
    execSync(
      `powershell.exe -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`,
      {
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          LCA_DEV_LOG: DEV_LOG_PATH,
          LCA_DEV_PID: DEV_PID_PATH,
          LCA_REPO_ROOT: repoRoot,
        },
      }
    );
    const pid = readDevPid();
    if (!pid) throw new Error("Failed to start dev rig (no dev.pid written)");
    return pid;
  }

  const logOut = openSync(DEV_LOG_PATH, "a");
  const logErr = openSync(DEV_LOG_PATH, "a");
  const child = spawn("npm", ["run", "dev"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logOut, logErr],
    env: process.env,
  });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error("Failed to start dev rig (no pid)");
  writeDevPid(pid);
  return pid;
}

/** Poll until the dashboard root returns HTTP 200 (Vite proxied in dev). */
export async function waitForDashboardReady(
  baseUrl: string,
  timeoutMs = 120_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(3000) });
      if (res.status === 200) return true;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
