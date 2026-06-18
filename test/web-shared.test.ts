import { describe, expect, it } from "vitest";

import {
  buildCitation,
  buildCitationId,
  braveFreshnessFromRecencyDays,
  makeCacheKey,
  readJsonResponse,
  sliceByBytes
} from "../src/tools/web-shared.js";

describe("web-shared", () => {
  it("reports HTTP status before attempting JSON parse on error responses", async () => {
    await expect(
      readJsonResponse(
        new Response("<html>bad gateway</html>", { status: 502 }),
        "Web search"
      )
    ).rejects.toThrow("Web search failed with HTTP status 502.");
  });

  it("maps recencyDays to Brave freshness buckets", () => {
    expect(braveFreshnessFromRecencyDays(1)).toBe("pd");
    expect(braveFreshnessFromRecencyDays(7)).toBe("pw");
    expect(braveFreshnessFromRecencyDays(30)).toBe("pm");
    expect(braveFreshnessFromRecencyDays(365)).toBe("py");
  });

  it("truncates strings by UTF-8 byte length", () => {
    const value = "你好世界".repeat(20);
    const truncated = sliceByBytes(value, 24);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(24);
    expect(truncated.length).toBeLessThan(value.length);
  });

  it("builds stable citation metadata", () => {
    const citation = buildCitation({
      id: buildCitationId("search", 2),
      source: "provider",
      text: "Snippet ".repeat(40),
      title: "Result",
      url: "https://example.com/result"
    });

    expect(citation.citationId).toBe("search:2");
    expect(citation.citedText.length).toBe(150);
    expect(citation.source).toBe("provider");
    expect(buildCitationId("extract", "https://example.com/result")).toMatch(/^extract:[a-f0-9]{12}$/u);
  });

  it("builds stable cache keys with undefined normalized to null", () => {
    expect(makeCacheKey(["http", "https://example.com", undefined, 100])).toBe(
      makeCacheKey(["http", "https://example.com", null, 100])
    );
  });
});
