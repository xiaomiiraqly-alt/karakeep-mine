import { describe, expect, it } from "vitest";

import { suggestTagMerges } from "./tagAudit";

describe("read-only duplicate tag audit", () => {
  it("proposes known synonyms and prefers a canonical existing destination", () => {
    const suggestions = suggestTagMerges([
      { id: "a", name: "Разработка программного обеспечения", usageCount: 20 },
      { id: "b", name: "Разработка ПО", usageCount: 2 },
      { id: "c", name: "ИИ", usageCount: 13 },
      { id: "d", name: "Искусственный интеллект", usageCount: 5 },
    ]);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromTagId: "a",
          intoTagId: "b",
          reason: "synonym",
          fromBookmarkCount: 20,
        }),
        expect.objectContaining({
          fromTagId: "c",
          intoTagId: "d",
          reason: "synonym",
        }),
      ]),
    );
  });

  it("detects visually equivalent spellings and case without altering data", () => {
    const existing = [
      { id: "1", name: "3D-печать", usageCount: 5 },
      { id: "2", name: "3d печать", usageCount: 3 },
    ];
    expect(suggestTagMerges(existing)[0]).toMatchObject({
      reason: "same_spelling",
      intoTagId: "1",
      fromTagId: "2",
    });
    expect(existing[1].name).toBe("3d печать");
  });

  it("does not merge semantically related but distinct topics", () => {
    expect(
      suggestTagMerges([
        { id: "1", name: "Машинное обучение", usageCount: 5 },
        { id: "2", name: "Искусственный интеллект", usageCount: 11 },
        { id: "3", name: "Программирование", usageCount: 2 },
        { id: "4", name: "Разработка ПО", usageCount: 9 },
      ]),
    ).toHaveLength(0);
  });

  it("offers likely typos for review and respects the limit", () => {
    const list = [
      { id: "1", name: "JavaScript", usageCount: 17 },
      { id: "2", name: "Javasript", usageCount: 2 },
      { id: "3", name: "Kubernetes", usageCount: 5 },
    ];
    expect(suggestTagMerges(list)).toEqual([
      expect.objectContaining({
        fromTagId: "2",
        intoTagId: "1",
        reason: "similar_spelling",
      }),
    ]);
    expect(suggestTagMerges(list, 0)).toEqual([]);
  });
});
