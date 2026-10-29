import { describe, expect, it } from "vitest";

import {
  applySemanticTagMatches,
  buildSemanticReusePrompt,
  selectExistingTagCandidates,
} from "./semanticTagReuse";

describe("prefer pre-existing tags before creating new tags", () => {
  it("prioritizes previously relevant existing tag names and bounds inference input", () => {
    const names = [
      "Дизайн",
      "Разработка ПО",
      "Искусственный интеллект",
      "Машинное обучение",
      "Маркетинг",
    ];
    expect(
      selectExistingTagCandidates(
        ["Создание программ", "Дизайн"],
        names,
        ["Разработка ПО"],
        3,
      ),
    ).toEqual(["Разработка ПО", "Дизайн", "Искусственный интеллект"]);
  });

  it("uses the exact existing tag when the model confirms a true synonym", () => {
    expect(
      applySemanticTagMatches(
        ["Создание программного обеспечения", "Автоматизация"],
        ["Разработка ПО", "Автоматизация"],
        [
          {
            suggested: "Создание программного обеспечения",
            existing: "Разработка ПО",
          },
        ],
      ),
    ).toEqual(["Разработка ПО", "Автоматизация"]);
  });

  it("deduplicates multiple newly suggested variants that map to one existing tag", () => {
    expect(
      applySemanticTagMatches(
        ["Разработка приложений", "Создание приложений"],
        ["Разработка ПО"],
        [
          { suggested: "Разработка приложений", existing: "Разработка ПО" },
          { suggested: "Создание приложений", existing: "Разработка ПО" },
        ],
      ),
    ).toEqual(["Разработка ПО"]);
  });

  it("rejects nonexistent labels, unrelated entries, and injected model suggestions", () => {
    expect(
      applySemanticTagMatches(
        ["Новая технология", "Docker"],
        ["Разработка ПО", "Контейнеризация"],
        [
          { suggested: "Новая технология", existing: "Не существует" },
          { suggested: "Подмена", existing: "Разработка ПО" },
          { suggested: "Docker", existing: null },
        ],
      ),
    ).toEqual(["Новая технология", "Docker"]);
  });

  it("instructs the model not to confuse a specialty with its umbrella category", () => {
    const prompt = buildSemanticReusePrompt(
      ["Машинное обучение"],
      ["Искусственный интеллект"],
    );
    expect(prompt).toContain("must NOT match");
    expect(prompt).toContain("broader categories");
    expect(prompt).toContain("Машинное обучение");
    expect(prompt).toContain("Искусственный интеллект");
  });
});
