import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findBookmark: vi.fn(),
  findUser: vi.fn(),
  findTags: vi.fn(),
  transaction: vi.fn(),
  vector: vi.fn(),
  reindex: vi.fn(),
}));
vi.mock("network", () => ({ getBookmarkDomain: vi.fn() }));
vi.mock("trpc", () => ({ buildImpersonatingTRPCClient: vi.fn() }));
vi.mock("@karakeep/db", () => ({
  db: {
    query: {
      bookmarks: { findFirst: mocks.findBookmark },
      users: { findFirst: mocks.findUser },
      bookmarkTags: { findMany: mocks.findTags },
      customPrompts: { findMany: vi.fn(async () => []) },
    },
    transaction: mocks.transaction,
  },
}));
vi.mock("@karakeep/shared/vectorStore", () => ({
  getVectorStoreClient: mocks.vector,
}));
vi.mock("@karakeep/shared-server", () => ({
  addLogFields: vi.fn(),
  setSpanAttributes: vi.fn(),
  triggerSearchReindex: mocks.reindex,
  ASSET_TYPES: {},
  readAsset: vi.fn(),
}));
vi.mock("@karakeep/shared/config", () => ({
  default: {
    embedding: { enableAutoIndexing: true },
    inference: {
      enableAutoTagging: true,
      contextLength: 4096,
      jobTimeoutSec: 30,
      inferredTagLang: "Russian",
    },
  },
}));
vi.mock("@karakeep/trpc/lib/ruleEngine", () => ({
  RuleEngine: { triggerOnEvent: vi.fn() },
}));
vi.mock("@karakeep/trpc/models/bookmarks", () => ({ Bookmark: {} }));
vi.mock("@karakeep/trpc/models/webhooks.service", () => ({
  WebhooksService: class {
    triggerWebhook = vi.fn();
  },
}));
vi.mock("./instagramVisual", () => ({
  getInstagramVisualContext: vi.fn(async () => ""),
}));

import { runTagging } from "./tagging";
import serverConfig from "@karakeep/shared/config";
import type { InferenceClient } from "@karakeep/shared/inference";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import type { ZOpenAIRequest } from "@karakeep/shared-server";

const job = () =>
  ({
    id: "j",
    data: { type: "tag", bookmarkId: "b" },
    abortSignal: new AbortController().signal,
  }) as DequeuedJob<ZOpenAIRequest>;
const client = (inferFromText: ReturnType<typeof vi.fn>) =>
  ({ inferFromText }) as unknown as InferenceClient;

beforeEach(() => {
  vi.clearAllMocks();
  serverConfig.embedding.enableAutoIndexing = true;
  mocks.findBookmark.mockResolvedValue({
    id: "b",
    userId: "u",
    type: "text",
    text: { text: "Как погасить задолженность по кредитам" },
  });
  mocks.findUser.mockResolvedValue({ autoTaggingEnabled: true });
  mocks.findTags.mockResolvedValue([
    { name: "Долги" },
    { name: "Личные финансы" },
  ]);
  mocks.vector.mockResolvedValue(null);
  mocks.transaction.mockImplementation(async (fn) =>
    fn({
      query: {
        bookmarkTags: {
          findMany: () => ({
            sync: () => [{ name: "Долги" }, { name: "Личные финансы" }],
          }),
        },
      },
    }),
  );
});

describe("tagging failure safety", () => {
  it.each(['{"tags":[]}', '{"tags":[" ","#"]}'])(
    "preserves saved tags for empty/invalid generated labels: %s",
    async (response) => {
      const infer = vi.fn(async () => ({ response }));
      await runTagging("b", job(), client(infer));
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.reindex).not.toHaveBeenCalled();
    },
  );
  it("passes existing vocabulary even when the vector document is missing", async () => {
    mocks.vector.mockResolvedValue({
      findSimilar: vi.fn().mockRejectedValue({ code: "not_found_similar_id" }),
    });
    const infer = vi.fn(async (_prompt: string) => ({
      response: '{"tags":[]}',
    }));
    await runTagging("b", job(), client(infer));
    expect(infer.mock.calls[0][0]).toContain("Личные финансы");
    expect(infer).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("does not create unchecked tags after an empty semantic response", async () => {
    const infer = vi
      .fn()
      .mockResolvedValueOnce({
        response: '{"tags":["Долги","Бюджетирование"]}',
      })
      .mockResolvedValueOnce({ response: "" });
    await runTagging("b", job(), client(infer));
    expect(infer).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("does not create new tags when the semantic response omits the suggestion", async () => {
    const infer = vi
      .fn()
      .mockResolvedValueOnce({
        response: '{"tags":["Долги","Бюджетирование"]}',
      })
      .mockResolvedValueOnce({ response: '{"matches":[]}' });
    await runTagging("b", job(), client(infer));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("propagates invalid primary responses without overwriting old tags", async () => {
    await expect(
      runTagging("b", job(), client(vi.fn(async () => ({ response: "" })))),
    ).rejects.toThrow("expected JSON");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("reuses a known synonym without a second inference request", async () => {
    const insert = vi.fn(() => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: () => ({ all: () => [] }) }),
      }),
    }));
    mocks.transaction.mockImplementationOnce(async (fn) =>
      fn({
        query: {
          bookmarkTags: {
            findMany: () => ({
              sync: () => [
                { name: "Искусственный интеллект", id: "existing-ai" },
              ],
            }),
          },
        },
        delete: () => ({
          where: () => ({ returning: () => ({ all: () => [] }) }),
        }),
        insert,
      }),
    );
    mocks.findTags.mockResolvedValue([{ name: "Искусственный интеллект" }]);
    const infer = vi.fn(async () => ({ response: '{"tags":["ИИ"]}' }));
    await runTagging("b", job(), client(infer));
    expect(infer).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(mocks.reindex).toHaveBeenCalledTimes(1);
  });
  it("propagates queue cancellation during optional lookup", async () => {
    const request = job();
    const controller = new AbortController();
    request.abortSignal = controller.signal;
    mocks.vector.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled lookup"));
      return null;
    });
    const infer = vi.fn();
    await expect(runTagging("b", request, client(infer))).rejects.toThrow(
      "cancelled lookup",
    );
    expect(infer).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("skips unmaintained vector indexes but still supplies existing vocabulary", async () => {
    serverConfig.embedding.enableAutoIndexing = false;
    const infer = vi.fn(async (_prompt: string) => ({
      response: '{"tags":[]}',
    }));
    await runTagging("b", job(), client(infer));
    expect(mocks.vector).not.toHaveBeenCalled();
    expect(infer.mock.calls[0][0]).toContain("Личные финансы");
    expect(infer).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
