import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMissingSimilarityDocument,
  withTaggingDeadline,
} from "./taggingResilience";

afterEach(() => vi.useRealTimers());

describe("tagging stage deadlines", () => {
  it("cancels slow inference before it consumes the whole job deadline", async () => {
    vi.useFakeTimers();
    let received: AbortSignal | undefined;
    const result = withTaggingDeadline(
      new AbortController().signal,
      50,
      async (signal) => {
        received = signal;
        return new Promise<string>(() => {
          /* Simulate an unresponsive provider. */
        });
      },
    );
    const assertion = expect(result).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(received?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not start work after queue cancellation", async () => {
    const controller = new AbortController();
    const operation = vi.fn();
    controller.abort(new Error("queue cancelled"));
    await expect(
      withTaggingDeadline(controller.signal, 50, operation),
    ).rejects.toThrow("queue cancelled");
    expect(operation).not.toHaveBeenCalled();
  });
  it("clears the timer after successful work", async () => {
    vi.useFakeTimers();
    await expect(
      withTaggingDeadline(new AbortController().signal, 50, async () => [
        "Долги",
      ]),
    ).resolves.toEqual(["Долги"]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("distinguishes an unindexed vector from actual Meilisearch failures", () => {
    expect(isMissingSimilarityDocument({ code: "not_found_similar_id" })).toBe(
      true,
    );
    expect(isMissingSimilarityDocument({ code: "document_not_found" })).toBe(
      true,
    );
    expect(isMissingSimilarityDocument({ code: "invalid_api_key" })).toBe(
      false,
    );
    expect(isMissingSimilarityDocument(null)).toBe(false);
  });
});
