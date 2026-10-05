/**
 * Pure roadmap id shape, template, slug, classification, and marker rules.
 * No fs, fetch, process, daemon, or dashboard imports.
 */

export const ROADMAP_ID_CANDIDATE_SOURCE =
  "^[a-z]{1,8}(?:-[a-z]{2,3})?\\d{1,6}$";

/** Bounded lowercase token with optional owner segment and trailing digits. */
export const ROADMAP_ID_CANDIDATE_RE = new RegExp(ROADMAP_ID_CANDIDATE_SOURCE);

export const DEFAULT_FEATURE_FORMAT_TEMPLATE = "b<n>, b-<owner><n>";
export const DEFAULT_EPIC_FORMAT_TEMPLATE = "e<n>, e-<owner><n>";

export const ROADMAP_FORMAT_DOC = "docs/roadmap-format.md";

export type IdFormatSource = "default" | "declared";

export type IdClassification = "feature" | "epic" | "unknown";

export type CompiledIdFormat = {
  source: IdFormatSource;
  /** Original template text (comma-separated alternatives). */
  template: string;
  /** Whole-id match (anchored). */
  anchored: RegExp;
  /** Token embedded in line parsers (unanchored). */
  unanchored: RegExp;
};

export type ResolvedIdFormats = {
  feature: CompiledIdFormat;
  epic: CompiledIdFormat;
};

export type IdFormatErrorCode =
  | "empty_alternative"
  | "duplicate_declaration"
  | "invalid_syntax"
  | "missing_trailing_n"
  | "multiple_n"
  | "raw_regex";

export class IdFormatError extends Error {
  constructor(
    public readonly code: IdFormatErrorCode,
    message: string,
    public readonly declarationKind: "feature" | "epic" = "feature"
  ) {
    super(message);
    this.name = "IdFormatError";
  }
}

export type NextMarkerMatch =
  | { kind: "plain"; id: string; raw: string }
  | { kind: "per-person"; id: string; raw: string };

/** Plain legacy counter: <!-- next: b42 --> */
export const NEXT_MARKER_RE = /<!--\s*next:\s*(b\d+)\s*-->/g;

/** Per-person counter: <!-- next: b-xy58 --> */
export const PER_PERSON_NEXT_MARKER_RE =
  /<!--\s*next:\s*([a-z]{1,8}-[a-z]{2,3}\d{1,6})\s*-->/g;

/** Standalone index comments only — ignore prose/backtick mentions of the tag. */
const ID_FORMAT_DECL_RE = /^[\t ]*<!--\s*id-format:\s*(.+?)\s*-->[\t ]*$/gim;
const EPIC_FORMAT_DECL_RE = /^[\t ]*<!--\s*epic-format:\s*(.+?)\s*-->[\t ]*$/gim;

const RAW_REGEX_CHARS = /[.*+?^${}()|[\]\\]/;

export function isRoadmapIdCandidate(id: string): boolean {
  return ROADMAP_ID_CANDIDATE_RE.test(id);
}

function resetGlobalRe(re: RegExp): void {
  re.lastIndex = 0;
}

function compileDefaultFeatureFormat(): CompiledIdFormat {
  return compileIdTemplate(DEFAULT_FEATURE_FORMAT_TEMPLATE, "default");
}

function compileDefaultEpicFormat(): CompiledIdFormat {
  return compileIdTemplate(DEFAULT_EPIC_FORMAT_TEMPLATE, "default");
}

