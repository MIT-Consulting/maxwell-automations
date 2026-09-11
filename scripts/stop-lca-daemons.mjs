/**
 * Stop LCA daemons on common ports so verify scripts get exclusive DB access.
 *
 * Never tears down a live operator session — that left Max/remote access down
 * when automation agents ran UI verify scripts (same effect as `lca down`).
 *
 * A daemon is protected when any of:
 * - remote auth / non-loopback bind (phone over Tailscale, etc.)
 * - non-terminal runs (`queued` / `running` / `needs_input`)
 *
 * Override only for intentional local-only exclusive access:
 *   LCA_FORCE_STOP_DAEMONS=1   or   stopLcaDaemons(ports, { force: true })
 *
 * Isolated-home harnesses (temp `LCA_HOME`) should not call this for port 3747
 * at all — they do not share the operator SQLite file.
 */

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "needs_input"]);

function isLoopbackHost(host) {
  if (!host || typeof host !== "string") return true;
  const h = host.trim().toLowerCase();
  return (
    h === "127.0.0.1" ||
    h === "localhost" ||
    h === "::1" ||
    h === "[::1]" ||
    h.startsWith("127.")
  );
}

/**
 * @param {unknown} status
 * @returns {{ protected: boolean, reason?: string }}
 */
export function classifyDaemonProtection(status) {
  if (!status || typeof status !== "object") {
    return { protected: false };
  }
  const s = /** @type {Record<string, unknown>} */ (status);

  if (s.remoteAuth === true) {
    return { protected: true, reason: "remoteAuth=on" };
  }

  const host = typeof s.host === "string" ? s.host : "";
  if (host && !isLoopbackHost(host)) {
    return { protected: true, reason: `host=${host}` };
  }

  const binds = Array.isArray(s.bindAddresses) ? s.bindAddresses : [];
  const remoteBind = binds.find(
    (addr) => typeof addr === "string" && !isLoopbackHost(addr)
  );
  if (remoteBind) {
    return { protected: true, reason: `bind=${remoteBind}` };
  }

  return { protected: false };
}

/**
 * @param {number} port
 * @returns {Promise<number>}
 */
async function countActiveRuns(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs?limit=50`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return 0;
    const body = /** @type {{ runs?: Array<{ status?: string }> }} */ (
      await res.json()
    );
    const runs = Array.isArray(body.runs) ? body.runs : [];
    return runs.filter((r) => ACTIVE_RUN_STATUSES.has(r.status ?? "")).length;
  } catch {
    return 0;
  }
}

/**
 * @param {number[]} [ports]
 * @param {{ force?: boolean, allowLive?: boolean }} [options]
 * @returns {Promise<{ stopped: number[], skipped: Array<{ port: number, reason: string }> }>}
 */
export async function stopLcaDaemons(
  ports = [3747, 3752, 3753],
  options = {}
) {
  const force =
    options.force === true || process.env.LCA_FORCE_STOP_DAEMONS === "1";
  const allowLive = options.allowLive === true;
  /** @type {number[]} */
  const stopped = [];
  /** @type {Array<{ port: number, reason: string }>} */
  const skipped = [];

  for (const port of ports) {
    try {
      const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!statusRes.ok) {
        // Older / bare health-only listener — fall through to shutdown attempt.
        const health = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        }).catch(() => null);
        if (!health?.ok) continue;
      } else {
        const status = await statusRes.json();
        if (!force) {
          const classification = classifyDaemonProtection(status);
          if (classification.protected) {
            const reason = classification.reason ?? "live session";
            console.warn(
              `[stop-lca-daemons] refusing to shut down live daemon on :${port} (${reason}). ` +
                `Set LCA_FORCE_STOP_DAEMONS=1 to override.`
            );
            skipped.push({ port, reason });
            continue;
          }
          const active = await countActiveRuns(port);
          if (active > 0) {
            const reason = `${active} active run(s)`;
            console.warn(
              `[stop-lca-daemons] refusing to shut down daemon on :${port} (${reason}). ` +
                `Set LCA_FORCE_STOP_DAEMONS=1 to override.`
            );
            skipped.push({ port, reason });
            continue;
          }
        }
      }

      await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
      stopped.push(port);
    } catch {
      /* not running */
    }
  }

  if (stopped.length > 0) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (skipped.length > 0 && !allowLive && !force) {
    const detail = skipped.map((s) => `:${s.port} (${s.reason})`).join(", ");
    throw new Error(
      `Refusing to stop live LCA daemon(s): ${detail}. ` +
        `Verify scripts must not tear down Max/remote sessions (same footgun as \`lca down\`). ` +
        `Use an isolated LCA_HOME harness, or set LCA_FORCE_STOP_DAEMONS=1 only when you intentionally want exclusive local access.`
    );
  }

  return { stopped, skipped };
}
