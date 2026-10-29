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
  // Give videos a few slots even when a post contains several pictures.
  const selected = [
    ...photos.slice(0, 3),
    ...frames.slice(0, 3),
    ...photos.slice(3),
    ...frames.slice(3),
  ].slice(0, 6);
  const cacheKey = JSON.stringify([
    userId,
    bookmarkId,
    selected.map((asset) => asset.id),
  ]);
  const cached = observationCache.get(cacheKey);
  if (cached) return cached;
  const observations: string[] = [];
  for (const [index, candidate] of selected.entries()) {
    abortSignal.throwIfAborted();
    if (Date.now() >= deadline) break;
    try {
      const { asset } = await readAsset({ userId, assetId: candidate.id });
      if (asset.length > 25 * 1024 * 1024) continue;
      const jpeg = await sharp(asset)
        .rotate()
        .resize({
          width: 1024,
          height: 1024,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 77 })
        .toBuffer();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const response = await withTaggingDeadline(
        abortSignal,
        remaining,
        (signal) =>
          client.inferFromImage(
            "Describe only what is visibly present in this Instagram photo or video frame. " +
              "Mention readable text. Do not guess identities or invent events. " +
              "Reply concisely in plain text.",
            "image/jpeg",
            jpeg.toString("base64"),
            { schema: null, abortSignal: signal },
          ),
      );
      if (response.response?.trim()) {
        observations.push(
          "Visual " + (index + 1) + ": " + response.response.slice(0, 1200),
        );
      }
    } catch (error) {
      if (abortSignal.aborted) throw error;
      if (error instanceof Error && error.name === "TimeoutError") break;
      logger.warn(
        "[Instagram Vision] Failed to analyze frame " +
          (index + 1) +
          ": " +
          (error instanceof Error ? error.name : "unknown"),
      );
    }
  }
  const result = observations.join("\n");
  if (result) observationCache.set(cacheKey, result);
  return result;
}
