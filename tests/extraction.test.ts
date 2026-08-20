import { describe, expect, it } from "vitest";
import {
  detectJsRequired,
  detectPaywall,
  extractBySelectors,
  htmlToText,
  isSubstantialText,
  sanitizeArticleHtml,
} from "../src/html.js";
import { findExtractor, listExtractorNames } from "../src/extractors/index.js";
import { normalizeConfig } from "../src/config.js";

describe("paywall detection", () => {
  it("detects Japanese paywall banners and never treats them as extractable", () => {
    const html = `
      <html><body>
        <h1>景気見通し</h1>
        <div class="paywall">この記事は有料会員限定です。ログインして全文を読むには登録が必要です。</div>
        <p>冒頭の一文だけ無料です。</p>
      </body></html>`;
    expect(detectPaywall(html)).toBe(true);
  });

  it("does not flag ordinary articles that mention 有料 in passing", () => {
    const html = `
      <html><body>
        <article>
          <h1>有料道路の料金改定</h1>
          <p>国土交通省は有料道路の料金体系を見直す方針を示した。関係者によると来年度から段階的に実施する。</p>
          <p>影響を受けるのは都市部の通勤客が中心になる見込みだ。</p>
        </article>
      </body></html>`;
    expect(detectPaywall(html)).toBe(false);
  });
});

describe("sanitizeArticleHtml", () => {
  it("keeps Japanese structure including ruby", () => {
    const html = `<p>これは<ruby>漢字<rt>かんじ</rt></ruby>です。</p><script>alert(1)</script>`;
    const clean = sanitizeArticleHtml(html);
    expect(clean).toContain("<ruby>");
    expect(clean).toContain("<rt>");
    expect(clean).not.toContain("script");
    expect(htmlToText(clean)).toContain("漢字");
  });
});

describe("substantial RSS content", () => {
  it("accepts long RSS bodies and rejects teasers", () => {
    const teaser = "政府はきょう方針を示した。";
    const full = "あ".repeat(1300);
    expect(isSubstantialText(teaser)).toBe(false);
    expect(isSubstantialText(full)).toBe(true);
  });
});

describe("JS-required detection", () => {
  it("detects empty SPA shells", () => {
    expect(detectJsRequired(`<div id="__next"></div>`, 0)).toBe(true);
    expect(detectJsRequired(`<article>${"あ".repeat(500)}</article>`, 500)).toBe(false);
  });
});

describe("site extractors", () => {
  it("routes known hosts to named extractors", () => {
    expect(findExtractor(new URL("https://www3.nhk.or.jp/news/html/20260820/k1001.html")).name).toBe("nhk");
    expect(findExtractor(new URL("https://www.itmedia.co.jp/news/articles/2608/20/news001.html")).name).toBe("itmedia");
    expect(findExtractor(new URL("https://pc.watch.impress.co.jp/docs/news/x.html")).name).toBe("impress");
    expect(findExtractor(new URL("https://unknown.example.jp/a")).name).toBe("generic");
    expect(listExtractorNames()).toContain("asahi");
  });

  it("extracts from a known selector", () => {
    const html = `<html><body><div id="news_textbody"><p>${"本文です。".repeat(40)}</p></div></body></html>`;
    const result = extractBySelectors(html, "https://www3.nhk.or.jp/news/x.html", ["#news_textbody"]);
    expect(result).toBeTruthy();
    expect(result?.paywalled).toBe(false);
    expect(result?.html).toContain("本文です");
  });

  it("returns paywalled result without body when a wall is present", () => {
    const html = `<html><body>
      <div class="paywall">会員限定です</div>
      <div id="news_textbody"><p>${"本文です。".repeat(40)}</p></div>
    </body></html>`;
    const result = extractBySelectors(html, "https://www3.nhk.or.jp/news/x.html", ["#news_textbody"]);
    expect(result?.paywalled).toBe(true);
    expect(result?.html).toBe("");
  });
});

describe("config", () => {
  it("normalizes feeds and rejects bad extraction strategies", () => {
    const cfg = normalizeConfig({
      feeds: [
        { name: "NHK", url: "https://www3.nhk.or.jp/rss/news/cat0.xml", category: "ニュース" },
      ],
    });
    expect(cfg.feeds[0].enabled).toBe(true);
    expect(cfg.epub.writingMode).toBe("horizontal");
    expect(() =>
      normalizeConfig({
        feeds: [{ name: "x", url: "https://example.com/rss", extraction: "bypass" }],
      }),
    ).toThrow(/extraction/);
  });
});
