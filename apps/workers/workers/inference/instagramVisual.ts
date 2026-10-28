/** Add image/frames context to Instagram AI tagging and summarization. */
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@karakeep/db";
import { AssetTypes, assets } from "@karakeep/db/schema";
import { readAsset } from "@karakeep/shared-server";
import type { InferenceClient } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";

import { instagramCanonicalUrl } from "../utils/instagramUrls";

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
): Promise<string> {
  if (!url || !instagramCanonicalUrl(url)) return "";
  const candidates = await db.query.assets.findMany({
    where: and(
      eq(assets.bookmarkId, bookmarkId),
      inArray(assets.assetType, [...IMAGE_TYPES]),
    ),
  });
  const sortByFilename = (a: (typeof candidates)[number], b: (typeof candidates)[number]) =>
    (a.fileName ?? "").localeCompare(b.fileName ?? "");
  const photos = candidates.filter((a) =>
    a.assetType !== AssetTypes.LINK_INSTAGRAM_FRAME).sort(sortByFilename);
  const frames = candidates.filter((a) =>
    a.assetType === AssetTypes.LINK_INSTAGRAM_FRAME).sort(sortByFilename);
  // Give videos a few slots even when a post contains several pictures.
  const selected = [
    ...photos.slice(0, 3), ...frames.slice(0, 3),
    ...photos.slice(3), ...frames.slice(3),
  ].slice(0, 6);
  const observations: string[] = [];
  for (const [index, candidate] of selected.entries()) {
    abortSignal.throwIfAborted();
    try {
      const { asset } = await readAsset({ userId, assetId: candidate.id });
      if (asset.length > 25 * 1024 * 1024) continue;
      const jpeg = await sharp(asset)
        .rotate()
        .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 77 })
        .toBuffer();
      const response = await client.inferFromImage(
        "Describe only what is visibly present in this Instagram photo or video frame. " +
        "Mention readable text. Do not guess identities or invent events. " +
        "Reply concisely in plain text.",
        "image/jpeg",
        jpeg.toString("base64"),
        { schema: null, abortSignal },
      );
      if (response.response?.trim()) {
        observations.push("Visual " + (index + 1) + ": " +
          response.response.slice(0, 1200));
      }
    } catch (error) {
      if (abortSignal.aborted) throw error;
      logger.warn("[Instagram Vision] Failed to analyze frame " +
        (index + 1) + ": " + (error instanceof Error ? error.name : "unknown"));
    }
  }
  return observations.join("\n");
}
