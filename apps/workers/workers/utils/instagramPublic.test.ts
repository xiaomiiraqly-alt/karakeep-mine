import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  downloadPublicInstagramPost,
  fetchPublicInstagramPost,
  isInstagramCdnUrl,
  parsePublicInstagramPost,
} from "./instagramPublic";

const fixture = {
  data: {
    xdt_api__v1__media__shortcode__web_info: {
      items: [
        {
          user: { username: "public_creator" },
          caption: { text: "A public post\nAnd its full caption" },
          carousel_media: [
            {
              image_versions2: {
                candidates: [
                  {
                    url: "https://scontent-ams2-1.cdninstagram.com/slide1.jpg",
                  },
                ],
              },
            },
            {
              video_versions: [
                { url: "https://video.cdninstagram.com/slide2.mp4" },
              ],
              image_versions2: {
                candidates: [
                  {
                    url: "https://scontent-ams2-1.cdninstagram.com/poster.jpg",
                  },
                ],
              },
            },
            {
              image_versions2: {
                candidates: [
                  {
                    url: "https://scontent.fbcdn.net/slide3.jpg",
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  },
};

describe("anonymous Instagram GraphQL extractor", () => {
  it("parses the complete ordered mixed-media carousel and caption", () => {
    const post = parsePublicInstagramPost(fixture);
    expect(post).toEqual({
      author: "public_creator",
      caption: "A public post\nAnd its full caption",
      media: [
        {
          type: "image",
          url: "https://scontent-ams2-1.cdninstagram.com/slide1.jpg",
        },
        {
          type: "video",
          url: "https://video.cdninstagram.com/slide2.mp4",
        },
        { type: "image", url: "https://scontent.fbcdn.net/slide3.jpg" },
      ],
    });
  });

  it("supports single-image publications and missing captions", () => {
    expect(
      parsePublicInstagramPost({
        data: {
          xdt_api__v1__media__shortcode__web_info: {
            items: [
              {
                image_versions2: {
                  candidates: [
                    { url: "https://x.cdninstagram.com/single.jpg" },
                  ],
                },
              },
            ],
          },
        },
      }),
    ).toEqual({
      author: null,
      caption: "",
      media: [{ type: "image", url: "https://x.cdninstagram.com/single.jpg" }],
    });
  });

  it("retains all 12 slides without truncating the carousel", () => {
    const many = {
      data: {
        xdt_api__v1__media__shortcode__web_info: {
          items: [
            {
              carousel_media: Array.from({ length: 12 }, (_, index) => ({
                image_versions2: {
                  candidates: [
                    {
                      url:
                        "https://scontent.cdninstagram.com/" + index + ".jpg",
                    },
                  ],
                },
              })),
            },
          ],
        },
      },
    };
    const media = parsePublicInstagramPost(many)?.media;
    expect(media).toHaveLength(12);
    expect(media?.[11]?.url).toBe("https://scontent.cdninstagram.com/11.jpg");
  });

  it("rejects private-network and attacker-owned media hosts", () => {
    expect(isInstagramCdnUrl("http://scontent.cdninstagram.com/img.jpg")).toBe(
      false,
    );
    expect(isInstagramCdnUrl("https://cdninstagram.com.evil.test/i.jpg")).toBe(
      false,
    );
    expect(isInstagramCdnUrl("https://127.0.0.1/internal")).toBe(false);
    expect(isInstagramCdnUrl("https://cdninstagram.com@127.0.0.1/")).toBe(
      false,
    );
    expect(isInstagramCdnUrl("https://scontent.fbcdn.net/image.jpg")).toBe(
      true,
    );
    const corrupted = {
      data: {
        xdt_api__v1__media__shortcode__web_info: {
          items: [
            {
              image_versions2: {
                candidates: [{ url: "https://127.0.0.1/private" }],
              },
            },
          ],
        },
      },
    };
    expect(parsePublicInstagramPost(corrupted)).toBeNull();
  });
  it("downloads and numbers all public images, preserving text in their metadata", async () => {
    const folder = await fs.mkdtemp(
      path.join(os.tmpdir(), "instagram-public-test-"),
    );
    const carousel = {
      data: {
        xdt_api__v1__media__shortcode__web_info: {
          items: [
            {
              user: { username: "test_user" },
              caption: { text: "Complete caption" },
              carousel_media: Array.from({ length: 12 }, (_, index) => ({
                image_versions2: {
                  candidates: [
                    {
                      url:
                        "https://scontent.cdninstagram.com/media-" +
                        index +
                        ".jpg",
                    },
                  ],
                },
              })),
            },
          ],
        },
      },
    };
    const mockedFetch = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value === "https://www.instagram.com/") {
        return new Response("", { status: 200 });
      }
      if (value === "https://www.instagram.com/graphql/query") {
        return new Response(JSON.stringify(carousel), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (value.startsWith("https://scontent.cdninstagram.com/media-")) {
        return new Response(new Uint8Array([255, 216, 255, 217]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        });
      }
      throw new Error("Unexpected external request");
    });
    vi.stubGlobal("fetch", mockedFetch);
    try {
      const count = await downloadPublicInstagramPost(
        "De7J5uajAKm",
        folder,
        1_000_000,
        20_000_000,
        new AbortController().signal,
      );
      expect(count).toBe(12);
      const downloaded = (await fs.readdir(folder)).sort();
      expect(downloaded).toHaveLength(24);
      expect(downloaded).toContain("001.jpg");
      expect(downloaded).toContain("012.jpg");
      const metadata = JSON.parse(
        await fs.readFile(path.join(folder, "012.jpg.json"), "utf8"),
      ) as { num: number; description: string; username: string };
      expect(metadata).toEqual({
        num: 12,
        description: "Complete caption",
        username: "test_user",
      });
      expect(mockedFetch).toHaveBeenCalledTimes(14);
    } finally {
      vi.unstubAllGlobals();
      await fs.rm(folder, { recursive: true, force: true });
    }
  });
  it("cancels unread and oversized response bodies", async () => {
    const homeCancelled = vi.fn();
    const metadataCancelled = vi.fn();
    const mockedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel: homeCancelled })),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(3000001));
            },
            cancel: metadataCancelled,
          }),
        ),
      );
    vi.stubGlobal("fetch", mockedFetch);
    try {
      await expect(
        fetchPublicInstagramPost("abc123", new AbortController().signal),
      ).rejects.toThrow("too large");
      expect(homeCancelled).toHaveBeenCalledTimes(1);
      expect(metadataCancelled).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    { status: 200, length: "3000001" },
    { status: 429, length: "1" },
  ])(
    "cancels metadata rejected by status or declared length: %j",
    async ({ status, length }) => {
      const cancelled = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response(""))
          .mockResolvedValueOnce(
            new Response(new ReadableStream({ cancel: cancelled }), {
              status,
              headers: { "content-length": length },
            }),
          ),
      );
      try {
        await expect(
          fetchPublicInstagramPost("abc123", new AbortController().signal),
        ).rejects.toThrow();
        expect(cancelled).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
