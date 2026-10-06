/**
 * What an open dashboard should do when a status poll returns a daemon identity.
 * The first key is the one this page loaded with. A later change means the
 * build on disk has moved, so the page reloads to pick up the new bundle.
 *
 * The key is version, channel, and test id. A test build keeps the release
 * semver, so version alone would leave the open tab on the old bundle.
 * Commit and dirty stay out of the key, so a factory rebuild does not reload.
 */
export function dashboardBootKey(status: {
  version: string;
  running?: { channel?: string | null; testId?: string | null } | null;
}): string {
  return `${status.version}\u0000${status.running?.channel ?? ""}\u0000${status.running?.testId ?? ""}`;
}

export function dashboardReloadAction(
  bootedKey: string | null,
  nextKey: string
): "record" | "reload" | "stay" {
  const version = nextKey.split("\u0000")[0] ?? "";
  if (version.trim() === "") return "stay";
  if (bootedKey === null) return "record";
  return nextKey !== bootedKey ? "reload" : "stay";
}
