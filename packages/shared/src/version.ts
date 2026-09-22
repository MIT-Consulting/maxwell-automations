/**
 * Product version identities for b68. Pure: no filesystem, no network.
 * Callers supply read/fetch so the dashboard bundle never pulls Node APIs.
 */

export const FACTORY_VERSION = "0.0.0-dev";
export const DEFAULT_UPDATE_REPO = "MIT-Consulting/maxwell-automations";

export type VersionChannel = "factory" | "public" | "unknown";

export type VersionIdentity = {
  version: string;
  channel: VersionChannel;
  commit?: string | null;
  dirty?: boolean;
  describe?: string | null;
};

export type UpdateState =
  | "restart-required"
  | "available"
  | "ahead/dev"
  | "disabled"
  | "offline"
  | "unknown"
  | "current";

export type ReleaseInfo = {
  version: string;
  tag: string;
  url: string | null;
  notes: string | null;
};

export type UpdateSnapshot = {
  running: VersionIdentity;
  checkout: VersionIdentity | null;
  available: ReleaseInfo | null;
  publicAvailable: ReleaseInfo | null;
  updateState: UpdateState;
  lastCheckedAt: string | null;
  releaseUrl: string | null;
};

export type UpdateSettingsResolved = {
  check: boolean;
  repo: string;
  publicRepo: string | null;
  cacheHours: number;
  token?: string;
  host: string | null;
};

export type UpdateCacheFile = {
  repo: string;
  etag: string | null;
  checkedAt: string | null;
  release: ReleaseInfo | null;
  publicRepo: string | null;
  publicEtag: string | null;
  publicRelease: ReleaseInfo | null;
  error: "offline" | "not-found" | "non-semver" | null;
};

export const FACTORY_IDENTITY: VersionIdentity = {
  version: FACTORY_VERSION,
  channel: "factory",
  commit: null,
  dirty: false,
  describe: null,
};

type FetchResponse = {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json: () => Promise<unknown>;
};

export type UpdateFetch = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<FetchResponse>;

export function parseSemver(input: string): [number, number, number] | null {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(input.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `left` is older. Null when either side is not semver. */
export function compareSemver(left: string, right: string): -1 | 0 | 1 | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export function isFactoryIdentity(id: VersionIdentity | null | undefined): boolean {
  if (!id) return false;
  return id.channel === "factory" || id.version === FACTORY_VERSION;
}

export function parseIdentityJson(text: string): VersionIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || record.version.trim() === "") {
    return null;
  }
  const channel: VersionChannel =
    record.channel === "factory" || record.channel === "public"
      ? record.channel
      : "unknown";
  return {
    version: record.version.trim(),
    channel,
    commit: typeof record.commit === "string" ? record.commit : null,
    dirty: record.dirty === true,
    describe: typeof record.describe === "string" ? record.describe : null,
  };
}

export function resolveUpdateState(input: {
  running: VersionIdentity | null;
  checkout: VersionIdentity | null;
  available: string | null;
  /** False when the approved tag exists but is not semver, or the repo 404s. */
  availableUnresolved: boolean;
  checkEnabled: boolean;
  /** True only on a network failure with no cached release. */
  offline: boolean;
}): UpdateState {
  if (!input.running && !input.checkout) return "unknown";

  if (
    input.running &&
    input.checkout &&
    input.running.version !== input.checkout.version
  ) {
    return "restart-required";
  }

  const effective = input.running ?? input.checkout;
  if (!effective) return "unknown";
  if (isFactoryIdentity(effective)) return "ahead/dev";
  if (!input.checkEnabled) return "disabled";
  if (input.offline) return "offline";
  if (input.availableUnresolved) return "unknown";
  if (!input.available || !input.running) return "current";

  const cmp = compareSemver(input.running.version, input.available);
  if (cmp === null) return "unknown";
  if (cmp < 0) return "available";
  return "current";
}

export function formatRunningLabel(id: VersionIdentity): string {
  if (isFactoryIdentity(id)) {
    return id.dirty ? `${FACTORY_VERSION} dirty` : FACTORY_VERSION;
  }
  return id.dirty ? `${id.version} dirty` : id.version;
}

