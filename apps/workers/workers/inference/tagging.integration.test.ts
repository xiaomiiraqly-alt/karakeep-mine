import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { InferenceClient } from "@karakeep/shared/inference";
import type { DequeuedJob } from "@karakeep/shared/queueing";
import type { ZOpenAIRequest } from "@karakeep/shared-server";

const state = vi.hoisted(() => ({ db: {} as object, events: vi.fn() }));
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
  readAsset: vi.fn(),
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
    await runTagging("b", request(), inference(["Хэллоуин", "Праздники", "Городские события", "Костюмы", "Севастополь"]));
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
