import { describe, expect, it } from "vitest";

import {
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
      media: [
        { type: "image", url: "https://x.cdninstagram.com/single.jpg" },
      ],
    });
  });


  it("retains all 12 slides without truncating the carousel", () => {
    const many = {
      data: {
        xdt_api__v1__media__shortcode__web_info: {
          items: [{
            carousel_media: Array.from({ length: 12 }, (_, index) => ({
              image_versions2: {
                candidates: [{
                  url: "https://scontent.cdninstagram.com/" + index + ".jpg",
                }],
              },
            })),
          }],
        },
      },
    };
    const media = parsePublicInstagramPost(many)?.media;
    expect(media).toHaveLength(12);
    expect(media?.[11]?.url).toEndWith("/11.jpg");
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
          items: [{
            image_versions2: {
              candidates: [{ url: "https://127.0.0.1/private" }],
            },
          }],
        },
      },
    };
    expect(parsePublicInstagramPost(corrupted)).toBeNull();
  });
});