export function formatUpdateSummary(input: {
  updateState?: UpdateState;
  running?: VersionIdentity | null;
  checkout?: VersionIdentity | null;
  available?: { version: string } | null;
}): string {
  const state = input.updateState ?? "unknown";
  const running = input.running ? formatRunningLabel(input.running) : "unknown";
  const checkout = input.checkout?.version ?? "unknown";
  const approved = input.available?.version ?? "unknown";
  switch (state) {
    case "restart-required":
      return `restart-required — running ${running}, checkout ${checkout}`;
    case "available":
      return `available — running ${running}, approved ${approved}`;
    case "ahead/dev":
      return `ahead/dev — ${running}`;
    case "disabled":
      return "disabled — update check off";
    case "offline":
      return "offline — approved release check failed";
    case "unknown":
      return "unknown — could not resolve a version";
    case "current":
      return `current — ${running}`;
    default:
      return "unknown — could not resolve a version";
  }
}

export function updateChipLabel(input: {
  updateState?: UpdateState;
  available?: { version: string } | null;
} | null): string | null {
  if (!input) return null;
  if (input.updateState === "available" && input.available?.version) {
    return `Update ${input.available.version}`;
  }
  if (input.updateState === "restart-required") return "Restart required";
  return null;
}

export function updateStateDetail(state: UpdateState): string {
  switch (state) {
    case "restart-required":
      return "Checkout differs from the running build. Restart picks up the local build. It does not install a release.";
    case "available":
      return "A newer approved release exists. Upgrading is a manual pin move.";
    case "ahead/dev":
      return "Factory checkout. Public tags are not an upgrade target.";
    case "disabled":
      return "Update check is turned off.";
    case "offline":
      return "The approved-release check could not reach the network.";
    case "unknown":
      return "Could not resolve a version.";
    case "current":
      return "Running the approved release.";
    default:
      return "Could not resolve a version.";
  }
}

export function releasesLatestUrl(repo: string, host: string | null): string | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const slash = repo.indexOf("/");
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const apiHost = (host ?? "https://api.github.com").replace(/\/$/, "");
  if (apiHost === "https://api.github.com" || apiHost === "api.github.com") {
    return `https://api.github.com/repos/${owner}/${name}/releases/latest`;
  }
  if (apiHost.includes("/api/")) {
    return `${apiHost}/repos/${owner}/${name}/releases/latest`;
  }
  return `${apiHost}/api/v3/repos/${owner}/${name}/releases/latest`;
}

export function excerptReleaseNotes(body: unknown, max = 240): string | null {
  if (typeof body !== "string") return null;
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

export function releaseFromGitHubPayload(payload: unknown): ReleaseInfo | "non-semver" | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const tag = typeof record.tag_name === "string" ? record.tag_name.trim() : "";
  if (!tag) return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!parseSemver(version)) return "non-semver";
  return {
    version,
    tag,
    url: typeof record.html_url === "string" ? record.html_url : null,
    notes: excerptReleaseNotes(record.body),
  };
}

export function resolveUpdateSettings(input: {
  file?: {
    check?: boolean;
    repo?: string;
    publicRepo?: string;
    cacheHours?: number;
    token?: string;
    host?: string;
  };
  env?: {
    check?: boolean;
    repo?: string;
    publicRepo?: string;
    cacheHours?: number;
    token?: string;
    host?: string;
  };
}): UpdateSettingsResolved {
  const file = input.file;
  const env = input.env ?? {};
  const repo = env.repo ?? file?.repo ?? DEFAULT_UPDATE_REPO;
  const configuredPublic = env.publicRepo ?? file?.publicRepo;
  const cacheRaw = env.cacheHours ?? file?.cacheHours ?? 24;
  return {
    check: env.check ?? file?.check ?? true,
    repo,
    publicRepo:
      configuredPublic && configuredPublic !== repo ? configuredPublic : null,
    cacheHours: Math.max(1, cacheRaw),
    token: env.token ?? file?.token,
    host: env.host ?? file?.host ?? null,
  };
}

