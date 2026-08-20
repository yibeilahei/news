import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFeedXml } from "../src/feeds.js";
import { normalizeUrl } from "../src/dedup.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-feed.xml");

describe("parseFeedXml", () => {
  it("parses RSS 2.0 items in UTF-8 Japanese", async () => {
    const xml = readFileSync(fixture, "utf8");
    const items = await parseFeedXml(xml, {
      name: "テスト",
      url: "https://example.co.jp/rss.xml",
      category: "ニュース",
      enabled: true,
    });
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("臨時国会が開会した");
    expect(items[0].url).toContain("example.co.jp/news/2026/08/20/diet");
    expect(items[0].summaryText).toContain("臨時国会");
    expect(items[0].publishedAt).toBeInstanceOf(Date);
    expect(items[1].author).toBe("報道部");
  });
});

describe("feed URL tracking params", () => {
  it("keeps the article path after RSS tracking params are stripped later", () => {
    const normalized = normalizeUrl(
      "https://example.co.jp/news/2026/08/20/diet?utm_source=rss&utm_medium=feed",
    );
    expect(normalized).toBe("https://example.co.jp/news/2026/08/20/diet");
  });
});
