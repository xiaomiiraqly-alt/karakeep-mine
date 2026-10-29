import { describe, expect, it } from "vitest";

import {
  buildInstagramTitlePrompt,
  instagramImportTitle,
  cleanInstagramTitle,
  isGenericInstagramTitle,
  updateInstagramReaderHeading,
} from "./instagramTitle";

describe("Instagram AI titles", () => {
  it("recognizes generic imported titles, but leaves meaningful titles alone", () => {
    expect(isGenericInstagramTitle("Instagram — @githubradar")).toBe(true);
    expect(isGenericInstagramTitle("Instagram post")).toBe(true);
    expect(
      isGenericInstagramTitle("https://www.instagram.com/p/De7J5uajAKm/"),
    ).toBe(true);
    expect(isGenericInstagramTitle("Лучшие сервисы для вайбкодинга")).toBe(
      false,
    );
    expect(isGenericInstagramTitle("Как настроить ChatGPT для работы")).toBe(
      false,
    );
  });

  it("generates a prompt from existing caption, summary, and visual evidence", () => {
    const prompt = buildInstagramTitlePrompt({
      language: "Russian",
      caption: "Подборка сервисов",
      summary: "12 инструментов для разработки приложений",
      visualContext: "Visual 1: screenshot of a programming IDE",
    });
    expect(prompt).toContain("Language: Russian");
    expect(prompt).toContain("Подборка сервисов");
    expect(prompt).toContain("12 инструментов");
    expect(prompt).toContain("programming IDE");
    expect(prompt).toContain("Do not invent details");
  });

  it("cleans the model response and rejects uninformative or unsafe titles", () => {
    expect(
      cleanInstagramTitle("Заголовок: «12 инструментов для вайбкодинга»"),
    ).toBe("12 инструментов для вайбкодинга");
    expect(cleanInstagramTitle("Instagram — @githubradar")).toBeNull();
    expect(cleanInstagramTitle("https://example.com/evil")).toBeNull();
    expect(cleanInstagramTitle("<script>alert(1)</script>")).toBeNull();
    expect(cleanInstagramTitle("Без названия")).toBeNull();
    expect(cleanInstagramTitle("")).toBeNull();
  });

  it("replaces only the archived Reader heading, not the post caption or media", () => {
    const html =
      '<article><h1>Instagram — @creator</h1><figure><img src="karakeep-asset:123"></figure><p>Actual caption</p></article>';
    const updated = updateInstagramReaderHeading(
      html,
      "Сервисы для дизайна и разработки",
    );
    expect(updated).toContain("<h1>Сервисы для дизайна и разработки</h1>");
    expect(updated).toContain('src="karakeep-asset:123"');
    expect(updated).toContain("<p>Actual caption</p>");
    expect(updateInstagramReaderHeading(null, "Any valid title")).toBeNull();
    expect(
      updateInstagramReaderHeading(
        "<article><p>no heading</p></article>",
        "New title",
      ),
    ).toBe("<article><p>no heading</p></article>");
  });
  it("preserves a descriptive title on reimport but replaces generic placeholders", () => {
    expect(
      instagramImportTitle("Хэллоуин в Севастополе", "Instagram — @tut.sev"),
    ).toBe("Хэллоуин в Севастополе");
    expect(instagramImportTitle("Instagram — @old", "Instagram — @new")).toBe(
      "Instagram — @new",
    );
    expect(instagramImportTitle(null, "Instagram post")).toBe("Instagram post");
  });
});
