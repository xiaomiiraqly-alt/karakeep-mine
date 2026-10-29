import path from "node:path";
import * as fs from "node:fs/promises";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { CrawlContext } from "./crawlerWorker";
const state = vi.hoisted(() => ({
  db: {} as object,
  download: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  gallery: vi.fn(),
  sequence: 0,
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
vi.mock("@karakeep/shared-server", () => ({
  newAssetId: () => "new-" + ++state.sequence,
  saveAssetFromFile: state.save,
  silentDeleteAsset: state.remove,
  QuotaService: { checkStorageQuota: vi.fn(async () => true) },
}));
vi.mock("network", () => ({ getProxyAgent: vi.fn() }));
vi.mock("execa", () => ({ execa: state.gallery }));
vi.mock("./utils/instagramPublic", () => ({
  downloadPublicInstagramPost: state.download,
}));
vi.mock("@karakeep/shared/config", () => ({ default: { maxAssetSizeMb: 50 } }));
import { importInstagramPost } from "./instagram";
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;
const context = (signal = new AbortController().signal) =>
  ({
    url: "https://www.instagram.com/p/abc/",
    bookmarkId: "b",
    userId: "u",
    runProxy: false,
    abortSignal: signal,
    log: { info: vi.fn(), warn: vi.fn() },
  }) as unknown as CrawlContext;
beforeEach(() => {
  vi.clearAllMocks();
  state.sequence = 0;
  sqlite = new Database(":memory:");
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve("../../packages/db/drizzle") });
  state.db = db;
  db.insert(schema.users)
    .values({ id: "u", email: "user@example.test", name: "User" })
    .run();
  db.insert(schema.bookmarks)
    .values({ id: "b", userId: "u", type: BookmarkTypes.LINK })
    .run();
  db.insert(schema.bookmarkLinks)
    .values({
      id: "b",
      url: "https://www.instagram.com/p/abc/",
      title: "Готовый заголовок Хэллоуин",
    })
    .run();
  db.insert(schema.assets)
    .values({
      id: "old",
      userId: "u",
      bookmarkId: "b",
      assetType: schema.AssetTypes.LINK_BANNER_IMAGE,
    })
    .run();
  state.save.mockResolvedValue(undefined);
  state.remove.mockResolvedValue(undefined);
  state.download.mockImplementation(async (_code: string, folder: string) => {
    for (const number of ["001", "002"]) {
      await fs.writeFile(
        path.join(folder, number + ".jpg"),
        Buffer.from([255, 216, 255, 217]),
      );
      await fs.writeFile(
        path.join(folder, number + ".jpg.json"),
        JSON.stringify({
          num: Number(number),
          description: "Куда идти на Хэллоуин",
          username: "test",
        }),
      );
    }
    return 2;
  });
});
afterEach(() => sqlite?.close());
describe("Instagram import transaction and cleanup", () => {
  it("keeps descriptive titles and replaces gallery assets atomically", async () => {
    expect(await importInstagramPost(context())).toBe(true);
    const link = db.select().from(schema.bookmarkLinks).all()[0];
    expect(link.title).toBe("Готовый заголовок Хэллоуин");
    expect(link.htmlContent).toContain("<h1>Готовый заголовок Хэллоуин</h1>");
    expect(
      db
        .select()
        .from(schema.assets)
        .all()
        .map((asset) => asset.id)
        .sort(),
    ).toEqual(["new-1", "new-2"]);
    expect(state.remove).toHaveBeenCalledWith("u", "old");
    expect(state.gallery).not.toHaveBeenCalled();
  });
  it("propagates cancellation and removes the temporary directory", async () => {
    const controller = new AbortController();
    let folder = "";
    state.download.mockImplementationOnce(
      async (_code: string, target: string) => {
        folder = target;
        controller.abort(new Error("cancelled import"));
        throw controller.signal.reason;
      },
    );
    await expect(
      importInstagramPost(context(controller.signal)),
    ).rejects.toThrow("cancelled import");
    expect(state.gallery).not.toHaveBeenCalled();
    expect(db.select().from(schema.assets).all()[0].id).toBe("old");
    await expect(fs.stat(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("cleans saved files and preserves old records if saving a later asset fails", async () => {
    state.save
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"));
    expect(await importInstagramPost(context())).toBe(false);
    expect(
      db
        .select()
        .from(schema.assets)
        .all()
        .map((asset) => asset.id),
    ).toEqual(["old"]);
    expect(state.remove).toHaveBeenCalledWith("u", "new-1");
    expect(state.remove).not.toHaveBeenCalledWith("u", "old");
  });
});
