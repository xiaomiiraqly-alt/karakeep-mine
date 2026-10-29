import { describe, expect, it } from "vitest";

import { canonicalizeAITags } from "./tagVocabulary";

describe("AI tag vocabulary", () => {
  it("deduplicates synonymous software development and AI labels", () => {
    expect(
      canonicalizeAITags(
        ["Разработка ПО", "разработка программного обеспечения", "AI", "ИИ"],
        [],
      ),
    ).toEqual(["Разработка ПО", "Искусственный интеллект"]);
  });

  it("reuses an existing user's chosen name without renaming saved tags", () => {
    expect(
      canonicalizeAITags(
        ["Разработка ПО", "Neural networks", "3D печать"],
        ["Разработка программного обеспечения", "Нейронные сети", "3D-печать"],
      ),
    ).toEqual([
      "Разработка программного обеспечения",
      "Нейронные сети",
      "3D-печать",
    ]);
  });

  it("strictly enforces curated tags and does not invent extras", () => {
    expect(
      canonicalizeAITags(
        [
          "программное обеспечение",
          "Разработка программного обеспечения",
          "ИИ",
          "AI",
          "Машинное обучение",
          "CSS",
        ],
        ["Разработка программного обеспечения", "CSS"],
        ["Разработка ПО", "Искусственный интеллект"],
      ),
    ).toEqual(["Разработка ПО", "Искусственный интеллект"]);
  });

  it("keeps related but distinct concepts separate", () => {
    expect(
      canonicalizeAITags(
        [
          "Искусственный интеллект",
          "Машинное обучение",
          "Программирование",
          "Разработка ПО",
        ],
        [],
      ),
    ).toEqual([
      "Искусственный интеллект",
      "Машинное обучение",
      "Программирование",
      "Разработка ПО",
    ]);
  });

  it("filters malformed labels and limits AI output to five useful tags", () => {
    expect(
      canonicalizeAITags(
        [
          "#ChatGPT",
          "  разработка   ПО ",
          "<script>",
          "https://example.org",
          "Нейросети",
          "AI",
          "Kubernetes",
          "Docker",
          "Python",
        ],
        [],
      ),
    ).toEqual([
      "ChatGPT",
      "Разработка ПО",
      "Нейросети",
      "Искусственный интеллект",
      "Kubernetes",
    ]);
  });

  it("preserves freely generated tags when there is no curated vocabulary", () => {
    expect(
      canonicalizeAITags(["Уличная архитектура", "Перголы"], ["Дизайн"]),
    ).toEqual(["Уличная архитектура", "Перголы"]);
  });
});
