import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import type { InferenceClient } from "@karakeep/shared/inference";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import type { ZOpenAIRequest } from "@karakeep/shared-server";
const mocks = vi.hoisted(() => ({
  bookmark: vi.fn(),
  user: vi.fn(),
  update: vi.fn(),
  reindex: vi.fn(),
  plainText: vi.fn(),
  visual: vi.fn(),
}));
vi.mock("../../network", () => ({ getBookmarkDomain: vi.fn() }));
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
  Bookmark: { getBookmarkPlainTextContent: mocks.plainText },
}));
vi.mock("./instagramVisual", () => ({
  getInstagramVisualContext: mocks.visual,
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
  mocks.plainText.mockResolvedValue("Saved caption");
  mocks.visual.mockResolvedValue("");
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

describe("upstream summary formats with custom Instagram processing", () => {
  it.each([
    {
      type: "text",
      text: { text: "Important saved note" },
      expected: "Important saved note",
    },
    {
      type: "asset",
      asset: { content: "Extracted PDF contents", fileName: "paper.pdf" },
      expected: "Extracted PDF contents",
    },
    {
      type: "asset",
      asset: { content: "Recovered image text", fileName: "scan.png" },
      expected: "Recovered image text",
    },
  ])(
    "summarizes $expected without reading link assets",
    async ({ expected, ...bookmark }) => {
      mocks.bookmark.mockResolvedValue({ id: "b", userId: "u", ...bookmark });
      const infer = vi
        .fn()
        .mockResolvedValue({ response: "Saved summary", totalTokens: 8 });
      await expect(
        runSummarization("b", request(), client(infer)),
      ).resolves.toBe("summarized");
      expect(infer).toHaveBeenCalledWith(
        expect.stringContaining(expected),
        expect.any(Object),
      );
      expect(mocks.plainText).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledTimes(1);
      expect(mocks.reindex).toHaveBeenCalledTimes(1);
    },
  );

  it("skips an empty asset without writing a fictitious summary", async () => {
    mocks.bookmark.mockResolvedValue({
      id: "b",
      userId: "u",
      type: "asset",
      asset: { content: "  ", fileName: "photo.jpg" },
    });
    const infer = vi.fn();
    await expect(runSummarization("b", request(), client(infer))).resolves.toBe(
      "skipped",
    );
    expect(infer).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("can summarize an Instagram post from visual observations alone", async () => {
    mocks.bookmark.mockResolvedValue({
      id: "b",
      userId: "u",
      type: "link",
      title: "My manually assigned title",
      link: {
        title: "Instagram",
        url: "https://www.instagram.com/p/abc/",
        description: null,
      },
    });
    mocks.plainText.mockResolvedValue("");
    mocks.visual.mockResolvedValue("A red bicycle parked next to a tree");
    const infer = vi
      .fn()
      .mockResolvedValue({ response: "A bicycle photograph", totalTokens: 8 });
    await expect(runSummarization("b", request(), client(infer))).resolves.toBe(
      "summarized",
    );
    expect(infer).toHaveBeenCalledTimes(1);
    expect(infer).toHaveBeenCalledWith(
      expect.stringContaining("A red bicycle"),
      expect.any(Object),
    );
  });
});

describe("Instagram title concurrency", () => {
  it("guards the cached Reader HTML against an intervening recrawl", async () => {
    const oldHtml =
      "<article><h1>Instagram — @test</h1><p>Old gallery</p></article>";
    mocks.bookmark.mockResolvedValue({
      id: "b",
      userId: "u",
      type: "link",
      title: null,
      link: {
        title: "Instagram — @test",
        url: "https://www.instagram.com/p/abc/",
        description: "A mountain bicycle",
        htmlContent: oldHtml,
      },
    });
    const filters: SQL[] = [];
    mocks.update.mockReturnValue({
      set: () => ({
        where: (filter: SQL) => {
          filters.push(filter);
          return { returning: async () => [] };
        },
      }),
    });
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ response: "A mountain bicycle in the forest" })
      .mockResolvedValueOnce({
        response: "Горный велосипед в осеннем лесу",
      });
    await expect(
      runSummarization("b", request(), client(infer)),
    ).resolves.toBe("summarized");
    expect(filters).toHaveLength(2);
    const titleGuard = new SQLiteSyncDialect().sqlToQuery(filters[1]);
    expect(titleGuard.sql).toContain("htmlContent");
    expect(titleGuard.params).toContain(oldHtml);
  });
});
