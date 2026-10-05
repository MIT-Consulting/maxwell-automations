/**
 * Pure roadmap slug resolution — candidate matching, link selection, derivation.
 * No fs, fetch, process, daemon, or dashboard imports.
 */

import {
  extractMarkdownHrefs,
  type RoadmapIndexEntry,
} from "./roadmap-index.js";
import { slugRegexForFeatureId } from "./roadmap-ids.js";

export const ROADMAP_DIR = "docs/roadmap";

export const PER_PERSON_IDEA_REFUSAL =
  "This roadmap uses per-person ids; add the item with your id to the index, then use --feature.";

export const SYMLINK_CANDIDATE_MESSAGE =
  "Roadmap candidate is a symlink and cannot be used";

const MAX_SLUG_LENGTH = 64;
const MAX_SLUG_SEGMENTS = 6;

export type RoadmapChildKind = "dir" | "file" | "symlink";

export type RoadmapChild = {
  name: string;
  kind: RoadmapChildKind;
};

export type SlugResolutionKind = "dir" | "file" | "derived";

export type SlugResolutionSuccess = {
  outcome: "resolved";
  slug: string;
  kind: SlugResolutionKind;
};

export type SlugResolutionBlocked = {
  outcome: "blocked";
  reason: "symlink" | "ambiguous" | "cannot-derive";
  message: string;
};

export type SlugResolutionResult = SlugResolutionSuccess | SlugResolutionBlocked;

export function splitHrefPathFragment(href: string): {
  path: string;
  fragment: string;
} {
  const hashIdx = href.indexOf("#");
  if (hashIdx >= 0) {
    return {
      path: href.slice(0, hashIdx),
      fragment: href.slice(hashIdx),
    };
  }
  return { path: href, fragment: "" };
}

export function deriveSlug(
  featureId: string,
  source: string
): { ok: true; slug: string } | { ok: false; message: string } {
  const segments =
    source
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.slice(0, MAX_SLUG_SEGMENTS) ?? [];
  if (segments.length === 0) {
    return {
      ok: false,
      message: "Cannot derive a feature slug from the source text",
    };
  }

  const prefix = `${featureId}-`;
  let suffix = segments.join("-");
  const maxSuffix = MAX_SLUG_LENGTH - prefix.length;
  if (maxSuffix < 1) {
    return {
      ok: false,
      message: "Cannot derive a feature slug from the source text",
    };
  }
  if (suffix.length > maxSuffix) {
    suffix = suffix.slice(0, maxSuffix).replace(/-+$/g, "");
  }
  if (!suffix || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(suffix)) {
    return {
      ok: false,
      message: "Cannot derive a feature slug from the source text",
    };
  }
  return { ok: true, slug: `${featureId}-${suffix}` };
}

export function matchingSlugCandidates(
  children: readonly RoadmapChild[],
  featureId: string,
  kind: "dir" | "file"
): { candidates: string[]; symlinkBlocked?: true } {
  const slugRe = slugRegexForFeatureId(featureId);
  const prefix = `${featureId}-`;
  const names: string[] = [];
  for (const child of children) {
    if (kind === "dir") {
      if (child.kind === "symlink" && child.name.startsWith(prefix)) {
        return { candidates: [], symlinkBlocked: true };
      }
      if (child.kind !== "dir") continue;
      if (slugRe.test(child.name) && child.name.startsWith(prefix)) {
        names.push(child.name);
      }
      continue;
    }
    if (child.kind === "symlink" && child.name.startsWith(prefix)) {
      return { candidates: [], symlinkBlocked: true };
    }
    if (child.kind !== "file") continue;
    if (!child.name.endsWith(".md")) continue;
    const stem = child.name.slice(0, -3);
    if (slugRe.test(stem) && stem.startsWith(prefix)) {
      names.push(stem);
    }
  }
  return { candidates: names };
}

export function linkPathStem(link: string): string {
  const pathOnly = splitHrefPathFragment(link).path;
  if (!pathOnly.startsWith(`${ROADMAP_DIR}/`)) return "";
  const rest = pathOnly.slice(ROADMAP_DIR.length + 1);
  const first = rest.split("/")[0]!;
  return first.endsWith(".md") ? first.slice(0, -3) : first;
}

export function selectByLink(
  candidates: readonly string[],
  links: readonly string[]
): string | null {
  const selected = new Set<string>();
  for (const link of links) {
    const stem = linkPathStem(link);
    if (stem && candidates.includes(stem)) selected.add(stem);
  }
  if (selected.size === 1) return [...selected][0]!;
  return null;
}

export function resolveSlugFromChildren(
  featureId: string,
  children: readonly RoadmapChild[],
  links: readonly string[],
  entry: Pick<RoadmapIndexEntry, "title" | "description">
): SlugResolutionResult {
  const dirs = matchingSlugCandidates(children, featureId, "dir");
  if (dirs.symlinkBlocked) {
    return {
      outcome: "blocked",
      reason: "symlink",
      message: SYMLINK_CANDIDATE_MESSAGE,
    };
  }
  if (dirs.candidates.length === 1) {
    return {
      outcome: "resolved",
      slug: dirs.candidates[0]!,
      kind: "dir",
    };
  }
  if (dirs.candidates.length > 1) {
    const picked = selectByLink(dirs.candidates, links);
    if (picked) {
      return { outcome: "resolved", slug: picked, kind: "dir" };
    }
    return {
      outcome: "blocked",
      reason: "ambiguous",
      message: `Ambiguous roadmap folders for ${featureId}`,
    };
  }

  const files = matchingSlugCandidates(children, featureId, "file");
  if (files.symlinkBlocked) {
    return {
      outcome: "blocked",
      reason: "symlink",
      message: SYMLINK_CANDIDATE_MESSAGE,
    };
  }
  if (files.candidates.length === 1) {
    return {
      outcome: "resolved",
      slug: files.candidates[0]!,
      kind: "file",
    };
  }
  if (files.candidates.length > 1) {
    const picked = selectByLink(files.candidates, links);
    if (picked) {
      return { outcome: "resolved", slug: picked, kind: "file" };
    }
    return {
      outcome: "blocked",
      reason: "ambiguous",
      message: `Ambiguous roadmap documents for ${featureId}`,
    };
  }

  const source = [entry.title, entry.description].filter(Boolean).join(" ");
  const derived = deriveSlug(featureId, source);
  if (!derived.ok) {
    return {
      outcome: "blocked",
      reason: "cannot-derive",
      message: derived.message,
    };
  }
  return { outcome: "resolved", slug: derived.slug, kind: "derived" };
}

export function hasDirectSlugMatch(
  children: readonly RoadmapChild[],
  featureId: string
): boolean {
  return (
    matchingSlugCandidates(children, featureId, "dir").candidates.length > 0 ||
    matchingSlugCandidates(children, featureId, "file").candidates.length > 0
  );
}

export function entryLinks(entry: Pick<RoadmapIndexEntry, "hrefs" | "raw">): string[] {
  return entry.hrefs.length > 0 ? [...entry.hrefs] : extractMarkdownHrefs(entry.raw);
}

export function isMarkdownPriorArtLink(link: string): boolean {
  const pathOnly = splitHrefPathFragment(link).path;
  return pathOnly.endsWith(".md");
}
