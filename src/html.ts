import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import sanitizeHtml from "sanitize-html";
import type { ArticleImage, ArticleResult } from "./models.js";
import { collapseWhitespace, parseDate } from "./util.js";

export const SUBSTANTIAL_TEXT_CHARS = 1200;
export const WEAK_TEXT_CHARS = 200;

const PAYWALL_SELECTORS = [
  "[class*='paywall']",
  "[id*='paywall']",
  "[class*='Paywall']",
  "[data-paywall]",
  ".piano-paywall",
  "#piano-paywall",
  ".c-paywall",
  ".article-paywall",
  ".login-wall",
  ".subscription-wall",
  ".member-only",
  ".c-member-only",
  ".paid-member",
  ".js-paywall",
  "[class*='PaidMember']",
  "[class*='memberLimited']",
];

const PAYWALL_TEXT_RE =
  /この記事は有料|有料会員になると|有料会員限定|会員限定です|会員限定記事|続きを読むには会員|全文を読むには|ログインして全文|日経電子版の購読|定期購読すると|本文を読むには（会員|本文を読むには会員/;

const PAYWALL_FLAG_RE = /会員限定|有料記事|有料会員/;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "s",
    "br",
    "hr",
    "img",
    "figure",
    "figcaption",
    "ruby",
    "rt",
    "rp",
    "rb",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "span",
    "div",
    "sub",
    "sup",
    "small",
    "dl",
    "dt",
    "dd",
    "section",
    "article",
    "header",
    "footer",
    "time",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title", "width", "height"],
    time: ["datetime"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
    ruby: [],
    rt: [],
    rp: [],
    rb: [],
    span: ["class"],
    div: ["class"],
    p: ["class"],
    h1: ["class"],
    h2: ["class"],
    h3: ["class"],
    figure: ["class"],
  },
  allowedSchemes: ["http", "https", "data"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    a: ["http", "https", "mailto"],
  },
  allowProtocolRelative: false,
  transformTags: {
    div: (tagName, attribs) => {
      if (attribs.class && /caption|photo|figure/i.test(attribs.class)) {
        return { tagName: "div", attribs };
      }
      return { tagName: "div", attribs };
    },
  },
};

const MAX_JSDOM_CHARS = 1_500_000;

function createDom(html: string, url?: string): JSDOM {
  const clipped = html.length > MAX_JSDOM_CHARS ? html.slice(0, MAX_JSDOM_CHARS) : html;
  return new JSDOM(clipped, url ? { url } : undefined);
}

export function withDocument<T>(html: string, url: string | undefined, fn: (doc: Document) => T): T {
  const dom = createDom(html, url);
  try {
    return fn(dom.window.document);
  } finally {
    dom.window.close();
  }
}

export async function withDocumentAsync<T>(
  html: string,
  url: string | undefined,
  fn: (doc: Document) => Promise<T>,
): Promise<T> {
  const dom = createDom(html, url);
  try {
    return await fn(dom.window.document);
  } finally {
    dom.window.close();
  }
}

export function sanitizeArticleHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
}

export function htmlToText(html: string): string {
  if (!html) return "";
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
  return collapseWhitespace(stripped);
}

