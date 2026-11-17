import { and, eq } from "drizzle-orm";

import type { ZOpenAIRequest } from "@karakeep/shared-server";
import { db } from "@karakeep/db";
import { bookmarks } from "@karakeep/db/schema";
import {
  addLogFields,
  OpenAIQueue,
  zOpenAIRequestSchema,
} from "@karakeep/shared-server";
import serverConfig from "@karakeep/shared/config";
import { InferenceClientFactory } from "@karakeep/shared/inference";
import logger from "@karakeep/shared/logger";
import { DequeuedJob, getQueueClient } from "@karakeep/shared/queueing";

import { workerStatsCounter } from "../../metrics";
import { withWorkerEventLog, withWorkerTracing } from "../../workerTracing";
import { runSummarization, SummarizationOutcome } from "./summarize";
import { runTagging } from "./tagging";
import type { TaggingOutcome } from "./taggingPolicy";

export type InferenceOutcome = TaggingOutcome | SummarizationOutcome;

async function attemptMarkStatus(
  jobData: object | undefined,
  status: "success" | "failure",
) {
  if (!jobData) {
    return;
  }
  try {
    const request = zOpenAIRequestSchema.parse(jobData);
    await db
      .update(bookmarks)
      .set({
        ...(request.type === "summarize"
          ? { summarizationStatus: status }
          : {}),
        ...(request.type === "tag" ? { taggingStatus: status } : {}),
      })
      .where(eq(bookmarks.id, request.bookmarkId));
  } catch (e) {
    logger.error(`Something went wrong when marking the tagging status: ${e}`);
  }
}

function isSummarizeJob(jobData: object | undefined): boolean {
  if (!jobData) {
    return false;
  }
  const parsed = zOpenAIRequestSchema.safeParse(jobData);
  return parsed.success && parsed.data.type === "summarize";
}

/** Clear the pending status if inference produced no result. */
async function attemptClearPendingStatus(jobData: object | undefined) {
  if (!jobData) return;
  try {
    const request = zOpenAIRequestSchema.parse(jobData);
    const status =
      request.type === "summarize"
        ? bookmarks.summarizationStatus
        : bookmarks.taggingStatus;
    await db
      .update(bookmarks)
      .set(
        request.type === "summarize"
          ? { summarizationStatus: null }
          : { taggingStatus: null },
      )
      .where(and(eq(bookmarks.id, request.bookmarkId), eq(status, "pending")));
  } catch (e) {
    logger.error("Failed to clear skipped inference status: " + e);
  }
}
export class OpenAiWorker {
  static async build() {
    logger.info("Starting inference worker ...");
    const worker = (await getQueueClient())!.createRunner<
      ZOpenAIRequest,
      InferenceOutcome
    >(
      OpenAIQueue,
      {
        run: withWorkerTracing(
          "inferenceWorker.run",
          withWorkerEventLog("inferenceWorker.run", runOpenAI),
        ),
        onComplete: async (job, result) => {
          if (result === "incomplete") {
            workerStatsCounter.labels("inference", "failed").inc();
            workerStatsCounter.labels("inference", "failed_permanent").inc();
            logger.warn(
              `[inference][${job.id}] Tagging incomplete; marking bookmark as failed without repeating the entire inference job.`,
            );
            await attemptMarkStatus(job.data, "failure");
            return;
          }
          // Skipped work must not count as successful AI processing.
          if (
            result === "skipped" ||
            (isSummarizeJob(job.data) && result !== "summarized")
          ) {
            await attemptClearPendingStatus(job.data);
            logger.info("[inference][" + job.id + "] Skipped without a result");
            return;
          }
          workerStatsCounter.labels("inference", "completed").inc();
          logger.info("[inference][" + job.id + "] Completed successfully");
          await attemptMarkStatus(job.data, "success");
        },
        onError: async (job) => {
          workerStatsCounter.labels("inference", "failed").inc();
          const jobId = job.id;
          logger.error(
            `[inference][${jobId}] inference job failed: ${job.error}\n${job.error.stack}`,
          );
          if (job.numRetriesLeft == 0) {
            workerStatsCounter.labels("inference", "failed_permanent").inc();
            await attemptMarkStatus(job?.data, "failure");
          }
        },
      },
      {
        concurrency: serverConfig.inference.numWorkers,
        pollIntervalMs: 1000,
        timeoutSecs: serverConfig.inference.jobTimeoutSec,
      },
    );

    return worker;
  }
}

async function runOpenAI(
  job: DequeuedJob<ZOpenAIRequest>,
): Promise<InferenceOutcome> {
  const jobId = job.id;

  const inferenceClient = InferenceClientFactory.build();
  if (!inferenceClient) {
    logger.debug(
      `[inference][${jobId}] No inference client configured, nothing to do now`,
    );
    // No model: neither tags nor summary was actually generated.
    return "skipped";
  }

  const request = zOpenAIRequestSchema.safeParse(job.data);
  if (!request.success) {
    throw new Error(
      `[inference][${jobId}] Got malformed job request: ${request.error.toString()}`,
    );
  }

  const { bookmarkId } = request.data;
  const bookmark = await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, bookmarkId),
    columns: {
      userId: true,
    },
  });

  addLogFields<"inferenceWorker.run">({
    "bookmark.id": bookmarkId,
    "inference.type": request.data.type,
    ...(bookmark ? { "user.id": bookmark.userId } : {}),
  });
  switch (request.data.type) {
    case "summarize":
      return await runSummarization(bookmarkId, job, inferenceClient);
    case "tag":
      return await runTagging(bookmarkId, job, inferenceClient);
    default:
      throw new Error(`Unknown inference type: ${request.data.type}`);
  }
}
