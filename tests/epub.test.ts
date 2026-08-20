import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { htmlToXhtmlFragment, writeEpubs } from "../src/epub.js";
import { defaultConfig } from "../src/config.js";
import { HttpClient } from "../src/http.js";
import type { Article } from "../src/models.js";

function sampleArticle(partial: Partial<Article> = {}): Article {
  const now = new Date("2026-08-20T03:00:00+09:00");
  return {
    id: "abc123",
    title: "臨時国会が開会した",
    source: "NHK",
    category: "ニュース",
    url: "https://www3.nhk.or.jp/news/html/20260820/k1001.html",
    canonicalUrl: "https://www3.nhk.or.jp/news/html/20260820/k1001.html",
    normalizedUrl: "https://www3.nhk.or.jp/news/html/20260820/k1001.html",
    publishedAt: now,
    author: "NHK",
    html: '<p>臨時国会がきょう開会した。<a href="https://www3.nhk.or.jp/news/html/20260820/k1001.html">続き</a></p><p>首相は所信表明演説を行う。</p>',
    text: "臨時国会がきょう開会した。首相は所信表明演説を行う。",
    rssSummary: "<p>臨時国会がきょう開会した。</p>",
    images: [],
    extractionStatus: "full",
    paywalled: false,
    inaccessible: false,
    firstSeenAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe("htmlToXhtmlFragment", () => {
  it("emits well-formed XHTML and preserves ruby", () => {
    const xhtml = htmlToXhtmlFragment(
      `<p>読みは<ruby>日本語<rt>にほんご</rt></ruby>です。<br><img src="a.jpg" alt="写真"></p>`,
    );
    expect(xhtml).toContain("<br/>");
    expect(xhtml).toContain("<img ");
    expect(xhtml).toContain("/>");
    expect(xhtml).toContain("<ruby>");
    expect(xhtml).toContain("<rt>にほんご</rt>");
  });

  it("unwraps hyperlinks and keeps the visible text", () => {
    const xhtml = htmlToXhtmlFragment(
      `<p>詳細は<a href="https://example.co.jp/a">こちら</a>と<a href="https://example.co.jp/b">続報</a>。</p>`,
    );
    expect(xhtml).toBe("<p>詳細はこちらと続報。</p>");
    expect(xhtml).not.toContain("href");
    expect(xhtml).not.toContain("<a");
  });
});

describe("writeEpubs", () => {
  it("writes an EPUB 3 with Japanese metadata, TOC, and paywall placeholder", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rss2epub-"));
    const config = defaultConfig();
    config.outputDir = dir;
    config.epub.embedImages = false;
    config.feeds = [
      {
        name: "NHK",
        url: "https://www3.nhk.or.jp/rss/news/cat0.xml",
        category: "ニュース",
        enabled: true,
      },
      {
        name: "ITmedia NEWS",
        url: "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml",
        category: "IT",
        enabled: true,
      },
    ];
    const articles = [
      sampleArticle(),
      sampleArticle({
        id: "pay1",
        title: "会員限定の経済記事",
        source: "ITmedia NEWS",
        category: "IT",
        extractionStatus: "paywalled",
        paywalled: true,
        inaccessible: true,
        html: "",
        text: "",
        rssSummary: "<p>RSSの概要だけ残る。</p>",
      }),
    ];
    const http = new HttpClient({
      userAgent: "rss2epub-test",
      timeoutMs: 1000,
      rateLimitMs: 0,
      respectRobotsTxt: false,
    });
    const [result] = await writeEpubs(articles, config, "2026-08-20", http);
    expect(result.path).toContain("2026-08-20");
    expect(result.path.endsWith(".epub")).toBe(true);

    const zip = await JSZip.loadAsync(readFileSync(result.path));
    expect(zip.file("mimetype")).toBeTruthy();
    const mime = await zip.file("mimetype")!.async("string");
    expect(mime).toBe("application/epub+zip");

    const opf = await zip.file("OEBPS/package.opf")!.async("string");
    expect(opf).toContain('version="3.0"');
    expect(opf).toContain("<dc:language>ja</dc:language>");
    expect(opf).toContain("日本ニュース 2026-08-20");

    const nav = await zip.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain("目次");
    expect(nav).toContain("NHK");
    expect(nav).toContain("ITmedia NEWS");
    expect(nav).toContain('href="styles/stylesheet.css"');
    expect(nav).toContain('href="text/cover.xhtml"');
    expect(nav).toContain("text/ch0001.xhtml");

    const pay = await zip.file("OEBPS/text/ch0002.xhtml")!.async("string");
    expect(pay).toContain("有料記事・本文取得不可");
    expect(pay).toContain("RSSで取得できた概要");
    expect(pay).toContain("xml:lang=\"ja\"");
    expect(pay).not.toContain("<script");

    const chapter = await zip.file("OEBPS/text/ch0001.xhtml")!.async("string");
    expect(chapter).toContain("続き");
    expect(chapter).not.toMatch(/<a[\s>]/i);
    expect(pay).not.toMatch(/<a[\s>]/i);
  });
});