export function emptyUpdateCache(repo: string): UpdateCacheFile {
  return {
    repo,
    etag: null,
    checkedAt: null,
    release: null,
    publicRepo: null,
    publicEtag: null,
    publicRelease: null,
    error: null,
  };
}

export function resolveInstallIdentity(args: {
  modulePath: string;
  dirname: (path: string) => string;
  join: (...parts: string[]) => string;
  parseRoot: (path: string) => string;
  readText: (path: string) => string | null;
}): {
  running: VersionIdentity;
  checkout: VersionIdentity | null;
  checkoutRoot: string | null;
} {
  const start = args.dirname(args.modulePath);
  const embedText = args.readText(args.join(start, "version-embed.json"));
  const running = (embedText && parseIdentityJson(embedText)) || {
    ...FACTORY_IDENTITY,
  };

  let current = start;
  const fsRoot = args.parseRoot(current);
  for (let depth = 0; depth < 8; depth += 1) {
    const text = args.readText(args.join(current, "version.json"));
    if (text) {
      const checkout = parseIdentityJson(text);
      if (checkout) {
        return { running, checkout, checkoutRoot: current };
      }
    }
    if (current === fsRoot) break;
    const parent = args.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { running, checkout: null, checkoutRoot: null };
}

type ReleaseFetchResult =
  | { kind: "not-modified" }
  | { kind: "release"; release: ReleaseInfo; etag: string | null }
  | { kind: "non-semver" }
  | { kind: "missing" }
  | { kind: "offline" };

async function fetchLatest(
  fetchImpl: UpdateFetch,
  url: string,
  etag: string | null,
  token: string | undefined
): Promise<ReleaseFetchResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "max-update-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (etag) headers["If-None-Match"] = etag;
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: FetchResponse;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    return { kind: "offline" };
  }
  if (response.status === 304) return { kind: "not-modified" };
  if (response.status === 404) return { kind: "missing" };
  if (!response.ok) return { kind: "offline" };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "offline" };
  }
  const release = releaseFromGitHubPayload(payload);
  if (release === "non-semver") return { kind: "non-semver" };
  if (!release) return { kind: "offline" };
  return { kind: "release", release, etag: response.headers.get("etag") };
}

export class UpdateChecker {
  private cache: UpdateCacheFile;

  constructor(
    private readonly deps: {
      settings: UpdateSettingsResolved;
      running: VersionIdentity;
      checkout: VersionIdentity | null;
      readCache: () => string | null;
      writeCache: (text: string) => void;
      fetch: UpdateFetch;
      now?: () => number;
      log?: (message: string) => void;
    }
  ) {
    this.cache = this.load();
  }

  snapshot(): UpdateSnapshot {
    return this.snapshotFrom(this.cache);
  }

  /** True when a background poll should run (not factory-quiet, check enabled). */
  shouldPoll(): boolean {
    return this.deps.settings.check && !this.isFactoryQuiet();
  }

  pollIntervalMs(): number {
    return Math.max(1, this.deps.settings.cacheHours) * 60 * 60 * 1000;
  }

  /** Fetch only when the cache is missing or older than cacheHours. */
  maybeRefresh(): void {
    if (!this.shouldPoll()) return;
    if (this.isFresh(this.deps.now?.() ?? Date.now())) return;
    void this.checkNow();
  }

