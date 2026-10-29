import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { canonicalizeAITags, matchExistingAITags } from "./tagVocabulary";

describe("persisting reused Cyrillic AI tags", () => {
  it("attaches existing IDs even though SQLite normalizedName differs from Unicode lowercase", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE bookmarkTags (id TEXT PRIMARY KEY, userId TEXT, name TEXT, normalizedName TEXT GENERATED ALWAYS AS (lower(replace(replace(replace(name, ' ', ''), '-', ''), '_', ''))) VIRTUAL, UNIQUE(userId,name)); CREATE TABLE tagsOnBookmarks (bookmarkId TEXT, tagId TEXT, PRIMARY KEY(bookmarkId,tagId));`,
      );
      const names = [
        "Хэллоуин",
        "Севастополь",
        "Рестораны И Бары",
        "Мероприятия",
      ];
      names.forEach((name, i) =>
        db
          .prepare("INSERT INTO bookmarkTags(id,userId,name) VALUES (?,?,?)")
          .run(String(i), "u", name),
      );
      expect(
        db
          .prepare("SELECT id FROM bookmarkTags WHERE normalizedName=?")
          .all("хэллоуин"),
      ).toEqual([]);
      const existing = db
        .prepare("SELECT id,name FROM bookmarkTags WHERE userId=?")
        .all("u") as { id: string; name: string }[];
      const resolved = canonicalizeAITags(
        names,
        existing.map((tag) => tag.name),
      );
      const { matchedTagIds, notFoundTagNames } = matchExistingAITags(
        resolved,
        existing,
      );
      expect(notFoundTagNames).toEqual([]);
      expect(matchedTagIds).toHaveLength(4);
      matchedTagIds.forEach((tagId) =>
        db
          .prepare("INSERT INTO tagsOnBookmarks VALUES (?,?)")
          .run("bookmark", tagId),
      );
      expect(
        db.prepare("SELECT count(*) AS n FROM tagsOnBookmarks").get(),
      ).toEqual({ n: 4 });
    } finally {
      db.close();
    }
  });
  it("preserves exact user spelling and only proposes genuinely absent names", () => {
    expect(
      matchExistingAITags(
        ["Долги", "долги", "Новая тема"],
        [{ id: "debt", name: "Долги" }],
      ),
    ).toEqual({ matchedTagIds: ["debt"], notFoundTagNames: ["Новая тема"] });
    expect(
      matchExistingAITags(
        ["долги"],
        [
          { id: "upper", name: "Долги" },
          { id: "lower", name: "долги" },
        ],
      ).matchedTagIds,
    ).toEqual(["lower"]);
  });
});
