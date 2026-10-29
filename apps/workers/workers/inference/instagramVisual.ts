/** Add image/frames context to Instagram AI tagging and summarization. */
import sharp from "sharp";
import { LRUCache } from "lru-cache";
import { withTaggingDeadline } from "./taggingResilience";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@karakeep/db";
import { AssetTypes, assets } from "@karakeep/db/schema";
import { readAsset } from "@karakeep/shared-server";
import type { InferenceClient } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";

import { instagramCanonicalUrl } from "../utils/instagramUrls";

const observationCache = new LRUCache<string, string>({
  max: 100,
  ttl: 5 * 60 * 1000,
});

const IMAGE_TYPES = [
  AssetTypes.LINK_BANNER_IMAGE,
  AssetTypes.LINK_INSTAGRAM_IMAGE,
  AssetTypes.LINK_INSTAGRAM_FRAME,
] as const;

export async function getInstagramVisualContext(
  url: string | null | undefined,
  bookmarkId: string,
  userId: string,
  client: InferenceClient,
  abortSignal: AbortSignal,
  budgetMs = 30000,
): Promise<string> {
  abortSignal.throwIfAborted();
  if (!url || !instagramCanonicalUrl(url)) return "";
  const deadline = Date.now() + budgetMs;
  const candidates = await db.query.assets.findMany({
    where: and(
      eq(assets.bookmarkId, bookmarkId),
      eq(assets.userId, userId),
      inArray(assets.assetType, [...IMAGE_TYPES]),
    ),
  });
  const sortByFilename = (
    a: (typeof candidates)[number],
    b: (typeof candidates)[number],
  ) => (a.fileName ?? "").localeCompare(b.fileName ?? "");
  const photos = candidates
    .filter((a) => a.assetType !== AssetTypes.LINK_INSTAGRAM_FRAME)
    .sort(sortByFilename);
  const frames = candidates
    .filter((a) => a.assetType === AssetTypes.LINK_INSTAGRAM_FRAME)
    .sort(sortByFilename);
  // Include the complete saved carousel (up to 20 slides) and all Reel frames,
  // not just the first six assets. For large galleries analyze contact sheets of
  // four slides so the limited AI window can cover the full publication.
  const selected = [...photos.slice(0, 20), ...frames.slice(0, 6)];
  const cacheKey = JSON.stringify([
    userId,
    bookmarkId,
    selected.map((asset) => asset.id),
  ]);
  const cached = observationCache.get(cacheKey);
  if (cached) return cached;
  const observations: string[] = [];
  const groupSize = selected.length > 6 ? 4 : 1;
  for (let offset = 0; offset < selected.length; offset += groupSize) {
    abortSignal.throwIfAborted();
    if (Date.now() >= deadline) break;
    const group = selected.slice(offset, offset + groupSize);
    try {
      const tiles: Buffer[] = [];
      for (const candidate of group) {
        abortSignal.throwIfAborted();
        const { asset } = await readAsset({ userId, assetId: candidate.id });
        if (asset.length > 25 * 1024 * 1024) {
          throw new Error("Image exceeds vision limit");
        }
        const jpeg = await sharp(asset)
          .rotate()
          .resize({
            width: groupSize === 1 ? 1024 : 700,
            height: groupSize === 1 ? 1024 : 700,
            fit: groupSize === 1 ? "inside" : "contain",
            background: "#ffffff",
            withoutEnlargement: groupSize === 1,
          })
          .jpeg({ quality: 77 })
          .toBuffer();
        tiles.push(jpeg);
      }
      const image =
        groupSize === 1
          ? tiles[0]
          : await sharp({
              create: {
                width: 1400,
                height: 1400,
                channels: 3,
                background: "#ffffff",
              },
            })
              .composite(
                tiles.map((input, index) => ({
                  input,
                  left: (index % 2) * 700,
                  top: Math.floor(index / 2) * 700,
                })),
              )
              .jpeg({ quality: 75 })
              .toBuffer();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const response = await withTaggingDeadline(
        abortSignal,
        remaining,
        (signal) =>
          client.inferFromImage(
            groupSize === 1
              ? "Describe only what is visibly present in this Instagram photo or video frame. Mention readable text. Do not guess identities or invent events. Reply concisely in plain text."
              : "This is a 2x2 grid of consecutive Instagram photos or video frames (top-left, top-right, bottom-left, bottom-right). Describe the content of EACH occupied tile separately, including readable text, objects, actions and the actual subject. Do not guess identities or invent events. Reply concisely.",
            "image/jpeg",
            image.toString("base64"),
            { schema: null, abortSignal: signal },
          ),
      );
      if (response.response?.trim()) {
        observations.push(
          "Visual slides " +
            (offset + 1) +
            "-" +
            (offset + group.length) +
            ": " +
            response.response.slice(0, 3000),
        );
      }
    } catch (error) {
      if (abortSignal.aborted) throw error;
      if (error instanceof Error && error.name === "TimeoutError") break;
      logger.warn(
        "[Instagram Vision] Failed to analyze slides " +
          (offset + 1) +
          "-" +
          (offset + group.length) +
          ": " +
          (error instanceof Error ? error.name : "unknown"),
      );
    }
  }
  const result = observations.join("\n");
  if (result) observationCache.set(cacheKey, result);
  return result;
}
