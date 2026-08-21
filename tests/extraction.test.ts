import { describe, expect, it } from "vitest";
import {
  cleanArticleHtml,
  detectJsRequired,
  detectPaywall,
  extractBySelectors,
  htmlToText,
  isSubstantialText,
  sanitizeArticleHtml,
} from "../src/html.js";
import { findExtractor, listExtractorNames } from "../src/extractors/index.js";
import { normalizeConfig } from "../src/config.js";
import { Semaphore } from "../src/util.js";

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

  it("does not concatenate a page wrapper with the inner body", () => {
    const body = `<p>${"本文です。".repeat(40)}</p>`;
    const html = `<html><body>
      <article id="article"><div id="news_textbody">${body}</div><div class="related">関連</div></article>
    </body></html>`;
    const result = extractBySelectors(html, "https://www3.nhk.or.jp/news/x.html", [
      "#news_textbody",
      "#article",
    ]);
    expect(result?.html).toContain("本文です");
    expect((result?.html.match(/本文です/g) ?? []).length).toBe(40);
  });

  it("keeps sibling body parts such as NHK textbody + textmore", () => {
    const html = `<html><body>
      <article id="newsarticle">
        <div id="news_textbody"><p>${"前文です。".repeat(20)}</p></div>
        <div id="news_textmore"><p>${"続きです。".repeat(20)}</p></div>
      </article>
    </body></html>`;
    const result = extractBySelectors(html, "https://www3.nhk.or.jp/news/x.html", [
      "#news_textbody",
      "#news_textmore",
      "#newsarticle",
    ]);
    expect(result?.html).toContain("前文です");
    expect(result?.html).toContain("続きです");
    expect((result?.html.match(/前文です/g) ?? []).length).toBe(20);
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

describe("cleanArticleHtml", () => {
  it("strips header, nav, related lists, footer, and tracking pixels", () => {
    const html = `
      <img src="https://tagger.opecloud.com/v2/noscript-image.gif" alt="" />
      <header><ul><li><a href="/tech">テック</a></li><li><a href="/life">ライフ</a></li><li><a href="/money">マネー</a></li></ul></header>
      <p class="hdg">アクセスランキング</p>
      <div class="ranking-content"><ul class="ranking-list"><li><a href="/a">記事A</a></li><li><a href="/b">記事B</a></li><li><a href="/c">記事C</a></li></ul></div>
      <p>Special Site</p>
      <p>Impress Watch をフォローする</p>
      <p class="hdg">Impress Watchシリーズ 人気記事</p>
      <p>${"本体メーカーは新型の記録装置を発売した。".repeat(8)}</p>
      <p>クリップ型で衣服に装着して使う。録音は本体のスイッチで開始できる。</p>
      <h2>関連記事</h2>
      <ul>
        <li><div class="body"><div class="image"><a href="/r1"><img src="https://example.com/1.jpg" /></a></div><div class="text"><p class="title"><a href="/r1">関連1</a></p></div></div></li>
        <li><div class="body"><div class="image"><a href="/r2"><img src="https://example.com/2.jpg" /></a></div><div class="text"><p class="title"><a href="/r2">関連2</a></p></div></div></li>
        <li><div class="body"><div class="image"><a href="/r3"><img src="https://example.com/3.jpg" /></a></div><div class="text"><p class="title"><a href="/r3">関連3</a></p></div></div></li>
      </ul>
      <footer><p>Copyright © 2018 Impress Corporation. All rights reserved.</p></footer>
    `;
    const clean = cleanArticleHtml(html);
    const text = htmlToText(clean);
    expect(text).toContain("本体メーカーは新型の記録装置を発売した。");
    expect(text).toContain("クリップ型で衣服に装着して使う");
    expect(text).not.toContain("テック");
    expect(text).not.toContain("アクセスランキング");
    expect(text).not.toContain("Special Site");
    expect(text).not.toContain("フォローする");
    expect(text).not.toContain("人気記事");
    expect(text).not.toContain("関連1");
    expect(text).not.toContain("Copyright");
    expect(clean).not.toContain("tagger.opecloud.com");
  });

  it("strips ITmedia chrome around the article", () => {
    const html = `
      <div class="page"><div>
        <ul>
          <li><a href="/news">速報</a></li>
          <li><a href="/industry">業界動向</a></li>
          <li><a href="/society">社会とIT</a></li>
          <li><a href="/life">くらテク</a></li>
          <li><a href="/archive">過去記事</a></li>
        </ul>
        <div><p>Share</p></div>
        <h2>ファミマが中古品を引き取る</h2>
        <div>
          <p><span>公開</span><time datetime="2026-08-19">2026年08月19日</time></p>
          <p><span>著者</span><a href="/author/1"><img src="https://example.com/a.jpg" alt="山田" /><span>山田</span></a></p>
        </div>
        <p>ブックオフコーポレーションはファミリーマートと共同で宅配買取を始めると発表した。自宅での集荷の待ち時間をなくす。</p>
        <p>利用するには専用フォームでコースと箱数を入力して申し込む。送料と手数料は無料である。</p>
        <p>Copyright © ITmedia, Inc. All Rights Reserved.</p>
        <h2>この記事の著者</h2>
        <div><p><img src="https://example.com/a.jpg" alt="山田" /></p></div>
        <h2>関連記事</h2>
        <ul><li></li><li></li><li></li></ul>
      </div></div>
    `;
    const clean = cleanArticleHtml(html);
    const text = htmlToText(clean);
    expect(text).toContain("ブックオフコーポレーションはファミリーマートと共同");
    expect(text).toContain("専用フォームでコースと箱数");
    expect(text).not.toContain("業界動向");
    expect(text).not.toContain("Share");
    expect(text).not.toContain("All Rights Reserved");
    expect(text).not.toContain("この記事の著者");
  });

  it("strips NHK nav, related rails, and consent copy", () => {
    const html = `
      <div class="page"><div>
        <header><a href="https://www.web.nhk/">NHK</a></header>
        <ul>
          <li><a href="/society">社会</a></li>
          <li><a href="/politics">政治</a></li>
          <li><a href="/business">経済</a></li>
          <li><a href="/sports">スポーツ</a></li>
        </ul>
        <p><img src="https://example.com/photo.jpg" alt="" /></p>
        <p>大リーグ、マリナーズなどで活躍し去年アメリカで野球殿堂入りしたイチローさんが、マリナーズの創設50周年を記念したOBによるホームラン競争に参加し、フェンスを越える当たりを連発して多くのファンをわかせま…</p>
        <h2>深掘りコンテンツ</h2>
        <ul>
          <li><a href="/a">「介護保険料払っているけど…」高齢外国人どう支援？</a></li>
          <li><a href="/b">女性審判たちが切り開いた「道」</a></li>
          <li><a href="/c">水木しげると硫黄島 命の重みをいまに問う</a></li>
        </ul>
        <div>
          <p>このページを見るにはご利用意向の確認をお願いします。</p>
          <p>NHK ONEはどなたでもご利用になれます。受信契約がお済みの世帯の方は追加のご負担なく利用できます。</p>
          <p>内容について確認しました</p>
        </div>
      </div></div>
    `;
    const clean = cleanArticleHtml(html);
    const text = htmlToText(clean);
    expect(text).toContain("イチローさんが、マリナーズの創設50周年");
    expect(text).not.toContain("深掘りコンテンツ");
    expect(text).not.toContain("ご利用意向");
    expect(text).not.toContain("高齢外国人どう支援");
  });

  it("strips Mainichi related articles after the body", () => {
    const html = `
      <div class="articledetail-body">
        <figure><img src="https://example.com/flood.jpg" alt="濁流" /><figcaption>防犯カメラの映像</figcaption></figure>
        <p>13、14日の豪雨で千葉県市原市北部の路上が冠水していく様子を防犯カメラが録画していた。いったん水が引いたものの、再び短時間で水かさが増した。</p>
        <h2>一度水が引いたのに…</h2>
        <p>この防犯カメラは、市原市ちはら台地区の住宅街の交差点に設置されている。毎日新聞は地元の自治会から映像の提供を受けた。</p>
        <span class="ad-article-text">Advertisement</span>
        <p>市の担当者は下水道の排水能力を超える雨が長時間降り、水が低い場所に集まってしまったとみる。</p>
        <div class="articledetail-subcontents">
          <h2 class="title-block">関連記事</h2>
          <ul>
            <li><div class="articlelist-item"><h3 class="articlelist-title">千葉豪雨1週間 残る爪痕</h3></div></li>
            <li><div class="articlelist-item"><h3 class="articlelist-title">記録的豪雨、なぜ起きた?</h3></div></li>
          </ul>
        </div>
      </div>
    `;
    const clean = cleanArticleHtml(html);
    const text = htmlToText(clean);
    expect(text).toContain("路上が冠水していく様子");
    expect(text).toContain("一度水が引いたのに");
    expect(text).not.toContain("Advertisement");
    expect(text).not.toContain("千葉豪雨1週間");
    expect(text).not.toContain("記録的豪雨、なぜ起きた");
  });

  it("keeps ruby and does not strip ordinary article mentions of 関連", () => {
    const html = `<p>これは<ruby>漢字<rt>かんじ</rt></ruby>です。関連会社の発表も本文に含まれている。</p><p>${"続きの段落です。".repeat(10)}</p>`;
    const clean = cleanArticleHtml(html);
    expect(clean).toContain("<ruby>");
    expect(htmlToText(clean)).toContain("関連会社の発表");
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
    expect(cfg.feedConcurrency).toBe(4);
    const tuned = normalizeConfig({ concurrency: 8, feedConcurrency: 3, rateLimitMs: 500 });
    expect(tuned.concurrency).toBe(8);
    expect(tuned.feedConcurrency).toBe(3);
    expect(tuned.rateLimitMs).toBe(500);
    expect(() =>
      normalizeConfig({
        feeds: [{ name: "x", url: "https://example.com/rss", extraction: "bypass" }],
      }),
    ).toThrow(/extraction/);
  });
});

describe("htmlToText", () => {
  it("strips tags and decodes entities without a DOM", () => {
    expect(htmlToText("<p>漢字&amp;仮名</p><div>続き</div>")).toBe("漢字&仮名 続き");
  });
});

describe("Semaphore", () => {
  it("caps concurrent runners", async () => {
    const gate = new Semaphore(2);
    let current = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        gate.run(async () => {
          current += 1;
          peak = Math.max(peak, current);
          await new Promise((resolve) => setTimeout(resolve, 15));
          current -= 1;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});
