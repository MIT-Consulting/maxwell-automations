/**
 * Deterministic private → public export (b61 D1).
 *
 *   node scripts/export-public.mjs --dry-run
 *   node scripts/export-public.mjs --out <dir>
 *
 * Writes two trees under --out (default: <repo>/.export-public/):
 *   <out>/maxwell-automations
 *   <out>/maxwell-automations-skills
 *
 * Allowlist is exclusion-by-default. Anything not listed never leaves.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");

export const CODE_REPO = "maxwell-automations";
export const SKILLS_REPO = "maxwell-automations-skills";

function joinLit(parts) {
  return parts.join("");
}

/** Explicit include prefixes (repo-relative, forward slashes). */
export const INCLUDE_PREFIXES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "LICENSE",
  "NOTICE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "README.md",
  ".gitignore",
  "gitleaks.toml",
  ".github/workflows/ci.yml",
  "config/",
  "packages/",
  "tests/",
  "scripts/",
  "skills/",
  ".cursor/skills/lca-dev/",
  ".cursor/rules/",
  "docs/brand.md",
  "docs/configuration.md",
  "docs/implement-fully-protocol.md",
  "docs/troubleshooting.md",
  "docs/roadmap-format.md",
  "docs/forking.md",
];

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".export-public",
]);
const SKIP_SUFFIXES = [".tsbuildinfo"];
const SKIP_BASENAMES = new Set([".DS_Store"]);

/** Personal-info / leak patterns scanned on the exported tree. */
export const LEAK_PATTERNS = [
  { id: "windows-user-path", re: /C:[/\\]Users[/\\](?!dev[/\\])/i },
  { id: "unix-user-path", re: /\/Users\/(?!dev\/)[A-Za-z0-9._-]+\//i },
  { id: "operator-windows-user", re: new RegExp(joinLit(["Miller", "Dev"]), "i") },
  {
    id: "personal-code-root",
    re: new RegExp(String.raw`C:[/\\]Code[/\\]` + joinLit(["Personal"]), "i"),
  },
  {
    // Any Tailscale CGNAT address (100.64.0.0/10) except the documentation
    // placeholders used in docs/tests: 100.64.0.x, 100.64.1.x, 100.127.255.1.
    id: "operator-tailnet",
    re: /\b100\.(?!64\.[01]\.\d{1,3}\b)(?!127\.255\.1\b)(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
  },
  { id: "lab-hostname", re: new RegExp(joinLit(["lair", "-", "node"]), "i") },
  { id: "vault-dirname", re: new RegExp(joinLit(["second", "-", "brain"]), "i") },
  {
    id: "transcript-uuid-link",
    re: /\[[^\]]+\]\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)/i,
  },
];

/**
 * @param {string} rel forward-slash repo-relative path
 */
export function isIncluded(rel) {
  const n = rel.replace(/\\/g, "/");
  return INCLUDE_PREFIXES.some((p) => {
    if (p.endsWith("/")) return n === p.slice(0, -1) || n.startsWith(p);
    return n === p;
  });
}

/**
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {string[]} repo-relative forward-slash paths
 */
