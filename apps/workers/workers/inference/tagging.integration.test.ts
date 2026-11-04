import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { InferenceClient } from "@karakeep/shared/inference";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import type { ZOpenAIRequest } from "@karakeep/shared-server";

const state = vi.hoisted(() => ({
  db: {} as object,
  events: vi.fn(),
  readAsset: vi.fn(),
}));
vi.mock("@karakeep/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = Reflect.get(state.db, key);
        return typeof value === "function" ? value.bind(state.db) : value;
      },
    },
  ),
}));
vi.mock("network", () => ({ getBookmarkDomain: vi.fn() }));
vi.mock("trpc", () => ({ buildImpersonatingTRPCClient: vi.fn() }));
vi.mock("@karakeep/shared/config", () => ({
  default: {
    embedding: { enableAutoIndexing: false },
    inference: {
      enableAutoTagging: true,
      contextLength: 4096,
      jobTimeoutSec: 120,
      inferredTagLang: "Russian",
    },
  },
}));
vi.mock("@karakeep/shared-server", () => ({
  addLogFields: vi.fn(),
  setSpanAttributes: vi.fn(),
  triggerSearchReindex: vi.fn(),
  ASSET_TYPES: {},
  readAsset: state.readAsset,
}));
vi.mock("@karakeep/trpc/lib/ruleEngine", () => ({
  RuleEngine: { triggerOnEvent: state.events },
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

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const request = () =>
  ({
    id: "job",
    data: { type: "tag", bookmarkId: "b" },
    abortSignal: new AbortController().signal,
  }) as DequeuedJob<ZOpenAIRequest>;
const inference = (tags: string[]) =>
  ({
    inferFromText: vi.fn(async () => ({ response: JSON.stringify({ tags }) })),
  }) as unknown as InferenceClient;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("../../packages/db/drizzle") });
  state.db = db;
  db.insert(schema.users)
    .values([
      { id: "u", email: "owner@example.test", name: "Owner" },
      { id: "other", email: "other@example.test", name: "Other" },
    ])
    .run();
  db.insert(schema.bookmarks)
    .values({ id: "b", userId: "u", type: BookmarkTypes.TEXT })
    .run();
  db.insert(schema.bookmarkTexts)
    .values({ id: "b", text: "Хэллоуин в Севастополе: рестораны и бары" })
    .run();
});
afterEach(() => sqlite?.close());

