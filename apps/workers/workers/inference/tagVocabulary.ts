/**
 * Stable tag vocabulary for generated bookmark tags.
 *
 * Never rename or merge stored tags here: callers can attach already-existing
 * tags and offer a separate, reversible UI workflow for historical cleanup.
 */

import {
  canonicalTagName,
  tagConceptKey,
  tagSpellingKey,
} from "@karakeep/shared/utils/tagConcepts";

function cleanTag(value: string): string | null {
  const tag = value.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim();

  if (
    tag.length < 2 ||
    tag.length > 70 ||
    /[\r\n<>\[\]{}]/.test(tag) ||
    /^https?:\/\//i.test(tag)
  ) {
    return null;
  }
  return tag;
}

/**
 * Resolve each AI suggestion to one vocabulary entry.
 *
 * - In curated mode only explicitly selected tag names may be used.
 * - In open mode existing user tags are preferred, including safe synonyms.
 * - Otherwise a canonical spelling is chosen for known synonym groups.
 * - No more than 5 distinct concepts are attached per inference run.
 */
export function canonicalizeAITags(
  generated: string[],
  existing: readonly string[],
  curated?: readonly string[],
): string[] {
  const curatedMode = Boolean(curated?.length);
  const allowed = curatedMode ? curated! : existing;
  const byConcept = new Map<string, string>();
  for (const name of allowed) {
    const key = tagConceptKey(name);
    // Prefer an existing canonical spelling over an existing alias.
    const current = byConcept.get(key);
    const canonical = canonicalTagName(name);
    if (!current || (canonical && tagSpellingKey(name) === tagSpellingKey(canonical))) {
      byConcept.set(key, name);
    }
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of generated) {
    const tag = cleanTag(raw);
    if (!tag) continue;
    const key = tagConceptKey(tag);
    if (seen.has(key)) continue;

    const preferred = byConcept.get(key);
    if (curatedMode && !preferred) continue;

    const resolved = preferred ?? canonicalTagName(tag);
    seen.add(key);
    result.push(resolved);
    if (result.length >= 5) break;
  }
  return result;
}
