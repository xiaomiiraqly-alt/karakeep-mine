import { and, eq, isNull } from "drizzle-orm";
import { getBookmarkDomain } from "network";

import { db } from "@karakeep/db";
import { bookmarkLinks, bookmarks, customPrompts, users } from "@karakeep/db/schema";
import {
  addLogFields,
  setSpanAttributes,
  triggerSearchReindex,
  ZOpenAIRequest,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { InferenceClient } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";
import { buildSummaryPrompt } from "@karakeep/shared/prompts.server";
import { DequeuedJob } from "@karakeep/shared/queueing";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import { Bookmark } from "@karakeep/trpc/models/bookmarks";

import { getInstagramVisualContext } from "./instagramVisual";
import {
  buildInstagramTitlePrompt,
  cleanInstagramTitle,
  isGenericInstagramTitle,
  updateInstagramReaderHeading,
} from "./instagramTitle";
import { instagramCanonicalUrl } from "../utils/instagramUrls";

async function fetchBookmarkDetailsForSummary(bookmarkId: string) {
  const bookmark = await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, bookmarkId),
    columns: { id: true, userId: true, type: true, title: true },
    with: {
      link: {
        columns: {
          title: true,
          description: true,
          htmlContent: true,
          contentAssetId: true,
          crawlStatusCode: true,
          publisher: true,
          author: true,
          url: true,
        },
      },
      // If assets (like PDFs with extracted text) should be summarized, extend here
    },
  });

  if (!bookmark) {
    throw new Error(`Bookmark with id ${bookmarkId} not found`);
  }
  return bookmark;
}