describe("full tagging persistence against migrated SQLite", () => {
  it.each(["text", "image"] as const)(
    "completes a short %s result to five existing thematic tags",
    async (kind) => {
      const names = [
        "Перголы",
        "Ландшафтный дизайн",
        "Архитектура",
        "Дерево",
        "Террасы",
      ];
      db.insert(schema.bookmarkTags)
        .values([
          ...names.map((name, i) => ({ id: "t" + i, userId: "u", name })),
          { id: "old", userId: "u", name: "Старый тег" },
          { id: "human", userId: "u", name: "Ручной тег" },
        ])
        .run();
      db.insert(schema.tagsOnBookmarks)
        .values([
          { bookmarkId: "b", tagId: "old", attachedBy: "ai" },
          { bookmarkId: "b", tagId: "human", attachedBy: "human" },
        ])
        .run();
      if (kind === "image") {
        db.delete(schema.bookmarkTexts).run();
        db.update(schema.bookmarks).set({ type: BookmarkTypes.ASSET }).run();
        db.insert(schema.bookmarkAssets)
          .values({
            id: "b",
            assetType: "image",
            assetId: "image-1",
            fileName: "IMG_001.png",
            content: null,
          })
          .run();
        state.readAsset.mockResolvedValue({
          asset: Buffer.from([137, 80, 78, 71]),
          metadata: { contentType: "image/png" },
        });
      } else {
        db.update(schema.bookmarkTexts)
          .set({
            text: "Деревянная пергола над террасой: архитектура и ландшафтный дизайн",
          })
          .run();
      }
      const infer = vi.fn(async (prompt: string) => {
        expect(prompt).toContain('"title" field');
        if (kind === "text")
          expect(prompt).toContain("Деревянная пергола над террасой");
        return {
          response: JSON.stringify({
            title: "Деревянная пергола над террасой",
            tags: prompt.includes("Complete the analysis")
              ? names
              : names.slice(0, 3),
          }),
        };
      });
      const result = await runTagging("b", request(), {
        inferFromText: infer,
        inferFromImage: infer,
      } as unknown as InferenceClient);
      expect(result).toBeUndefined();
      expect(infer).toHaveBeenCalledTimes(2);
      expect(infer.mock.calls[1][0]).toContain("at least five distinct");
      const saved = db.select().from(schema.tagsOnBookmarks).all();
      expect(saved).toHaveLength(6);
      expect(saved.some((tag) => tag.tagId === "old")).toBe(false);
      expect(saved.find((tag) => tag.tagId === "human")?.attachedBy).toBe(
        "human",
      );
      expect(db.select().from(schema.bookmarkTags).all()).toHaveLength(7);
      expect(db.select().from(schema.bookmarks).all()[0].title).toBe(
        "Деревянная пергола над террасой",
      );
    },
  );

  it.each([1, 2, 3, 4])(
    "keeps %i verified tags and saved links but reports incomplete after one completion pass",
    async (count) => {
      const names = ["Хэллоуин", "Севастополь", "Рестораны", "Бары"].slice(
        0,
        count,
      );
      db.insert(schema.bookmarkTags)
        .values([
          ...names.map((name, i) => ({ id: "t" + i, userId: "u", name })),
          { id: "old", userId: "u", name: "Старый тег" },
          { id: "human", userId: "u", name: "Ручной тег" },
        ])
        .run();
      db.insert(schema.tagsOnBookmarks)
        .values([
          { bookmarkId: "b", tagId: "old", attachedBy: "ai" },
          { bookmarkId: "b", tagId: "human", attachedBy: "human" },
        ])
        .run();
      const client = inference(names);
      expect(await runTagging("b", request(), client)).toBe("incomplete");
      expect(client.inferFromText).toHaveBeenCalledTimes(2);
      const saved = db.select().from(schema.tagsOnBookmarks).all();
      expect(saved).toHaveLength(count + 2);
      expect(saved.find((tag) => tag.tagId === "human")?.attachedBy).toBe(
        "human",
      );
      expect(saved.some((tag) => tag.tagId === "old")).toBe(true);
      expect(
        state.events.mock.calls
          .flatMap((call) => call[2])
          .some((event) => event.type === "tagRemoved"),
      ).toBe(false);
    },
  );

  it.each(["provider error", "unchecked new tags"])(
    "preserves verified progress when completion encounters %s",
    async (failure) => {
      const names = ["Хэллоуин", "Севастополь", "Рестораны"];
      db.insert(schema.bookmarkTags)
        .values(names.map((name, i) => ({ id: "t" + i, userId: "u", name })))
        .run();
      const infer = vi
        .fn()
        .mockResolvedValueOnce({ response: JSON.stringify({ tags: names }) });
      if (failure === "provider error") {
        infer.mockRejectedValueOnce(new Error("429"));
      } else {
        infer
          .mockResolvedValueOnce({
            response: JSON.stringify({
              tags: [...names, "Бары", "Мероприятия"],
            }),
          })
          .mockResolvedValueOnce({ response: '{"matches":[]}' });
      }
      expect(
        await runTagging("b", request(), {
          inferFromText: infer,
        } as unknown as InferenceClient),
      ).toBe("incomplete");
      expect(db.select().from(schema.tagsOnBookmarks).all()).toHaveLength(3);
      expect(db.select().from(schema.bookmarkTags).all()).toHaveLength(3);
      expect(infer).toHaveBeenCalledTimes(failure === "provider error" ? 2 : 3);
    },
  );

  it("respects curated restrictions and reports incomplete if fewer than five concepts are allowed", async () => {
    db.insert(schema.bookmarkTags)
      .values({ id: "chosen", userId: "u", name: "Хэллоуин" })
      .run();
    db.update(schema.users)
      .set({ curatedTagIds: ["chosen"] })
      .where(eq(schema.users.id, "u"))
      .run();
    const client = inference([
      "Хэллоуин",
      "VPN",
      "Нейросети",
      "Docker",
      "Разработка ПО",
    ]);
    expect(await runTagging("b", request(), client)).toBe("incomplete");
    expect(client.inferFromText).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.bookmarkTags).all()).toHaveLength(1);
    expect(db.select().from(schema.tagsOnBookmarks).all()).toHaveLength(1);
  });

  it("creates completion tags only after checking that existing vocabulary has no equivalent", async () => {
    const initial = ["Хэллоуин", "Севастополь", "Рестораны"];
    db.insert(schema.bookmarkTags)
      .values(initial.map((name, i) => ({ id: "t" + i, userId: "u", name })))
      .run();
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ response: JSON.stringify({ tags: initial }) })
      .mockResolvedValueOnce({
        response: JSON.stringify({ tags: [...initial, "Бары", "Мероприятия"] }),
      })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          matches: [
            { suggested: "Бары", existing: null },
            { suggested: "Мероприятия", existing: null },
          ],
        }),
      });
    expect(
      await runTagging("b", request(), {
        inferFromText: infer,
      } as unknown as InferenceClient),
    ).toBeUndefined();
    expect(infer).toHaveBeenCalledTimes(3);
    expect(infer.mock.calls[2][0]).toContain("exact semantic synonym");
    expect(db.select().from(schema.bookmarkTags).all()).toHaveLength(5);
    expect(db.select().from(schema.tagsOnBookmarks).all()).toHaveLength(5);
  });

  it("stores an AI title and topical tags for a newly created text note", async () => {
    const proposedTags = [
      "Хэллоуин",
      "Севастополь",
      "Рестораны",
      "Бары",
      "Мероприятия",
    ];
    const client = {
      inferFromText: vi.fn(async (prompt: string) => {
        expect(prompt).toContain('"title" field');
        expect(prompt).toContain("Хэллоуин в Севастополе");
        return {
          response: JSON.stringify({
            tags: proposedTags,
            title: "Хэллоуин в Севастополе: рестораны и бары",
          }),
        };
      }),
    } as unknown as InferenceClient;
    await runTagging("b", request(), client);
    expect(db.select().from(schema.bookmarks).all()[0].title).toBe(
      "Хэллоуин в Севастополе: рестораны и бары",
    );
    expect(db.select().from(schema.tagsOnBookmarks).all()).toHaveLength(5);
  });

  it("stores a visual AI title and tags for an image without OCR text", async () => {
    db.delete(schema.bookmarkTexts).run();
    db.update(schema.bookmarks)
      .set({ type: BookmarkTypes.ASSET, title: null })
      .run();
    db.insert(schema.bookmarkAssets)
      .values({
        id: "b",
        assetType: "image",
        assetId: "image-1",
        fileName: "IMG_001.png",
        content: null,
      })
      .run();
    state.readAsset.mockResolvedValue({
      asset: Buffer.from([137, 80, 78, 71]),
      metadata: { contentType: "image/png" },
    });
    const inferFromImage = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('"title" field');
      return {
        response: JSON.stringify({
          title: "Современная пергола с деревянными ламелями",
          tags: [
            "Перголы",
            "Ландшафтный дизайн",
            "Архитектура",
            "Дерево",
            "Террасы",
          ],
        }),
      };
    });
    await runTagging("b", request(), {
      inferFromImage,
    } as unknown as InferenceClient);
    expect(inferFromImage).toHaveBeenCalledTimes(1);
    expect(db.select().from(schema.bookmarks).all()[0].title).toBe(
      "Современная пергола с деревянными ламелями",
    );
    expect(db.select().from(schema.tagsOnBookmarks).all()).toHaveLength(5);
  });

  it("reuses four Cyrillic IDs, preserves human tags and is idempotent", async () => {
    const names = [
      "Хэллоуин",
      "Севастополь",
      "Рестораны И Бары",
      "Мероприятия",
      "Ночные события",
    ];
    db.insert(schema.bookmarkTags)
      .values(
        names.map((name, index) => ({ id: "t" + index, userId: "u", name })),
      )
      .run();
    db.insert(schema.tagsOnBookmarks)
      .values({ bookmarkId: "b", tagId: "t0", attachedBy: "human" })
      .run();
    await runTagging("b", request(), inference(names));
    const saved = db.select().from(schema.tagsOnBookmarks).all();
    expect(saved).toHaveLength(5);
    expect(saved.find((row) => row.tagId === "t0")?.attachedBy).toBe("human");
    expect(db.select().from(schema.bookmarkTags).all()).toHaveLength(5);
    expect(state.events).toHaveBeenLastCalledWith(
      "u",
      "b",
      expect.arrayContaining([
        expect.objectContaining({ type: "tagAdded", tagId: "t1" }),
      ]),
    );
    await runTagging("b", request(), inference(names));
    expect(db.select().from(schema.tagsOnBookmarks).all()).toEqual(saved);
    expect(state.events).toHaveBeenLastCalledWith("u", "b", []);
  });
  it("creates new vocabulary on an empty library without attaching another user's tag", async () => {
    db.insert(schema.bookmarkTags)
      .values({ id: "foreign", userId: "other", name: "Хэллоуин" })
      .run();
    await runTagging(
      "b",
      request(),
      inference([
        "Хэллоуин",
        "Праздники",
        "Городские события",
        "Костюмы",
        "Севастополь",
      ]),
    );
    const saved = db.select().from(schema.tagsOnBookmarks).all();
    expect(saved).toHaveLength(5);
    expect(saved.every((item) => item.tagId !== "foreign")).toBe(true);
    expect(db.select().from(schema.bookmarkTags).all()).toHaveLength(6);
  });
  it("preserves saved AI tags on empty output", async () => {
    db.insert(schema.bookmarkTags)
      .values({ id: "old", userId: "u", name: "Мероприятия" })
      .run();
    db.insert(schema.tagsOnBookmarks)
      .values({ bookmarkId: "b", tagId: "old", attachedBy: "ai" })
      .run();
    await runTagging("b", request(), inference([]));
    expect(db.select().from(schema.tagsOnBookmarks).all()).toMatchObject([
      { tagId: "old", attachedBy: "ai" },
    ]);
  });
  it("does not turn an invalid curated selection into permission to create new tags", async () => {
    db.update(schema.users)
      .set({ curatedTagIds: ["deleted"] })
      .run();
    const client = inference(["Новый тег"]);
    await runTagging("b", request(), client);
    expect(client.inferFromText).not.toHaveBeenCalled();
    expect(db.select().from(schema.bookmarkTags).all()).toEqual([]);
  });
  it("ignores disabled prompts", async () => {
    db.insert(schema.customPrompts)
      .values({
        userId: "u",
        text: "DISABLED PROMPT MUST NOT RUN",
        enabled: false,
        appliesTo: "text",
      })
      .run();
    const client = {
      inferFromText: vi.fn(async (prompt: string) => {
        expect(prompt).not.toContain("DISABLED PROMPT MUST NOT RUN");
        return { response: '{"tags":[]}' };
      }),
    } as unknown as InferenceClient;
    await runTagging("b", request(), client);
    expect(client.inferFromText).toHaveBeenCalledTimes(1);
  });
  it("does not save a title generated from text that changed during inference", async () => {
    const original = db.select().from(schema.bookmarks).all()[0];
    const client = {
      inferFromText: vi.fn(async () => {
        db.update(schema.bookmarks)
          .set({ modifiedAt: new Date(original.modifiedAt!.getTime() + 5000) })
          .run();
        db.update(schema.bookmarkTexts)
          .set({ text: "Совсем другая заметка" })
          .run();
        return {
          response: '{"tags":[],"title":"Старый заголовок про Хэллоуин"}',
        };
      }),
    } as unknown as InferenceClient;
    await runTagging("b", request(), client);
    expect(db.select().from(schema.bookmarks).all()[0].title).toBeNull();
  });
});
