import { describe, expect, it } from "vitest";

import { instagramCanonicalUrl } from "./instagramUrls";

describe("instagramCanonicalUrl", () => {
  it("accepts post/reel/tv links and removes tracking", () => {
    expect(
      instagramCanonicalUrl("https://instagram.com/p/C123abcd/?igsh=123"),
    ).toBe("https://www.instagram.com/p/C123abcd/");
    expect(
      instagramCanonicalUrl("https://www.instagram.com/reel/C123_ab-c/"),
    ).toBe("https://www.instagram.com/reel/C123_ab-c/");
    expect(instagramCanonicalUrl("https://www.instagram.com/tv/C123abc/")).toBe(
      "https://www.instagram.com/tv/C123abc/",
    );
  });
  it("rejects profiles, stories and lookalike domains", () => {
    for (const url of [
      "https://www.instagram.com/example/",
      "https://www.instagram.com/stories/example/123/",
      "https://notinstagram.com/p/abc/",
      "http://localhost/p/abc/",
      "file:///p/abc/",
      "https://www.instagram.com/p/../../@private",
    ])
      expect(instagramCanonicalUrl(url)).toBeNull();
  });
});
