/**
 * Product version identities for b68. Pure: no filesystem, no network.
 * Callers supply read/fetch so the dashboard bundle never pulls Node APIs.
 */

import { parseNodeFloorFromPackageManifest, satisfiesNodeFloor } from "./node-floor.js";
import {
  boundUpgradeActionLines,
  extractUpgradeActionsFromReleaseBody,
  upgradeActionsForPersistence,
} from "./upgrade-actions.js";

export const FACTORY_VERSION = "0.0.0-dev";
export const DEFAULT_UPDATE_REPO = "MIT-Consulting/maxwell-automations";

export type VersionChannel = "factory" | "public" | "unknown" | "test";

export type VersionIdentity = {
  version: string;
  channel: VersionChannel;
  commit?: string | null;
  dirty?: boolean;
  describe?: string | null;
  /** Release this test build was cut from. Set when `channel` is `test`. */
  base?: string | null;
  /** Short id for a test build. Set when `channel` is `test`. */
  testId?: string | null;
};

export type UpdateState =
  | "restart-required"
  | "available"
  | "ahead/dev"
  | "test-build"
  | "disabled"
  | "offline"
  | "unknown"
  | "current";

export type ReleaseInfo = {
  version: string;
  tag: string;
  url: string | null;
  notes: string | null;
  /** Target `engines.node` from the tagged manifest; null when unknown. */
  nodeFloor: string | null;
  /** Bounded action lines; null unknown, `[]` explicit none. */
  upgradeActions: string[] | null;
};