  async checkNow(): Promise<UpdateSnapshot> {
    if (!this.deps.settings.check || this.isFactoryQuiet()) {
      return this.snapshot();
    }

    const nowIso = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const next: UpdateCacheFile = {
      ...this.cache,
      repo: this.deps.settings.repo,
      publicRepo: this.deps.settings.publicRepo,
    };

    const approvedUrl = releasesLatestUrl(
      this.deps.settings.repo,
      this.deps.settings.host
    );
    if (!approvedUrl) {
      next.error = "non-semver";
      next.release = null;
      next.checkedAt = nowIso;
      this.persist(next);
      return this.snapshot();
    }

    const approved = await fetchLatest(
      this.deps.fetch,
      approvedUrl,
      this.cache.repo === this.deps.settings.repo ? this.cache.etag : null,
      this.deps.settings.token
    );

    if (approved.kind === "not-modified") {
      next.checkedAt = nowIso;
      next.error = null;
    } else if (approved.kind === "release") {
      next.release = approved.release;
      next.etag = approved.etag;
      next.error = null;
      next.checkedAt = nowIso;
    } else if (approved.kind === "missing") {
      next.release = null;
      next.etag = null;
      next.error = "not-found";
      next.checkedAt = nowIso;
    } else if (approved.kind === "non-semver") {
      next.release = null;
      next.etag = null;
      next.error = "non-semver";
      next.checkedAt = nowIso;
    } else if (next.release) {
      // Keep the last good release. Do not claim offline when a cache exists.
      next.error = null;
      this.deps.log?.("approved release check failed; using cache");
    } else {
      next.error = "offline";
      this.deps.log?.("approved release check failed");
    }

    if (this.deps.settings.publicRepo) {
      const publicUrl = releasesLatestUrl(
        this.deps.settings.publicRepo,
        this.deps.settings.host
      );
      if (publicUrl) {
        const pub = await fetchLatest(
          this.deps.fetch,
          publicUrl,
          this.cache.publicRepo === this.deps.settings.publicRepo
            ? this.cache.publicEtag
            : null,
          this.deps.settings.token
        );
        if (pub.kind === "release") {
          next.publicRelease = pub.release;
          next.publicEtag = pub.etag;
        } else if (pub.kind === "not-modified") {
          next.publicRelease = this.cache.publicRelease;
        } else if (pub.kind === "missing" || pub.kind === "non-semver") {
          next.publicRelease = null;
          next.publicEtag = null;
        }
      }
    } else {
      next.publicRelease = null;
      next.publicEtag = null;
    }

    this.persist(next);
    return this.snapshot();
  }

  private isFactoryQuiet(): boolean {
    if (!isFactoryIdentity(this.deps.running)) return false;
    if (!this.deps.checkout) return true;
    return (
      isFactoryIdentity(this.deps.checkout) &&
      this.deps.checkout.version === this.deps.running.version
    );
  }

  private isFresh(now: number): boolean {
    if (this.cache.repo !== this.deps.settings.repo) return false;
    if (!this.cache.checkedAt) return false;
    const then = Date.parse(this.cache.checkedAt);
    if (Number.isNaN(then)) return false;
    return now - then < this.pollIntervalMs();
  }

  private load(): UpdateCacheFile {
    const text = this.deps.readCache();
    if (!text) return emptyUpdateCache(this.deps.settings.repo);
    try {
      const parsed = JSON.parse(text) as Partial<UpdateCacheFile>;
      if (parsed.repo !== this.deps.settings.repo) {
        return emptyUpdateCache(this.deps.settings.repo);
      }
      return {
        ...emptyUpdateCache(this.deps.settings.repo),
        ...parsed,
        repo: this.deps.settings.repo,
      };
    } catch {
      return emptyUpdateCache(this.deps.settings.repo);
    }
  }

  private persist(next: UpdateCacheFile): void {
    this.cache = next;
    try {
      this.deps.writeCache(JSON.stringify(next));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(`update cache write failed: ${message}`);
    }
  }

  private snapshotFrom(cache: UpdateCacheFile): UpdateSnapshot {
    const offline = cache.error === "offline" && !cache.release;
    const availableUnresolved =
      cache.error === "non-semver" || cache.error === "not-found";
    const updateState = resolveUpdateState({
      running: this.deps.running,
      checkout: this.deps.checkout,
      available: cache.release?.version ?? null,
      availableUnresolved,
      checkEnabled: this.deps.settings.check,
      offline,
    });
    // Factory checkouts keep a cache but are not told to move to a public tag.
    const quiet = updateState === "ahead/dev";
    return {
      running: this.deps.running,
      checkout: this.deps.checkout,
      available: quiet ? null : cache.release,
      publicAvailable:
        quiet || !this.deps.settings.publicRepo ? null : cache.publicRelease,
      updateState,
      lastCheckedAt: cache.checkedAt,
      releaseUrl: quiet ? null : (cache.release?.url ?? null),
    };
  }
}
