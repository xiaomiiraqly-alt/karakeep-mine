/** Conservative tag synonyms shared by AI generation and human review. */

const ALIAS_GROUPS = [
  ["Разработка ПО", "Разработка программного обеспечения", "Software development"],
  ["Искусственный интеллект", "ИИ", "AI", "Artificial intelligence"],
  ["Машинное обучение", "Machine learning", "ML"],
  ["Нейросети", "Нейронные сети", "Neural networks"],
  ["3D-печать", "3D печать", "Аддитивное производство"],
  ["Генерация изображений", "Генерация картинок", "ИИ-картинки"],
] as const;

export function tagSpellingKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[\s_\-–—]+/g, "");
}

const canonicalByKey = new Map<string, string>();
for (const group of ALIAS_GROUPS) {
  for (const alias of group) {
    canonicalByKey.set(tagSpellingKey(alias), group[0]);
  }
}

export function canonicalTagName(name: string): string {
  return canonicalByKey.get(tagSpellingKey(name)) ?? name;
}

export function tagConceptKey(name: string): string {
  return tagSpellingKey(canonicalTagName(name));
}
