import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZOpenAIRequest } from "@karakeep/shared-server";
import type { DequeuedJob, RunnerFuncs } from "@karakeep/shared/queueing";
import type { TaggingOutcome } from "./taggingPolicy";
import type { InferenceOutcome } from "./inferenceWorker";

const mocks = vi.hoisted(() => ({
  runner: vi.fn(),
  buildClient: vi.fn(),
  set: vi.fn(),
  tag: vi.fn<() => Promise<TaggingOutcome>>(),
  summarize: vi.fn(),
  labels: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../metrics", () => ({
  workerStatsCounter: { labels: mocks.labels },
}));
vi.mock("../../workerTracing", () => ({
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
  InferenceClientFactory: { build: mocks.buildClient },
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
  mocks.buildClient.mockReturnValue({});
  mocks.summarize.mockResolvedValue("summarized");
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

describe("upstream summarization outcomes", () => {
  it.each(["summarized", "skipped"] as const)(
    "records %s without confusing tagging outcomes",
    async (outcome) => {
      mocks.summarize.mockResolvedValue(outcome);
      await OpenAiWorker.build();
      const callbacks = mocks.runner.mock.calls[0][1] as RunnerFuncs<
        ZOpenAIRequest,
        InferenceOutcome
      >;
      const job: DequeuedJob<ZOpenAIRequest> = {
        id: "job",
        data: { type: "summarize", bookmarkId: "b" },
        priority: 0,
        runNumber: 0,
        abortSignal: new AbortController().signal,
      };
      const result = await callbacks.run(job);
      expect(result).toBe(outcome);
      await callbacks.onComplete!(job, result);
      expect(mocks.set).toHaveBeenLastCalledWith({
        summarizationStatus: outcome === "summarized" ? "success" : null,
      });
    },
  );

  it("clears pending summarization when no inference client is configured", async () => {
    mocks.buildClient.mockReturnValue(null);
    await OpenAiWorker.build();
    const callbacks = mocks.runner.mock.calls[0][1] as RunnerFuncs<
      ZOpenAIRequest,
      InferenceOutcome
    >;
    const job: DequeuedJob<ZOpenAIRequest> = {
      id: "job",
      data: { type: "summarize", bookmarkId: "b" },
      priority: 0,
      runNumber: 0,
      abortSignal: new AbortController().signal,
    };
    const result = await callbacks.run(job);
    expect(result).toBe("skipped");
    await callbacks.onComplete!(job, result);
    expect(mocks.set).toHaveBeenLastCalledWith({ summarizationStatus: null });
    expect(mocks.summarize).not.toHaveBeenCalled();
  });
  it("does not claim successful tagging when no model is configured", async () => {
    mocks.buildClient.mockReturnValue(null);
    await OpenAiWorker.build();
    const callbacks = mocks.runner.mock.calls[0][1] as RunnerFuncs<
      ZOpenAIRequest,
      InferenceOutcome
    >;
    const job: DequeuedJob<ZOpenAIRequest> = {
      id: "no-model-tag",
      data: { type: "tag", bookmarkId: "b" },
      priority: 0,
      runNumber: 0,
      abortSignal: new AbortController().signal,
    };
    const result = await callbacks.run(job);
    expect(result).toBe("skipped");
    await callbacks.onComplete!(job, result);
    expect(mocks.set).toHaveBeenLastCalledWith({ taggingStatus: null });
    expect(mocks.tag).not.toHaveBeenCalled();
    expect(mocks.labels).not.toHaveBeenCalledWith("inference", "completed");
  });

  it("clears pending status for user-disabled tagging", async () => {
    mocks.tag.mockResolvedValue("skipped");
    await OpenAiWorker.build();
    const callbacks = mocks.runner.mock.calls[0][1] as RunnerFuncs<
      ZOpenAIRequest,
      InferenceOutcome
    >;
    const job: DequeuedJob<ZOpenAIRequest> = {
      id: "disabled-tag",
      data: { type: "tag", bookmarkId: "b" },
      priority: 0,
      runNumber: 0,
      abortSignal: new AbortController().signal,
    };
    expect(await callbacks.run(job)).toBe("skipped");
    await callbacks.onComplete!(job, "skipped");
    expect(mocks.set).toHaveBeenLastCalledWith({ taggingStatus: null });
  });
});
