import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFeedXml, sanitizeFeedXml } from "../src/feeds.js";
import { normalizeUrl } from "../src/dedup.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-feed.xml");

const feedMeta = {
  name: "テスト",
  url: "https://example.co.jp/rss.xml",
  category: "ニュース",
  enabled: true,
};

describe("parseFeedXml", () => {
  it("parses RSS 2.0 items in UTF-8 Japanese", async () => {
    const xml = readFileSync(fixture, "utf8");
    const items = await parseFeedXml(xml, feedMeta);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("臨時国会が開会した");
    expect(items[0].url).toContain("example.co.jp/news/2026/08/20/diet");
    expect(items[0].summaryText).toContain("臨時国会");
    expect(items[0].publishedAt).toBeInstanceOf(Date);
    expect(items[1].author).toBe("報道部");
  });

  it("parses titles with a raw ampersand before an ideographic space", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>毎日</title>
    <link>https://mainichi.jp/</link>
    <item>
      <title>羽生結弦さん衣装&写真展　デザイナー伊藤聡美氏が着こなし絶賛</title>
      <link>https://mainichi.jp/articles/20260821/k00/00m/050/141000c</link>
      <description>A&amp;B は正しいエンティティ</description>
    </item>
  </channel>
</rss>`;
    const items = await parseFeedXml(xml, { ...feedMeta, name: "毎日新聞" });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("羽生結弦さん衣装&写真展　デザイナー伊藤聡美氏が着こなし絶賛");
  });

  it("parses RSS 1.0 RDF with the same unescaped ampersand", async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <channel rdf:about="https://mainichi.jp/rss/etc/mainichi-flash.rss">
    <title>ニュース速報</title>
    <link>https://mainichi.jp/rss/etc/mainichi-flash.rss</link>
    <items>
      <rdf:Seq>
        <rdf:li rdf:resource="https://mainichi.jp/articles/a"/>
      </rdf:Seq>
    </items>
  </channel>
  <item rdf:about="https://mainichi.jp/articles/a">
    <title>外務省は1.2兆円要求へ　ソフトパワー&　外交強化</title>
    <link>https://mainichi.jp/articles/a</link>
    <dc:date>2026-08-21T18:07:43+09:00</dc:date>
  </item>
</rdf:RDF>`;
    const items = await parseFeedXml(xml, { ...feedMeta, name: "毎日新聞" });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("外務省は1.2兆円要求へ　ソフトパワー&　外交強化");
  });
});

describe("sanitizeFeedXml", () => {
  it("escapes bare ampersands but keeps real entities", () => {
    expect(sanitizeFeedXml("衣装&写真展　x")).toBe("衣装&amp;写真展　x");
    expect(sanitizeFeedXml("A&amp;B &#123; &#xA0;")).toBe("A&amp;B &#123; &#xA0;");
    expect(sanitizeFeedXml("foo&")).toBe("foo&amp;");
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
