/** Best-effort archival of individual Instagram posts, carousels and Reels. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execa } from "execa";
import { and, eq, inArray } from "drizzle-orm";
import { getProxyAgent } from "network";

import { db } from "@karakeep/db";
import { AssetTypes, assets, bookmarkLinks } from "@karakeep/db/schema";
import {
  newAssetId,
  QuotaService,
  saveAssetFromFile,
  silentDeleteAsset,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { tryCatch } from "@karakeep/shared/tryCatch";

import type { CrawlContext } from "./crawlerWorker";
import { instagramCanonicalUrl } from "./utils/instagramUrls";
import { buildInstagramReaderHtml } from "./utils/instagramReaderHtml";
import { instagramImportTitle } from "./inference/instagramTitle";
import {
  downloadPublicInstagramPost,
  fetchEmbeddedInstagramPost,
  downloadInstagramMediaBatch,
} from "./utils/instagramPublic";

const MAX_MEDIA = 20;
const MAX_FILE = 80 * 1024 * 1024;
const MAX_BATCH = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 150_000;
const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
type Meta = Record<string, unknown>;
interface Media {
  file: string;
  mime: string;
  size: number;
  meta: Meta;
}

function field(meta: Meta, key: string): string | null {
  const val = meta[key];
  return typeof val === "string" ? val.trim() || null : null;
}
function caption(meta: Meta): string | null {
  return (
    (
      field(meta, "description") ??
      field(meta, "caption") ??
      field(meta, "text")
    )?.slice(0, 30_000) ?? null
  );
}
function author(meta: Meta): string | null {
  return (
    field(meta, "username") ??
    field(meta, "owner_username") ??
    field(meta, "user")
  );
}
async function mediaFiles(folder: string): Promise<string[]> {
  return (await fs.readdir(folder, { withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.join(folder, e.name))
    .filter((f) => Object.hasOwn(MIME, path.extname(f).toLowerCase()))
    .sort()
    .slice(0, MAX_MEDIA);
}
async function metadataFor(file: string): Promise<Meta> {
  const result = await tryCatch(fs.readFile(file + ".json", "utf8"));
  if (!result.data || result.data.length > 1_000_000) return {};
  try {
    const value: unknown = JSON.parse(result.data);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Meta)
      : {};
  } catch {
    return {};
  }
}

/** Return true if imported. Return false to use the standard web crawler. */
export async function importInstagramPost(ctx: CrawlContext): Promise<boolean> {
  const url = instagramCanonicalUrl(ctx.url);
  if (!url) return false;

  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "karakeep-instagram-"),
  );
  const fileLimit = Math.min(
    MAX_FILE,
    serverConfig.maxAssetSizeMb * 1024 * 1024,
  );
  const storedIds: string[] = [];
  let committed = false;
  try {
    // Prefer the public Instagram data endpoint: it can return complete
    // carousels when the gallery-dl extractor redirects to a login page.
    // Neither the server nor the user needs an Instagram account.
    let files: string[] = [];
    try {
      const shortcode = new URL(url).pathname.split("/")[2];
      const count = await downloadPublicInstagramPost(
        shortcode,
        folder,
        fileLimit,
        MAX_BATCH,
        ctx.abortSignal,
      );
      files = await mediaFiles(folder);
      ctx.log.info("Fetched " + count + " public Instagram media items.");
    } catch (error) {
      ctx.abortSignal.throwIfAborted();
      const reason =
        error instanceof Error ? error.message : "Unknown downloader error";
      ctx.log.warn(
        "Anonymous Instagram download failed (" +
          reason.replace(/https?:\/\/\S+/g, "[URL]").slice(0, 200) +
          "); trying gallery-dl.",
      );
    }

    if (!files.length) {
      // Instagram may include a complete JSON media payload in a browser-like
      // HTML response even after its anonymous GraphQL API rejects POST/GET.
      try {
        const shortcode = new URL(url).pathname.split("/")[2];
        const post = await fetchEmbeddedInstagramPost(
          url,
          shortcode,
          ctx.abortSignal,
          ctx.runProxy,
        );
        const count = await downloadInstagramMediaBatch(
          post,
          folder,
          fileLimit,
          MAX_BATCH,
          ctx.abortSignal,
        );
        files = await mediaFiles(folder);
        ctx.log.info("Extracted " + count + " Instagram media items from embedded page data.");
      } catch (error) {
        ctx.abortSignal.throwIfAborted();
        const reason = error instanceof Error ? error.message : "Unknown HTML extraction error";
        ctx.log.warn(
          "Instagram embedded media unavailable (" +
          reason.replace(/https?:\\/\\/\\S+/g, "[URL]").slice(0, 200) +
          "); trying gallery-dl.",
        );
      }
    }

    if (!files.length) {
      // gallery-dl never receives arbitrary URLs; the canonical host/path
      // is validated. Logged-in cookies, when configured, are optional.
      const args = [
        "--config-ignore",
        "--no-input",
        "--no-part",
        "--no-mtime",
        "-o",
        "directory=[]",
        "-o",
        "filename={media_id}.{extension}",
        "--write-metadata",
        "--range",
        "1-" + MAX_MEDIA,
        "--filesize-max",
        String(fileLimit),
        "-R",
        "1",
        "--http-timeout",
        "15",
        "--whitelist",
        "instagram",
        "-D",
        folder,
      ];
      const cookies = process.env.KARAKEEP_INSTAGRAM_COOKIES_FILE;
      if (cookies) {
        // The host-mounted cookie jar is read-only; never modify it.
        args.push("--cookies", cookies, "-o", "extractor.cookies-update=false");
      }
      const proxy = getProxyAgent(url, ctx.runProxy);
      if (proxy) args.push("--proxy", proxy.proxy.toString());
      args.push(url);
      const run = await tryCatch(
        execa("gallery-dl", args, {
          cancelSignal: ctx.abortSignal,
          timeout: DOWNLOAD_TIMEOUT_MS,
          reject: false,
        }),
      );
      ctx.abortSignal.throwIfAborted();
      if (run.error) {
        ctx.log.warn("Instagram downloader unavailable; using normal crawler.");
        return false;
      }
      ctx.abortSignal.throwIfAborted();

      files = await mediaFiles(folder);
      if (!files.length) {
        const detail = (run.data.stderr || "")
          .split("\n")
          .filter(Boolean)
          .slice(-2)
          .join("; ")
          .replace(/https?:\/\/\S+/g, "[URL]")
          .replace(
            /(?:sessionid|csrftoken|authorization)\s*[:=]\s*\S+/gi,
            "[secret]",
          )
          .slice(0, 320);
        ctx.log.warn(
          "Instagram extractor returned no media (exit " +
            run.data.exitCode +
            (detail ? "; " + detail : "") +
            "); using normal crawler.",
        );
        return false;
      }
    }

    const media: Media[] = [];
    let total = 0;
    for (const file of files) {
      const mime = MIME[path.extname(file).toLowerCase()];
      const stat = await fs.stat(file);
      if (!stat.isFile() || !stat.size || stat.size > fileLimit) continue;
      if (total + stat.size > MAX_BATCH) break;
      total += stat.size;
      media.push({
        file,
        mime,
        size: stat.size,
        meta: await metadataFor(file),
      });
    }
    if (!media.length) return false;

    // Instagram carousels may download with unordered media IDs. Prefer the
    // per-slide index from gallery-dl metadata for predictable media ordering.
    const slideIndex = (item: Media): number => {
      const value = item.meta.num;
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : Number.MAX_SAFE_INTEGER;
    };
    media.sort(
      (a, b) => slideIndex(a) - slideIndex(b) || a.file.localeCompare(b.file),
    );

    // Frames enrich Reel summaries. Audio is not transcribed.
    const frames: Media[] = [];
    for (const [index, item] of media.entries()) {
      if (!item.mime.startsWith("video/") || frames.length >= 6) continue;
      for (const [n, second] of [0.5, 3, 8].entries()) {
        ctx.abortSignal.throwIfAborted();
        if (frames.length >= 6) break;
        const frame = path.join(folder, "frame-" + index + "-" + n + ".jpg");
        const outcome = await tryCatch(
          execa(
            "ffmpeg",
            [
              "-nostdin",
              "-loglevel",
              "error",
              "-ss",
              String(second),
              "-i",
              item.file,
              "-frames:v",
              "1",
              "-vf",
              "scale=960:-2",
              "-y",
              frame,
            ],
            { cancelSignal: ctx.abortSignal, timeout: 12_000, reject: false },
          ),
        );
        if (outcome.error || outcome.data.exitCode !== 0) continue;
        const stat = await tryCatch(fs.stat(frame));
        if (
          !stat.data?.isFile() ||
          !stat.data.size ||
          stat.data.size > 2_000_000
        )
          continue;
        if (total + stat.data.size > MAX_BATCH) break;
        total += stat.data.size;
        frames.push({
          file: frame,
          mime: "image/jpeg",
          size: stat.data.size,
          meta: item.meta,
        });
      }
    }

    const meta =
      media.map((m) => m.meta).find((m) => caption(m)) ?? media[0].meta;
    const text =
      caption(meta) ?? media.map((m) => caption(m.meta)).find(Boolean) ?? "";
    const creator =
      author(meta) ?? media.map((m) => author(m.meta)).find(Boolean) ?? null;
    const title = creator ? "Instagram — @" + creator : "Instagram post";

    const quotaApproved = await QuotaService.checkStorageQuota(
      db,
      ctx.userId,
      total,
    );
    const fresh: (typeof assets.$inferInsert)[] = [];
    let photos = 0,
      videos = 0,
      bannerFrame = false;

    for (const item of [...media, ...frames]) {
      ctx.abortSignal.throwIfAborted();
      let type: AssetTypes;
      if (frames.includes(item)) {
        if (photos === 0 && !bannerFrame) {
          type = AssetTypes.LINK_BANNER_IMAGE;
          bannerFrame = true;
        } else {
          type = AssetTypes.LINK_INSTAGRAM_FRAME;
        }
      } else if (item.mime.startsWith("image/")) {
        type =
          photos++ === 0
            ? AssetTypes.LINK_BANNER_IMAGE
            : AssetTypes.LINK_INSTAGRAM_IMAGE;
      } else {
        type =
          videos++ === 0
            ? AssetTypes.LINK_VIDEO
            : AssetTypes.LINK_INSTAGRAM_VIDEO;
      }
      const id = newAssetId();
      await saveAssetFromFile({
        userId: ctx.userId,
        assetId: id,
        assetPath: item.file,
        metadata: {
          contentType: item.mime,
          fileName: path.basename(item.file),
        },
        quotaApproved,
      });
      storedIds.push(id);
      fresh.push({
        id,
        userId: ctx.userId,
        bookmarkId: ctx.bookmarkId,
        assetType: type,
        contentType: item.mime,
        size: item.size,
        fileName: path.basename(item.file),
      });
    }

    // Archive captions and original media in Reader view; links are signed
    // on each authorized read rather than persisted with expiring credentials.
    const types = [
      AssetTypes.LINK_BANNER_IMAGE,
      AssetTypes.LINK_VIDEO,
      AssetTypes.LINK_INSTAGRAM_IMAGE,
      AssetTypes.LINK_INSTAGRAM_VIDEO,
      AssetTypes.LINK_INSTAGRAM_FRAME,
      // A previously crawled webpage may have stored its HTML in a separate
      // asset. Replacing contentAssetId with null must remove that old asset.
      AssetTypes.LINK_HTML_CONTENT,
    ];
    // Resolve current assets after reserving the writer slot, so concurrent
    // reimports cannot leave duplicate galleries or delete a newer import.
    const previous = await db.transaction(
      (tx) => {
        const previous = tx.query.assets
          .findMany({
            where: and(
              eq(assets.bookmarkId, ctx.bookmarkId),
              inArray(assets.assetType, types),
            ),
          })
          .sync();
        const currentLink = tx.query.bookmarkLinks
          .findFirst({
            where: eq(bookmarkLinks.id, ctx.bookmarkId),
            columns: { title: true },
          })
          .sync();
        const preservedTitle = instagramImportTitle(currentLink?.title, title);
        const html = buildInstagramReaderHtml(
          preservedTitle,
          text,
          fresh.slice(0, media.length).map((item) => ({
            id: item.id,
            contentType: item.contentType ?? null,
          })),
        );

        if (previous.length) {
          tx.delete(assets)
            .where(
              inArray(
                assets.id,
                previous.map((a) => a.id),
              ),
            )
            .run();
        }
        for (const item of fresh) tx.insert(assets).values(item).run();
        tx.update(bookmarkLinks)
          .set({
            title: preservedTitle,
            description: text || "Instagram media (" + media.length + ")",
            publisher: "Instagram",
            author: creator,
            htmlContent: html,
            contentAssetId: null,
            crawledAt: new Date(),
            crawlStatusCode: 200,
            readerViewStatus: "readable",
            readerViewScore: 100,
            readerViewReasons: null,
            readerViewClassifierVersion: null,
          })
          .where(eq(bookmarkLinks.id, ctx.bookmarkId))
          .run();
        return previous;
      },
      { behavior: "immediate" },
    );
    committed = true;
    await Promise.all(previous.map((a) => silentDeleteAsset(ctx.userId, a.id)));
    logger.info(
      "[Instagram] Imported " +
        photos +
        " photos, " +
        videos +
        " videos and " +
        frames.length +
        " frame samples.",
    );
    return true;
  } catch (error) {
    if (!committed) {
      await Promise.all(
        storedIds.map((id) => silentDeleteAsset(ctx.userId, id)),
      );
    }
    ctx.abortSignal.throwIfAborted();
    if (committed) return true;
    ctx.log.warn(
      "Instagram import failed (" +
        (error instanceof Error ? error.name : "error") +
        "); using regular crawler.",
    );
    return false;
  } finally {
    await fs
      .rm(folder, { recursive: true, force: true })
      .catch((error: unknown) => {
        ctx.log.warn(
          "Failed to clean up Instagram temporary folder: " + String(error),
        );
      });
  }
}