export function wrapPlainTextAsHtml(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) return sanitizeArticleHtml(trimmed);
  return trimmed
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para.replace(/\n/g, "<br/>"))}</p>`)
    .join("\n");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function isSubstantialText(text: string, min = SUBSTANTIAL_TEXT_CHARS): boolean {
  return htmlToTextIfNeeded(text).length >= min;
}

function htmlToTextIfNeeded(value: string): string {
  if (/<[a-z][\s\S]*>/i.test(value)) return htmlToText(value);
  return collapseWhitespace(value);
}

export function isWeakText(text: string): boolean {
  return htmlToTextIfNeeded(text).length < WEAK_TEXT_CHARS;
}

const CHROME_TAG_SELECTOR = "header, footer, nav, aside, form, iframe, noscript, button";

const CHROME_ROLE_SELECTOR =
  "[role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], [role='search']";

const CHROME_TOKEN_RE =
  /^(share|sns|social|breadcrumb|ranking|recommend|related|pickup|sidebar|widget|banner|advert|advertisement|promo|comment|comments|paging|pagination|pagetop|toolbar|articletool|articletag|subcontents|articlelist|newsletter|cookie|consent|modal|overlay|menu|footer|header|copyright|byline|snsbtn|sharebar)$/i;

const CHROME_HEADING_RE =
  /^(関連記事|関連リンク|あわせて読みたい|おすすめ(記事)?|この記事の著者|アクセスランキング|最新記事|新着ニュース|新着・注目|注目の記事|特集|PR|Special\s*PR|Special Site|深掘りコンテンツ|最新・注目の動画|天気予報・防災情報|各地のニュース|Share|著者)$/i;

const JUNK_EXACT_RE =
  /^(share|advertisement|広告|PR|Special\s*PR|Special Site|関連記事|関連リンク|あわせて読みたい|この記事の著者|アクセスランキング|最新記事|新着ニュース|もっと見る|おすすめ記事|配信中の動画を見る|天気予報・防災情報(を確認する)?|新着ニュース一覧を見る|地図から選ぶ|サービスを利用しない|チェックをすると次に進めます|トップページに戻る|アクセスランキングトップ|.+をフォローする|.+人気記事|.*ニュース・防災アプリ.*)$/i;

const JUNK_CONTAINS_RE =
  /Copyright\s*©|All Rights Reserved|このページを見るにはご利用意向|NHK ONEはどなたでもご利用|内容について確認しました|受信契約がお済み|Google検索で「毎日新聞」|1ステップで今すぐ登録|本サイトのご利用について|プライバシーポリシー|特定商取引法に基づく表示|1時間\s*24時間|アクセスランキング|スポニチのアクセスランキング|ご利用いただけるサービス|地域を選択都道府県|トップページに戻る/;

const TRACKING_IMG_RE = /tagger|pixel|beacon|tracker|1x1|noscript-image|doubleclick|scorecard|analytics/i;

export interface ExtractSelectorOptions {
  removeSelectors?: string[];
}

export function stripChromeFromDocument(doc: Document, extraSelectors: string[] = []): void {
  const root = doc.body;
  if (!root) return;
  for (const selector of [CHROME_TAG_SELECTOR, CHROME_ROLE_SELECTOR, ...extraSelectors]) {
    try {
      root.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      // ignore invalid selectors
    }
  }
}

export function cleanArticleHtml(html: string): string {
  if (!html) return "";
  return withDocument(`<div id="__clean">${html}</div>`, undefined, (doc) => {
    const root = doc.getElementById("__clean");
    if (!root) return "";
    stripBoilerplate(root);
    trimChromeEdges(root, true);
    pruneEmpty(root);
    unwrapSingleWrappers(root);
    trimChromeEdges(root, true);
    pruneEmpty(root);
    return sanitizeArticleHtml(root.innerHTML).trim();
  });
}

function stripBoilerplate(root: Element): void {
  root.querySelectorAll(CHROME_TAG_SELECTOR).forEach((el) => el.remove());
  root.querySelectorAll(CHROME_ROLE_SELECTOR).forEach((el) => el.remove());

  for (const el of [...root.querySelectorAll("*")]) {
    if (!el.isConnected) continue;
    if (el === root) continue;
    if (articleParagraphs(el).length >= 1 && !isHeading(el) && !isNavOrRelatedList(el)) continue;
    if (chromeAttr(el) || isNavOrRelatedList(el) || isBylineBox(el) || isJunkTextBlock(el)) {
      el.remove();
    }
  }

  for (const img of [...root.querySelectorAll("img")]) {
    const src = img.getAttribute("src") ?? "";
    const w = img.getAttribute("width");
    const h = img.getAttribute("height");
    if (TRACKING_IMG_RE.test(src) || (w === "1" && h === "1") || src.startsWith("data:image/gif")) {
      img.remove();
    }
  }

  for (const el of [...root.querySelectorAll(".ad-article-text, [class*='ad-article'], .article-info, .publish-date")]) {
    el.remove();
  }

  for (const heading of [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")]) {
    if (!heading.isConnected) continue;
    const title = collapseWhitespace(heading.textContent ?? "");
    if (!CHROME_HEADING_RE.test(title)) continue;
    let sibling = heading.nextElementSibling;
    heading.remove();
    while (sibling) {
      const next = sibling.nextElementSibling;
      if (isHeading(sibling)) break;
      if (isProseBlock(sibling)) break;
      sibling.remove();
      sibling = next;
    }
  }
}

function trimChromeEdges(root: Element, stripLeadingTitle = false): void {
  unwrapSingleWrappers(root);
  const meaningful = (): ChildNode[] =>
    [...root.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && collapseWhitespace(n.textContent ?? "")));

  while (true) {
    const nodes = meaningful();
    if (nodes.length === 0) break;
    const first = nodes[0];
    if (first.nodeType === 3) {
      if (isJunkPhrase(first.textContent ?? "")) {
        first.remove();
        continue;
      }
      break;
    }
    const el = first as Element;
    if (shouldTrimLeading(el, stripLeadingTitle)) {
      el.remove();
      continue;
    }
    break;
  }

  while (true) {
    const nodes = meaningful();
    if (nodes.length === 0) break;
    const last = nodes[nodes.length - 1];
    if (last.nodeType === 3) {
      if (isJunkPhrase(last.textContent ?? "") || collapseWhitespace(last.textContent ?? "").length < 20) {
        last.remove();
        continue;
      }
      break;
    }
    const el = last as Element;
    if (isChromeBlock(el) && !isProseBlock(el)) {
      el.remove();
      continue;
    }
    break;
  }

  const only = [...root.children];
  if (only.length === 1 && /^(DIV|SECTION|ARTICLE|SPAN)$/.test(only[0].tagName)) {
    trimChromeEdges(only[0], stripLeadingTitle);
    return;
  }
  for (const child of [...root.children]) {
    if (child.children.length > 0) trimChromeEdges(child, false);
  }
}

function shouldTrimLeading(el: Element, stripLeadingTitle: boolean): boolean {
  if (isChromeBlock(el) && !isProseBlock(el)) return true;
  if (stripLeadingTitle && /^H[12]$/.test(el.tagName)) {
    const t = collapseWhitespace(el.textContent ?? "");
    if (t.length > 0 && t.length < 120 && !/[。．！？]/.test(t)) return true;
  }
  return false;
}

function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.tagName);
}

function chromeAttr(el: Element): boolean {
  const bits = `${el.getAttribute("class") ?? ""} ${el.id} ${el.getAttribute("role") ?? ""}`;
  const tokens = bits
    .split(/[\s_-]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.some((t) => CHROME_TOKEN_RE.test(t));
}

function isArticleParagraphText(text: string): boolean {
  const t = collapseWhitespace(text);
  if (t.length < 40) return false;
  if (JUNK_CONTAINS_RE.test(t) || JUNK_EXACT_RE.test(t)) return false;
  if (t.includes("。")) return true;
  return t.length >= 80;
}

function articleParagraphs(el: Element): string[] {
  const fromDescendants = [...el.querySelectorAll("p")]
    .map((p) => collapseWhitespace(p.textContent ?? ""))
    .filter((t) => isArticleParagraphText(t));
  if (el.tagName === "P") {
    const own = collapseWhitespace(el.textContent ?? "");
    if (isArticleParagraphText(own) && !fromDescendants.includes(own)) fromDescendants.push(own);
  }
  return fromDescendants;
}

function hasArticleProse(el: Element): boolean {
  return articleParagraphs(el).length >= 2;
}

function isProseBlock(el: Element): boolean {
  if (el.tagName === "P") {
    const t = collapseWhitespace(el.textContent ?? "");
    return t.length >= 40 && !isJunkPhrase(t);
  }
  if (el.tagName === "FIGURE") return Boolean(el.querySelector("img"));
  if (el.tagName === "TABLE" || el.tagName === "BLOCKQUOTE" || el.tagName === "PRE") {
    return collapseWhitespace(el.textContent ?? "").length >= 20;
  }
  const ps = [...el.querySelectorAll("p")].filter((p) => collapseWhitespace(p.textContent ?? "").length >= 40);
  if (ps.length >= 2) return true;
  if (ps.length === 1 && collapseWhitespace(ps[0].textContent ?? "").length >= 80) return true;
  if (ps.length >= 1 && el.querySelector("figure, img")) return true;
  return false;
}

function isChromeBlock(el: Element): boolean {
  if (/^(HEADER|FOOTER|NAV|ASIDE)$/.test(el.tagName)) return true;
  if (isBylineBox(el) || isNavOrRelatedList(el) || isJunkTextBlock(el)) return true;
  if (chromeAttr(el) && !hasArticleProse(el)) return true;
  if (isHeading(el) && CHROME_HEADING_RE.test(collapseWhitespace(el.textContent ?? ""))) return true;
  const text = collapseWhitespace(el.textContent ?? "");
  if (!text && !el.querySelector("img")) return true;
  if (!isProseBlock(el) && linkDensity(el) > 0.55 && text.length < 600) return true;
  return false;
}

function isBylineBox(el: Element): boolean {
  const text = collapseWhitespace(el.textContent ?? "");
  if (text.length === 0 || text.length > 280) return false;
  if (/著者|公開/.test(text) && el.querySelector("img, time")) return true;
  if (/^Share$/i.test(text)) return true;
  if (el.querySelector(".publish-date, time") && !text.includes("。") && text.length < 200) return true;
  if (/\d{4}年\d{1,2}月\d{1,2}日/.test(text) && !text.includes("。") && text.length < 120) return true;
  return false;
}

function isNavOrRelatedList(el: Element): boolean {
  if (!/^(UL|OL)$/.test(el.tagName)) return false;
  const items = [...el.querySelectorAll(":scope > li")];
  if (items.length < 3) return false;
  const cards = items.filter((i) => i.querySelector("img") && i.querySelector("a"));
  if (cards.length >= 3) return true;
  const shortOrLink = items.filter((i) => {
    const t = collapseWhitespace(i.textContent ?? "");
    if (t.length < 40) return true;
    return linkDensity(i) > 0.7;
  });
  return shortOrLink.length >= items.length * 0.75;
}

function isJunkTextBlock(el: Element): boolean {
  const text = collapseWhitespace(el.textContent ?? "");
  if (!text) return true;
  if (JUNK_EXACT_RE.test(text)) return true;
  if (JUNK_CONTAINS_RE.test(text) && articleParagraphs(el).length === 0) return true;
  return false;
}

function isJunkPhrase(text: string): boolean {
  const t = collapseWhitespace(text);
  return !t || JUNK_EXACT_RE.test(t) || (t.length < 800 && JUNK_CONTAINS_RE.test(t));
}

function linkDensity(el: Element): number {
  const text = collapseWhitespace(el.textContent ?? "");
  if (!text.length) return 1;
  const linkText = collapseWhitespace([...el.querySelectorAll("a")].map((a) => a.textContent ?? "").join(""));
  return linkText.length / text.length;
}

function pruneEmpty(root: Element): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of [...root.querySelectorAll("*")].reverse()) {
      if (!el.isConnected) continue;
      if (/^(IMG|BR|HR|RUBY|RT|RP|RB|TD|TH|TR|THEAD|TBODY|TABLE|COL)$/.test(el.tagName)) continue;
      if (el.querySelector("img, br, hr, ruby, td, th")) continue;
      if (!collapseWhitespace(el.textContent ?? "")) {
        el.remove();
        changed = true;
      }
    }
  }
}

function unwrapSingleWrappers(root: Element): void {
  while (root.children.length === 1) {
    const child = root.children[0];
    if (!/^(DIV|SECTION|ARTICLE|SPAN)$/.test(child.tagName)) break;
    if (child.attributes.length > 0 && chromeAttr(child)) {
      root.innerHTML = child.innerHTML;
      continue;
    }
    if (child.attributes.length === 0 || child.getAttribute("class") === "page") {
      root.innerHTML = child.innerHTML;
      continue;
    }
    break;
  }
}

export function detectPaywall(html: string, doc?: Document): boolean {
  if (!html) return false;
  if (!doc) return withDocument(html, undefined, (parsed) => detectPaywall(html, parsed));
  for (const selector of PAYWALL_SELECTORS) {
    try {
      if (doc.querySelector(selector)) return true;
    } catch {
      // invalid selector in this jsdom version
    }
  }
  const flags = [
    ...doc.querySelectorAll(
      ".flag, .label, .badge, .kiji-pay, [class*='member'], [class*='paid'], [class*='Paid']",
    ),
  ]
    .map((el) => el.textContent ?? "")
    .join(" ");
  if (PAYWALL_FLAG_RE.test(flags) && flags.length < 400) return true;

  const banners = [
    ...doc.querySelectorAll(
      "aside, .banner, .modal, .overlay, [class*='login'], [class*='subscribe']",
    ),
  ]
    .map((el) => collapseWhitespace(el.textContent ?? ""))
    .join("\n");
  if (PAYWALL_TEXT_RE.test(banners)) return true;
  if (PAYWALL_TEXT_RE.test(html.slice(0, 80_000))) return true;
  return false;
}

export function detectJsRequired(html: string, extractedTextLen: number): boolean {
  if (extractedTextLen >= 400) return false;
  if (/enable JavaScript|JavaScript を有効|JavaScriptを有効/i.test(html)) return true;
  if (/<div id="(__next|app|root)"[^>]*>\s*<\/div>/i.test(html)) return true;
  if (/id="__NEXT_DATA__"/.test(html) && extractedTextLen < 120) return true;
  if (/cf-browser-verification|just a moment/i.test(html)) return true;
  if (/<noscript>/i.test(html) && extractedTextLen < 120) return true;
  return false;
}

export function detectAccessDenied(html: string, status?: number): boolean {
  if (status === 401 || status === 403) return true;
  if (/captcha|are you a robot|hcaptcha|recaptcha/i.test(html) && html.length < 20_000) {
    return true;
  }
  if (/access denied|access is denied|アクセスが拒否/i.test(html) && html.length < 8000) {
    return true;
  }
  return false;
}

export function extractMetadata(doc: Document): {
  title?: string;
  author?: string | null;
  publishedAt?: Date | null;
  canonicalUrl?: string;
} {
  const canonical =
    doc.querySelector("link[rel='canonical']")?.getAttribute("href") ??
    doc.querySelector("meta[property='og:url']")?.getAttribute("content") ??
    undefined;
  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content") ??
    doc.querySelector("h1")?.textContent ??
    doc.title ??
    undefined;
  const author =
    doc.querySelector("meta[name='author']")?.getAttribute("content") ??
    doc.querySelector("meta[property='article:author']")?.getAttribute("content") ??
    doc.querySelector("[rel='author']")?.textContent ??
    doc.querySelector(".author, .byline, [class*='author']")?.textContent ??
    null;
  const publishedRaw =
    doc.querySelector("meta[property='article:published_time']")?.getAttribute("content") ??
    doc.querySelector("meta[name='pubdate']")?.getAttribute("content") ??
    doc.querySelector("time[datetime]")?.getAttribute("datetime") ??
    null;

  return {
    title: title ? collapseWhitespace(title) : undefined,
    author: author ? collapseWhitespace(author) || null : null,
    publishedAt: parseDate(publishedRaw),
    canonicalUrl: canonical ?? undefined,
  };
}

export function collectImages(html: string, baseUrl: string): ArticleImage[] {
  if (!html) return [];
  return withDocument(`<div id="root">${html}</div>`, baseUrl, (doc) => {
    const images: ArticleImage[] = [];
    const seen = new Set<string>();
    for (const img of doc.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) continue;
      let absolute: string;
      try {
        absolute = new URL(src, baseUrl).href;
      } catch {
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const figure = img.closest("figure");
      const caption = figure?.querySelector("figcaption")?.textContent;
      images.push({
        originalUrl: absolute,
        alt: img.getAttribute("alt") ?? undefined,
        caption: caption ? collapseWhitespace(caption) : undefined,
      });
    }
    return images.slice(0, 20);
  });
}

export function extractWithReadability(html: string, url: string): ArticleResult | null {
  return withDocument(html, url, (doc) => {
    const meta = extractMetadata(doc);
    if (detectPaywall(html, doc)) {
      return {
        html: "",
        title: meta.title,
        author: meta.author,
        publishedAt: meta.publishedAt,
        canonicalUrl: meta.canonicalUrl,
        paywalled: true,
        inaccessible: true,
      };
    }
    stripChromeFromDocument(doc);
    let parsed: ReturnType<Readability["parse"]> = null;
    try {
      parsed = new Readability(doc).parse();
    } catch {
      parsed = null;
    }
    if (!parsed?.content) return null;
    const sanitized = cleanArticleHtml(parsed.content);
    const text = htmlToText(sanitized);
    if (!text) return null;
    return {
      title: parsed.title || meta.title,
      html: sanitized,
      text,
      author: parsed.byline || meta.author,
      publishedAt: meta.publishedAt,
      canonicalUrl: meta.canonicalUrl,
      images: collectImages(sanitized, url),
      paywalled: false,
      inaccessible: false,
    };
  });
}

export function extractBySelectors(
  html: string,
  url: string,
  selectors: string[],
  options: ExtractSelectorOptions = {},
): ArticleResult | null {
  return withDocument(html, url, (doc) => {
    const meta = extractMetadata(doc);
    if (detectPaywall(html, doc)) {
      return {
        html: "",
        title: meta.title,
        author: meta.author,
        publishedAt: meta.publishedAt,
        canonicalUrl: meta.canonicalUrl,
        paywalled: true,
        inaccessible: true,
      };
    }
    stripChromeFromDocument(doc, options.removeSelectors ?? []);
    const collected: Element[] = [];
    for (const selector of selectors) {
      try {
        const matches = [...doc.querySelectorAll(selector)];
        const unique = matches.filter((el, _i, arr) => {
          if (arr.some((other) => other !== el && other.contains(el))) return false;
          if (collected.some((c) => c === el || c.contains(el) || el.contains(c))) return false;
          const text = collapseWhitespace(el.textContent ?? "");
          return text.length > 0;
        });
        if (unique.length > 3 && unique.every((el) => collapseWhitespace(el.textContent ?? "").length < 400)) {
          continue;
        }
        collected.push(...unique);
      } catch {
        // ignore bad selectors
      }
    }
    if (collected.length === 0) return null;
    const combined = collected
      .map((el) => (el as HTMLElement).innerHTML?.trim() ?? "")
      .filter(Boolean)
      .join("\n");
    const rawText = htmlToText(sanitizeArticleHtml(combined));
    if (rawText.length < WEAK_TEXT_CHARS) return null;
    const sanitized = cleanArticleHtml(combined);
    const text = htmlToText(sanitized);
    if (!text) return null;
    return {
      title: meta.title,
      html: sanitized,
      text,
      author: meta.author,
      publishedAt: meta.publishedAt,
      canonicalUrl: meta.canonicalUrl,
      images: collectImages(sanitized, url),
      paywalled: false,
      inaccessible: false,
    };
  });
}

export function finalizeResult(result: ArticleResult, url: string): ArticleResult {
  const html = result.html ? cleanArticleHtml(result.html) : "";
  const text = html ? htmlToText(html) : "";
  return {
    ...result,
    html,
    text,
    images: result.images && result.images.length > 0 ? result.images : collectImages(html, url),
  };
}

export function rssSummaryToHtml(summary: string | null | undefined): string {
  if (!summary) return "";
  const trimmed = summary.trim();
  if (!trimmed) return "";
  if (/<[a-z][\s\S]*>/i.test(trimmed)) return cleanArticleHtml(trimmed);
  return wrapPlainTextAsHtml(trimmed);
}
