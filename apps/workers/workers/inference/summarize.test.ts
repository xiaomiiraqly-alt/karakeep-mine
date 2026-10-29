import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceClient } from "@karakeep/shared/inference";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import type { ZOpenAIRequest } from "@karakeep/shared-server";
const mocks = vi.hoisted(() => ({
  bookmark: vi.fn(),
  user: vi.fn(),
  update: vi.fn(),
  reindex: vi.fn(),
}));
vi.mock("network", () => ({ getBookmarkDomain: vi.fn() }));
vi.mock("@karakeep/db", () => ({
  db: {
    query: {
      bookmarks: { findFirst: mocks.bookmark },
      users: { findFirst: mocks.user },
      customPrompts: { findMany: vi.fn(async () => []) },
    },
    update: mocks.update,
  },
}));
vi.mock("@karakeep/shared-server", () => ({
  addLogFields: vi.fn(),
  setSpanAttributes: vi.fn(),
  triggerSearchReindex: mocks.reindex,
}));
vi.mock("@karakeep/shared/config", () => ({
  default: {
    inference: {
      enableAutoSummarization: true,
      jobTimeoutSec: 1,
      contextLength: 4096,
      inferredTagLang: "Russian",
    },
  },
}));
vi.mock("@karakeep/trpc/models/bookmarks", () => ({
  Bookmark: { getBookmarkPlainTextContent: vi.fn(async () => "Saved caption") },
}));
vi.mock("./instagramVisual", () => ({
  getInstagramVisualContext: vi.fn(async () => ""),
}));
import { runSummarization } from "./summarize";
const request = (signal = new AbortController().signal) =>
  ({
    id: "job",
    data: { type: "summarize", bookmarkId: "b" },
    abortSignal: signal,
  }) as DequeuedJob<ZOpenAIRequest>;
const client = (inferFromText: ReturnType<typeof vi.fn>) =>
  ({ inferFromText }) as unknown as InferenceClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.bookmark.mockResolvedValue({
    id: "b",
    userId: "u",
    type: "link",
    title: null,
    link: {
      title: "Instagram — @test",
      url: "https://www.instagram.com/p/abc/",
      description: "Actual caption",
    },
  });
  mocks.user.mockResolvedValue({ autoSummarizationEnabled: true });
  mocks.update.mockReturnValue({
    set: () => ({ where: async () => undefined }),
  });
});
describe("summary failure boundaries", () => {
  it("does not write a response returned after queue cancellation", async () => {
    const controller = new AbortController();
    const infer = vi.fn(async () => {
      controller.abort(new Error("cancelled"));
      return { response: "A late summary" };
    });
    await expect(
      runSummarization("b", request(controller.signal), client(infer)),
    ).rejects.toThrow("cancelled");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects whitespace-only summaries", async () => {
    await expect(
      runSummarization(
        "b",
        request(),
        client(vi.fn(async () => ({ response: "   " }))),
      ),
    ).rejects.toThrow("empty response");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("keeps a saved summary successful when the optional title call hangs", async () => {
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ response: "A useful summary" })
      .mockImplementationOnce(
        async () =>
          new Promise(() => {
            /* Unresponsive optional title call. */
          }),
      );
    await runSummarization("b", request(), client(infer));
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.reindex).toHaveBeenCalledTimes(1);
  });
});