/** Compile comma-separated template alternatives into anchored/unanchored regexes. */
export function compileIdTemplate(
  template: string,
  source: IdFormatSource = "declared",
  declarationKind: "feature" | "epic" = "feature"
): CompiledIdFormat {
  const alternatives = template.split(",").map((part) => part.trim());
  if (alternatives.some((alt) => alt.length === 0)) {
    throw formatError(
      "empty_alternative",
      `Id format template has an empty alternative. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }

  const parts: string[] = [];
  for (const alt of alternatives) {
    parts.push(compileOneAlternative(alt, declarationKind));
  }

  const combined = parts.length === 1 ? parts[0]! : `(?:${parts.join("|")})`;
  return {
    source,
    template,
    anchored: new RegExp(`^${combined}$`),
    unanchored: new RegExp(combined),
  };
}

function formatError(
  code: IdFormatErrorCode,
  message: string,
  declarationKind: "feature" | "epic"
): IdFormatError {
  return new IdFormatError(code, message, declarationKind);
}

function compileOneAlternative(
  alt: string,
  declarationKind: "feature" | "epic"
): string {
  if (RAW_REGEX_CHARS.test(alt.replace(/<owner>/g, "").replace(/<n>/g, ""))) {
    throw formatError(
      "raw_regex",
      `Id format template must use literal letters and placeholders, not regex syntax. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }

  const nCount = (alt.match(/<n>/g) ?? []).length;
  if (nCount === 0) {
    throw formatError(
      "missing_trailing_n",
      `Id format alternative "${alt}" must include exactly one trailing <n>. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }
  if (nCount > 1) {
    throw formatError(
      "multiple_n",
      `Id format alternative "${alt}" must include exactly one <n> placeholder. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }

  if (!alt.endsWith("<n>")) {
    throw formatError(
      "missing_trailing_n",
      `Id format alternative "${alt}" must end with <n>. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }

  const body = alt.slice(0, -"<n>".length);
  const withoutOwner = body.replace(/<owner>/g, "");
  if (withoutOwner.includes("<")) {
    throw formatError(
      "invalid_syntax",
      `Id format alternative "${alt}" contains an unknown placeholder. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }
  if (!/^[a-z-]*(?:<owner>)?[a-z-]*$/.test(body)) {
    throw formatError(
      "invalid_syntax",
      `Id format alternative "${alt}" may only use lowercase letters, hyphens, and <owner>. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }

  const ownerCount = (body.match(/<owner>/g) ?? []).length;
  if (ownerCount > 1) {
    throw formatError(
      "invalid_syntax",
      `Id format alternative "${alt}" may include <owner> at most once. See ${ROADMAP_FORMAT_DOC}.`,
      declarationKind
    );
  }

  const regexBody = body.replace(/<owner>/g, "[a-z]{2,3}");
  return `${regexBody}\\d+`;
}

function collectDeclarationMatches(
  markdown: string,
  re: RegExp
): string[] {
  resetGlobalRe(re);
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    matches.push(m[1]!.trim());
  }
  return matches;
}

export function parseIdFormatDeclarations(markdown: string): ResolvedIdFormats {
  const featureDecls = collectDeclarationMatches(markdown, ID_FORMAT_DECL_RE);
  const epicDecls = collectDeclarationMatches(markdown, EPIC_FORMAT_DECL_RE);

  if (featureDecls.length > 1) {
    throw new IdFormatError(
      "duplicate_declaration",
      `Duplicate <!-- id-format: … --> declarations. See ${ROADMAP_FORMAT_DOC}.`,
      "feature"
    );
  }
  if (epicDecls.length > 1) {
    throw new IdFormatError(
      "duplicate_declaration",
      `Duplicate <!-- epic-format: … --> declarations. See ${ROADMAP_FORMAT_DOC}.`,
      "epic"
    );
  }

  const feature =
    featureDecls.length === 1
      ? compileIdTemplate(featureDecls[0]!, "declared", "feature")
      : compileDefaultFeatureFormat();
  const epic =
    epicDecls.length === 1
      ? compileIdTemplate(epicDecls[0]!, "declared", "epic")
      : compileDefaultEpicFormat();

  return { feature, epic };
}

export function defaultIdFormats(): ResolvedIdFormats {
  return {
    feature: compileDefaultFeatureFormat(),
    epic: compileDefaultEpicFormat(),
  };
}

export function classifyId(
  id: string,
  formats: ResolvedIdFormats
): IdClassification {
  if (formats.feature.anchored.test(id)) return "feature";
  if (formats.epic.anchored.test(id)) return "epic";
  return "unknown";
}

export function isEpicId(id: string, formats: ResolvedIdFormats): boolean {
  return formats.epic.anchored.test(id);
}

/** Slug must begin with `${featureId}-` followed by lowercase segments. */
export function slugRegexForFeatureId(featureId: string): RegExp {
  const escaped = featureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}-[a-z0-9]+(-[a-z0-9]+)*$`);
}

export function isValidFeatureSlug(featureId: string, slug: string): boolean {
  return slugRegexForFeatureId(featureId).test(slug);
}

/** Capture a roadmap id prefix when a slug begins with `<id>-`. */
export const SLUG_FEATURE_PREFIX_RE = new RegExp(
  `^(${ROADMAP_ID_CANDIDATE_SOURCE.slice(1, -1)})-`
);

export function slugFeaturePrefix(slug: string): string | null {
  const match = SLUG_FEATURE_PREFIX_RE.exec(slug);
  return match?.[1] ?? null;
}

/** Collect all next-id markers without silently picking one winner. */
export function parseNextMarkers(markdown: string): NextMarkerMatch[] {
  const results: NextMarkerMatch[] = [];
  const seen = new Set<string>();

  resetGlobalRe(NEXT_MARKER_RE);
  let m: RegExpExecArray | null;
  while ((m = NEXT_MARKER_RE.exec(markdown)) !== null) {
    const raw = m[0]!;
    const id = m[1]!;
    const key = `plain:${id}:${raw}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ kind: "plain", id, raw });
    }
  }

  resetGlobalRe(PER_PERSON_NEXT_MARKER_RE);
  while ((m = PER_PERSON_NEXT_MARKER_RE.exec(markdown)) !== null) {
    const raw = m[0]!;
    const id = m[1]!;
    const key = `per-person:${id}:${raw}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ kind: "per-person", id, raw });
    }
  }

  return results;
}

export function hasPerPersonNextMarker(markdown: string): boolean {
  return parseNextMarkers(markdown).some((entry) => entry.kind === "per-person");
}