export type UpdateSnapshot = {
  running: VersionIdentity;
  checkout: VersionIdentity | null;
  available: ReleaseInfo | null;
  publicAvailable: ReleaseInfo | null;
  updateState: UpdateState;
  lastCheckedAt: string | null;
  releaseUrl: string | null;
  /** Node version used for floor evaluation (CLI or daemon runtime). */
  runningNode: string | null;
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
  text: () => Promise<string>;
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

const SEMVER = /^\d+\.\d+\.\d+$/;
const TEST_ID = /^[A-Za-z0-9._-]{1,40}$/;

function testFields(
  version: string,
  record: Record<string, unknown>
): { base: string; testId: string } | null {
  const base = typeof record.base === "string" ? record.base.trim() : "";
  const testId = typeof record.testId === "string" ? record.testId.trim() : "";
  if (!SEMVER.test(version) || base !== version || !TEST_ID.test(testId)) return null;
  return { base, testId };
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
  const version = record.version.trim();
  let channel: VersionChannel =
    record.channel === "factory" || record.channel === "public" || record.channel === "test"
      ? record.channel
      : "unknown";
  const test = channel === "test" ? testFields(version, record) : null;
  if (channel === "test" && !test) channel = "unknown";
  return {
    version,
    channel,
    commit: typeof record.commit === "string" ? record.commit : null,
    dirty: record.dirty === true,
    describe: typeof record.describe === "string" ? record.describe : null,
    base: test?.base ?? null,
    testId: test?.testId ?? null,
  };
}

/** About / CLI line for a test build. Null when the identity is not a test. */
export function formatTestBuildLine(id: VersionIdentity): string | null {
  if (id.channel !== "test" || !id.testId) return null;
  const base = id.base ?? id.version;
  return `Test build ${id.testId} on ${base}. Return to the release with max update --stable.`;
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
  // max update --apply refuses a test checkout, so a newer release is not actionable here.
  if (effective.channel === "test") return "test-build";
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
  const version =
    id.channel === "test" && id.testId ? `${id.version} test ${id.testId}` : id.version;
  return id.dirty ? `${version} dirty` : version;
}

export type UpdateDisplayInput = {
  updateState?: UpdateState;
  running?: VersionIdentity | null;
  checkout?: VersionIdentity | null;
  available?: ReleaseInfo | null;
  runningNode?: string | null;
};

function formatNodeMinimum(requirement: string): string {
  const trimmed = requirement.trim();
  return trimmed.startsWith(">=") ? trimmed.slice(2).trim() : trimmed;
}

function evaluateUnmetNodeFloor(input: UpdateDisplayInput): string | null {
  if (input.updateState !== "available" || !input.available?.nodeFloor) return null;
  const runningNode = input.runningNode;
  if (!runningNode) return null;
  const check = satisfiesNodeFloor(runningNode, input.available.nodeFloor);
  if (check.ok || check.minimum === null) return null;
  return formatNodeMinimum(check.requirement);
}

export function formatUpdateSummary(input: UpdateDisplayInput): string {
  const state = input.updateState ?? "unknown";
  const running = input.running ? formatRunningLabel(input.running) : "unknown";
  const checkout = input.checkout?.version ?? "unknown";
  const approved = input.available?.version ?? "unknown";
  const nodeNeed = evaluateUnmetNodeFloor(input);
  switch (state) {
    case "restart-required":
      return `restart-required — running ${running}, checkout ${checkout}`;
    case "available":
      if (nodeNeed) {
        return `available — running ${running}, approved ${approved} · needs Node ${nodeNeed}`;
      }
      return `available — running ${running}, approved ${approved}`;
    case "ahead/dev":
      return `ahead/dev — ${running}`;
    case "test-build":
      return `test-build — ${running}; return with max update --stable`;
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

export function updateChipLabel(input: UpdateDisplayInput | null): string | null {
  if (!input) return null;
  if (input.updateState === "available" && input.available?.version) {
    const nodeNeed = evaluateUnmetNodeFloor(input);
    if (nodeNeed) {
      return `Update ${input.available.version} · needs Node ${nodeNeed}`;
    }
    return `Update ${input.available.version}`;
  }
  if (input.updateState === "restart-required") return "Restart required";
  return null;
}

export function updateStateDetail(
  state: UpdateState,
  input?: Pick<UpdateDisplayInput, "available" | "runningNode" | "updateState"> | null
): string {
  const nodeNeed =
    input && input.updateState === state ? evaluateUnmetNodeFloor(input) : null;
  switch (state) {
    case "restart-required":
      return "Checkout differs from the running build. Restart picks up the local build. It does not install a release.";
    case "available":
      if (nodeNeed) {
        return (
          `A newer approved release exists but requires Node ${nodeNeed}. ` +
          "Install a compatible Node version before upgrading."
        );
      }
      return "A newer approved release exists. Upgrading is a manual pin move.";
    case "ahead/dev":
      return "Factory checkout. Public tags are not an upgrade target.";
    case "test-build":
      return "Test build installed. Release updates wait until you return to the release.";
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

function parseRepoSlug(repo: string): { owner: string; name: string } | null {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  const slash = repo.indexOf("/");
  return { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}

function apiHostBase(host: string | null): string {
  return (host ?? "https://api.github.com").replace(/\/$/, "");
}

export function releasesLatestUrl(repo: string, host: string | null): string | null {
  const slug = parseRepoSlug(repo);
  if (!slug) return null;
  const apiHost = apiHostBase(host);
  if (apiHost === "https://api.github.com" || apiHost === "api.github.com") {
    return `https://api.github.com/repos/${slug.owner}/${slug.name}/releases/latest`;
  }
  if (apiHost.includes("/api/")) {
    return `${apiHost}/repos/${slug.owner}/${slug.name}/releases/latest`;
  }
  return `${apiHost}/api/v3/repos/${slug.owner}/${slug.name}/releases/latest`;
}

export function releaseByTagUrl(
  repo: string,
  tag: string,
  host: string | null
): string | null {
  const slug = parseRepoSlug(repo);
  if (!slug) return null;
  const encodedTag = encodeURIComponent(tag);
  const apiHost = apiHostBase(host);
  if (apiHost === "https://api.github.com" || apiHost === "api.github.com") {
    return `https://api.github.com/repos/${slug.owner}/${slug.name}/releases/tags/${encodedTag}`;
  }
  if (apiHost.includes("/api/")) {
    return `${apiHost}/repos/${slug.owner}/${slug.name}/releases/tags/${encodedTag}`;
  }
  return `${apiHost}/api/v3/repos/${slug.owner}/${slug.name}/releases/tags/${encodedTag}`;
}

export function packageContentsUrl(
  repo: string,
  tag: string,
  host: string | null
): string | null {
  const slug = parseRepoSlug(repo);
  if (!slug) return null;
  const encodedTag = encodeURIComponent(tag);
  const apiHost = apiHostBase(host);
  if (apiHost === "https://api.github.com" || apiHost === "api.github.com") {
    return `https://api.github.com/repos/${slug.owner}/${slug.name}/contents/package.json?ref=${encodedTag}`;
  }
  if (apiHost.includes("/api/")) {
    return `${apiHost}/repos/${slug.owner}/${slug.name}/contents/package.json?ref=${encodedTag}`;
  }
  return `${apiHost}/api/v3/repos/${slug.owner}/${slug.name}/contents/package.json?ref=${encodedTag}`;
}

function normalizeReleaseInfo(release: Partial<ReleaseInfo> | null | undefined): ReleaseInfo | null {
  if (!release || typeof release.version !== "string" || release.version.trim() === "") {
    return null;
  }
  const version = release.version.trim();
  return {
    version,
    tag: typeof release.tag === "string" && release.tag.trim() ? release.tag.trim() : `v${version}`,
    url: typeof release.url === "string" ? release.url : null,
    notes: typeof release.notes === "string" ? release.notes : null,
    nodeFloor: typeof release.nodeFloor === "string" ? release.nodeFloor : null,
    upgradeActions: Array.isArray(release.upgradeActions)
      ? [...boundUpgradeActionLines(
          release.upgradeActions.filter((line): line is string => typeof line === "string")
        )]
      : null,
  };
}

function releaseNeedsEnrichment(release: ReleaseInfo | null): release is ReleaseInfo {
  if (!release) return false;
  return release.nodeFloor === null || release.upgradeActions === null;
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
  const body = typeof record.body === "string" ? record.body : "";
  const upgradeActions = upgradeActionsForPersistence(
    extractUpgradeActionsFromReleaseBody(body)
  );
  return {
    version,
    tag,
    url: typeof record.html_url === "string" ? record.html_url : null,
    notes: excerptReleaseNotes(body),
    nodeFloor: null,
    upgradeActions,
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

async function fetchRawText(
  fetchImpl: UpdateFetch,
  url: string,
  token: string | undefined
): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "max-update-check",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: FetchResponse;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    return null;
  }
  if (response.status === 404 || !response.ok) return null;
  try {
    return await response.text();
  } catch {
    return null;
  }
}

async function enrichReleaseMetadata(
  fetchImpl: UpdateFetch,
  repo: string,
  host: string | null,
  release: ReleaseInfo,
  token: string | undefined,
  log?: (message: string) => void
): Promise<ReleaseInfo> {
  let next = release;
  if (next.nodeFloor === null) {
    const contentsUrl = packageContentsUrl(repo, next.tag, host);
    if (contentsUrl) {
      const manifestText = await fetchRawText(fetchImpl, contentsUrl, token);
      if (manifestText) {
        const floor = parseNodeFloorFromPackageManifest(manifestText);
        if (floor) {
          next = { ...next, nodeFloor: floor };
        } else {
          log?.(`target manifest at ${next.tag} has no engines.node`);
        }
      } else {
        log?.(`could not fetch package.json for ${next.tag}`);
      }
    }
  }

  if (next.upgradeActions === null) {
    const tagUrl = releaseByTagUrl(repo, next.tag, host);
    if (tagUrl) {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "max-update-check",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      try {
        const response = await fetchImpl(tagUrl, { headers });
        if (response.ok) {
          const payload = await response.json();
          if (payload && typeof payload === "object") {
            const body = (payload as Record<string, unknown>).body;
            if (typeof body === "string") {
              next = {
                ...next,
                upgradeActions: upgradeActionsForPersistence(
                  extractUpgradeActionsFromReleaseBody(body)
                ),
              };
            }
          }
        }
      } catch {
        log?.(`could not fetch release body for ${next.tag}`);
      }
    }
  }

  return next;
}

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
      runningNode: string;
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
      if (releaseNeedsEnrichment(next.release)) {
        next.release = await enrichReleaseMetadata(
          this.deps.fetch,
          this.deps.settings.repo,
          this.deps.settings.host,
          next.release!,
          this.deps.settings.token,
          this.deps.log
        );
      }
    } else if (approved.kind === "release") {
      next.release = await enrichReleaseMetadata(
        this.deps.fetch,
        this.deps.settings.repo,
        this.deps.settings.host,
        approved.release,
        this.deps.settings.token,
        this.deps.log
      );
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
          next.publicRelease = await enrichReleaseMetadata(
            this.deps.fetch,
            this.deps.settings.publicRepo,
            this.deps.settings.host,
            pub.release,
            this.deps.settings.token,
            this.deps.log
          );
          next.publicEtag = pub.etag;
        } else if (pub.kind === "not-modified") {
          next.publicRelease = this.cache.publicRelease;
          if (releaseNeedsEnrichment(next.publicRelease)) {
            next.publicRelease = await enrichReleaseMetadata(
              this.deps.fetch,
              this.deps.settings.publicRepo!,
              this.deps.settings.host,
              next.publicRelease!,
              this.deps.settings.token,
              this.deps.log
            );
          }
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
        release: normalizeReleaseInfo(parsed.release),
        publicRelease: normalizeReleaseInfo(parsed.publicRelease),
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
    const available = quiet ? null : cache.release;
    return {
      running: this.deps.running,
      checkout: this.deps.checkout,
      available,
      publicAvailable:
        quiet || !this.deps.settings.publicRepo ? null : cache.publicRelease,
      updateState,
      lastCheckedAt: cache.checkedAt,
      releaseUrl: quiet ? null : (cache.release?.url ?? null),
      runningNode: this.deps.runningNode,
    };
  }
}

/** Operator-facing lines for persisted Upgrade actions (null → unavailable). */
export function formatPersistedUpgradeActionsLines(
  actions: string[] | null | undefined
): readonly string[] {
  if (actions === null || actions === undefined) return ["unavailable"];
  if (actions.length === 0) return ["none"];
  return actions;
}
