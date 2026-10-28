import { describe, expect, it } from "vitest";

import { hydrateInstagramReaderAssets } from "./instagramReaderAssets";

describe("Instagram Reader asset URLs", () => {
  it("uses fresh signed URLs for assets that belong to this bookmark", () => {
    const html = '<img src="karakeep-asset:authorized-one"><img src="karakeep-asset:other-user">';
    const result = hydrateInstagramReaderAssets(
      html,
      new Set(["authorized-one"]),
      (id) => "https://example.test/api/public/assets/" + id + "?token=x&expires=y",
    );
    expect(result).toContain(
      'src="https://example.test/api/public/assets/authorized-one?token=x&amp;expires=y"',
    );
    expect(result).not.toContain("karakeep-asset:other-user");
    expect(result).not.toContain("api/public/assets/other-user");
  });

  it("does not alter unrelated HTML and accepts missing content", () => {
    expect(hydrateInstagramReaderAssets(null, new Set(), () => "")).toBeNull();
    const original = '<article><h1>Ordinary bookmark</h1><img src="https://example.test/a.jpg"></article>';
    expect(hydrateInstagramReaderAssets(original, new Set(), () => "")).toBe(
      original,
    );
  });
});
