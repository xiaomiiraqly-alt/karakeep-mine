import type { Tiktoken } from "js-tiktoken";

import type { ZTagStyle } from "./types/users";
import { constructSummaryPrompt, constructTextTaggingPrompt } from "./prompts";

let encoding: Tiktoken | null = null;

/**
 * Lazy load the encoding to avoid loading the tiktoken data into memory
 * until it's actually needed
 */
async function getEncodingInstance(): Promise<Tiktoken> {
  if (!encoding) {
    // Dynamic import to lazy load the tiktoken module
    const { getEncoding } = await import("js-tiktoken");
    encoding = getEncoding("o200k_base");
  }
  return encoding;
}

async function calculateNumTokens(text: string): Promise<number> {
  const enc = await getEncodingInstance();
  return enc.encode(text).length;
}

async function truncateContent(
  content: string,
  length: number,
): Promise<string> {
  const enc = await getEncodingInstance();
  // Tokenizing is slow and blocks the event loop, so cut the content to a
  // generous upper bound of characters before encoding it.
  content = content.slice(0, length * 8);
  const tokens = enc.encode(content);
  if (tokens.length <= length) {
    return content;
  }
  const truncatedTokens = tokens.slice(0, length);
  return enc.decode(truncatedTokens);
}

/**
 * Remove duplicate whitespaces to avoid tokenization issues
 */
function preprocessContent(content: string) {
  return content.replace(/(\s){10,}/g, "$1");
}

export async function buildTextPrompt(
  lang: string,
  customPrompts: string[],
  content: string,
  contextLength: number,
  tagStyle: ZTagStyle,
  curatedTags?: string[],
  potentialRelevantTags?: string[],
): Promise<string> {
  content = preprocessContent(content);
  // Optional vocabulary hints must not consume all of the saved content.
  let hints = potentialRelevantTags;
  let available: number;
  const reserve = Math.min(
    128,
    await calculateNumTokens(content.slice(0, 512)),
  );
  while (true) {
    const template = constructTextTaggingPrompt(
      lang,
      customPrompts,
      "",
      tagStyle,
      curatedTags,
      hints,
    );
    available = contextLength - (await calculateNumTokens(template));
    if (available >= reserve && available >= 0) break;
    if (!hints?.length)
      throw new Error(
        "Tagging instructions exceed the context budget; reduce custom prompts or increase INFERENCE_CONTEXT_LENGTH",
      );
    hints = hints.slice(0, Math.floor(hints.length / 2));
  }
  const truncatedContent =
    available === 0 ? "" : await truncateContent(content, available);
  return constructTextTaggingPrompt(
    lang,
    customPrompts,
    truncatedContent,
    tagStyle,
    curatedTags,
    hints,
  );
}

export async function buildSummaryPrompt(
  lang: string,
  customPrompts: string[],
  content: string,
  contextLength: number,
): Promise<string> {
  content = preprocessContent(content);
  const promptTemplate = constructSummaryPrompt(lang, customPrompts, "");
  const promptSize = await calculateNumTokens(promptTemplate);
  const available = contextLength - promptSize;
  if (available <= 0 && content.trim())
    throw new Error(
      "Summary instructions exceed the context budget; reduce custom prompts or increase INFERENCE_CONTEXT_LENGTH",
    );
  const truncatedContent =
    available === 0 ? "" : await truncateContent(content, available);
  return constructSummaryPrompt(lang, customPrompts, truncatedContent);
}
