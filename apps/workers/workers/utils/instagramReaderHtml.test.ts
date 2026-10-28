import { describe, expect, it } from "vitest";

import { buildInstagramReaderHtml } from "./instagramReaderHtml";

describe("Instagram Reader content", () => {
  it("keeps all carousel images in their original order with the full caption", () => {
    const html = buildInstagramReaderHtml("Instagram — @creator", "First line\nSecond line", [
      { id: "img-one", contentType: "image/jpeg" },
      { id: "img-two", contentType: "image/png" },
      { id: "img-three", contentType: "image/webp" },
    ]);
    expect(html.indexOf("karakeep-asset:img-one")).toBeLessThan(
      html.indexOf("karakeep-asset:img-two"),
    );
    expect(html.indexOf("karakeep-asset:img-two")).toBeLessThan(
      html.indexOf("karakeep-asset:img-three"),
    );
    expect(html).toContain("First line<br>Second line");
    expect(html.match(/<img /g)).toHaveLength(3);
  });

  it("escapes untrusted captions, renders a Reel, and rejects malicious asset IDs", () => {
    const html = buildInstagramReaderHtml("<author>", "<script>alert(1)</script>", [
      { id: "reel-id", contentType: "video/mp4" },
      { id: 'x" onerror="alert(1)', contentType: "image/jpeg" },
    ]);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;author&gt;");
    expect(html).toContain('<video src="karakeep-asset:reel-id"');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script>");
  });
});
