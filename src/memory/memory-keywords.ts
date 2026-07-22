import { tokenize, uniqueStrings } from "../recall/recall-engine.js";

/** Extract CJK-aware keywords for memory indexing and recall. */
export function extractMemoryKeywords(content: string, limit = 16): string[] {
  const tokens = tokenize(content);
  const ngrams = expandCjkNgrams(tokens);
  const combined = uniqueStrings([...tokens, ...ngrams]);
  if (combined.length > 0) {
    return combined.slice(0, limit);
  }
  // Fallback: keep single CJK characters when tokenize filters length < 2.
  const cjk = uniqueStrings(
    [...content.toLowerCase().matchAll(/[\u4e00-\u9fa5]/gu)].map((match) => match[0] ?? "")
  ).filter(Boolean);
  return cjk.slice(0, Math.max(1, limit));
}

/** Expand CJK runs into overlapping bigrams/trigrams for recall overlap. */
export function expandCjkNgrams(tokens: string[]): string[] {
  const ngrams: string[] = [];
  for (const token of tokens) {
    if (!/^[\u4e00-\u9fa5]+$/u.test(token) || token.length < 2) {
      continue;
    }
    for (let index = 0; index < token.length - 1; index += 1) {
      ngrams.push(token.slice(index, index + 2));
    }
    if (token.length >= 3) {
      for (let index = 0; index < token.length - 2; index += 1) {
        ngrams.push(token.slice(index, index + 3));
      }
    }
  }
  return uniqueStrings(ngrams);
}

/** Query tokens plus CJK n-grams, used by RecallEngine scoring. */
export function expandQueryTokens(query: string): string[] {
  const tokens = tokenize(query);
  return uniqueStrings([...tokens, ...expandCjkNgrams(tokens)]);
}
