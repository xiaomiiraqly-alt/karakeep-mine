import { describe, expect, it } from "vitest";
import {
  needsGeneratedTitle,
  taggingTitleInstruction,
  cleanBookmarkTitle,
} from "./bookmarkTitle";

describe("titles independent of summarization", () => {
  it("generates titles for untitled text notes and generic Instagram imports", () => {
    expect(
      needsGeneratedTitle({
        title: null,
        text: { text: "Леха должен 20 тысяч" },
      }),
    ).toBe(true);
    expect(
      needsGeneratedTitle({ title: "Untitled", text: { text: "Долг" } }),
    ).toBe(true);
    expect(
      needsGeneratedTitle({
        link: {
          url: "https://www.instagram.com/p/abc/",
          title: "Instagram — @tut.sev",
        },
      }),
    ).toBe(true);
  });
  it("preserves manual bookmark titles and ignores empty notes", () => {
    expect(
      needsGeneratedTitle({ title: "Мои расчёты", text: { text: "Долг" } }),
    ).toBe(false);
    expect(needsGeneratedTitle({ text: { text: "  " } })).toBe(false);
    expect(
      needsGeneratedTitle({
        link: {
          url: "https://www.instagram.com/p/abc/",
          title: "Хэллоуин в Севастополе",
        },
      }),
    ).toBe(true);
  });
  it("requires factual titles from current content and rejects unusable responses", () => {
    expect(taggingTitleInstruction({ text: { text: "Долг" } })).toContain(
      "Do not invent",
    );
    expect(cleanBookmarkTitle("Долг Лёхи: возврат до 8 ноября")).toBe(
      "Долг Лёхи: возврат до 8 ноября",
    );
    for (const value of [
      null,
      42,
      "Untitled",
      "Instagram — @tut.sev",
      "<script>alert(1)</script>",
    ])
      expect(cleanBookmarkTitle(value)).toBeNull();
  });
});
