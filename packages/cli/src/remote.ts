import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { Document, parseDocument } from "yaml";

const LCA_HOME = join(homedir(), ".cursor-local-automations");
const CONFIG_PATH = join(LCA_HOME, "automations.yaml");

export const LOOPBACK_HOST = "127.0.0.1";
export const ALL_INTERFACES_HOST = "0.0.0.0";

export type NetworkConfig = {
  host: string;
  allowedIps: string[];
  /** Shared app-auth token, when provisioned. Undefined means app-auth is off. */
  controlToken?: string;
};

/** Absolute path to the global config the daemon reads its `settings` from. */
export function configPath(): string {
  return CONFIG_PATH;
}

/** Remote access is "on" whenever the server binds beyond loopback. */
export function isRemoteEnabled(cfg: NetworkConfig): boolean {
  return cfg.host !== LOOPBACK_HOST && cfg.host !== "::1";
}

/**
 * Validate an IPv4 (incl. Tailscale CGNAT) or loose IPv6 literal. Keeps obvious
 * typos out of the allowlist, where a wrong entry silently locks a device out.
 */
export function isValidIp(ip: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((octet) => Number(octet) <= 255);
  }
  return ip.includes(":") && /^[0-9a-fA-F:]+$/.test(ip);
}

/** A network-interface entry, narrowed to the fields discovery needs. */
type InterfaceEntry = { family: string | number; address: string; internal: boolean };

