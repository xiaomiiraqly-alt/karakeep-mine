import { describe, expect, it } from "vitest";
import { getEncoding } from "js-tiktoken";
import { buildSummaryPrompt, buildTextPrompt } from "./prompts.server";

describe("preserving evidence in inference prompts", () => {
  it("drops optional vocabulary before dropping saved content", async () => {
    const content = "Unique saved content about pergolas.";
    const baseline = await buildTextPrompt(
      "Russian",
      [],
      content,
      4096,
      "as-generated",
    );
    const encoding = getEncoding("o200k_base");
    const budget = encoding.encode(baseline).length + 10;
    const result = await buildTextPrompt(
      "Russian",
      [],
      content,
      budget,
      "as-generated",
      undefined,
      Array.from(
        { length: 100 },
        (_, i) => "Very long unrelated vocabulary hint " + i,
      ),
    );
    expect(result).toContain(content);
    expect(encoding.encode(result).length).toBeLessThanOrEqual(budget);
  });
  it("fails visibly instead of requesting tags or summaries without source content", async () => {
    await expect(
      buildTextPrompt("Russian", [], "Saved content", 1, "as-generated"),
    ).rejects.toThrow("context budget");
    await expect(
      buildSummaryPrompt("Russian", [], "Saved content", 1),
    ).rejects.toThrow("context budget");
  });
});
