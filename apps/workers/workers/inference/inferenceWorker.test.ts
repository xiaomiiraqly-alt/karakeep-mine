import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZOpenAIRequest } from "@karakeep/shared-server";
import type { DequeuedJob, RunnerFuncs } from "@karakeep/shared/queueing";
import type { TaggingOutcome } from "./taggingPolicy";

const mocks = vi.hoisted(() => ({
  runner: vi.fn(),
  set: vi.fn(),
  tag: vi.fn<() => Promise<TaggingOutcome>>(),
  summarize: vi.fn(),
  labels: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("metrics", () => ({
  workerStatsCounter: { labels: mocks.labels },
}));
vi.mock("workerTracing", () => ({
  withWorkerTracing: (_name: string, fn: unknown) => fn,
  withWorkerEventLog: (_name: string, fn: unknown) => fn,
}));
vi.mock("@karakeep/db", () => ({
  db: {
    query: { bookmarks: { findFirst: async () => ({ userId: "u" }) } },
    update: () => ({ set: mocks.set }),
  },
}));
vi.mock("@karakeep/shared-server", () => ({
  addLogFields: vi.fn(),
  OpenAIQueue: {},
  zOpenAIRequestSchema: {
    parse: (data: unknown) => data,
    safeParse: (data: unknown) => ({ success: true, data }),
  },
}));
vi.mock("@karakeep/shared/config", () => ({
  default: { inference: { numWorkers: 1, jobTimeoutSec: 120 } },
}));
vi.mock("@karakeep/shared/inference", () => ({
  InferenceClientFactory: { build: () => ({}) },
}));
vi.mock("@karakeep/shared/logger", () => ({
  default: {
    info: mocks.info,
    warn: mocks.warn,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("@karakeep/shared/queueing", () => ({
  getQueueClient: async () => ({ createRunner: mocks.runner }),
}));
vi.mock("./tagging", () => ({ runTagging: mocks.tag }));
vi.mock("./summarize", () => ({ runSummarization: mocks.summarize }));

import { OpenAiWorker } from "./inferenceWorker";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.set.mockReturnValue({ where: async () => undefined });
  mocks.labels.mockReturnValue({ inc: vi.fn() });
  mocks.tag.mockResolvedValue(undefined);
});

describe("inference completion status", () => {
  it.each([undefined, "incomplete"] as const)(
    "propagates the tagging outcome %s through tracing into bookmark status",
    async (outcome) => {
      mocks.tag.mockResolvedValue(outcome);
      await OpenAiWorker.build();
      const callbacks = mocks.runner.mock.calls[0][1] as RunnerFuncs<
        ZOpenAIRequest,
        TaggingOutcome
      >;
      const job: DequeuedJob<ZOpenAIRequest> = {
        id: "job",
        data: { type: "tag", bookmarkId: "b" },
        priority: 0,
        runNumber: 0,
        abortSignal: new AbortController().signal,
      };
      const result = await callbacks.run(job);
      expect(result).toBe(outcome);
      await callbacks.onComplete!(job, result);
      expect(mocks.set).toHaveBeenLastCalledWith({
        taggingStatus: outcome === "incomplete" ? "failure" : "success",
      });
      if (outcome === "incomplete") {
        expect(mocks.info).not.toHaveBeenCalledWith(
          expect.stringContaining("Completed successfully"),
        );
        expect(mocks.labels).toHaveBeenCalledWith("inference", "failed");
      }
    },
  );
});