/** Whether an IPv4 literal falls in Tailscale's CGNAT range (100.64.0.0/10). */
function isTailscaleCgnat(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Pure classifier: from a flat list of interface entries, return every candidate
 * Tailscale-reachable address (deduped, in discovery order). Candidates are
 * non-internal IPv4 in the CGNAT range (100.64.0.0/10) and non-internal IPv6 in
 * Tailscale's ULA range (`fd7a:115c:a1e0::/48`, i.e. addresses starting `fd7a:`).
 */
export function classifyTailscaleCandidates(entries: InterfaceEntry[]): string[] {
  const out: string[] = [];
  for (const ni of entries) {
    if (ni.internal) continue;
    if (ni.family === "IPv4" && isTailscaleCgnat(ni.address)) {
      out.push(ni.address);
    } else if (ni.family === "IPv6" && ni.address.toLowerCase().startsWith("fd7a:")) {
      out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

/** Flatten the live interface table into the entries the classifier consumes. */
function liveInterfaceEntries(): InterfaceEntry[] {
  const entries: InterfaceEntry[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      entries.push({ family: ni.family, address: ni.address, internal: ni.internal });
    }
  }
  return entries;
}

/**
 * Best-effort discovery of every Tailscale-reachable address on this machine
 * (IPv4 CGNAT + IPv6 ULA) so `lca remote detect` can list candidate URLs.
 */
export function tailscaleAddresses(): string[] {
  return classifyTailscaleCandidates(liveInterfaceEntries());
}

/**
 * Best-effort discovery of this machine's Tailscale IPv4 (CGNAT range
 * 100.64.0.0/10) so `lca remote` can print the URL to open on another device.
 * Returns the first IPv4 candidate; see `tailscaleAddresses` for the full set.
 */
export function tailscaleIp(): string | undefined {
  return tailscaleAddresses().find((addr) => addr.includes("."));
}

function loadDocument(): Document {
  const text = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  return parseDocument(text);
}

/** Read the current host/allowedIps/controlToken from the global YAML (defaults when unset). */
export function readNetworkConfig(): NetworkConfig {
  const js = (loadDocument().toJS() ?? {}) as {
    settings?: { host?: unknown; allowedIps?: unknown; controlToken?: unknown };
  };
  const settings = js.settings ?? {};
  return {
    host: typeof settings.host === "string" ? settings.host : LOOPBACK_HOST,
    allowedIps: Array.isArray(settings.allowedIps)
      ? settings.allowedIps.map(String)
      : [],
    controlToken:
      typeof settings.controlToken === "string" && settings.controlToken.length > 0
        ? settings.controlToken
        : undefined,
  };
}

/** The persisted control token, if app-auth has been provisioned. */
export function readControlToken(): string | undefined {
  return readNetworkConfig().controlToken;
}

function dedupe(ips: string[]): string[] {
  return [...new Set(ips)];
}

/**
 * Read-modify-write the `settings.host`/`settings.allowedIps` keys in place,
 * preserving the rest of the document (other settings, automations, comments).
 */
function mutate(fn: (current: NetworkConfig) => NetworkConfig): NetworkConfig {
  const doc = loadDocument();
  if (doc.contents == null) {
    doc.contents = doc.createNode({});
  }

  const current = readNetworkConfig();
  const next = fn(current);

  doc.setIn(["settings", "host"], next.host);
  doc.setIn(["settings", "allowedIps"], doc.createNode(next.allowedIps));
  // Only write the token when present so unrelated host/allowlist edits never
  // clobber an existing token (callers that don't touch it return it unchanged).
  if (next.controlToken) {
    doc.setIn(["settings", "controlToken"], next.controlToken);
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, doc.toString(), "utf8");
  return next;
}

/**
 * Return the existing control token, or generate + persist one if none exists.
 * The token is a URL-safe random string so it is safe in the `/ws?token=` query.
 */
export function ensureControlToken(): { token: string; created: boolean } {
  const existing = readControlToken();
  if (existing) {
    return { token: existing, created: false };
  }
  const token = randomBytes(32).toString("base64url");
  mutate((cur) => ({ ...cur, controlToken: token }));
  return { token, created: true };
}

/**
 * Bind beyond loopback to the given target `host` (a specific local address, or
 * `0.0.0.0` for all interfaces) and add any given device IPs to the allowlist.
 * The caller resolves the bind target; this stays a dumb writer. An existing
 * control token is preserved by `mutate`.
 */
export function enableRemote(host: string, ips: string[]): NetworkConfig {
  return mutate((cur) => ({
    host,
    allowedIps: dedupe([...cur.allowedIps, ...ips]),
  }));
}

/** Return to loopback-only, leaving the allowlist intact for next time. */
export function disableRemote(): NetworkConfig {
  return mutate((cur) => ({ ...cur, host: LOOPBACK_HOST }));
}

export function addAllowedIps(ips: string[]): NetworkConfig {
  return mutate((cur) => ({
    ...cur,
    allowedIps: dedupe([...cur.allowedIps, ...ips]),
  }));
}

export function removeAllowedIps(ips: string[]): NetworkConfig {
  const drop = new Set(ips);
  return mutate((cur) => ({
    ...cur,
    allowedIps: cur.allowedIps.filter((ip) => !drop.has(ip)),
  }));
}

/** Remove every device from the allowlist (host and control token unchanged). */
export function clearAllowedIps(): NetworkConfig {
  return mutate((cur) => ({ ...cur, allowedIps: [] }));
}

/**
 * Resolve `lca remote deny` arguments to IP addresses. Accepts 1-based list indices
 * (from `lca remote allowed`) or literal IPs. Use `all` or `--all` as the sole
 * argument to clear the entire allowlist.
 */
export function resolveDenyTargets(
  allowedIps: readonly string[],
  args: string[]
): { ips: string[]; clearAll: boolean } {
  if (args.length === 0) {
    return { ips: [], clearAll: false };
  }
  const sole = args.length === 1 && (args[0] === "all" || args[0] === "--all");
  if (sole) {
    return { ips: [...allowedIps], clearAll: true };
  }
  if (args.some((a) => a === "all" || a === "--all")) {
    throw new Error("Use `lca remote deny --all` to clear the entire allowlist.");
  }

  const ips: string[] = [];
  for (const arg of args) {
    if (/^\d+$/.test(arg)) {
      const n = Number(arg);
      if (n < 1 || n > allowedIps.length) {
        throw new Error(
          `Invalid allowlist index ${n} (use 1–${allowedIps.length}; run \`lca remote allowed\`)`
        );
      }
      ips.push(allowedIps[n - 1]!);
    } else {
      ips.push(arg);
    }
  }
  return { ips: dedupe(ips), clearAll: false };
}
