/**
 * Stable tag vocabulary for generated bookmark tags.
 *
 * Never rename or merge stored tags here: callers can attach already-existing
 * tags and offer a separate, reversible UI workflow for historical cleanup.
 */

/** Only unambiguous, explicitly enumerated synonyms are canonicalized. */
const ALIAS_GROUPS = [
  ["Разработка ПО", "Разработка программного обеспечения", "Software development"],
  ["Искусственный интеллект", "ИИ", "AI", "Artificial intelligence"],
  ["Машинное обучение", "Machine learning", "ML"],
  ["Нейросети", "Нейронные сети", "Neural networks"],
  ["3D-печать", "3D печать", "Аддитивное производство"],
  ["Генерация изображений", "Генерация картинок", "ИИ-картинки"],
] as const;

function tagKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[\s_\-–—]+/g, "");
}

const canonicalByKey = new Map<string, string>();
for (const group of ALIAS_GROUPS) {
  for (const alias of group) {
    canonicalByKey.set(tagKey(alias), group[0]);
  }
}

function conceptKey(name: string): string {
  return tagKey(canonicalByKey.get(tagKey(name)) ?? name);
}

function cleanTag(value: string): string | null {
  const tag = value
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .trim();

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
    const key = conceptKey(name);
    // Prefer an existing canonical spelling over an existing alias.
    const current = byConcept.get(key);
    const canonical = canonicalByKey.get(tagKey(name));
    if (!current || (canonical && tagKey(name) === tagKey(canonical))) {
      byConcept.set(key, name);
    }
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of generated) {
    const tag = cleanTag(raw);
    if (!tag) continue;
    const key = conceptKey(tag);
    if (seen.has(key)) continue;

    const preferred = byConcept.get(key);
    if (curatedMode && !preferred) continue;

    const resolved = preferred ?? canonicalByKey.get(tagKey(tag)) ?? tag;
    seen.add(key);
    result.push(resolved);
    if (result.length >= 5) break;
  }
  return result;
}
