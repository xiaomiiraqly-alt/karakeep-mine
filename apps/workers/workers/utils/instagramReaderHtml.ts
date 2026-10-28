/** Build safe cached Reader HTML for an Instagram post or carousel. */
export interface InstagramReaderMedia {
  id: string;
  contentType: string | null;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char,
  );
}

export function buildInstagramReaderHtml(
  title: string,
  caption: string,
  media: InstagramReaderMedia[],
): string {
  const gallery = media
    .filter((item) => /^[a-zA-Z0-9-]+$/.test(item.id))
    .map((item, index) => {
      const source = "karakeep-asset:" + item.id;
      if (item.contentType?.startsWith("video/")) {
        return (
          '<figure><video src="' +
          source +
          '" controls playsinline preload="metadata" style="width:100%;max-width:100%"></video></figure>'
        );
      }
      if (item.contentType?.startsWith("image/")) {
        return (
          '<figure><img src="' +
          source +
          '" alt="Instagram photo ' +
          (index + 1) +
          '" loading="lazy" style="width:100%;height:auto;max-width:100%"></figure>'
        );
      }
      return "";
    })
    .join("");
  const text = caption
    ? "<p>" + escapeHtml(caption).replace(/\n/g, "<br>") + "</p>"
    : "";
  return (
    "<article><h1>" +
    escapeHtml(title) +
    "</h1>" +
    gallery +
    text +
    "</article>"
  );
}
