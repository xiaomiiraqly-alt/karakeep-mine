/** Accept individual Instagram posts/reels, never arbitrary downloader URLs. */
export function instagramCanonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase())
    ) return null;
    const match = /^\/(p|reel|tv)\/([a-zA-Z0-9_-]+)\/?$/.exec(url.pathname);
    return match ? "https://www.instagram.com/" + match[1] + "/" + match[2] + "/" : null;
  } catch {
    return null;
  }
}
