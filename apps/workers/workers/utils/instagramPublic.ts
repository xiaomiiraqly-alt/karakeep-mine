/** Public Instagram media fallback. No user login, cookies or credentials are stored. */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const DOC_ID = "27128499623469141";
const APP_ID = "936619743392459";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

export interface PublicInstagramMedia {
  url: string;
  type: "image" | "video";
}

export interface PublicInstagramPost {
  author: string | null;
  caption: string;
  media: PublicInstagramMedia[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Prevent an untrusted media URL from reaching private/internal networks. */
export function isInstagramCdnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (host === "cdninstagram.com" ||
        host.endsWith(".cdninstagram.com") ||
        host === "fbcdn.net" ||
        host.endsWith(".fbcdn.net"))
    );
  } catch {
    return false;
  }
}

function firstMediaUrl(values: unknown): string | null {
  for (const value of array(values)) {
    const url = object(value)?.url;
    if (typeof url === "string" && isInstagramCdnUrl(url)) return url;
  }
  return null;
}

export function parsePublicInstagramPost(
  response: unknown,
): PublicInstagramPost | null {
  const data = object(object(response)?.data);
  const webInfo = object(data?.xdt_api__v1__media__shortcode__web_info);
  const post = object(array(webInfo?.items)[0]);
  if (!post) return null;

  const candidates = array(post.carousel_media).length
    ? array(post.carousel_media)
    : [post];
  const media: PublicInstagramMedia[] = [];
  for (const entry of candidates) {
    const item = object(entry);
    if (!item) return null;

    // Video carousels may contain video_versions alongside a thumbnail.
    const videoUrl = firstMediaUrl(item.video_versions);
    const images = object(item.image_versions2);
    const imageUrl = firstMediaUrl(images?.candidates);
    if (videoUrl) {
      media.push({ url: videoUrl, type: "video" });
    } else if (imageUrl) {
      media.push({ url: imageUrl, type: "image" });
    } else {
      // Do not silently archive only part of a carousel.
      return null;
    }
  }
  if (!media.length || media.length > 20) return null;

  const rawCaption = object(post.caption)?.text;
  const rawAuthor = object(post.user)?.username;
  return {
    author: typeof rawAuthor === "string" ? rawAuthor.slice(0, 100) : null,
    caption: typeof rawCaption === "string" ? rawCaption.slice(0, 30_000) : "",
    media,
  };
}

function signalWithTimeout(parent: AbortSignal, milliseconds: number) {
  return AbortSignal.any([parent, AbortSignal.timeout(milliseconds)]);
}

async function requestTextLimited(response: Response, maxBytes: number) {
  const length = Number(response.headers.get("content-length"));
  if (length > maxBytes) {
    await response.body?.cancel();
    throw new Error("Instagram response too large");
  }
  if (!response.body) throw new Error("Instagram response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Instagram response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
      /* Preserve the original read/write error. */
    });
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchPublicInstagramPost(
  shortcode: string,
  signal: AbortSignal,
): Promise<PublicInstagramPost> {
  if (!/^[a-zA-Z0-9_-]{3,30}$/.test(shortcode))
    throw new Error("Invalid Instagram shortcode");

  const home = await fetch("https://www.instagram.com/", {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
    signal: signalWithTimeout(signal, 15_000),
  });
  const csrf = (home.headers.getSetCookie?.() ?? [])
    .map((cookie) => /^csrftoken=([^;]+)/.exec(cookie)?.[1])
    .find(Boolean);

  await home.body?.cancel();

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "X-IG-App-ID": APP_ID,
    "X-CSRFToken": csrf ?? "",
    "Content-Type": "application/x-www-form-urlencoded",
    Referer: "https://www.instagram.com/",
  };
  if (csrf) headers.Cookie = "csrftoken=" + csrf;

  const result = await fetch("https://www.instagram.com/graphql/query", {
    method: "POST",
    headers,
    redirect: "manual",
    body: new URLSearchParams({
      doc_id: DOC_ID,
      variables: JSON.stringify({
        shortcode,
        __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
      }),
    }),
    signal: signalWithTimeout(signal, 20_000),
  });
  if (!result.ok) {
    await result.body?.cancel();
    throw new Error("Instagram metadata HTTP " + result.status);
  }
  const raw = await requestTextLimited(result, 3_000_000);
  const parsed: unknown = JSON.parse(raw);
  const post = parsePublicInstagramPost(parsed);
  if (!post) throw new Error("No public Instagram carousel in API response");
  return post;
}

/** Stream media directly to disk and clean incomplete batches on failure. */
export async function downloadPublicInstagramPost(
  shortcode: string,
  folder: string,
  fileLimit: number,
  batchLimit: number,
  signal: AbortSignal,
): Promise<number> {
  const post = await fetchPublicInstagramPost(shortcode, signal);
  const written: string[] = [];
  let total = 0;
  try {
    for (const [index, item] of post.media.entries()) {
      signal.throwIfAborted();
      const ext = item.type === "video" ? ".mp4" : ".jpg";
      const filename = path.join(
        folder,
        String(index + 1).padStart(3, "0") + ext,
      );
      const partial = filename + ".part";
      const response = await fetch(item.url, {
        headers: {
          "User-Agent": USER_AGENT,
          Referer: "https://www.instagram.com/",
        },
        redirect: "manual",
        signal: signalWithTimeout(signal, 30_000),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error("Instagram CDN HTTP " + response.status);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        !contentType
          .toLowerCase()
          .startsWith(item.type === "video" ? "video/" : "image/")
      ) {
        await response.body.cancel();
        throw new Error("Unexpected Instagram media content type");
      }

      const handle = await fs.open(partial, "wx");
      written.push(partial);
      let size = 0;
      try {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > fileLimit || size + total > batchLimit)
              throw new Error("Instagram media exceeds size limit");
            await handle.writeFile(value);
          }
        } finally {
          await reader.cancel().catch(() => {
            /* Preserve the original read/write error. */
          });
          reader.releaseLock();
        }
      } finally {
        await handle.close();
      }
      if (!size) throw new Error("Empty Instagram media file");
      total += size;
      await fs.rename(partial, filename);
      written.push(filename);

      const metaFile = filename + ".json";
      await fs.writeFile(
        metaFile,
        JSON.stringify({
          num: index + 1,
          description: post.caption,
          username: post.author,
        }),
        { flag: "wx" },
      );
      written.push(metaFile);
    }
  } catch (error) {
    await Promise.allSettled(
      written.map((name) => fs.rm(name, { force: true })),
    );
    throw error;
  }
  return post.media.length;
}
