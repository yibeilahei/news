import { describe, expect, it } from "vitest";
import { Deduper, normalizeTitle, normalizeUrl, titleSourceKey } from "../src/dedup.js";
import type { Article } from "../src/models.js";

function article(partial: Partial<Article> & Pick<Article, "canonicalUrl" | "normalizedUrl" | "title" | "source">): Article {
  const now = new Date("2026-08-20T01:00:00Z");
  return {
    id: partial.id ?? "1",
    category: "ニュース",
    url: partial.url ?? partial.canonicalUrl,
    publishedAt: partial.publishedAt ?? now,
    author: null,
    html: "<p>本文</p>",
    text: "本文",
    rssSummary: null,
    images: [],
    extractionStatus: "full",
    paywalled: false,
    inaccessible: false,
    firstSeenAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe("normalizeUrl", () => {
  it("strips tracking params, www, hash, and trailing slash", () => {
    expect(
      normalizeUrl("http://www.example.co.jp/a/b/?utm_source=x&id=1#frag"),
    ).toBe("https://example.co.jp/a/b?id=1");
  });

  it("treats mobile hosts as the same site when they use m.", () => {
    expect(normalizeUrl("https://m.example.co.jp/story")).toBe(
      "https://example.co.jp/story",
    );
  });

  it("strips AMP suffixes", () => {
    expect(normalizeUrl("https://example.co.jp/story/amp")).toBe(
      "https://example.co.jp/story",
    );
  });
});

describe("Deduper", () => {
  it("matches canonical URL first", () => {
    const d = new Deduper();
    d.add(
      article({
        canonicalUrl: "https://example.co.jp/a",
        normalizedUrl: "https://example.co.jp/a",
        title: "同じ記事",
        source: "NHK",
      }),
    );
    expect(
      d.has({
        canonicalUrl: "https://example.co.jp/a",
        normalizedUrl: "https://example.co.jp/other",
        title: "別タイトル",
        source: "毎日新聞",
        publishedAt: new Date("2026-08-20T00:00:00Z"),
      })?.source,
    ).toBe("NHK");
  });

  it("falls back to normalized title + source + date", () => {
    const d = new Deduper();
    d.add(
      article({
        canonicalUrl: "https://example.co.jp/1",
        normalizedUrl: "https://example.co.jp/1",
        title: "臨時国会が開会した",
        source: "NHK",
        publishedAt: new Date("2026-08-20T00:00:00Z"),
      }),
    );
    const key = titleSourceKey("臨時国会が開会した", "NHK", "2026-08-20");
    expect(key).toContain(normalizeTitle("臨時国会が開会した"));
    expect(
      d.has({
        canonicalUrl: "https://example.co.jp/2",
        normalizedUrl: "https://example.co.jp/2",
        title: "臨時国会が開会した",
        source: "NHK",
        publishedAt: new Date("2026-08-20T03:00:00Z"),
      }),
    ).toBeTruthy();
  });
});
