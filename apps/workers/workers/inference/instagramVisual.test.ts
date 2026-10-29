import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceClient } from "@karakeep/shared/inference";
const mocks = vi.hoisted(() => ({ assets: vi.fn(), read: vi.fn() }));
vi.mock("@karakeep/db", () => ({
  db: { query: { assets: { findMany: mocks.assets } } },
}));
vi.mock("@karakeep/shared-server", () => ({ readAsset: mocks.read }));
vi.mock("sharp", () => ({
  default: () => ({
    rotate() {
      return this;
    },
    resize() {
      return this;
    },
    jpeg() {
      return this;
    },
    async toBuffer() {
      return Buffer.from("jpeg");
    },
  }),
}));
import { getInstagramVisualContext } from "./instagramVisual";
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  sequence++;
  mocks.assets.mockResolvedValue([
    { id: "a", assetType: "linkBannerImage", fileName: "001.jpg" },
    { id: "b", assetType: "linkInstagramImage", fileName: "002.jpg" },
  ]);
  mocks.read.mockResolvedValue({ asset: Buffer.from("image") });
});
afterEach(() => vi.useRealTimers());
const url = "https://www.instagram.com/p/abc/";
const client = (inferFromImage: ReturnType<typeof vi.fn>) =>
  ({ inferFromImage }) as unknown as InferenceClient;

describe("bounded Instagram visual context", () => {
  it("retains finished observations if a later frame exceeds the budget and reuses them for summary", async () => {
    vi.useFakeTimers();
    const infer = vi
      .fn()
      .mockResolvedValueOnce({ response: "Poster: Halloween in Sevastopol" })
      .mockImplementationOnce(
        async () =>
          new Promise(() => {
            /* Simulate an unresponsive vision call. */
          }),
      );
    const bookmarkId = "partial-" + sequence;
    const pending = getInstagramVisualContext(
      url,
      bookmarkId,
      "u",
      client(infer),
      new AbortController().signal,
      5000,
    );
    const assertion = expect(pending).resolves.toContain(
      "Halloween in Sevastopol",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    const result = await pending;
    expect(infer).toHaveBeenCalledTimes(2);
    expect(
      await getInstagramVisualContext(
        url,
        bookmarkId,
        "u",
        client(infer),
        new AbortController().signal,
        5000,
      ),
    ).toBe(result);
    expect(infer).toHaveBeenCalledTimes(2);
  });
  it("invalidates cached observations when assets or owner change", async () => {
    const infer = vi.fn(async () => ({ response: "Visible text" }));
    const bookmarkId = "cache-" + sequence;
    await getInstagramVisualContext(
      url,
      bookmarkId,
      "u",
      client(infer),
      new AbortController().signal,
    );
    await getInstagramVisualContext(
      url,
      bookmarkId,
      "other",
      client(infer),
      new AbortController().signal,
    );
    expect(infer).toHaveBeenCalledTimes(4);
    mocks.assets.mockResolvedValue([
      { id: "new", assetType: "linkBannerImage", fileName: "001.jpg" },
    ]);
    await getInstagramVisualContext(
      url,
      bookmarkId,
      "u",
      client(infer),
      new AbortController().signal,
    );
    expect(infer).toHaveBeenCalledTimes(5);
  });
  it("propagates job cancellation without converting it into partial success", async () => {
    const controller = new AbortController();
    const infer = vi.fn(async () => {
      controller.abort(new Error("cancelled"));
      throw controller.signal.reason;
    });
    await expect(
      getInstagramVisualContext(
        url,
        "abort-" + sequence,
        "u",
        client(infer),
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  });
});
