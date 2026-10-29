import {
  canonicalTagName,
  tagConceptKey,
  tagSpellingKey,
} from "./tagConcepts";

export interface AuditableTag {
  id: string;
  name: string;
  usageCount: number;
}

export interface TagAuditSuggestion {
  intoTagId: string;
  intoTagName: string;
  fromTagId: string;
  fromTagName: string;
  reason: "synonym" | "same_spelling" | "similar_spelling";
  intoBookmarkCount: number;
  fromBookmarkCount: number;
}

/** Only suggest merges: audit never modifies a bookmark or tag. */
export function suggestTagMerges(
  tags: readonly AuditableTag[],
  limit = 100,
): TagAuditSuggestion[] {
  const byConcept = new Map<string, AuditableTag[]>();
  for (const tag of tags) {
    const key = tagConceptKey(tag.name);
    const list = byConcept.get(key) ?? [];
    list.push(tag);
    byConcept.set(key, list);
  }
  const result: TagAuditSuggestion[] = [];
  const paired = new Set<string>();
  const add = (
    from: AuditableTag,
    into: AuditableTag,
    reason: TagAuditSuggestion["reason"],
  ) => {
    if (from.id === into.id || paired.has(from.id)) return;
    paired.add(from.id);
    result.push({
      fromTagId: from.id,
      fromTagName: from.name,
      intoTagId: into.id,
      intoTagName: into.name,
      reason,
      fromBookmarkCount: from.usageCount,
      intoBookmarkCount: into.usageCount,
    });
  };

  const chooseTarget = (items: AuditableTag[]) =>
    [...items].sort((a, b) => {
      const aIsCanonical =
        tagSpellingKey(a.name) === tagSpellingKey(canonicalTagName(a.name));
      const bIsCanonical =
        tagSpellingKey(b.name) === tagSpellingKey(canonicalTagName(b.name));
      return (
        Number(bIsCanonical) - Number(aIsCanonical) ||
        b.usageCount - a.usageCount ||
        a.name.localeCompare(b.name, "ru")
      );
    })[0];

  for (const group of byConcept.values()) {
    if (group.length < 2) continue;
    const into = chooseTarget(group);
    for (const from of group) {
      if (from.id !== into.id) {
        add(
          from,
          into,
          tagSpellingKey(from.name) === tagSpellingKey(into.name)
            ? "same_spelling"
            : "synonym",
        );
      }
    }
  }

  // Catch near-typos even if they are not in the synonym dictionary.
  // Require a substantial shared spelling and never merge these automatically.
  const unpaired = tags.filter((t) => !paired.has(t.id));
  const byStart = new Map<string, AuditableTag[]>();
  for (const tag of unpaired) {
    const spelling = tagSpellingKey(tag.name);
    if (spelling.length < 7) continue;
    const prefix = spelling.slice(0, 4);
    byStart.set(prefix, [...(byStart.get(prefix) ?? []), tag]);
  }
  for (const group of byStart.values()) {
    if (group.length > 150) continue; // Avoid expensive quadratic scans.
    const sorted = [...group].sort(
      (a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name),
    );
    for (let i = 1; i < sorted.length; i++) {
      const from = sorted[i];
      if (paired.has(from.id)) continue;
      const left = tagSpellingKey(from.name);
      for (let j = 0; j < i; j++) {
        const into = sorted[j];
        const right = tagSpellingKey(into.name);
        if (
          Math.abs(left.length - right.length) > 1 ||
          left.length < 8 ||
          right.length < 8
        ) {
          continue;
        }
        let mismatches = 0;
        // Allow a single typo or one insertion/deletion.
        let x = 0;
        let y = 0;
        while (x < left.length && y < right.length && mismatches <= 1) {
          if (left[x] === right[y]) {
            x++;
            y++;
          } else {
            mismatches++;
            if (left.length > right.length) x++;
            else if (right.length > left.length) y++;
            else {
              x++;
              y++;
            }
          }
        }
        mismatches += Number(x < left.length || y < right.length);
        if (mismatches <= 1) {
          add(from, into, "similar_spelling");
          break;
        }
      }
    }
  }
  const severity = { same_spelling: 0, synonym: 1, similar_spelling: 2 };
  return result
    .sort(
      (a, b) =>
        severity[a.reason] - severity[b.reason] ||
        b.fromBookmarkCount - a.fromBookmarkCount ||
        a.fromTagName.localeCompare(b.fromTagName, "ru"),
    )
    .slice(0, Math.max(0, limit));
}