export function listIncludedFiles(dir = REPO_ROOT, prefix = "") {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_BASENAMES.has(name)) continue;
    if (SKIP_DIR_NAMES.has(name)) continue;
    if (SKIP_SUFFIXES.some((s) => name.endsWith(s))) continue;
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!isIncluded(rel) && !INCLUDE_PREFIXES.some((p) => p.startsWith(`${rel}/`))) {
        continue;
      }
      out.push(...listIncludedFiles(full, rel));
    } else if (st.isFile() && isIncluded(rel)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * @param {string} rel
 * @param {string} text
 */
export function transformContent(rel, text) {
  let out = text;
  const n = rel.replace(/\\/g, "/");
  if (n === "package.json") {
    const pkg = JSON.parse(out);
    pkg.name = CODE_REPO;
    pkg.license = "Apache-2.0";
    out = `${JSON.stringify(pkg, null, 2)}\n`;
  }
  if (n === "README.md") {
    out = out.replace(
      /^# cursor-local-automations\s*$/m,
      `# Max`
    );
  }
  return out;
}

/**
 * @param {string} rel
 * @param {string} text
 * @returns {{ id: string, line: number, excerpt: string }[]}
 */
export function scanLeaks(rel, text) {
  /** @type {{ id: string, line: number, excerpt: string }[]} */
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { id, re } of LEAK_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) {
        hits.push({
          id,
          line: i + 1,
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }
  return hits;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {string} text
 */
function writeText(to, text) {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text, "utf8");
}

/**
 * @param {string} from
 * @param {string} to
 */
function copyBinary(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

function isProbablyText(rel) {
  return /\.(md|txt|ts|tsx|js|mjs|cjs|json|yml|yaml|toml|css|html|svg|gitignore)$/i.test(
    rel
  ) || /^(LICENSE|NOTICE|README)$/i.test(rel.split("/").pop() ?? "");
}

/** Wipe a dest tree but keep an existing `.git` so re-exports can push. */
function emptyDirKeepGit(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    return;
  }
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * @param {{ outDir: string, dryRun: boolean }} opts
 */
export function exportPublic(opts) {
  const outDir = resolve(opts.outDir);
  const codeDest = join(outDir, CODE_REPO);
  const skillsDest = join(outDir, SKILLS_REPO);
  const files = listIncludedFiles();
  /** @type {{ id: string, file: string, line: number, excerpt: string }[]} */
  const leaks = [];
  /** @type {string[]} */
  const written = [];

  if (!opts.dryRun) {
    mkdirSync(outDir, { recursive: true });
    emptyDirKeepGit(codeDest);
    emptyDirKeepGit(skillsDest);
  }

  for (const rel of files) {
    const src = join(REPO_ROOT, ...rel.split("/"));
    const dest = join(codeDest, ...rel.split("/"));
    if (isProbablyText(rel)) {
      const raw = readFileSync(src, "utf8");
      const text = transformContent(rel, raw);
      for (const hit of scanLeaks(rel, text)) {
        leaks.push({ file: rel, ...hit });
      }
      if (!opts.dryRun) {
        writeText(dest, text);
        written.push(rel);
      }
    } else {
      if (!opts.dryRun) {
        copyBinary(src, dest);
        written.push(rel);
      }
    }
  }

  const overlayGitleaks = join(
    REPO_ROOT,
    "scripts",
    "export-overlays",
    "gitleaks.yml"
  );
  if (existsSync(overlayGitleaks)) {
    const text = readFileSync(overlayGitleaks, "utf8");
    const rel = ".github/workflows/gitleaks.yml";
    for (const hit of scanLeaks(rel, text)) leaks.push({ file: rel, ...hit });
    if (!opts.dryRun) {
      writeText(join(codeDest, ".github", "workflows", "gitleaks.yml"), text);
      written.push(rel);
    }
  }

  const skillSources = ["implement-fully", "plan-implement-fully"];
  for (const name of skillSources) {
    const srcDir = join(REPO_ROOT, "skills", name);
    if (!existsSync(srcDir)) continue;
    const walk = listIncludedFiles(srcDir, `skills/${name}`);
    for (const rel of walk) {
      const src = join(REPO_ROOT, ...rel.split("/"));
      const destRel = rel.replace(/^skills\//, "");
      const text = readFileSync(src, "utf8");
      for (const hit of scanLeaks(destRel, text)) {
        leaks.push({ file: `${SKILLS_REPO}/${destRel}`, ...hit });
      }
      if (!opts.dryRun) {
        writeText(join(skillsDest, ...destRel.split("/")), text);
      }
    }
  }

  const skillsReadme = join(
    REPO_ROOT,
    "scripts",
    "export-overlays",
    "skills-README.md"
  );
  if (existsSync(skillsReadme)) {
    const text = readFileSync(skillsReadme, "utf8");
    for (const hit of scanLeaks("README.md", text)) {
      leaks.push({ file: `${SKILLS_REPO}/README.md`, ...hit });
    }
    if (!opts.dryRun) {
      writeText(join(skillsDest, "README.md"), text);
      copyBinary(join(REPO_ROOT, "LICENSE"), join(skillsDest, "LICENSE"));
      copyBinary(join(REPO_ROOT, "NOTICE"), join(skillsDest, "NOTICE"));
    }
  }

  return {
    outDir,
    codeDest,
    skillsDest,
    fileCount: files.length,
    written,
    leaks,
    dryRun: opts.dryRun,
  };
}

function parseArgs(argv) {
  let dryRun = false;
  let outDir = join(REPO_ROOT, ".export-public");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a directory");
      outDir = resolve(next);
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/export-public.mjs [--dry-run] [--out <dir>]\n" +
          "  Allowlist export to maxwell-automations + maxwell-automations-skills.\n" +
          "  --dry-run  scan without writing\n" +
          "  --out DIR  destination (default: .export-public/)"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { dryRun, outDir };
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]).replace(/\\/g, "/").toLowerCase() ===
    fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase();

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const result = exportPublic(opts);
  console.log(
    `${opts.dryRun ? "dry-run" : "export"}: ${result.fileCount} allowlisted file(s) → ${relative(REPO_ROOT, result.outDir) || result.outDir}`
  );
  if (result.leaks.length) {
    console.error(`LEAKS: ${result.leaks.length} hit(s)`);
    for (const hit of result.leaks.slice(0, 50)) {
      console.error(`  [${hit.id}] ${hit.file}:${hit.line}  ${hit.excerpt}`);
    }
    if (result.leaks.length > 50) {
      console.error(`  … ${result.leaks.length - 50} more`);
    }
    process.exit(1);
  }
  console.log("leak-scan: clean");
}
