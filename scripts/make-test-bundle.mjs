/**
 * Build a git bundle a public clone can install with `max update --from`.
 *
 * The repo must be a clean throwaway clone of an export snapshot, using the
 * public git identity, with a release tag as an ancestor of HEAD. The script
 * stamps version.json as a test build, commits that stamp when it changed,
 * and writes one bundle of `<tag>..HEAD`. Nothing is pushed.
 *
 * It refuses a repo whose `origin` is on GitHub. That is the publishing clone
 * under `.export-public/`, and a test-stamp commit there could be released.
 *
 *   node scripts/make-test-bundle.mjs --repo <throwaway-clone> --out <file> --id <id>
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_GIT_IDENTITY } from "./export-public.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/;
const TEST_ID = /^[A-Za-z0-9._-]{1,40}$/;
const TIP_REF = "refs/heads/max-test-tip";

/**
 * @param {string} base
 * @param {string} testId
 */
export function buildTestStamp(base, testId) {
  if (!SEMVER.test(base)) {
    throw new Error(`base must be semver (got ${base})`);
  }
  if (!TEST_ID.test(testId)) {
    throw new Error(
      `test id must be 1-40 letters, numbers, dots, or dashes (got ${testId})`
    );
  }
  return { version: base, channel: "test", base, testId };
}

/**
 * @param {string} repo
 * @param {string[]} args
 */
function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * @param {{ repo: string, out: string, id?: string }} opts
 */
export function createTestBundle(opts) {
  const root = resolve(opts.repo);
  let email = "";
  try {
    email = git(root, ["config", "--get", "user.email"]);
  } catch {
    email = "";
  }
  if (email !== PUBLIC_GIT_IDENTITY.email) {
    throw new Error(
      `Refusing to bundle ${root}: git user.email is ${email || "unset"}. ` +
        `The export clone must use ${PUBLIC_GIT_IDENTITY.email}.`
    );
  }
  let origin = "";
  try {
    origin = git(root, ["remote", "get-url", "origin"]);
  } catch {
    origin = "";
  }
  if (/github\.com/i.test(origin)) {
    throw new Error(
      `Refusing to bundle ${root}: origin is ${origin}. ` +
        "Cut test bundles in a throwaway clone of the export clone, not the clone you publish from."
    );
  }
  if (git(root, ["status", "--porcelain"]).length > 0) {
    throw new Error("Working tree is dirty. Commit the test changes before bundling.");
  }

  let tag;
  try {
    tag = git(root, ["describe", "--tags", "--abbrev=0"]);
  } catch {
    throw new Error("No release tag is an ancestor of HEAD.");
  }
  const base = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!SEMVER.test(base)) {
    throw new Error(`Ancestor tag ${tag} is not vX.Y.Z.`);
  }
  git(root, ["merge-base", "--is-ancestor", tag, "HEAD"]);

  const testId = opts.id ?? randomBytes(4).toString("hex");
  const stamp = buildTestStamp(base, testId);
  const versionPath = join(root, "version.json");
  const next = `${JSON.stringify(stamp, null, 2)}\n`;
  const current = existsSync(versionPath) ? readFileSync(versionPath, "utf8") : "";
  if (current !== next) {
    writeFileSync(versionPath, next);
    git(root, ["add", "version.json"]);
    git(root, ["-c", "commit.gpgsign=false", "commit", "-m", `test: ${testId} on ${tag}`]);
  }
  if (git(root, ["rev-parse", tag]) === git(root, ["rev-parse", "HEAD"])) {
    throw new Error(`${tag} is HEAD. Commit the test changes before bundling.`);
  }

  const dest = resolve(opts.out);
  git(root, ["update-ref", TIP_REF, "HEAD"]);
  try {
    git(root, ["bundle", "create", dest, `${tag}..${TIP_REF}`]);
  } finally {
    git(root, ["update-ref", "-d", TIP_REF]);
  }
  return { base, testId, tag, out: dest };
}

function parseArgs(argv) {
  let repo = "";
  let out = "";
  let id;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") repo = argv[++i] ?? "";
    else if (arg === "--out") out = argv[++i] ?? "";
    else if (arg === "--id") id = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/make-test-bundle.mjs --repo <throwaway-clone> --out <file.bundle> [--id <id>]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!repo || !out) {
    throw new Error(
      "Usage: node scripts/make-test-bundle.mjs --repo <throwaway-clone> --out <file.bundle> [--id <id>]"
    );
  }
  if (id !== undefined && !TEST_ID.test(id)) {
    throw new Error(`test id must be 1-40 letters, numbers, dots, or dashes (got ${id})`);
  }
  return { repo, out, id };
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]).replace(/\\/g, "/").toLowerCase() ===
    fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = createTestBundle(opts);
    console.log(`test bundle ${result.testId} on ${result.tag} → ${result.out}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}