export async function runSummarization(
  bookmarkId: string,
  job: DequeuedJob<ZOpenAIRequest>,
  inferenceClient: InferenceClient,
) {
  if (!serverConfig.inference.enableAutoSummarization) {
    logger.debug(
      `[inference][${job.id}] Skipping summarization job for bookmark with id "${bookmarkId}" because it's disabled in the config.`,
    );
    return;
  }
  const jobId = job.id;

  logger.info(
    `[inference][${jobId}] Starting a summary job for bookmark with id "${bookmarkId}"`,
  );

  const bookmarkData = await fetchBookmarkDetailsForSummary(bookmarkId);

  // Check user-level preference
  const userSettings = await db.query.users.findFirst({
    where: eq(users.id, bookmarkData.userId),
    columns: {
      autoSummarizationEnabled: true,
      inferredTagLang: true,
    },
  });

  setSpanAttributes({
    "user.id": bookmarkData.userId,
    "bookmark.id": bookmarkData.id,
    "inference.type": "summarization",
  });
  addLogFields<"inferenceWorker.run">({
    "user.id": bookmarkData.userId,
    "bookmark.url": bookmarkData.link?.url,
    "bookmark.domain": getBookmarkDomain(bookmarkData.link?.url),
    "bookmark.content_type": bookmarkData.type,
    "crawler.status_code": bookmarkData.link?.crawlStatusCode ?? undefined,
    "inference.model": serverConfig.inference.textModel,
  });

  if (userSettings?.autoSummarizationEnabled === false) {
    logger.debug(
      `[inference][${jobId}] Skipping summarization job for bookmark with id "${bookmarkId}" because user has disabled auto-summarization.`,
    );
    return;
  }

  let textToSummarize = "";
  if (bookmarkData.type === BookmarkTypes.LINK && bookmarkData.link) {
    const link = bookmarkData.link;

    // Extract plain text content from HTML for summarization
    let content =
      (await Bookmark.getBookmarkPlainTextContent(link, bookmarkData.userId)) ??
      "";

    if (!link.description && !content) {
      // No content to infer from; skip summarization
      logger.info(
        `[inference] No content found for link "${bookmarkId}". Skipping summary.`,
      );
      return;
    }

    textToSummarize = `
Title: ${link.title ?? ""}
Description: ${link.description ?? ""}
Content: ${content}
Publisher: ${link.publisher ?? ""}
Author: ${link.author ?? ""}
URL: ${link.url ?? ""}
`;
  } else {
    logger.warn(
      `[inference][${jobId}] Bookmark ${bookmarkId} (type: ${bookmarkData.type}) is not a LINK or TEXT type with content, or content is missing. Skipping summary.`,
    );
    return;
  }

  // Instagram captions alone can omit the actual content of photos/Reels.
  // Include observed images and sampled frames; audio is not transcribed.
  const visualContext = await getInstagramVisualContext(
    bookmarkData.link?.url,
    bookmarkId,
    bookmarkData.userId,
    inferenceClient,
    job.abortSignal,
  );
  if (visualContext)
    textToSummarize += "\nVisual observations:\n" + visualContext;

  if (!textToSummarize.trim()) {
    logger.info(
      `[inference][${jobId}] No content to summarize for bookmark ${bookmarkId}.`,
    );
    return;
  }

  const prompts = await db.query.customPrompts.findMany({
    where: and(
      eq(customPrompts.userId, bookmarkData.userId),
      eq(customPrompts.appliesTo, "summary"),
    ),
    columns: {
      text: true,
    },
  });

  addLogFields<"inferenceWorker.run">({
    "inference.prompt.custom_count": prompts.length,
  });

  const summaryPrompt = await buildSummaryPrompt(
    userSettings?.inferredTagLang ?? serverConfig.inference.inferredTagLang,
    prompts.map((p) => p.text),
    textToSummarize,
    serverConfig.inference.contextLength,
  );

  addLogFields<"inferenceWorker.run">({
    "inference.prompt.size": Buffer.byteLength(summaryPrompt, "utf8"),
  });

  const summaryResult = await inferenceClient.inferFromText(summaryPrompt, {
    schema: null, // Summaries are typically free-form text
    abortSignal: job.abortSignal,
  });

  if (!summaryResult.response) {
    throw new Error(
      `[inference][${jobId}] Failed to summarize bookmark ${bookmarkId}, empty response from inference client.`,
    );
  }

  addLogFields<"inferenceWorker.run">({
    "inference.summary.size": Buffer.byteLength(summaryResult.response, "utf8"),
    "inference.total_tokens": summaryResult.totalTokens,
  });

  logger.info(
    `[inference][${jobId}] Generated summary for bookmark "${bookmarkId}" using ${summaryResult.totalTokens} tokens.`,
  );

  await db
    .update(bookmarks)
    .set({
      summary: summaryResult.response,
      modifiedAt: new Date(),
    })
    .where(eq(bookmarks.id, bookmarkId));

  // The imported media already underwent AI summarization and image analysis.
  // Use those observations for one short title inference rather than repeating
  // costly image processing. Never overwrite an explicit user-defined title.
  const instagramLink = bookmarkData.link;
  if (
    instagramLink?.url &&
    instagramCanonicalUrl(instagramLink.url) &&
    !bookmarkData.title &&
    isGenericInstagramTitle(instagramLink.title)
  ) {
    try {
      const proposed = await inferenceClient.inferFromText(
        buildInstagramTitlePrompt({
          language:
            userSettings?.inferredTagLang ??
            serverConfig.inference.inferredTagLang,
          caption: instagramLink.description ?? "",
          summary: summaryResult.response,
          visualContext,
        }),
        { schema: null, abortSignal: job.abortSignal },
      );
      const title = cleanInstagramTitle(proposed.response ?? "");
      if (title) {
        // Compare-and-set: do not replace an intervening re-crawl or manual
        // title edit while the model was generating the new title.
        const condition =
          instagramLink.title === null
            ? isNull(bookmarkLinks.title)
            : eq(bookmarkLinks.title, instagramLink.title);
        const changed = await db
          .update(bookmarkLinks)
          .set({
            title,
            ...(instagramLink.htmlContent
              ? {
                  htmlContent: updateInstagramReaderHeading(
                    instagramLink.htmlContent,
                    title,
                  ),
                }
              : {}),
          })
          .where(and(eq(bookmarkLinks.id, bookmarkId), condition))
          .returning({ id: bookmarkLinks.id });
        if (changed.length) {
          logger.info(
            `[inference][${jobId}] Generated descriptive Instagram title for bookmark "${bookmarkId}".`,
          );
        }
      }
    } catch (error) {
      if (job.abortSignal.aborted) throw error;
      logger.warn(
        `[inference][${jobId}] Instagram title generation unavailable for bookmark "${bookmarkId}" (${error instanceof Error ? error.name : "unknown"}). Keeping original title.`,
      );
    }
  }

  await triggerSearchReindex(bookmarkId, {
    priority: job.priority,
    groupId: bookmarkData.userId,
  });
}
